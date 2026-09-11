import { CheckResult, MonitorCheckTarget } from './types.js';
import { checkSSL } from './ssl.js';

export async function checkHTTP(target: MonitorCheckTarget): Promise<CheckResult> {
  const startTime = performance.now();
  let url = target.target.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }

  let sslResult = undefined;
  if (url.startsWith('https://') && target.check_ssl !== 0) {
    try {
      const parsed = new URL(url);
      const port = parsed.port ? parseInt(parsed.port, 10) : 443;
      sslResult = await checkSSL(parsed.hostname, port, Math.min(target.timeout, 5000));
    } catch {
      // Ignored if URL parsing fails
    }
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), target.timeout);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Watchtower-Monitor/1.0 (+https://github.com/watchtower)',
        'Accept': '*/*'
      },
      redirect: 'follow'
    });

    clearTimeout(timeoutId);
    const latency = Math.round(performance.now() - startTime);
    const statusCode = response.status;

    let bodyText = '';
    if (target.keyword) {
      try {
        bodyText = await response.text();
      } catch {
        bodyText = '';
      }
    }

    // Keyword verification
    if (target.keyword && !bodyText.includes(target.keyword)) {
      return {
        status: 'degraded',
        latency,
        statusCode,
        error: `Keyword "${target.keyword}" not found in response`,
        ssl: sslResult
      };
    }

    if (statusCode >= 200 && statusCode < 400) {
      // Check if SSL is expired or expiring critically
      if (sslResult && !sslResult.valid) {
        return {
          status: 'degraded',
          latency,
          statusCode,
          error: `SSL Certificate expired or invalid: ${sslResult.error || 'Expired'}`,
          ssl: sslResult
        };
      }

      const isDegraded = latency > 2000;
      return {
        status: isDegraded ? 'degraded' : 'online',
        latency,
        statusCode,
        error: isDegraded ? `Высокая задержка отклика HTTP: ${latency} мс (порог деградации > 2000 мс)` : undefined,
        ssl: sslResult
      };
    } else {
      return {
        status: 'down',
        latency,
        statusCode,
        error: `HTTP status ${statusCode} (${response.statusText})`,
        ssl: sslResult
      };
    }
  } catch (err: any) {
    const latency = Math.round(performance.now() - startTime);
    let errorMessage = err.message || 'Connection failed';
    if (err.name === 'AbortError' || err.message?.includes('aborted')) {
      errorMessage = `Request timed out after ${target.timeout}ms`;
    }

    return {
      status: 'down',
      latency,
      statusCode: null,
      error: errorMessage,
      ssl: sslResult
    };
  }
}
