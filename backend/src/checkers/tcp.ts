import net from 'node:net';
import { CheckResult, MonitorCheckTarget } from './types.js';

export function checkTCP(target: MonitorCheckTarget): Promise<CheckResult> {
  return new Promise((resolve) => {
    const startTime = performance.now();
    let host = target.target.replace(/^https?:\/\//i, '').split('/')[0];
    let port = target.port || 80;

    if (host.includes(':')) {
      const parts = host.split(':');
      host = parts[0];
      port = parseInt(parts[1], 10) || port;
    }

    const socket = net.createConnection(
      {
        host,
        port,
        timeout: target.timeout
      },
      () => {
        const latency = Math.round(performance.now() - startTime);
        socket.destroy();
        resolve({
          status: latency > 2000 ? 'degraded' : 'online',
          latency
        });
      }
    );

    socket.on('timeout', () => {
      socket.destroy();
      const latency = Math.round(performance.now() - startTime);
      resolve({
        status: 'down',
        latency,
        error: `TCP connection timed out to ${host}:${port} (${target.timeout}ms)`
      });
    });

    socket.on('error', (err: any) => {
      socket.destroy();
      const latency = Math.round(performance.now() - startTime);
      resolve({
        status: 'down',
        latency,
        error: err.message || `Failed to connect to ${host}:${port}`
      });
    });
  });
}
