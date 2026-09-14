import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { initDatabase } from './db/index.js';
import { authRoutes } from './routes/auth.js';
import { monitorRoutes } from './routes/monitors.js';
import { notificationRoutes } from './routes/notifications.js';
import { statsRoutes } from './routes/stats.js';
import { startScheduler, stopScheduler } from './scheduler/index.js';
import { startTelegramBot, stopTelegramBot } from './notifiers/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize DB schema
initDatabase();

const server = Fastify({
  logger: process.env.NODE_ENV === 'production' ? true : { level: 'info' }
});

// Allow empty body when Content-Type is application/json (e.g. DELETE requests)
server.addContentTypeParser('application/json', { parseAs: 'string' }, function (req, body: string, done) {
  if (!body || body === '') {
    done(null, {});
    return;
  }
  try {
    done(null, JSON.parse(body));
  } catch (err: any) {
    err.statusCode = 400;
    done(err, undefined);
  }
});

await server.register(fastifyCors, {
  origin: true,
  credentials: true
});

// Determine frontend static path
let frontendPath = path.resolve(__dirname, '../../frontend');
if (!fs.existsSync(frontendPath)) {
  frontendPath = path.resolve(process.cwd(), '../frontend');
}

if (fs.existsSync(frontendPath)) {
  await server.register(fastifyStatic, {
    root: frontendPath,
    prefix: '/'
  });

  // Handle SPA routing for /overview, /monitors, /incidents, /alerts, /admin, /settings
  const spaRoutes = [
    '/overview', '/monitors', '/incidents', '/alerts', '/admin', '/settings',
    '/monitor', '/view', '/incident', '/alert'
  ];
  for (const route of spaRoutes) {
    server.get(route, async (req, reply) => {
      return reply.sendFile('index.html');
    });
  }

  server.setNotFoundHandler((req, reply) => {
    if (req.raw.url && req.raw.url.startsWith('/api')) {
      return reply.status(404).send({ error: 'API route not found' });
    }
    const indexPath = path.join(frontendPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      return reply.sendFile('index.html');
    }
    reply.status(404).send('Not Found');
  });
}

// Register API Routes
server.register(authRoutes, { prefix: '/api/auth' });
server.register(monitorRoutes, { prefix: '/api/monitors' });
server.register(notificationRoutes, { prefix: '/api/notifications' });
server.register(statsRoutes, { prefix: '/api/stats' });

// Healthcheck endpoint
server.get('/health', async () => ({ status: 'healthy', timestamp: Date.now() }));

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function start() {
  try {
    await server.listen({ port: PORT, host: HOST });
    console.log(`\n======================================================`);
    console.log(`🚀 Watchtower Server running at: http://${HOST}:${PORT}`);
    console.log(`🔐 Admin Panel available at:     http://${HOST}:${PORT}/#admin`);
    console.log(`======================================================\n`);

    // Start background monitor scheduler
    startScheduler();

    // Start Telegram Bot interactive service
    startTelegramBot();
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
const shutdown = () => {
  console.log('\nGracefully shutting down Watchtower...');
  stopScheduler();
  stopTelegramBot();
  server.close(() => {
    console.log('Server closed. Goodbye!');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
