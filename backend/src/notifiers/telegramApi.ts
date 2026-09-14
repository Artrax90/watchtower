import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { normalizeProxyUrl } from './telegram.js';

export interface TelegramApiResponse<T = any> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramInlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  copy_text?: { text: string };
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_markup?: TelegramInlineKeyboard;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
  chat_instance?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/**
 * Low-level request to Telegram Bot API with full HTTP/SOCKS proxy support.
 */
export async function telegramApiRequest<T = any>(
  token: string,
  method: string,
  payload?: any,
  rawProxyUrl?: string,
  timeoutMs = 15000,
  abortSignal?: AbortSignal
): Promise<TelegramApiResponse<T>> {
  const cleanToken = (token || '').trim();
  if (!cleanToken) {
    return { ok: false, description: 'Telegram Bot Token is empty' };
  }

  const cleanProxy = normalizeProxyUrl(rawProxyUrl || '');
  const bodyString = payload ? JSON.stringify(payload) : undefined;

  // Use proxy agent if configured
  if (cleanProxy) {
    let agent: any;
    if (cleanProxy.toLowerCase().startsWith('socks')) {
      agent = new SocksProxyAgent(cleanProxy);
    } else {
      agent = new HttpsProxyAgent(cleanProxy);
    }

    return new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'api.telegram.org',
          port: 443,
          path: `/bot${cleanToken}/${method}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(bodyString ? { 'Content-Length': Buffer.byteLength(bodyString) } : {}),
            Host: 'api.telegram.org'
          },
          servername: 'api.telegram.org',
          agent,
          timeout: timeoutMs,
          signal: abortSignal
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data) as TelegramApiResponse<T>;
              resolve(parsed);
            } catch {
              resolve({
                ok: false,
                description: `Invalid JSON response: ${data.slice(0, 100)}`
              });
            }
          });
        }
      );

      req.on('error', (err: any) => {
        resolve({ ok: false, description: `Network/Proxy error: ${err.message}` });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, description: `Request timed out after ${timeoutMs}ms` });
      });

      if (bodyString) {
        req.write(bodyString);
      }
      req.end();
    });
  }

  // Direct connection without proxy using native fetch
  try {
    const res = await fetch(`https://api.telegram.org/bot${cleanToken}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: bodyString,
      signal: abortSignal
    });
    const json = (await res.json()) as TelegramApiResponse<T>;
    return json;
  } catch (err: any) {
    return { ok: false, description: `Fetch error: ${err.message}` };
  }
}

export async function sendMessage(
  token: string,
  chatId: string | number,
  text: string,
  options?: {
    parse_mode?: 'HTML' | 'MarkdownV2' | 'Markdown';
    reply_markup?: TelegramInlineKeyboard;
    disable_web_page_preview?: boolean;
  },
  proxyUrl?: string
): Promise<TelegramApiResponse<TelegramMessage>> {
  const parseMode = options?.parse_mode ?? 'HTML';
  const res = await telegramApiRequest<TelegramMessage>(
    token,
    'sendMessage',
    {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      reply_markup: options?.reply_markup,
      disable_web_page_preview: options?.disable_web_page_preview ?? true
    },
    proxyUrl
  );

  if (!res.ok) {
    console.warn(`[TelegramApi] sendMessage error: ${res.description}`);
    if (res.description && res.description.toLowerCase().includes("can't parse entities")) {
      console.warn('[TelegramApi] Retrying sendMessage without parse_mode due to entity parsing error...');
      const fallbackText = text.replace(/<[^>]+>/g, '');
      return telegramApiRequest<TelegramMessage>(
        token,
        'sendMessage',
        {
          chat_id: chatId,
          text: fallbackText,
          reply_markup: options?.reply_markup,
          disable_web_page_preview: options?.disable_web_page_preview ?? true
        },
        proxyUrl
      );
    }
  }

  return res;
}

export async function editMessageText(
  token: string,
  chatId: string | number,
  messageId: number,
  text: string,
  options?: {
    parse_mode?: 'HTML' | 'MarkdownV2' | 'Markdown';
    reply_markup?: TelegramInlineKeyboard;
    disable_web_page_preview?: boolean;
  },
  proxyUrl?: string
): Promise<TelegramApiResponse<TelegramMessage | boolean>> {
  const parseMode = options?.parse_mode ?? 'HTML';
  const res = await telegramApiRequest<TelegramMessage | boolean>(
    token,
    'editMessageText',
    {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode,
      reply_markup: options?.reply_markup,
      disable_web_page_preview: options?.disable_web_page_preview ?? true
    },
    proxyUrl
  );

  if (!res.ok) {
    console.warn(`[TelegramApi] editMessageText error: ${res.description}`);
    if (res.description && res.description.toLowerCase().includes("can't parse entities")) {
      console.warn('[TelegramApi] Retrying editMessageText without parse_mode due to entity parsing error...');
      const fallbackText = text.replace(/<[^>]+>/g, '');
      return telegramApiRequest<TelegramMessage | boolean>(
        token,
        'editMessageText',
        {
          chat_id: chatId,
          message_id: messageId,
          text: fallbackText,
          reply_markup: options?.reply_markup,
          disable_web_page_preview: options?.disable_web_page_preview ?? true
        },
        proxyUrl
      );
    }
  }

  return res;
}

export async function answerCallbackQuery(
  token: string,
  callbackQueryId: string,
  options?: {
    text?: string;
    show_alert?: boolean;
    cache_time?: number;
  },
  proxyUrl?: string
): Promise<TelegramApiResponse<boolean>> {
  // Telegram limits answerCallbackQuery text to 200 characters max
  let safeText = options?.text;
  if (safeText && safeText.length > 200) {
    safeText = safeText.slice(0, 197) + '...';
  }

  return telegramApiRequest<boolean>(
    token,
    'answerCallbackQuery',
    {
      callback_query_id: callbackQueryId,
      text: safeText,
      show_alert: options?.show_alert ?? false,
      cache_time: options?.cache_time ?? 0
    },
    proxyUrl
  );
}

export async function setMyCommands(
  token: string,
  commands: Array<{ command: string; description: string }>,
  proxyUrl?: string
): Promise<TelegramApiResponse<boolean>> {
  return telegramApiRequest<boolean>(
    token,
    'setMyCommands',
    { commands },
    proxyUrl
  );
}

export async function getUpdates(
  token: string,
  offset?: number,
  timeout = 25,
  proxyUrl?: string,
  abortSignal?: AbortSignal
): Promise<TelegramApiResponse<TelegramUpdate[]>> {
  return telegramApiRequest<TelegramUpdate[]>(
    token,
    'getUpdates',
    {
      offset,
      timeout,
      allowed_updates: ['message', 'callback_query']
    },
    proxyUrl,
    (timeout + 10) * 1000,
    abortSignal
  );
}

export async function deleteWebhook(
  token: string,
  dropPendingUpdates = false,
  proxyUrl?: string
): Promise<TelegramApiResponse<boolean>> {
  return telegramApiRequest<boolean>(
    token,
    'deleteWebhook',
    { drop_pending_updates: dropPendingUpdates },
    proxyUrl
  );
}

