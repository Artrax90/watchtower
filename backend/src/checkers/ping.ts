import { exec } from 'node:child_process';
import dns from 'node:dns/promises';
import { CheckResult, MonitorCheckTarget } from './types.js';

export function checkPing(target: MonitorCheckTarget): Promise<CheckResult> {
  return new Promise((resolve) => {
    const startTime = performance.now();
    let host = target.target.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
    const isWin = process.platform === 'win32';
    const timeoutSec = Math.max(1, Math.round(target.timeout / 1000));
    const timeoutMs = target.timeout;

    // Windows: ping -n 1 -w <timeout_ms> <host>
    // Linux: ping -c 1 -W <timeout_sec> <host>
    const cmd = isWin ? `ping -n 1 -w ${timeoutMs} ${host}` : `ping -c 1 -W ${timeoutSec} ${host}`;

    exec(cmd, { timeout: target.timeout + 1000 }, async (error, stdout, stderr) => {
      const elapsed = Math.round(performance.now() - startTime);

      // Parse IP from stdout
      // Windows: "Pinging github.com [140.82.121.4] ..." or "Reply from 140.82.121.4: ..."
      // Linux: "PING github.com (140.82.121.4) ..." or "64 bytes from 140.82.121.4: ..."
      let resolvedIp: string | undefined = undefined;
      const ipMatch =
        stdout.match(/(?:\[|\()([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})(?:\]|\))/) ||
        stdout.match(/(?:from|Ответ от)\s+([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/i);

      if (ipMatch && ipMatch[1]) {
        resolvedIp = ipMatch[1];
      } else if (/^([0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host)) {
        resolvedIp = host;
      } else {
        // Fallback: resolve IP via dns
        try {
          const lookup = await dns.lookup(host);
          if (lookup?.address) resolvedIp = lookup.address;
        } catch {}
      }

      if (error) {
        return resolve({
          status: 'down',
          latency: elapsed,
          ip: resolvedIp,
          error: error.message || 'Ping destination host unreachable'
        });
      }

      // Try to parse ping time from stdout
      // Windows: "time=25ms" or "time<1ms" or "время=25мс"
      // Linux: "time=25.4 ms"
      let parsedLatency = elapsed;
      const match = stdout.match(/(?:time|время)[=<]([0-9.]+)\s*(?:ms|мс)/i);
      if (match && match[1]) {
        parsedLatency = Math.round(parseFloat(match[1]));
      }

      const isDegraded = parsedLatency > 1500;
      resolve({
        status: isDegraded ? 'degraded' : 'online',
        latency: parsedLatency,
        ip: resolvedIp,
        error: isDegraded ? `Высокая задержка ping: ${parsedLatency} мс (порог деградации > 1500 мс)` : undefined
      });
    });
  });
}
