import { FastifyInstance } from 'fastify';
import { dbQueries } from '../db/index.js';
import { requireAdmin } from './auth.js';
import { sendTestNotification, testProxyConnection, restartTelegramBot } from '../notifiers/index.js';
import { randomUUID } from 'node:crypto';

export async function notificationRoutes(fastify: FastifyInstance) {
  // Get channels (Admin only)
  fastify.get('/', { preHandler: requireAdmin }, async () => {
    const channels = dbQueries.getNotificationChannels();

    // Mask secret tokens for security
    const masked = channels.map((c) => {
      let configObj: any = {};
      try {
        configObj = JSON.parse(c.config);
      } catch {}

      if (configObj.botToken && configObj.botToken.length > 8) {
        const token = configObj.botToken;
        configObj.botTokenMasked = `${token.slice(0, 4)}...${token.slice(-4)}`;
      }

      return {
        id: c.id,
        type: c.type,
        name: c.name,
        is_enabled: c.is_enabled,
        config: configObj,
        created_at: c.created_at
      };
    });

    return { channels: masked };
  });

  // Save / update channel (Admin only)
  fastify.post<{
    Body: {
      id?: string;
      type: string;
      name: string;
      is_enabled?: number;
      config: any;
    };
  }>(
    '/',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id, type, name, is_enabled, config } = req.body || {};

      if (!type || !['telegram', 'max', 'webhook'].includes(type.toLowerCase())) {
        return reply.status(400).send({ error: 'Invalid channel type. Allowed: telegram, max, webhook' });
      }
      if (!name || !name.trim()) {
        return reply.status(400).send({ error: 'Channel name is required' });
      }
      if (!config || typeof config !== 'object') {
        return reply.status(400).send({ error: 'Channel configuration object is required' });
      }

      const channelId = id || randomUUID();
      dbQueries.saveNotificationChannel({
        id: channelId,
        type: type.toLowerCase(),
        name: name.trim(),
        is_enabled: is_enabled !== undefined ? Number(is_enabled) : 1,
        config: JSON.stringify(config)
      });

      if (type.toLowerCase() === 'telegram') {
        restartTelegramBot();
      }

      return { success: true, id: channelId };
    }
  );

  // Delete channel (Admin only)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req) => {
      dbQueries.deleteNotificationChannel(req.params.id);
      restartTelegramBot();
      return { success: true };
    }
  );

  // Test channel delivery (Admin only)
  fastify.post<{
    Body: {
      type: 'telegram' | 'max';
      config: any;
    };
  }>(
    '/test',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { type, config } = req.body || {};
      if (!type || !config) {
        return reply.status(400).send({ error: 'Type and config are required' });
      }

      const res = await sendTestNotification(type, config);
      return res;
    }
  );

  // Test proxy connection to api.telegram.org (Admin only)
  fastify.post<{
    Body: {
      proxyUrl: string;
    };
  }>(
    '/test-proxy',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { proxyUrl } = req.body || {};
      if (!proxyUrl || !proxyUrl.trim()) {
        return reply.status(400).send({ success: false, error: 'Параметры прокси не указаны' });
      }

      const res = await testProxyConnection(proxyUrl.trim());
      return res;
    }
  );
}
