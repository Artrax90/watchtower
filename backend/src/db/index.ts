import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const dbDir = process.env.DATA_DIR || path.resolve(process.cwd(), '../data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = process.env.DB_PATH || path.join(dbDir, 'watchtower.db');
export const db = new DatabaseSync(dbPath);

// Enable WAL mode for high performance concurrency
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA synchronous = NORMAL;`);
db.exec(`PRAGMA foreign_keys = ON;`);

export function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin', -- 'admin', 'viewer'
      created_at INTEGER NOT NULL
    );
  `);

  // Migration for existing tables
  try {
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin';`);
  } catch {}
  try {
    db.exec(`UPDATE users SET role = 'admin' WHERE role IS NULL OR role = '';`);
  } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS monitors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'http', -- 'http', 'port', 'ping', 'dns'
      target TEXT NOT NULL,
      port INTEGER,
      interval INTEGER NOT NULL DEFAULT 60,
      timeout INTEGER NOT NULL DEFAULT 10000,
      retry_count INTEGER NOT NULL DEFAULT 2,
      keyword TEXT,
      check_ssl INTEGER NOT NULL DEFAULT 1,
      ssl_alert_days INTEGER NOT NULL DEFAULT 14,
      status TEXT NOT NULL DEFAULT 'pending', -- 'online', 'down', 'degraded', 'pending', 'paused'
      current_latency INTEGER DEFAULT 0,
      last_checked_at INTEGER DEFAULT 0,
      last_status_change INTEGER DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      ssl_days_remaining INTEGER,
      ssl_issuer TEXT,
      ssl_expiry_date TEXT,
      is_paused INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id TEXT NOT NULL,
      status TEXT NOT NULL, -- 'online', 'down', 'degraded'
      latency INTEGER NOT NULL,
      status_code INTEGER,
      error TEXT,
      ssl_days_remaining INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_heartbeats_monitor_created ON heartbeats(monitor_id, created_at);

    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      status TEXT NOT NULL, -- 'critical', 'warning', 'resolved'
      cause TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      resolved_at INTEGER,
      duration_seconds INTEGER,
      FOREIGN KEY(monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_incidents_monitor ON incidents(monitor_id);

    CREATE TABLE IF NOT EXISTS notification_channels (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL, -- 'telegram', 'max', 'webhook'
      name TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Migrations for HTTP advanced check & auth verification
  try {
    db.exec(`ALTER TABLE monitors ADD COLUMN http_method TEXT DEFAULT 'GET';`);
  } catch {}
  try {
    db.exec(`ALTER TABLE monitors ADD COLUMN http_headers TEXT;`);
  } catch {}
  try {
    db.exec(`ALTER TABLE monitors ADD COLUMN http_body TEXT;`);
  } catch {}
  try {
    db.exec(`ALTER TABLE monitors ADD COLUMN expected_status TEXT;`);
  } catch {}
  try {
    db.exec(`ALTER TABLE monitors ADD COLUMN follow_redirects INTEGER DEFAULT 1;`);
  } catch {}
}

export interface MonitorRow {
  id: string;
  name: string;
  type: string;
  target: string;
  port: number | null;
  interval: number;
  timeout: number;
  retry_count: number;
  keyword: string | null;
  check_ssl: number;
  ssl_alert_days: number;
  status: string;
  current_latency: number;
  last_checked_at: number;
  last_status_change: number;
  consecutive_failures: number;
  ssl_days_remaining: number | null;
  ssl_issuer: string | null;
  ssl_expiry_date: string | null;
  is_paused: number;
  http_method?: string | null;
  http_headers?: string | null;
  http_body?: string | null;
  expected_status?: string | null;
  follow_redirects?: number | null;
  created_at: number;
}

export interface HeartbeatRow {
  id: number;
  monitor_id: string;
  status: string;
  latency: number;
  status_code: number | null;
  error: string | null;
  ssl_days_remaining: number | null;
  created_at: number;
}

export interface IncidentRow {
  id: string;
  monitor_id: string;
  status: string;
  cause: string;
  started_at: number;
  resolved_at: number | null;
  duration_seconds: number | null;
}

export interface NotificationChannelRow {
  id: string;
  type: string;
  name: string;
  is_enabled: number;
  config: string;
  created_at: number;
}

// Data access queries
export const dbQueries = {
  // Users & Auth
  getUserCount: () => {
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    return row ? Number(row.count) : 0;
  },
  createUser: (id: string, username: string, passwordHash: string, role = 'admin') => {
    db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      username,
      passwordHash,
      role,
      Date.now()
    );
  },
  getUserByUsername: (username: string) => {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | { id: string; username: string; password_hash: string; role: string; created_at: number }
      | undefined;
  },
  getUserById: (id: string) => {
    return db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id) as
      | { id: string; username: string; role: string; created_at: number }
      | undefined;
  },
  getAllUsers: () => {
    return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC').all() as unknown as {
      id: string;
      username: string;
      role: string;
      created_at: number;
    }[];
  },
  deleteUser: (id: string) => {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  },
  getAdminCount: () => {
    const row = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get() as { count: number };
    return row ? Number(row.count) : 0;
  },
  createSession: (token: string, userId: string, expiresAt: number) => {
    db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
      token,
      userId,
      expiresAt,
      Date.now()
    );
  },
  getSession: (token: string) => {
    return db
      .prepare('SELECT s.*, u.username, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.expires_at > ?')
      .get(token, Date.now()) as { token: string; user_id: string; expires_at: number; username: string; role: string } | undefined;
  },
  deleteSession: (token: string) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  },
  cleanExpiredSessions: () => {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  },

  // Monitors
  getAllMonitors: (): MonitorRow[] => {
    return db.prepare('SELECT * FROM monitors ORDER BY created_at DESC').all() as unknown as MonitorRow[];
  },
  getActiveMonitors: (): MonitorRow[] => {
    return db.prepare('SELECT * FROM monitors WHERE is_paused = 0').all() as unknown as MonitorRow[];
  },
  getMonitorById: (id: string): MonitorRow | undefined => {
    return db.prepare('SELECT * FROM monitors WHERE id = ?').get(id) as unknown as MonitorRow | undefined;
  },
  createMonitor: (m: Partial<MonitorRow> & { id: string; name: string; target: string }) => {
    db.prepare(`
      INSERT INTO monitors (
        id, name, type, target, port, interval, timeout, retry_count,
        keyword, check_ssl, ssl_alert_days, status, current_latency,
        last_checked_at, last_status_change, consecutive_failures,
        ssl_days_remaining, ssl_issuer, ssl_expiry_date, is_paused,
        http_method, http_headers, http_body, expected_status, follow_redirects,
        created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?
      )
    `).run(
      m.id,
      m.name,
      m.type || 'http',
      m.target,
      m.port ?? null,
      m.interval || 60,
      m.timeout || 10000,
      m.retry_count ?? 2,
      m.keyword ?? null,
      m.check_ssl ?? 1,
      m.ssl_alert_days || 14,
      m.status || 'pending',
      m.current_latency || 0,
      m.last_checked_at || 0,
      m.last_status_change || Date.now(),
      m.consecutive_failures || 0,
      m.ssl_days_remaining ?? null,
      m.ssl_issuer ?? null,
      m.ssl_expiry_date ?? null,
      m.is_paused ?? 0,
      m.http_method || 'GET',
      m.http_headers ?? null,
      m.http_body ?? null,
      m.expected_status ?? null,
      m.follow_redirects ?? 1,
      m.created_at || Date.now()
    );
  },
  updateMonitor: (id: string, m: Partial<MonitorRow>) => {
    const existing = dbQueries.getMonitorById(id);
    if (!existing) return;

    db.prepare(`
      UPDATE monitors SET
        name = ?,
        type = ?,
        target = ?,
        port = ?,
        interval = ?,
        timeout = ?,
        retry_count = ?,
        keyword = ?,
        check_ssl = ?,
        ssl_alert_days = ?,
        is_paused = ?,
        http_method = ?,
        http_headers = ?,
        http_body = ?,
        expected_status = ?,
        follow_redirects = ?
      WHERE id = ?
    `).run(
      (m.name ?? existing.name),
      (m.type ?? existing.type),
      (m.target ?? existing.target),
      (m.port !== undefined ? m.port : existing.port) ?? null,
      (m.interval ?? existing.interval),
      (m.timeout ?? existing.timeout),
      (m.retry_count ?? existing.retry_count),
      (m.keyword !== undefined ? m.keyword : existing.keyword) ?? null,
      (m.check_ssl ?? existing.check_ssl),
      (m.ssl_alert_days ?? existing.ssl_alert_days),
      (m.is_paused ?? existing.is_paused),
      (m.http_method !== undefined ? m.http_method : existing.http_method) ?? 'GET',
      (m.http_headers !== undefined ? m.http_headers : existing.http_headers) ?? null,
      (m.http_body !== undefined ? m.http_body : existing.http_body) ?? null,
      (m.expected_status !== undefined ? m.expected_status : existing.expected_status) ?? null,
      (m.follow_redirects !== undefined ? m.follow_redirects : existing.follow_redirects) ?? 1,
      id
    );
  },
  deleteMonitor: (id: string) => {
    db.prepare('DELETE FROM monitors WHERE id = ?').run(id);
  },
  updateMonitorCheckState: (
    id: string,
    state: {
      status: string;
      current_latency: number;
      last_checked_at: number;
      last_status_change?: number;
      consecutive_failures: number;
      ssl_days_remaining?: number | null;
      ssl_issuer?: string | null;
      ssl_expiry_date?: string | null;
    }
  ) => {
    db.prepare(`
      UPDATE monitors SET
        status = ?,
        current_latency = ?,
        last_checked_at = ?,
        last_status_change = COALESCE(?, last_status_change),
        consecutive_failures = ?,
        ssl_days_remaining = ?,
        ssl_issuer = ?,
        ssl_expiry_date = ?
      WHERE id = ?
    `).run(
      state.status,
      state.current_latency,
      state.last_checked_at,
      state.last_status_change ?? null,
      state.consecutive_failures,
      state.ssl_days_remaining ?? null,
      state.ssl_issuer ?? null,
      state.ssl_expiry_date ?? null,
      id
    );
  },

  // Heartbeats
  recordHeartbeat: (h: {
    monitor_id: string;
    status: string;
    latency: number;
    status_code?: number | null;
    error?: string | null;
    ssl_days_remaining?: number | null;
  }) => {
    db.prepare(`
      INSERT INTO heartbeats (monitor_id, status, latency, status_code, error, ssl_days_remaining, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      h.monitor_id,
      h.status,
      h.latency,
      h.status_code ?? null,
      h.error ?? null,
      h.ssl_days_remaining ?? null,
      Date.now()
    );

    // Keep only last 1000 heartbeats per monitor
    db.prepare(`
      DELETE FROM heartbeats
      WHERE monitor_id = ?
        AND id NOT IN (
          SELECT id FROM heartbeats
          WHERE monitor_id = ?
          ORDER BY created_at DESC
          LIMIT 1000
        )
    `).run(h.monitor_id, h.monitor_id);
  },
  getRecentHeartbeats: (monitorId: string, limit = 24): HeartbeatRow[] => {
    return (
      db
        .prepare('SELECT * FROM heartbeats WHERE monitor_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(monitorId, limit) as unknown as HeartbeatRow[]
    ).reverse();
  },
  getMonitorUptime24h: (monitorId: string): number => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const row = db
      .prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status != 'down' THEN 1 ELSE 0 END) as up_count
        FROM heartbeats
        WHERE monitor_id = ? AND created_at >= ?
      `)
      .get(monitorId, since) as { total: number; up_count: number } | undefined;

    if (!row || !row.total || row.total === 0) return 100;
    return Number(((row.up_count / row.total) * 100).toFixed(2));
  },
  getMonitorLatencyHistory: (monitorId?: string, pointsCount = 12) => {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const points: { label: string; latency: number }[] = [];
    const filterSql = monitorId ? 'AND monitor_id = ?' : '';

    for (let i = pointsCount - 1; i >= 0; i--) {
      const bucketStart = now - (i + 1) * oneHour;
      const bucketEnd = now - i * oneHour;
      const date = new Date(bucketEnd);
      const label = `${String(date.getHours()).padStart(2, '0')}:00`;

      const stmt = db.prepare(`
        SELECT AVG(latency) as avg_latency
        FROM heartbeats
        WHERE created_at >= ? AND created_at < ? AND status != 'down' ${filterSql}
      `);
      const row = (monitorId ? stmt.get(bucketStart, bucketEnd, monitorId) : stmt.get(bucketStart, bucketEnd)) as
        | { avg_latency: number | null }
        | undefined;

      const latency = row?.avg_latency ? Math.round(row.avg_latency) : 0;
      points.push({ label, latency });
    }

    const summaryStmt = db.prepare(`
      SELECT
        AVG(latency) as avg_latency,
        MIN(latency) as min_latency,
        MAX(latency) as max_latency,
        COUNT(*) as total_checks,
        SUM(CASE WHEN status != 'down' THEN 1 ELSE 0 END) as up_checks
      FROM heartbeats
      WHERE created_at >= ? ${filterSql}
    `);
    const summaryRow = (monitorId
      ? summaryStmt.get(now - pointsCount * oneHour, monitorId)
      : summaryStmt.get(now - pointsCount * oneHour)) as
      | {
          avg_latency: number | null;
          min_latency: number | null;
          max_latency: number | null;
          total_checks: number;
          up_checks: number;
        }
      | undefined;

    const total = summaryRow?.total_checks || 0;
    const up = summaryRow?.up_checks || 0;
    const uptime = total > 0 ? Number(((up / total) * 100).toFixed(1)) : 100.0;

    return {
      points,
      avgLatency: summaryRow?.avg_latency ? Math.round(summaryRow.avg_latency) : 0,
      minLatency: summaryRow?.min_latency ? Math.round(summaryRow.min_latency) : 0,
      maxLatency: summaryRow?.max_latency ? Math.round(summaryRow.max_latency) : 0,
      uptime,
      uptime24h: uptime,
      totalChecks: total,
      upChecks: up
    };
  },

  // Incidents
  createIncident: (inc: { id: string; monitor_id: string; status: string; cause: string; started_at: number }) => {
    db.prepare(`
      INSERT INTO incidents (id, monitor_id, status, cause, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(inc.id, inc.monitor_id, inc.status, inc.cause, inc.started_at);
  },
  resolveOpenIncident: (monitorId: string) => {
    const openInc = db
      .prepare('SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1')
      .get(monitorId) as IncidentRow | undefined;
    if (openInc) {
      const now = Date.now();
      const durationSeconds = Math.round((now - openInc.started_at) / 1000);
      db.prepare(`
        UPDATE incidents
        SET resolved_at = ?, duration_seconds = ?, status = 'resolved'
        WHERE id = ?
      `).run(now, durationSeconds, openInc.id);
    }
  },
  getActiveIncidents: (monitorId?: string): (IncidentRow & { monitor_name: string })[] => {
    if (monitorId) {
      return db
        .prepare(`
          SELECT i.*, m.name as monitor_name
          FROM incidents i
          JOIN monitors m ON i.monitor_id = m.id
          WHERE i.resolved_at IS NULL AND i.monitor_id = ?
          ORDER BY i.started_at DESC
        `)
        .all(monitorId) as unknown as (IncidentRow & { monitor_name: string })[];
    }
    return db
      .prepare(`
        SELECT i.*, m.name as monitor_name
        FROM incidents i
        JOIN monitors m ON i.monitor_id = m.id
        WHERE i.resolved_at IS NULL
        ORDER BY i.started_at DESC
      `)
      .all() as unknown as (IncidentRow & { monitor_name: string })[];
  },
  getRecentIncidents: (limit = 50, monitorId?: string): (IncidentRow & { monitor_name: string })[] => {
    if (monitorId) {
      return db
        .prepare(`
          SELECT i.*, m.name as monitor_name
          FROM incidents i
          JOIN monitors m ON i.monitor_id = m.id
          WHERE i.resolved_at IS NOT NULL AND i.monitor_id = ?
          ORDER BY i.started_at DESC
          LIMIT ?
        `)
        .all(monitorId, limit) as unknown as (IncidentRow & { monitor_name: string })[];
    }
    return db
      .prepare(`
        SELECT i.*, m.name as monitor_name
        FROM incidents i
        JOIN monitors m ON i.monitor_id = m.id
        WHERE i.resolved_at IS NOT NULL
        ORDER BY i.started_at DESC
        LIMIT ?
      `)
      .all(limit) as unknown as (IncidentRow & { monitor_name: string })[];
  },
  getRecentIssuesHeartbeats: (sinceTimestamp: number, limit = 50, monitorId?: string): (HeartbeatRow & { monitor_name: string })[] => {
    if (monitorId) {
      return db
        .prepare(`
          SELECT h.*, m.name as monitor_name
          FROM heartbeats h
          JOIN monitors m ON h.monitor_id = m.id
          WHERE h.status != 'online' AND h.created_at >= ? AND h.monitor_id = ?
          ORDER BY h.created_at DESC
          LIMIT ?
        `)
        .all(sinceTimestamp, monitorId, limit) as unknown as (HeartbeatRow & { monitor_name: string })[];
    }
    return db
      .prepare(`
        SELECT h.*, m.name as monitor_name
        FROM heartbeats h
        JOIN monitors m ON h.monitor_id = m.id
        WHERE h.status != 'online' AND h.created_at >= ?
        ORDER BY h.created_at DESC
        LIMIT ?
      `)
      .all(sinceTimestamp, limit) as unknown as (HeartbeatRow & { monitor_name: string })[];
  },

  // Notification channels
  getNotificationChannels: (): NotificationChannelRow[] => {
    return db.prepare('SELECT * FROM notification_channels ORDER BY created_at ASC').all() as unknown as NotificationChannelRow[];
  },
  getEnabledChannelsByType: (type: string): NotificationChannelRow[] => {
    return db.prepare('SELECT * FROM notification_channels WHERE type = ? AND is_enabled = 1').all(type) as unknown as NotificationChannelRow[];
  },
  saveNotificationChannel: (ch: { id: string; type: string; name: string; is_enabled: number; config: string }) => {
    db.prepare(`
      INSERT INTO notification_channels (id, type, name, is_enabled, config, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        name = excluded.name,
        is_enabled = excluded.is_enabled,
        config = excluded.config
    `).run(ch.id, ch.type, ch.name, ch.is_enabled, ch.config, Date.now());
  },
  deleteNotificationChannel: (id: string) => {
    db.prepare('DELETE FROM notification_channels WHERE id = ?').run(id);
  }
};
