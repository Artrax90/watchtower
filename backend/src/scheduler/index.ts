import { dbQueries, MonitorRow } from '../db/index.js';
import { runCheck, CheckResult } from '../checkers/index.js';
import { broadcastAlert } from '../notifiers/index.js';
import { randomUUID } from 'node:crypto';

let isRunning = false;
let schedulerTimer: NodeJS.Timeout | null = null;
const runningChecks = new Set<string>();
// Cache of last SSL warning timestamps to prevent spam (once per 24h)
const sslAlertTimestamps = new Map<string, number>();

export function startScheduler() {
  if (isRunning) return;
  isRunning = true;
  console.log('⚡ Watchtower Monitoring Scheduler started');

  // Main tick every 1000ms
  schedulerTimer = setInterval(async () => {
    try {
      await checkDueMonitors();
    } catch (err) {
      console.error('Scheduler tick error:', err);
    }
  }, 1000);
}

export function stopScheduler() {
  isRunning = false;
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  console.log('🛑 Watchtower Monitoring Scheduler stopped');
}

async function checkDueMonitors() {
  const monitors = dbQueries.getActiveMonitors();
  const now = Date.now();

  for (const monitor of monitors) {
    if (runningChecks.has(monitor.id)) continue;

    const intervalMs = Math.max(10, monitor.interval) * 1000;
    const isDue = now - monitor.last_checked_at >= intervalMs;

    if (isDue || monitor.last_checked_at === 0) {
      executeMonitorCheck(monitor);
    }
  }
}

export async function executeMonitorCheck(monitor: MonitorRow): Promise<CheckResult> {
  if (runningChecks.has(monitor.id)) {
    // If already running, return mock
    return { status: 'online', latency: 0 };
  }

  runningChecks.add(monitor.id);
  const now = Date.now();

  try {
    const result = await runCheck({
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
      target: monitor.target,
      port: monitor.port,
      timeout: monitor.timeout,
      keyword: monitor.keyword,
      check_ssl: monitor.check_ssl,
      ssl_alert_days: monitor.ssl_alert_days
    });

    // Record heartbeat
    dbQueries.recordHeartbeat({
      monitor_id: monitor.id,
      status: result.status,
      latency: result.latency,
      status_code: result.statusCode,
      error: result.error,
      ssl_days_remaining: result.ssl?.daysRemaining ?? null
    });

    let newStatus = monitor.status;
    let consecutiveFailures = monitor.consecutive_failures;
    const retryThreshold = Math.max(1, monitor.retry_count);

    if (result.status === 'down') {
      consecutiveFailures += 1;
      if (consecutiveFailures >= retryThreshold && monitor.status !== 'down') {
        newStatus = 'down';
        const incidentId = randomUUID();
        dbQueries.createIncident({
          id: incidentId,
          monitor_id: monitor.id,
          status: 'critical',
          cause: result.error || 'Connection failed',
          started_at: now
        });

        // Broadcast DOWN alert
        await broadcastAlert({
          monitorName: monitor.name,
          monitorTarget: monitor.target,
          type: 'DOWN',
          error: result.error || 'Service unreachable'
        });
      }
    } else if (result.status === 'degraded') {
      consecutiveFailures = 0;
      if (monitor.status === 'down') {
        // Recovered from down to degraded
        resolveIncidentAndNotify(monitor, now, result.latency);
      }
      newStatus = 'degraded';
    } else {
      // Result is 'online'
      consecutiveFailures = 0;
      if (monitor.status === 'down') {
        // Recovered!
        resolveIncidentAndNotify(monitor, now, result.latency);
      }
      newStatus = 'online';
    }

    // SSL Alerting check
    if (result.ssl && result.ssl.daysRemaining !== undefined) {
      const lastAlertTime = sslAlertTimestamps.get(monitor.id) || 0;
      const twentyFourHours = 24 * 60 * 60 * 1000;

      if (now - lastAlertTime > twentyFourHours) {
        if (result.ssl.daysRemaining <= 0) {
          sslAlertTimestamps.set(monitor.id, now);
          await broadcastAlert({
            monitorName: monitor.name,
            monitorTarget: monitor.target,
            type: 'SSL_EXPIRED',
            error: result.ssl.error || 'Certificate validity expired'
          });
        } else if (result.ssl.daysRemaining <= monitor.ssl_alert_days) {
          sslAlertTimestamps.set(monitor.id, now);
          await broadcastAlert({
            monitorName: monitor.name,
            monitorTarget: monitor.target,
            type: 'SSL_EXPIRING',
            sslDaysRemaining: result.ssl.daysRemaining,
            sslExpiryDate: result.ssl.expiryDate
          });
        }
      }
    }

    // Persist check state
    dbQueries.updateMonitorCheckState(monitor.id, {
      status: newStatus,
      current_latency: result.latency,
      last_checked_at: now,
      last_status_change: newStatus !== monitor.status ? now : undefined,
      consecutive_failures: consecutiveFailures,
      ssl_days_remaining: result.ssl?.daysRemaining ?? monitor.ssl_days_remaining,
      ssl_issuer: result.ssl?.issuer ?? monitor.ssl_issuer,
      ssl_expiry_date: result.ssl?.expiryDate ?? monitor.ssl_expiry_date
    });

    return result;
  } catch (err: any) {
    console.error(`Check execution failed for monitor ${monitor.name}:`, err);
    return { status: 'down', latency: 0, error: err.message };
  } finally {
    runningChecks.delete(monitor.id);
  }
}

function resolveIncidentAndNotify(monitor: MonitorRow, now: number, latency?: number) {
  const downDurationMs = now - (monitor.last_status_change || now);
  const minutes = Math.floor(downDurationMs / (1000 * 60));
  const seconds = Math.floor((downDurationMs % (1000 * 60)) / 1000);
  const downtimeFormatted = minutes > 0 ? `${minutes} мин ${seconds} сек` : `${seconds} сек`;

  dbQueries.resolveOpenIncident(monitor.id);

  broadcastAlert({
    monitorName: monitor.name,
    monitorTarget: monitor.target,
    type: 'UP',
    latency,
    downtimeDuration: downtimeFormatted
  });
}
