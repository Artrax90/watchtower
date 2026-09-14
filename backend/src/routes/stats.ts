import { FastifyInstance } from 'fastify';
import { db, dbQueries } from '../db/index.js';

export async function statsRoutes(fastify: FastifyInstance) {
  // Summary metrics for the 4 top cards
  fastify.get('/summary', async () => {
    const monitors = dbQueries.getAllMonitors();
    const activeIncidents = dbQueries.getActiveIncidents();

    const total = monitors.length;
    let online = 0;
    let down = 0;
    let degraded = 0;
    let totalLatency = 0;
    let countedLatencyMonitors = 0;

    for (const m of monitors) {
      if (m.status === 'online') online++;
      else if (m.status === 'down') down++;
      else if (m.status === 'degraded') degraded++;

      if (m.current_latency > 0) {
        totalLatency += m.current_latency;
        countedLatencyMonitors++;
      }
    }

    const avgLatency = countedLatencyMonitors > 0 ? Math.round(totalLatency / countedLatencyMonitors) : 0;
    const actionNeeded = down + degraded + (activeIncidents.length > 0 ? 1 : 0);

    return {
      total,
      online,
      down,
      degraded,
      avgLatency,
      actionNeeded: Math.max(actionNeeded, activeIncidents.length),
      criticalIncidents: down,
      activeIncidentsCount: activeIncidents.length
    };
  });

  // Incidents and issues log
  fastify.get<{ Querystring: { monitor_id?: string } }>('/incidents', async (req) => {
    const monitorId = req.query.monitor_id || undefined;
    const active = dbQueries.getActiveIncidents(monitorId);
    const recent = dbQueries.getRecentIncidents(50, monitorId);
    const since24h = Date.now() - 24 * 60 * 60 * 1000;
    const issueHeartbeats = dbQueries.getRecentIssuesHeartbeats(since24h, 50, monitorId);
    return { active, recent, issueHeartbeats };
  });

  // Latency history for response time bar chart (last 14 data points / hours)
  fastify.get('/latency-history', async () => {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const points: { label: string; latency: number }[] = [];

    for (let i = 13; i >= 0; i--) {
      const bucketStart = now - (i + 1) * oneHour;
      const bucketEnd = now - i * oneHour;
      const date = new Date(bucketEnd);
      const label = `${String(date.getHours()).padStart(2, '0')}:00`;

      const row = db
        .prepare(`
          SELECT AVG(latency) as avg_latency
          FROM heartbeats
          WHERE created_at >= ? AND created_at < ? AND status != 'down'
        `)
        .get(bucketStart, bucketEnd) as { avg_latency: number | null } | undefined;

      const latency = row?.avg_latency ? Math.round(row.avg_latency) : 0;
      points.push({ label, latency });
    }

    // Overall 24h average
    const summaryRow = db
      .prepare(`
        SELECT AVG(latency) as avg_latency
        FROM heartbeats
        WHERE created_at >= ? AND status != 'down'
      `)
      .get(now - 24 * oneHour) as { avg_latency: number | null } | undefined;

    return {
      points,
      average24h: summaryRow?.avg_latency ? Math.round(summaryRow.avg_latency) : 0
    };
  });
}
