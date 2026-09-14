/**
 * Watchtower Smart Auth Detector
 * Automatically inspects target URLs to discover authentication mechanisms:
 * 1. HTML Login Forms (action URL, username/password fields, CSRF tokens)
 * 2. SSO / OAuth / Identity Provider redirects (302 Location inspection)
 * 3. HTTP Basic / Digest Auth (401 WWW-Authenticate)
 * 4. REST API Auth endpoints (/api/auth/login, /api/login, etc.)
 *
 * Runs a synthetic test probe to automatically extract:
 * - Expected HTTP status code (e.g. 401 Unauthorized)
 * - Actual error keyword (e.g. "Invalid credentials", "Неверный логин или пароль")
 * - Formatted request body and headers
 */

export interface DetectAuthResult {
  success: boolean;
  strategy: 'form_post' | 'redirect_flow' | 'basic_auth' | 'api_endpoint' | 'none';
  targetUrl: string;
  httpMethod: string;
  expectedStatus: string;
  keyword?: string;
  httpBody?: string;
  httpHeaders?: string;
  followRedirects: number;
  summary: string;
  details?: {
    formAction?: string;
    usernameField?: string;
    passwordField?: string;
    detectedStatus?: number;
    errorSample?: string;
    redirectUrl?: string;
  };
}

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Normalizes input URL.
 */
function normalizeUrl(raw: string): string {
  let trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  return trimmed;
}

/**
 * Extracts error text from JSON response.
 */
function extractErrorFromJson(data: any): string | null {
  if (!data || typeof data !== 'object') return null;
  const candidates = [
    data.message,
    data.error,
    data.error_description,
    data.detail,
    data.msg,
    data.title,
    data.description,
    data.error_message
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0 && c.length < 150) {
      return c.trim();
    }
  }
  if (data.errors && typeof data.errors === 'object') {
    const firstVal = Object.values(data.errors)[0];
    if (typeof firstVal === 'string') return firstVal.trim();
    if (Array.isArray(firstVal) && typeof firstVal[0] === 'string') return firstVal[0].trim();
  }
  return null;
}

/**
 * Extracts error text from HTML using common Russian and English error markers.
 */
