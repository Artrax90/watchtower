import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { dbQueries, MonitorRow } from '../db/index.js';
import { requireAuth, requireAdmin } from './auth.js';
import { executeMonitorCheck } from '../scheduler/index.js';
import { checkHTTP } from '../checkers/http.js';
import { checkTCP } from '../checkers/tcp.js';
import { checkPing } from '../checkers/ping.js';
import { checkDNS } from '../checkers/dns.js';
import { checkSSL } from '../checkers/ssl.js';
import { randomUUID } from 'node:crypto';

export async function monitorRoutes(fastify: FastifyInstance) {
  // Get all monitors with 24h uptime and recent heartbeats (for ticks)
  fastify.get('/', async () => {
    const monitors = dbQueries.getAllMonitors();

    const enriched = monitors.map((m) => {
      const uptime24h = dbQueries.getMonitorUptime24h(m.id);
      const recentHeartbeats = dbQueries.getRecentHeartbeats(m.id, 24);
      return {
        ...m,
        uptime24h,
        heartbeats: recentHeartbeats
      };
    });

    return { monitors: enriched };
  });

  // Get single monitor details
  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const monitor = dbQueries.getMonitorById(req.params.id);
    if (!monitor) {
      return reply.status(404).send({ error: 'Monitor not found' });
    }

    const uptime24h = dbQueries.getMonitorUptime24h(monitor.id);
    const heartbeats = dbQueries.getRecentHeartbeats(monitor.id, 50);

    return {
      monitor: {
        ...monitor,
        uptime24h,
        heartbeats
      }
    };
  });

  // Create monitor (Admin only)
  fastify.post<{
    Body: {
      name: string;
      type?: string;
      target: string;
      port?: number;
      interval?: number;
      timeout?: number;
      retry_count?: number;
      keyword?: string;
      check_ssl?: number;
      ssl_alert_days?: number;
      http_method?: string;
      http_headers?: string;
      http_body?: string;
      expected_status?: string;
      follow_redirects?: number;
    };
  }>(
    '/',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const {
        name,
        type,
        target,
        port,
        interval,
        timeout,
        retry_count,
        keyword,
        check_ssl,
        ssl_alert_days,
        http_method,
        http_headers,
        http_body,
        expected_status,
        follow_redirects
      } = req.body || {};

      if (!name || !name.trim()) {
        return reply.status(400).send({ error: 'Monitor name is required' });
      }
      if (!target || !target.trim()) {
        return reply.status(400).send({ error: 'Target URL/host is required' });
      }

      const id = randomUUID();
      dbQueries.createMonitor({
        id,
        name: name.trim(),
        type: (type || 'http').toLowerCase(),
        target: target.trim(),
        port: port ? Number(port) : null,
        interval: Math.max(10, Number(interval) || 60),
        timeout: Math.max(1000, Number(timeout) || 10000),
        retry_count: Math.max(2, Number(retry_count) || 2),
        keyword: keyword?.trim() || null,
        check_ssl: check_ssl !== undefined ? Number(check_ssl) : 1,
        ssl_alert_days: Number(ssl_alert_days) || 14,
        http_method: http_method || 'GET',
        http_headers: http_headers || null,
        http_body: http_body || null,
        expected_status: expected_status?.trim() || null,
        follow_redirects: follow_redirects !== undefined ? Number(follow_redirects) : 1
      });

      const created = dbQueries.getMonitorById(id)!;
      // Trigger instant check asynchronously
      executeMonitorCheck(created).catch(() => {});

      return reply.status(201).send({ monitor: created });
    }
  );

  // Update monitor (Admin only)
  fastify.put<{ Params: { id: string }; Body: Partial<MonitorRow> }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = dbQueries.getMonitorById(req.params.id);
      if (!existing) {
        return reply.status(404).send({ error: 'Monitor not found' });
      }

      dbQueries.updateMonitor(req.params.id, req.body);
      const updated = dbQueries.getMonitorById(req.params.id);
      return { monitor: updated };
    }
  );

  // Delete monitor (Admin only)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const existing = dbQueries.getMonitorById(req.params.id);
      if (!existing) {
        return reply.status(404).send({ error: 'Monitor not found' });
      }

      dbQueries.deleteMonitor(req.params.id);
      return { success: true };
    }
  );

  // Trigger manual immediate check (Admin only)
  fastify.post<{ Params: { id: string } }>(
    '/:id/check',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const monitor = dbQueries.getMonitorById(req.params.id);
      if (!monitor) {
        return reply.status(404).send({ error: 'Monitor not found' });
      }

      const result = await executeMonitorCheck(monitor);
      const updated = dbQueries.getMonitorById(req.params.id);

      return {
        checkResult: result,
        monitor: updated
      };
    }
  );

  // Toggle pause (Admin only)
  fastify.post<{ Params: { id: string } }>(
    '/:id/pause',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const monitor = dbQueries.getMonitorById(req.params.id);
      if (!monitor) {
        return reply.status(404).send({ error: 'Monitor not found' });
      }

      const newPaused = monitor.is_paused ? 0 : 1;
      dbQueries.updateMonitor(req.params.id, { is_paused: newPaused });
      return { is_paused: newPaused };
    }
  );

  // On-demand check for a single badge/type (Accessible to authenticated users)
  fastify.post<{ Params: { id: string }; Body: { type: string } }>(
    '/:id/test-check',
    { preHandler: requireAuth },
    async (req, reply) => {
      const monitor = dbQueries.getMonitorById(req.params.id);
      if (!monitor) {
        return reply.status(404).send({ error: 'Монитор не найден' });
      }

      const type = (req.body?.type || 'http').toLowerCase().trim();
      let result: any = null;

      if (type === 'http' || type === 'https') {
        const res = await checkHTTP(monitor);
        result = {
          type: 'HTTP',
          status: res.status,
          latency: res.latency,
          statusCode: res.statusCode,
          error: res.error,
          details: res.statusCode
            ? `Код ответа: ${res.statusCode}, задержка: ${res.latency} мс`
            : `Сбой HTTP: ${res.error || 'Ошибка соединения'}`
        };
      } else if (type === 'ssl') {
        let host = monitor.target.replace(/^https?:\/\//i, '').split('/')[0];
        const port = monitor.port || 443;
        const ssl = await checkSSL(host, port, monitor.timeout || 8000);
        result = {
          type: 'SSL',
          status: ssl.valid ? (ssl.daysRemaining <= (monitor.ssl_alert_days || 14) ? 'degraded' : 'online') : 'down',
          latency: 0,
          ssl,
          details: ssl.valid
            ? `Сертификат действителен ещё ${ssl.daysRemaining} дн. (до ${ssl.expiryDate}), выдан: ${ssl.issuer}`
            : `Ошибка SSL: ${ssl.error || 'Сертификат истёк или недействителен'}`
        };
      } else if (type === 'ping') {
        const res = await checkPing(monitor);
        const ipStr = res.ip ? ` от ${res.ip}` : '';
        result = {
          type: 'PING',
          status: res.status,
          latency: res.latency,
          ip: res.ip,
          error: res.error,
          details: res.status === 'online' || res.status === 'degraded'
            ? `ICMP эхо-ответ получен${ipStr} за ${res.latency} мс`
            : `Пинг не прошёл${ipStr}: ${res.error || 'Узел не отвечает'}`
        };
      } else if (type === 'port' || type === 'tcp') {
        const res = await checkTCP(monitor);
        const port = monitor.port || 80;
        result = {
          type: 'TCP',
          status: res.status,
          latency: res.latency,
          error: res.error,
          details: res.status === 'online' || res.status === 'degraded'
            ? `Порт ${port} открыт и отвечает за ${res.latency} мс`
            : `Порт ${port} закрыт или недоступен (${res.error || 'Connection refused'})`
        };
      } else if (type === 'dns') {
        const res = await checkDNS(monitor);
        const ipStr = res.ip ? ` (${res.ip})` : '';
        result = {
          type: 'DNS',
          status: res.status,
          latency: res.latency,
          ip: res.ip,
          error: res.error,
          details: res.status === 'online' || res.status === 'degraded'
            ? `DNS успешно разрешён${ipStr} за ${res.latency} мс`
            : `Ошибка резолвинга DNS: ${res.error || 'NXDOMAIN'}`
        };
      } else {
        return reply.status(400).send({ error: `Неизвестный тип проверки: ${type}` });
      }

      return { success: true, result };
    }
  );
}
