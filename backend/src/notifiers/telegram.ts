import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { SocksClient, SocksProxy } from 'socks';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  proxyUrl?: string;
}

/**
 * Normalizes proxy URL ensuring remote DNS resolution is used for SOCKS proxies.
 * Standard "socks5://" in Node causes local DNS resolution, which fails when Telegram is blocked locally.
 * "socks5h://" forces the SOCKS5 proxy to resolve hostnames remotely.
 */
export function normalizeProxyUrl(rawUrl: string): string {
  let url = (rawUrl || '').trim();
  if (!url) return '';
  if (/^socks5:\/\//i.test(url)) {
    url = url.replace(/^socks5:\/\//i, 'socks5h://');
  } else if (/^socks:\/\//i.test(url)) {
    url = url.replace(/^socks:\/\//i, 'socks5h://');
  } else if (/^socks4:\/\//i.test(url)) {
    url = url.replace(/^socks4:\/\//i, 'socks4a://');
  }
  return url;
}

export async function sendTelegramMessage(
  config: TelegramConfig,
  text: string,
  inlineKeyboard?: any
): Promise<{ success: boolean; error?: string }> {
  try {
    const token = (config.botToken || '').trim();
    const chatId = (config.chatId || '').trim();
    const rawProxyUrl = (config.proxyUrl || '').trim();

    if (!token || !chatId) {
      return { success: false, error: 'Telegram Bot Token и Chat ID обязательны' };
    }

    const payload = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(inlineKeyboard ? { reply_markup: inlineKeyboard } : {})
    });

    // If proxy is configured, use Node's https with HttpsProxyAgent or SocksProxyAgent (with remote DNS)
    if (rawProxyUrl) {
      const proxyUrl = normalizeProxyUrl(rawProxyUrl);
      let agent: any;
      if (proxyUrl.toLowerCase().startsWith('socks')) {
        agent = new SocksProxyAgent(proxyUrl);
      } else {
        agent = new HttpsProxyAgent(proxyUrl);
      }

      return new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.telegram.org',
          port: 443,
          path: `/bot${token}/sendMessage`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            'Host': 'api.telegram.org'
          },
          servername: 'api.telegram.org',
          agent,
          timeout: 15000
        }, (res) => {
          let body = '';
          res.on('data', chunk => { body += chunk; });
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (data.ok) {
                resolve({ success: true });
              } else {
                resolve({ success: false, error: data.description || `HTTP ${res.statusCode}` });
              }
            } catch {
              resolve({ success: false, error: `Некорректный ответ Telegram API: ${body.slice(0, 120)}` });
            }
          });
        });

        req.on('error', (err) => {
          resolve({ success: false, error: `Ошибка прокси/сети: ${err.message}` });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ success: false, error: 'Превышено время ожидания ответа Telegram через прокси (15 сек)' });
        });

        req.write(payload);
        req.end();
      });
    }

    // Direct connection without proxy
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: payload
    });

    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return {
        success: false,
        error: data.description || `HTTP ${res.status}: ${res.statusText}`
      };
    }

    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Ошибка отправки сообщения в Telegram'
    };
  }
}

export async function testProxyConnection(proxyUrl: string): Promise<{ success: boolean; latency?: number; error?: string }> {
  const cleanProxy = (proxyUrl || '').trim();
  if (!cleanProxy) {
    return { success: false, error: 'Адрес прокси не указан' };
  }

  const startTime = performance.now();
  const isSocks = cleanProxy.toLowerCase().startsWith('socks');

  if (isSocks) {
    // SOCKS4 / SOCKS5 direct tunnel test via SocksClient with remote hostname resolution
    try {
      const cleanUrl = cleanProxy
        .replace(/^socks5h?:\/\//i, 'http://')
        .replace(/^socks4a?:\/\//i, 'http://')
        .replace(/^socks:\/\//i, 'http://');

      const parsed = new URL(cleanUrl);
      const proxyHost = parsed.hostname;
      const proxyPort = parseInt(parsed.port || '1080', 10);
      const proxyUser = parsed.username ? decodeURIComponent(parsed.username) : undefined;
      const proxyPass = parsed.password ? decodeURIComponent(parsed.password) : undefined;
      const isSocks4 = /^socks4/i.test(cleanProxy);

      const proxy: SocksProxy = {
        host: proxyHost,
        port: proxyPort,
        type: isSocks4 ? 4 : 5
      };
      if (proxyUser) proxy.userId = proxyUser;
      if (proxyPass) proxy.password = proxyPass;

      const info = await SocksClient.createConnection({
        proxy,
        command: 'connect',
        destination: {
          host: 'api.telegram.org',
          port: 443
        },
        timeout: 12000
      });

      const latency = Math.round(performance.now() - startTime);
      info.socket.destroy();
      return { success: true, latency };
    } catch (err: any) {
      let errMsg = err.message || String(err);
      if (errMsg.includes('Authentication failed')) {
        errMsg = 'Ошибка аутентификации в SOCKS5 (неверный логин или пароль)';
      } else if (errMsg.includes('ECONNREFUSED')) {
        errMsg = `Прокси-сервер недоступен или порт закрыт (${errMsg})`;
      } else if (errMsg.includes('ETIMEDOUT') || errMsg.includes('timeout') || errMsg.includes('Timed out')) {
        errMsg = 'Превышено время ожидания ответа от SOCKS-прокси (таймаут 12 сек)';
      } else if (errMsg.includes('ENOTFOUND')) {
        errMsg = `Хост прокси-сервера не найден в DNS (${errMsg})`;
      }
      return { success: false, error: errMsg };
    }
  }

  // HTTP / HTTPS Proxy test via HttpsProxyAgent
  try {
    const agent = new HttpsProxyAgent(cleanProxy);

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: '/',
        method: 'GET',
        headers: {
          'Host': 'api.telegram.org',
          'User-Agent': 'Watchtower/1.0'
        },
        servername: 'api.telegram.org',
        agent,
        timeout: 12000
      }, (res) => {
        res.resume();
        const latency = Math.round(performance.now() - startTime);
        resolve({ success: true, latency });
      });

      req.on('error', (err) => {
        resolve({ success: false, error: `Ошибка подключения через HTTP-прокси: ${err.message}` });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Превышено время ожидания ответа HTTP-прокси (таймаут 12 сек)' });
      });

      req.end();
    });
  } catch (err: any) {
    return { success: false, error: `Неверный формат адреса прокси: ${err.message}` };
  }
}
