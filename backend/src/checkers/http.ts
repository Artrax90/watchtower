import { CheckResult, MonitorCheckTarget, ChainStep } from './types.js';
import { checkSSL } from './ssl.js';

export function isExpectedStatus(actualCode: number, expectedExpr?: string | null): boolean {
  if (!expectedExpr || !expectedExpr.trim()) {
    // Default behavior: 200..399 is considered healthy
    return actualCode >= 200 && actualCode < 400;
  }
  const tokens = expectedExpr.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  for (const token of tokens) {
    if (token.includes('-')) {
      const [startStr, endStr] = token.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (!isNaN(start) && !isNaN(end) && actualCode >= start && actualCode <= end) {
        return true;
      }
    } else if (token.endsWith('xx')) {
      const prefix = parseInt(token[0], 10);
      if (!isNaN(prefix) && Math.floor(actualCode / 100) === prefix) {
        return true;
      }
    } else {
      const code = parseInt(token, 10);
      if (actualCode === code) return true;
    }
  }
  return false;
}

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
      sslResult = await checkSSL(parsed.hostname, port, target.timeout);
    } catch {
      // Ignored if URL parsing fails
    }
  }

  const method = (target.http_method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    'User-Agent': 'Watchtower-Monitor/1.0 (+https://github.com/watchtower)',
    'Accept': '*/*'
  };

  if (target.http_headers) {
    try {
      const parsed = JSON.parse(target.http_headers);
      if (typeof parsed === 'object' && parsed !== null) {
        Object.assign(headers, parsed);
      }
    } catch {
      target.http_headers.split('\n').forEach((line) => {
        const idx = line.indexOf(':');
        if (idx > 0) {
          const k = line.slice(0, idx).trim();
          const v = line.slice(idx + 1).trim();
          if (k && v) headers[k] = v;
        }
      });
    }
  }

  let body: string | undefined = undefined;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && target.http_body) {
    body = target.http_body;
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
    if (!hasContentType && (body.trim().startsWith('{') || body.trim().startsWith('['))) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const redirectMode = target.follow_redirects === 0 ? 'manual' : 'follow';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), target.timeout);

    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers,
      body,
      redirect: redirectMode
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

    // Check keyword in body and Location header (for redirect check)
    let isKeywordFound = false;
    let discoveredSsoUrl: string | undefined = undefined;

    if (target.keyword) {
      const locationHeader = response.headers.get('location') || '';
      const matchSource = `${bodyText} Location: ${locationHeader}`;
      isKeywordFound = matchSource.toLowerCase().includes(target.keyword.toLowerCase());

      // If not found in HTML shell, check if target is an SPA that delegates auth to an SSO gateway
      if (!isKeywordFound && statusCode === 200 && (bodyText.includes('id="root"') || bodyText.includes('id="app"') || bodyText.includes('class="login-pf"') || bodyText.includes('keycloak'))) {
        try {
          let domain = '';
          let realm = '';
          let clientId = 'account';

          // 1. Check <script id="environment"> first if present
          const envMatch = bodyText.match(/<script[^>]+id=["']environment["'][^>]*>([\s\S]*?)<\/script>/i);
          if (envMatch) {
            try {
              const envJson = JSON.parse(envMatch[1].trim());
              realm = envJson.realm || '';
              domain = (envJson.serverBaseUrl || envJson.authServerUrl || envJson.authUrl || '').replace(/\/$/, '');
              clientId = envJson.clientId || 'account';
            } catch {}
          }

          // 2. Check /api/tenants/auth/
          if (!realm || !domain) {
            const tenantUrl = new URL('/api/tenants/auth/', url).href;
            const tenantRes = await fetch(tenantUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Watchtower/1.0' },
              signal: AbortSignal.timeout(2500)
            });
            if (tenantRes.ok) {
              const tenantJson = (await tenantRes.json()) as any;
              if (tenantJson && tenantJson.domain && tenantJson.realm) {
                domain = String(tenantJson.domain).replace(/\/$/, '');
                realm = tenantJson.realm;
                clientId = tenantJson.client_id || 'account';
              }
            }
          }

          // 3. Check realm in URL path
          if (!realm || !domain) {
            const realmPathMatch = new URL(url).pathname.match(/(.*)\/realms\/([a-zA-Z0-9_\-]+)/i);
            if (realmPathMatch) {
              realm = realmPathMatch[2];
              domain = `${new URL(url).origin}${realmPathMatch[1]}`;
            }
          }

          if (domain && realm) {
            const ssoLoginUrl = `${domain}/realms/${realm}/protocol/openid-connect/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(url)}&response_type=code&scope=openid`;
            discoveredSsoUrl = ssoLoginUrl;

            const ssoRes = await fetch(ssoLoginUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Watchtower/1.0' },
              signal: AbortSignal.timeout(3000)
            });
            if (ssoRes.ok) {
              const ssoText = await ssoRes.text();
              if (ssoText.toLowerCase().includes(target.keyword.toLowerCase())) {
                isKeywordFound = true;
              }
            }

            if (!isKeywordFound) {
              const realmUrl = `${domain}/realms/${realm}`;
              const realmRes = await fetch(realmUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Watchtower/1.0', Accept: 'application/json' },
                signal: AbortSignal.timeout(2000)
              });
              if (realmRes.ok) {
                const realmText = await realmRes.text();
                if (realmText.toLowerCase().includes(target.keyword.toLowerCase())) {
                  isKeywordFound = true;
                }
              }
            }
          }
        } catch {
          // Ignore fallback errors, rely on standard failure message
        }
      }
    }

    const finalUrl = response.url || url;
    const isRedirected = Boolean(response.url && response.url !== url);

    const chainSteps: ChainStep[] = [];

    // Step 1: Entry Point URL
    chainSteps.push({
      name: 'Входная точка (Портал)',
      target: url,
      status: (statusCode >= 200 && statusCode < 400) ? 'ok' : 'fail',
      statusCode,
      latency,
      details: isRedirected
        ? `Успешное перенаправление на страницу входа (${finalUrl})`
        : `Сервер ответил HTTP ${statusCode}`
    });

    // Step 2: Auth page / SSO gateway
    if (target.keyword || isRedirected || discoveredSsoUrl) {
      const authTarget = discoveredSsoUrl || finalUrl;
      const stepStatus: 'ok' | 'fail' = (!target.keyword || isKeywordFound) ? 'ok' : 'fail';
      let details = 'Страница авторизации загружена';
      if (target.keyword) {
        details = isKeywordFound
          ? `Форма входа найдена, ключевое слово «${target.keyword}» подтверждено`
          : `Ключевое слово «${target.keyword}» не найдено на странице`;
      }
      chainSteps.push({
        name: discoveredSsoUrl ? 'Шлюз SSO (Keycloak)' : 'Форма авторизации',
        target: authTarget,
        status: stepStatus,
        details
      });
    }

    // Step 3: TLS / SSL
    if (sslResult) {
      chainSteps.push({
        name: 'Безопасность TLS / SSL',
        target: new URL(url).hostname,
        status: sslResult.valid ? 'ok' : 'fail',
        details: sslResult.valid
          ? `Действителен ещё ${sslResult.daysRemaining} дн. (${sslResult.issuer || 'Trusted CA'})`
          : (sslResult.error || 'Ошибка SSL')
      });
    }

    const chainDetails = {
      initialUrl: url,
      finalUrl,
      redirected: isRedirected,
      keywordFound: target.keyword ? isKeywordFound : undefined,
      keyword: target.keyword || undefined,
      ssoUrl: discoveredSsoUrl,
      steps: chainSteps
    };

    if (target.keyword && !isKeywordFound) {
      return {
        status: 'degraded',
        latency,
        statusCode,
        error: `Ожидаемый текст/адрес "${target.keyword}" не найден в ответе/редиректе`,
        ssl: sslResult,
        chainDetails
      };
    }

    const isOk = isExpectedStatus(statusCode, target.expected_status);

    if (isOk) {
      // Check if SSL is expired or expiring critically
      if (sslResult && !sslResult.valid) {
        const isTimeout = sslResult.error?.toLowerCase().includes('timed out');
        const sslMsg = isTimeout
          ? `Таймаут проверки TLS-рукопожатия: ${sslResult.error}`
          : `SSL-сертификат просрочен или недействителен: ${sslResult.error || 'Истёк срок действия'}`;
        return {
          status: 'degraded',
          latency,
          statusCode,
          error: sslMsg,
          ssl: sslResult,
          chainDetails
        };
      }

      const isDegraded = latency > 2000;
      return {
        status: isDegraded ? 'degraded' : 'online',
        latency,
        statusCode,
        error: isDegraded ? `Высокая задержка отклика HTTP: ${latency} мс (порог деградации > 2000 мс)` : undefined,
        ssl: sslResult,
        chainDetails
      };
    } else {
      const expMsg = target.expected_status ? ` (ожидался: ${target.expected_status})` : '';
      return {
        status: 'down',
        latency,
        statusCode,
        error: `HTTP статус ${statusCode} ${response.statusText || ''}${expMsg}`.trim(),
        ssl: sslResult,
        chainDetails
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