function extractErrorFromHtml(html: string): string | null {
  // 1. Look inside alert/error/danger elements
  const alertRegex = /<[^>]+class=["'][^"']*(?:alert|error|feedback|danger|warning|notification|toast)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi;
  let match: RegExpExecArray | null;
  while ((match = alertRegex.exec(html)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length >= 3 && text.length <= 120) {
      return text;
    }
  }

  // 2. Look for common authentication error phrases
  const phrasePatterns = [
    /(?:неверн(?:ый|ое|ые|ая)|неправильн(?:ый|ое|ые|ая))\s+(?:логин|пароль|учетн(?:ые|ую)\s+данн(?:ые|ую)|пользовател(?:ь|я))/i,
    /пользователь\s+(?:не\s+найден|заблокирован)/i,
    /ошибка\s+авторизации/i,
    /неверные\s+учетные\s+данные/i,
    /invalid\s+(?:credentials|username|password|email|grant|authentication)/i,
    /incorrect\s+(?:username|password|credentials)/i,
    /user\s+not\s+found/i,
    /authentication\s+failed/i,
    /unauthorized/i
  ];

  for (const pattern of phrasePatterns) {
    const m = html.match(pattern);
    if (m && m[0]) {
      return m[0].trim();
    }
  }

  return null;
}

/**
 * Inspects a target URL and tests authentication mechanisms.
 */
export async function detectAuthMechanism(targetInput: string, timeoutMs = 7000): Promise<DetectAuthResult> {
  const targetUrl = normalizeUrl(targetInput);

  try {
    // Step 1: Initial GET with manual redirect to detect SSO/OAuth redirect flows
    const initialController = new AbortController();
    const initialTimer = setTimeout(() => initialController.abort(), timeoutMs);

    let initialRes: Response;
    try {
      initialRes = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        redirect: 'manual',
        signal: initialController.signal
      });
    } finally {
      clearTimeout(initialTimer);
    }

    // Check if initial request redirects to SSO / Auth server
    const isRedirect = [301, 302, 303, 307, 308].includes(initialRes.status);
    const locationHeader = initialRes.headers.get('location');

    if (isRedirect && locationHeader) {
      const resolvedRedirect = new URL(locationHeader, targetUrl).href;
      const lowerLoc = resolvedRedirect.toLowerCase();

      // Check if redirect is specifically an auth gateway or login page
      const isAuthRedirect =
        lowerLoc.includes('auth') ||
        lowerLoc.includes('login') ||
        lowerLoc.includes('sso') ||
        lowerLoc.includes('oauth') ||
        lowerLoc.includes('keycloak') ||
        lowerLoc.includes('identity') ||
        lowerLoc.includes('saml') ||
        lowerLoc.includes('signin') ||
        new URL(resolvedRedirect).hostname !== new URL(targetUrl).hostname;

      if (isAuthRedirect) {
        // Extract meaningful keyword from redirect (path or domain)
        const redirectUrlObj = new URL(resolvedRedirect);
        const keywordGuess = redirectUrlObj.hostname !== new URL(targetUrl).hostname
          ? redirectUrlObj.hostname
          : redirectUrlObj.pathname;

        return {
          success: true,
          strategy: 'redirect_flow',
          targetUrl,
          httpMethod: 'GET',
          expectedStatus: `${initialRes.status}`,
          followRedirects: 0,
          keyword: keywordGuess,
          summary: `Обнаружен редирект (HTTP ${initialRes.status}) на шлюз авторизации: ${resolvedRedirect}`,
          details: {
            redirectUrl: resolvedRedirect,
            detectedStatus: initialRes.status
          }
        };
      }
    }

    // Check HTTP Basic Auth (401 with WWW-Authenticate)
    if (initialRes.status === 401 && initialRes.headers.get('www-authenticate')) {
      const authHeader = initialRes.headers.get('www-authenticate') || '';
      return {
        success: true,
        strategy: 'basic_auth',
        targetUrl,
        httpMethod: 'GET',
        expectedStatus: '401',
        followRedirects: 1,
        keyword: authHeader.includes('Basic') ? 'Basic' : undefined,
        summary: `Обнаружена HTTP Basic / Digest авторизация на сервере (код 401 Unauthorized)`,
        details: {
          detectedStatus: 401,
          errorSample: authHeader
        }
      };
    }

    // Step 2: Fetch the full page content (following redirects)
    const pageController = new AbortController();
    const pageTimer = setTimeout(() => pageController.abort(), timeoutMs);

    let pageRes: Response;
    let pageHtml = '';
    let finalUrl = targetUrl;

    try {
      pageRes = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        redirect: 'follow',
        signal: pageController.signal
      });
      finalUrl = pageRes.url || targetUrl;
      pageHtml = await pageRes.text();
    } finally {
      clearTimeout(pageTimer);
    }

    // Step 3: Search for HTML login form with password input
    const formRegex = /<form\b([\s\S]*?)<\/form>/gi;
    let formMatch: RegExpExecArray | null;
    let bestForm: {
      actionUrl: string;
      method: string;
      usernameField: string;
      passwordField: string;
      csrfToken?: { name: string; value: string };
    } | null = null;

    while ((formMatch = formRegex.exec(pageHtml)) !== null) {
      const formContent = formMatch[1];
      const formOpenTag = formContent.split('>')[0];

      // Check if this form contains a password input
      const hasPassword = /<input[^>]+type=["']?password["']?/i.test(formContent);
      if (!hasPassword) continue;

      // Extract form action
      const actionMatch = formOpenTag.match(/action=["']([^"']*)["']/i);
      const rawAction = actionMatch ? actionMatch[1].trim() : '';
      let actionUrl = finalUrl;
      if (rawAction) {
        try {
          actionUrl = new URL(rawAction, finalUrl).href;
        } catch {
          actionUrl = finalUrl;
        }
      }

      // Extract form method
      const methodMatch = formOpenTag.match(/method=["']([^"']*)["']/i);
      const method = (methodMatch ? methodMatch[1] : 'POST').toUpperCase();

      // Extract password field name
      const passNameMatch = formContent.match(/<input[^>]+type=["']?password["'][^>]*name=["']?([^"'\s>]+)["']?/i) ||
                            formContent.match(/<input[^>]+name=["']?([^"'\s>]+)["'][^>]*type=["']?password["']?/i);
      const passwordField = passNameMatch ? passNameMatch[1] : 'password';

      // Extract username/login field name
      const userNameMatch =
        formContent.match(/<input[^>]+name=["']?([^"'\s>]*(?:user|login|email|account|name)[^"'\s>]*)["']?/i) ||
        formContent.match(/<input[^>]+type=["']?(?:text|email)["'][^>]*name=["']?([^"'\s>]+)["']?/i);
      const usernameField = userNameMatch ? userNameMatch[1] : 'username';

      // Extract CSRF token if present
      const csrfMatch = formContent.match(
        /<input[^>]+name=["']?(_csrf|csrf_token|csrfToken|authenticity_token|__RequestVerificationToken)["'][^>]*value=["']?([^"']*)["']?/i
      );
      let csrfToken: { name: string; value: string } | undefined;
      if (csrfMatch && csrfMatch[1]) {
        csrfToken = { name: csrfMatch[1], value: csrfMatch[2] || '' };
      }

      bestForm = {
        actionUrl,
        method,
        usernameField,
        passwordField,
        csrfToken
      };
      break; // Found the primary login form
    }

    // If HTML form found -> Execute synthetic probe
    if (bestForm) {
      const probeBodyObj: Record<string, string> = {
        [bestForm.usernameField]: 'watchtower_probe_check',
        [bestForm.passwordField]: 'probe_password_123'
      };
      if (bestForm.csrfToken) {
        probeBodyObj[bestForm.csrfToken.name] = bestForm.csrfToken.value;
      }

      // Test with JSON first, then urlencoded form
      const probeController = new AbortController();
      const probeTimer = setTimeout(() => probeController.abort(), timeoutMs);

      let probeRes: Response | null = null;
      let probeText = '';
      let formatUsed: 'json' | 'form' = 'json';

      try {
        probeRes = await fetch(bestForm.actionUrl, {
          method: bestForm.method,
          headers: {
            'User-Agent': BROWSER_USER_AGENT,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*'
          },
          body: JSON.stringify(probeBodyObj),
          signal: probeController.signal
        });
        probeText = await probeRes.text();

        // If JSON was rejected (415 Unsupported Media Type or 404), try URL-encoded form
        if (probeRes.status === 415 || (probeRes.status === 404 && bestForm.actionUrl !== finalUrl)) {
          const formParams = new URLSearchParams(probeBodyObj);
          probeRes = await fetch(bestForm.actionUrl, {
            method: bestForm.method,
            headers: {
              'User-Agent': BROWSER_USER_AGENT,
              'Content-Type': 'application/x-www-form-urlencoded',
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            body: formParams.toString(),
            signal: probeController.signal
          });
          probeText = await probeRes.text();
          formatUsed = 'form';
        }
      } catch (err: any) {
        // Form endpoint probe error
      } finally {
        clearTimeout(probeTimer);
      }

      let detectedKeyword: string | undefined;
      let expectedStatus = '401';

      if (probeRes) {
        expectedStatus = `${probeRes.status}`;

        // Try extracting error from JSON
        try {
          const json = JSON.parse(probeText);
          const err = extractErrorFromJson(json);
          if (err) detectedKeyword = err;
        } catch {
          // HTML response
          const err = extractErrorFromHtml(probeText);
          if (err) detectedKeyword = err;
        }
      }

      const generatedBody =
        formatUsed === 'json'
          ? JSON.stringify({ [bestForm.usernameField]: 'watchtower_probe', [bestForm.passwordField]: 'dummy_password' }, null, 2)
          : `${bestForm.usernameField}=watchtower_probe&${bestForm.passwordField}=dummy_password`;

      return {
        success: true,
        strategy: 'form_post',
        targetUrl: bestForm.actionUrl,
        httpMethod: bestForm.method,
        expectedStatus: expectedStatus === '200' ? '200,401' : expectedStatus,
        keyword: detectedKeyword,
        httpBody: generatedBody,
        followRedirects: 1,
        summary: `Найдена форма входа (${bestForm.method} ${new URL(bestForm.actionUrl).pathname}). ` +
                 `Сервер ответил кодом ${expectedStatus}` +
                 (detectedKeyword ? ` с сообщением: «${detectedKeyword}»` : '.'),
        details: {
          formAction: bestForm.actionUrl,
          usernameField: bestForm.usernameField,
          passwordField: bestForm.passwordField,
          detectedStatus: probeRes?.status,
          errorSample: detectedKeyword
        }
      };
    }

    // Step 4: No HTML form found -> Check standard SPA / REST API login endpoints
    const commonApiPaths = [
      '/api/auth/login',
      '/api/login',
      '/api/v1/auth/login',
      '/api/v1/login',
      '/auth/login',
      '/api/authenticate'
    ];

    const targetUrlObj = new URL(finalUrl);

    for (const apiPath of commonApiPaths) {
      const candidateUrl = new URL(apiPath, targetUrlObj.origin).href;
      const apiController = new AbortController();
      const apiTimer = setTimeout(() => apiController.abort(), 3500);

      try {
        const apiRes = await fetch(candidateUrl, {
          method: 'POST',
          headers: {
            'User-Agent': BROWSER_USER_AGENT,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({
            username: 'watchtower_probe',
            password: 'probe_password_123'
          }),
          signal: apiController.signal
        });

        const text = await apiRes.text();
        // If it responds with auth error (400, 401, 403, 422)
        if ([400, 401, 403, 422].includes(apiRes.status)) {
          let kw: string | undefined;
          try {
            const parsed = JSON.parse(text);
            kw = extractErrorFromJson(parsed) || undefined;
          } catch {}

          return {
            success: true,
            strategy: 'api_endpoint',
            targetUrl: candidateUrl,
            httpMethod: 'POST',
            expectedStatus: `${apiRes.status}`,
            keyword: kw,
            httpBody: JSON.stringify({ username: 'watchtower_probe', password: 'dummy_password' }, null, 2),
            followRedirects: 1,
            summary: `Обнаружен API-эндпоинт авторизации (${apiPath}). Сервер ответил кодом ${apiRes.status}` +
                     (kw ? ` и ошибкой: «${kw}»` : '.'),
            details: {
              formAction: candidateUrl,
              detectedStatus: apiRes.status,
              errorSample: kw
            }
          };
        }
      } catch {
        // Skip candidate on error/timeout
      } finally {
        clearTimeout(apiTimer);
      }
    }

    // Fallback: No active form or API found
    return {
      success: false,
      strategy: 'none',
      targetUrl,
      httpMethod: 'GET',
      expectedStatus: '200',
      followRedirects: 1,
      summary: `Форма входа на главной странице не обнаружена (HTTP ${pageRes.status}). ` +
               `Если форма находится на отдельном адресе, укажите прямую ссылку (например, ${targetUrlObj.origin}/login).`
    };
  } catch (err: any) {
    return {
      success: false,
      strategy: 'none',
      targetUrl: normalizeUrl(targetInput),
      httpMethod: 'GET',
      expectedStatus: '200',
      followRedirects: 1,
      summary: `Ошибка при подключении к сервису: ${err.message || 'Таймаут или сбой сети'}`
    };
  }
}
