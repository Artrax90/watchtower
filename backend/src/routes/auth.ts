import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { dbQueries } from '../db/index.js';
import { hashPassword, verifyPassword, generateToken } from '../utils/crypto.js';
import { randomUUID } from 'node:crypto';

export async function authRoutes(fastify: FastifyInstance) {
  // Check auth status & first run
  fastify.get('/status', async (req) => {
    const count = dbQueries.getUserCount();
    const token = extractToken(req);
    let session = token ? dbQueries.getSession(token) : undefined;

    return {
      needsSetup: count === 0,
      authenticated: !!session,
      user: session ? { id: session.user_id, username: session.username, role: session.role || 'admin' } : null
    };
  });

  // Setup first admin account
  fastify.post<{ Body: { username?: string; password?: string } }>('/setup', async (req, reply) => {
    const count = dbQueries.getUserCount();
    if (count > 0) {
      return reply.status(400).send({ error: 'Первоначальная настройка уже завершена. Пожалуйста, выполните вход.' });
    }

    const { username, password } = req.body || {};
    if (!username || username.trim().length < 3) {
      return reply.status(400).send({ error: 'Логин должен содержать минимум 3 символа.' });
    }
    if (!password || password.length < 6) {
      return reply.status(400).send({ error: 'Пароль должен содержать минимум 6 символов.' });
    }

    const userId = randomUUID();
    const passwordHash = hashPassword(password);
    dbQueries.createUser(userId, username.trim(), passwordHash, 'admin');

    // Auto login
    const token = generateToken();
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days
    dbQueries.createSession(token, userId, expiresAt);

    return {
      success: true,
      token,
      user: { id: userId, username: username.trim(), role: 'admin' }
    };
  });

  // Login
  fastify.post<{ Body: { username?: string; password?: string } }>('/login', async (req, reply) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return reply.status(400).send({ error: 'Введите имя пользователя и пароль.' });
    }

    const user = dbQueries.getUserByUsername(username.trim());
    if (!user || !verifyPassword(password, user.password_hash)) {
      return reply.status(401).send({ error: 'Неверный логин или пароль.' });
    }

    const token = generateToken();
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    dbQueries.createSession(token, user.id, expiresAt);

    return {
      success: true,
      token,
      user: { id: user.id, username: user.username, role: user.role || 'admin' }
    };
  });

  // Logout
  fastify.post('/logout', async (req) => {
    const token = extractToken(req);
    if (token) {
      dbQueries.deleteSession(token);
    }
    return { success: true };
  });

  // --- User Management (Admin only) ---
  // List all users
  fastify.get('/users', { preHandler: requireAdmin }, async () => {
    const users = dbQueries.getAllUsers();
    return { users };
  });

  // Create new user (Admin or Viewer)
  fastify.post<{ Body: { username?: string; password?: string; role?: string } }>(
    '/users',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { username, password, role } = req.body || {};

      if (!username || username.trim().length < 3) {
        return reply.status(400).send({ error: 'Логин должен содержать не менее 3 символов.' });
      }
      if (!password || password.length < 6) {
        return reply.status(400).send({ error: 'Пароль должен быть не менее 6 символов.' });
      }

      const assignedRole = role === 'admin' ? 'admin' : 'viewer';
      const cleanUsername = username.trim();

      const existing = dbQueries.getUserByUsername(cleanUsername);
      if (existing) {
        return reply.status(400).send({ error: `Пользователь с логином "${cleanUsername}" уже существует.` });
      }

      const userId = randomUUID();
      const passwordHash = hashPassword(password);
      dbQueries.createUser(userId, cleanUsername, passwordHash, assignedRole);

      const newUser = dbQueries.getUserById(userId);
      return reply.status(201).send({ success: true, user: newUser });
    }
  );

  // Delete user
  fastify.delete<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const currentUserId = (req as any).user?.id;
      const targetId = req.params.id;

      if (targetId === currentUserId) {
        return reply.status(400).send({ error: 'Нельзя удалить собственную учетную запись.' });
      }

      const targetUser = dbQueries.getUserById(targetId);
      if (!targetUser) {
        return reply.status(404).send({ error: 'Пользователь не найден.' });
      }

      if (targetUser.role === 'admin' && dbQueries.getAdminCount() <= 1) {
        return reply.status(400).send({ error: 'Нельзя удалить единственного администратора системы.' });
      }

      dbQueries.deleteUser(targetId);
      return { success: true };
    }
  );
}

export function extractToken(req: FastifyRequest): string | null {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  return null;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  const token = extractToken(req);
  if (!token) {
    return reply.status(401).send({ error: 'Требуется авторизация.' });
  }

  const session = dbQueries.getSession(token);
  if (!session) {
    return reply.status(401).send({ error: 'Сессия истекла или недействительна. Пожалуйста, выполните вход.' });
  }

  (req as any).user = { id: session.user_id, username: session.username, role: session.role || 'admin' };
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  await requireAuth(req, reply);
  if (reply.sent) return;

  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    return reply.status(403).send({ error: 'Доступ запрещен. Требуются права администратора.' });
  }
}
