import dns from 'node:dns/promises';
import { CheckResult, MonitorCheckTarget } from './types.js';

export async function checkDNS(target: MonitorCheckTarget): Promise<CheckResult> {
  const startTime = performance.now();
  let host = target.target.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];

  try {
    const res = await dns.lookup(host);
    const latency = Math.round(performance.now() - startTime);

    if (!res || !res.address) {
      return {
        status: 'down',
        latency,
        error: `DNS resolution returned empty address for ${host}`
      };
    }

    return {
      status: latency > 1000 ? 'degraded' : 'online',
      latency,
      ip: res.address
    };
  } catch (err: any) {
    const latency = Math.round(performance.now() - startTime);
    return {
      status: 'down',
      latency,
      error: `DNS lookup failed for ${host}: ${err.message || 'NXDOMAIN'}`
    };
  }
}
