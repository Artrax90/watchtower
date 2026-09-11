import { CheckResult, MonitorCheckTarget } from './types.js';
import { checkHTTP } from './http.js';
import { checkTCP } from './tcp.js';
import { checkPing } from './ping.js';
import { checkDNS } from './dns.js';
import { checkSSL } from './ssl.js';

export async function runCheck(target: MonitorCheckTarget): Promise<CheckResult> {
  const typeStr = (target.type || 'http').toLowerCase();
  const types = typeStr.includes(',') ? typeStr.split(',').map((s) => s.trim()) : [typeStr];

  // If single check, run directly
  if (types.length === 1) {
    const single = types[0];
    if (single === 'port' || single === 'tcp') return checkTCP(target);
    if (single === 'ping') return checkPing(target);
    if (single === 'dns') return checkDNS(target);
    if (single === 'ssl') {
      let host = target.target.replace(/^https?:\/\//i, '').split('/')[0];
      const port = target.port || 443;
      const ssl = await checkSSL(host, port, target.timeout);
      return {
        status: ssl.valid ? (ssl.daysRemaining <= (target.ssl_alert_days || 14) ? 'degraded' : 'online') : 'down',
        latency: 0,
        ssl
      };
    }
    return checkHTTP(target);
  }

  // Multiple checks selected: run in parallel and aggregate
  const promises: Promise<{ type: string; res: CheckResult }>[] = [];

  for (const t of types) {
    if (t === 'http' || t === 'https') {
      promises.push(checkHTTP(target).then((res) => ({ type: 'HTTP', res })));
    } else if (t === 'port' || t === 'tcp') {
      promises.push(checkTCP(target).then((res) => ({ type: 'TCP', res })));
    } else if (t === 'ping') {
      promises.push(checkPing(target).then((res) => ({ type: 'Ping', res })));
    } else if (t === 'dns') {
      promises.push(checkDNS(target).then((res) => ({ type: 'DNS', res })));
    } else if (t === 'ssl' && !types.includes('http') && !types.includes('https')) {
      let host = target.target.replace(/^https?:\/\//i, '').split('/')[0];
      const port = target.port || 443;
      promises.push(
        checkSSL(host, port, target.timeout).then((ssl) => ({
          type: 'SSL',
          res: {
            status: ssl.valid ? (ssl.daysRemaining <= (target.ssl_alert_days || 14) ? 'degraded' : 'online') : 'down',
            latency: 0,
            ssl
          }
        }))
      );
    }
  }

  const results = await Promise.all(promises);

  let overallStatus: 'online' | 'down' | 'degraded' = 'online';
  let totalLatency = 0;
  let latencyCount = 0;
  const errors: string[] = [];
  let sslData = undefined;
  let statusCode = undefined;

  for (const item of results) {
    const r = item.res;
    if (r.latency !== undefined && r.latency > 0) {
      totalLatency += r.latency;
      latencyCount++;
    }
    if (r.ssl) {
      sslData = r.ssl;
    }
    if (r.statusCode !== undefined) {
      statusCode = r.statusCode;
    }

    if (r.status === 'down') {
      overallStatus = 'down';
      errors.push(`${item.type}: ${r.error || 'Failed'}`);
    } else if (r.status === 'degraded' && overallStatus !== 'down') {
      overallStatus = 'degraded';
      if (r.error) errors.push(`${item.type}: ${r.error}`);
    }
  }

  return {
    status: overallStatus,
    latency: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0,
    statusCode,
    error: errors.length > 0 ? errors.join('; ') : undefined,
    ssl: sslData
  };
}

export * from './types.js';
export * from './ssl.js';
export * from './http.js';
export * from './tcp.js';
export * from './ping.js';
export * from './dns.js';
