import { dbQueries, MonitorRow } from '../db/index.js';
import { executeMonitorCheck } from '../scheduler/index.js';
import {
  getUpdates,
  sendMessage,
  editMessageText,
  answerCallbackQuery,
  setMyCommands,
  deleteWebhook,
  TelegramUpdate,
  TelegramInlineKeyboard,
  TelegramInlineButton
} from './telegramApi.js';
import { getErrorExplanation } from './errorExplanations.js';
import { snoozeManager } from './snoozeManager.js';
import { normalizeProxyUrl } from './telegram.js';
import { randomUUID } from 'node:crypto';

export interface TelegramUserRecord {
  id: string;
  name?: string;
  role: 'admin' | 'viewer';
}

export interface ActiveTelegramConfig {
  botToken: string;
  chatId: string;
  allowedUserIds: string[];
  allowedUsers: TelegramUserRecord[];
  proxyUrl?: string;
}

export function parseAllowedUsers(input: any): TelegramUserRecord[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map((x) => {
        if (typeof x === 'object' && x !== null && (x.id || x.userId)) {
          const id = String(x.id || x.userId).trim();
          const name = typeof x.name === 'string' ? x.name.trim() : '';
          const role = x.role === 'viewer' ? 'viewer' : 'admin';
          return { id, name, role: role as 'admin' | 'viewer' };
        }
        const id = String(x).trim();
        return { id, name: '', role: 'admin' as const };
      })
      .filter((u) => u.id.length > 0);
  }
  if (typeof input === 'string' || typeof input === 'number') {
    return String(input)
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((id) => ({ id, name: '', role: 'admin' as const }));
  }
  return [];
}

export function parseUserIds(input: any): string[] {
  return parseAllowedUsers(input).map((u) => u.id);
}

export function getUserRecord(userId: string | number | undefined, cfg: ActiveTelegramConfig): TelegramUserRecord | null {
  if (!userId) return null;
  const uid = String(userId).trim();
  if (!uid) return null;
  const found = (cfg.allowedUsers || []).find((u) => u.id === uid);
  if (found) return found;
  if ((cfg.allowedUserIds || []).includes(uid)) {
    return { id: uid, name: '', role: 'admin' };
  }
  return null;
}

export function getUserRole(userId: string | number | undefined, cfg: ActiveTelegramConfig): 'admin' | 'viewer' | null {
  const rec = getUserRecord(userId, cfg);
  return rec ? rec.role : null;
}

export function isUserAuthorized(userId: string | number | undefined, cfg: ActiveTelegramConfig): boolean {
  return getUserRole(userId, cfg) !== null;
}

export function isUserAdmin(userId: string | number | undefined, cfg: ActiveTelegramConfig): boolean {
  return getUserRole(userId, cfg) === 'admin';
}

let isPolling = false;
let pollingCycle = 0;
let abortController: AbortController | null = null;
let lastUpdateId = 0;

export function getActiveTelegramConfig(): ActiveTelegramConfig | null {
  const channels = dbQueries.getNotificationChannels();
  const tgChannel = channels.find((c) => c.type === 'telegram' && c.is_enabled === 1);
  if (!tgChannel) return null;

  try {
    const cfg = JSON.parse(tgChannel.config);
    if (cfg && cfg.botToken) {
      const rawUserSource = cfg.allowedUsers ?? cfg.userIds ?? cfg.allowedUserIds ?? cfg.userId ?? '';
      const allowedUsers = parseAllowedUsers(rawUserSource);
      const allowedUserIds = allowedUsers.map((u) => u.id);

      return {
        botToken: cfg.botToken.trim(),
        chatId: (cfg.chatId || '').trim(),
        allowedUserIds,
        allowedUsers,
        proxyUrl: (cfg.proxyUrl || '').trim() || undefined
      };
    }
  } catch (err) {
    console.error('[TelegramBot] Failed to parse telegram config:', err);
  }
  return null;
}

/**
 * Starts background polling listener for Telegram Bot.
 */
export async function startTelegramBot() {
  if (isPolling) return;

  const cfg = getActiveTelegramConfig();
  if (!cfg) {
    console.log('[TelegramBot] Telegram channel not configured or disabled. Polling standby.');
    return;
  }

  isPolling = true;
  const currentCycle = ++pollingCycle;
  abortController = new AbortController();

  console.log(`[TelegramBot] Starting Telegram bot polling... (Cycle: ${currentCycle}, Proxy: ${cfg.proxyUrl || 'none'})`);

  // Ensure any stale webhook is deleted so getUpdates polling works cleanly
  try {
    const delRes = await deleteWebhook(cfg.botToken, false, cfg.proxyUrl);
    if (delRes.ok) {
      console.log('[TelegramBot] Cleaned up any existing webhook for polling mode.');
    }
  } catch (err: any) {
    console.warn('[TelegramBot] Failed to delete webhook on startup:', err.message);
  }

  // Register modern bot command menu in Telegram
  try {
    await setMyCommands(
      cfg.botToken,
      [
        { command: 'status', description: '📊 Сводка доступности и Uptime' },
        { command: 'monitors', description: '🖥 Список мониторов и состояние' },
        { command: 'check', description: '🔍 Экспресс-проверка сервиса' },
        { command: 'pause', description: '⏸ Поставить монитор на паузу (Админ)' },
        { command: 'resume', description: '▶ Возобновить монитор (Админ)' },
        { command: 'ssl', description: '🔒 Сроки действия SSL-сертификатов' },
        { command: 'incidents', description: '⚠️ История сбоев и аварий' },
        { command: 'add', description: '➕ Добавить монитор (Админ)' },
        { command: 'help', description: 'ℹ️ Справка по всем командам' }
      ],
      cfg.proxyUrl
    );
  } catch (err: any) {
    console.warn('[TelegramBot] Failed to set bot commands:', err.message);
  }

  // Polling loop
  pollLoop(currentCycle).catch((err) => {
    console.error('[TelegramBot] Unexpected polling loop crash:', err);
    isPolling = false;
  });
}

export async function stopTelegramBot() {
  pollingCycle++;
  if (!isPolling) return;
  isPolling = false;
  if (abortController) {
    try {
      abortController.abort();
    } catch {}
    abortController = null;
  }
  console.log('[TelegramBot] Telegram bot polling stopped.');
}

export async function restartTelegramBot() {
  await stopTelegramBot();
  // Delay to let previous long-polling socket abort and terminate cleanly
  await new Promise((r) => setTimeout(r, 1000));
  await startTelegramBot();
}

async function pollLoop(cycle: number) {
  while (isPolling && cycle === pollingCycle) {
    const cfg = getActiveTelegramConfig();
    if (!cfg) {
      await sleep(3000);
      continue;
    }

    try {
      const res = await getUpdates(cfg.botToken, lastUpdateId + 1, 25, cfg.proxyUrl, abortController?.signal);

      if (cycle !== pollingCycle || !isPolling) break;

      if (res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);
          const currentCfg = getActiveTelegramConfig() || cfg;
          handleUpdate(update, currentCfg).catch((err) => {
            console.error('[TelegramBot] Error handling update:', err);
          });
        }
      } else if (!res.ok) {
        if (cycle !== pollingCycle || !isPolling) break;
        console.warn('[TelegramBot] getUpdates error:', res.description);
        if (res.description && res.description.toLowerCase().includes('webhook is active')) {
          console.log('[TelegramBot] Detected active webhook, clearing with deleteWebhook...');
          try {
            await deleteWebhook(cfg.botToken, false, cfg.proxyUrl);
            console.log('[TelegramBot] Webhook cleared successfully.');
          } catch (e: any) {
            console.warn('[TelegramBot] Failed to clear webhook:', e.message);
          }
        }
        await sleep(4000);
      }
    } catch (err: any) {
      if (cycle !== pollingCycle || !isPolling) break;
      if (err.name === 'AbortError' || err.code === 'ABORT_ERR') break;
      console.warn('[TelegramBot] Polling network cycle error:', err.message);
      await sleep(3000);
    }
  }
  console.log(`[TelegramBot] Polling cycle ${cycle} finished.`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleUpdate(update: TelegramUpdate, cfg: ActiveTelegramConfig) {
  if (update.message && update.message.text) {
    await handleMessage(update.message, cfg);
  } else if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, cfg);
  }
}

// --- Messages & Commands Handler ---
async function handleMessage(msg: NonNullable<TelegramUpdate['message']>, cfg: ActiveTelegramConfig) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  const fromId = msg.from ? String(msg.from.id) : String(chatId);

  // Security & Authorization Check: only whitelisted user IDs are allowed to access
  if (!isUserAuthorized(fromId, cfg)) {
    const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'Пользователь';

    const unauthorizedHtml = [
      `🔒 <b>Доступ ограничен</b>`,
      ``,
      `Здравствуйте, <b>${escapeHtml(senderName)}</b>!`,
      `У вас пока нет доступа к управлению системой мониторинга <b>Watchtower</b>.`,
      ``,
      `🆔 <b>Ваш Telegram User ID:</b>`,
      `<code>${fromId}</code>`,
      `<i>(нажмите на номер выше, чтобы скопировать)</i>`,
      ``,
      `📋 <b>Инструкция по подключению:</b>`,
      `1. Скопируйте ваш ID выше.`,
      `2. Отправьте его администратору системы Watchtower.`,
      `3. Администратор добавит его в настройках Telegram (в белый список).`,
      ``,
      `✨ <i>Как только администратор сохранит ваш ID, бот автоматически пришлёт вам приветственное сообщение и откроет доступ к функциям мониторинга!</i>`
    ].join('\n');

    const kb: TelegramInlineKeyboard = {
      inline_keyboard: [
        [
          {
            text: `📋 Скопировать мой ID (${fromId})`,
            copy_text: { text: fromId }
          }
        ]
      ]
    };

    await sendMessage(cfg.botToken, chatId, unauthorizedHtml, { reply_markup: kb }, cfg.proxyUrl);
    return;
  }

  const role = getUserRole(fromId, cfg) || 'viewer';
  const isAdmin = role === 'admin';

  // Split command and argument (e.g. "/check google" or "/add https://test.com Тест")
  const parts = text.split(/\s+/);
  const rawCmd = parts[0].toLowerCase();
  // Strip bot username if invoked as /cmd@botname
  const cmd = rawCmd.split('@')[0];
  const arg = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case '/start':
    case '/help': {
      const helpHtml = getHelpText(role);
      const kb = getHelpKeyboard(role);
      await sendMessage(cfg.botToken, chatId, helpHtml, { reply_markup: kb }, cfg.proxyUrl);
      break;
    }

    case '/status': {
      await sendStatusMessage(chatId, cfg);
      break;
    }

    case '/monitors': {
      await sendMonitorsMessage(chatId, cfg, undefined, role);
      break;
    }

    case '/check': {
      await handleCheckCommand(chatId, arg, cfg);
      break;
    }

    case '/pause': {
      if (!isAdmin) {
        await sendMessage(
          cfg.botToken,
          chatId,
          `⛔ <b>Недостаточно прав</b>\n\nКоманда <code>/pause</code> доступна только <b>Администраторам</b> системы.\nВаша роль: <b>Наблюдатель</b> (только просмотр и диагностика).`,
          {},
          cfg.proxyUrl
        );
        break;
      }
      await handlePauseCommand(chatId, arg, true, cfg);
      break;
    }

    case '/resume': {
      if (!isAdmin) {
        await sendMessage(
          cfg.botToken,
          chatId,
          `⛔ <b>Недостаточно прав</b>\n\nКоманда <code>/resume</code> доступна только <b>Администраторам</b> системы.\nВаша роль: <b>Наблюдатель</b> (только просмотр и диагностика).`,
          {},
          cfg.proxyUrl
        );
        break;
      }
      await handlePauseCommand(chatId, arg, false, cfg);
      break;
    }

    case '/ssl': {
      await sendSslMessage(chatId, cfg);
      break;
    }

    case '/incidents': {
      await sendIncidentsMessage(chatId, cfg);
      break;
    }

    case '/add': {
      if (!isAdmin) {
        await sendMessage(
          cfg.botToken,
          chatId,
          `⛔ <b>Недостаточно прав</b>\n\nКоманда <code>/add</code> доступна только <b>Администраторам</b> системы.\nВаша роль: <b>Наблюдатель</b> (только просмотр и диагностика).`,
          {},
          cfg.proxyUrl
        );
        break;
      }
      await handleAddCommand(chatId, arg, cfg);
      break;
    }

    default: {
      // If user typed unknown command starting with /
      if (text.startsWith('/')) {
        await sendMessage(
          cfg.botToken,
          chatId,
          `Неизвестная команда: <code>${escapeHtml(text)}</code>.\nИспользуйте /help для списка всех команд.`,
          {},
          cfg.proxyUrl
        );
      }
      break;
    }
  }
}

// --- Callback Queries Handler (Interactive Inline Buttons) ---
async function handleCallbackQuery(cb: NonNullable<TelegramUpdate['callback_query']>, cfg: ActiveTelegramConfig) {
  const data = cb.data || '';
  const cbId = cb.id;
  const msg = cb.message;
  const chatId = msg?.chat.id || cfg.chatId;
  const fromId = cb.from ? String(cb.from.id) : '';

  // Security & Authorization Check for inline button clicks
  if (!isUserAuthorized(fromId, cfg)) {
    await answerCallbackQuery(
      cfg.botToken,
      cbId,
      {
        text: `⛔ Доступ запрещен. Ваш ID: ${fromId}. Отправьте его администратору.`,
        show_alert: true
      },
      cfg.proxyUrl
    );
    return;
  }

  const role = getUserRole(fromId, cfg) || 'viewer';
  const isAdmin = role === 'admin';

  // Check admin-only actions
  if (data.startsWith('snz:') || data.startsWith('unsnz:')) {
    if (!isAdmin) {
      await answerCallbackQuery(cfg.botToken, cbId, { text: '⛔ Управление оповещениями доступно только Администраторам.', show_alert: true }, cfg.proxyUrl);
      return;
    }
  }

  if (data.startsWith('pau:') || data.startsWith('res:')) {
    if (!isAdmin) {
      await answerCallbackQuery(cfg.botToken, cbId, { text: '⛔ Приостановка и возобновление мониторов доступны только Администраторам.', show_alert: true }, cfg.proxyUrl);
      return;
    }
  }

  if (data === 'cmd:add') {
    if (!isAdmin) {
      await answerCallbackQuery(cfg.botToken, cbId, { text: '⛔ Добавление мониторов доступно только Администраторам.', show_alert: true }, cfg.proxyUrl);
      return;
    }
  }

  // 1. Re-check monitor: chk:<monitorId>
  if (data.startsWith('chk:')) {
    const monitorId = data.slice(4);
    const monitor = dbQueries.getMonitorById(monitorId);

    if (!monitor) {
      await answerCallbackQuery(cfg.botToken, cbId, { text: '❌ Монитор не найден', show_alert: true }, cfg.proxyUrl);
      return;
    }

    // Instant acknowledge toast
    await answerCallbackQuery(cfg.botToken, cbId, { text: '⏳ Проверяем сервис...', show_alert: false }, cfg.proxyUrl);

    // Run live check
    const result = await executeMonitorCheck(monitor);
    const updated = dbQueries.getMonitorById(monitorId) || monitor;

    const isUp = result.status === 'online';
    const statusIcon = isUp ? '🟢' : result.status === 'degraded' ? '🟡' : '🔴';
    const toastResult = isUp
      ? `✅ ${updated.name}: Онлайн (${result.latency} мс)`
      : `⚠️ ${updated.name}: ${result.status.toUpperCase()} (${result.error || result.latency + ' мс'})`;

    // Show result popup or toast
    await answerCallbackQuery(cfg.botToken, cbId, { text: toastResult, show_alert: false }, cfg.proxyUrl);

    // Update message text if possible
    if (msg) {
      const timeStr = new Date().toLocaleTimeString('ru-RU');
      const updatedText = [
        `${statusIcon} <b>РЕЗУЛЬТАТ ПРОВЕРКИ</b>`,
        ``,
        `📍 Сервис: <b>${escapeHtml(updated.name)}</b>`,
        `🔗 Адрес: <code>${escapeHtml(updated.target)}</code>`,
        `⚡ Отклик: <b>${result.latency} мс</b>`,
        result.statusCode ? `📄 HTTP Код: <b>${result.statusCode}</b>` : '',
        result.ssl?.daysRemaining !== undefined ? `🔒 SSL: <b>${result.ssl.daysRemaining} дн.</b>` : '',
        result.error ? `<blockquote expandable>⚠️ <b>Ошибка:</b>\n<code>${escapeHtml(result.error)}</code></blockquote>` : '',
        `⏱ Проверено: <code>${timeStr}</code>`
      ]
        .filter(Boolean)
        .join('\n');

      const kbRows: TelegramInlineKeyboard['inline_keyboard'] = [
        [
          { text: '🔄 Перепроверить', callback_data: `chk:${monitor.id}` }
        ]
      ];

      if (isAdmin) {
        kbRows[0].push({ text: updated.is_paused ? '▶ Возобновить' : '⏸ На паузу', callback_data: updated.is_paused ? `res:${monitor.id}` : `pau:${monitor.id}` });
        kbRows.push([
          { text: 'ℹ️ Что за ошибка?', callback_data: `exp:${monitor.id}` },
          { text: '📊 Статус', callback_data: 'cmd:status' }
        ]);
      } else {
        kbRows.push([
          { text: 'ℹ️ Что за ошибка?', callback_data: `exp:${monitor.id}` },
          { text: '📊 Статус', callback_data: 'cmd:status' }
        ]);
      }

      await editMessageText(cfg.botToken, chatId, msg.message_id, updatedText, { reply_markup: { inline_keyboard: kbRows } }, cfg.proxyUrl);
    }
    return;
  }

  // 2. Snooze alerts: snz:<monitorId>:<minutes>
  if (data.startsWith('snz:')) {
    const [, monitorId, minStr] = data.split(':');
    const minutes = parseInt(minStr || '60', 10);
    const monitor = dbQueries.getMonitorById(monitorId);

    if (!monitor) {
      await answerCallbackQuery(cfg.botToken, cbId, { text: 'Монитор не найден', show_alert: true }, cfg.proxyUrl);
      return;
    }

    snoozeManager.snooze(monitorId, minutes);
    await answerCallbackQuery(
      cfg.botToken,
      cbId,
      {
        text: `🔕 Оповещения для «${monitor.name}» заглушены на ${minutes >= 60 ? `${minutes / 60} ч.` : `${minutes} мин.`}`,
        show_alert: false
      },
      cfg.proxyUrl
    );

    // Update buttons on message to allow unsnooze
    if (msg && msg.reply_markup) {
      const newRows = msg.reply_markup.inline_keyboard.map((row) =>
        row.map((btn) => {
          if (btn.callback_data && btn.callback_data.startsWith('snz:')) {
            return { text: '🔔 Включить оповещения', callback_data: `unsnz:${monitorId}` };
          }
          return btn;
        })
      );
      await editMessageText(cfg.botToken, chatId, msg.message_id, msg.text || '', { reply_markup: { inline_keyboard: newRows } }, cfg.proxyUrl);
    }
    return;
  }

  // 3. Unsnooze alerts: unsnz:<monitorId>
  if (data.startsWith('unsnz:')) {
    const monitorId = data.slice(6);
    snoozeManager.unsnooze(monitorId);

    await answerCallbackQuery(cfg.botToken, cbId, { text: '🔔 Оповещения снова активны!', show_alert: false }, cfg.proxyUrl);

    if (msg && msg.reply_markup) {
      const newRows = msg.reply_markup.inline_keyboard.map((row) =>
        row.map((btn) => {
          if (btn.callback_data && btn.callback_data.startsWith('unsnz:')) {
            return { text: '🔕 Заглушить 1ч', callback_data: `snz:${monitorId}:60` };
          }
          return btn;
        })
      );
      await editMessageText(cfg.botToken, chatId, msg.message_id, msg.text || '', { reply_markup: { inline_keyboard: newRows } }, cfg.proxyUrl);
    }
    return;
  }

  // 4. Pause monitor: pau:<monitorId>
  if (data.startsWith('pau:')) {
    const monitorId = data.slice(4);
    const monitor = dbQueries.getMonitorById(monitorId);
    if (!monitor) return;

    dbQueries.updateMonitor(monitorId, { is_paused: 1 });
    await answerCallbackQuery(cfg.botToken, cbId, { text: `⏸ Монитор «${monitor.name}» поставлен на паузу`, show_alert: false }, cfg.proxyUrl);

    if (msg && msg.reply_markup) {
      const newRows = msg.reply_markup.inline_keyboard.map((row) =>
        row.map((btn) => {
          if (btn.callback_data === `pau:${monitorId}`) {
            return { text: '▶ Возобновить', callback_data: `res:${monitorId}` };
          }
          return btn;
        })
      );
      await editMessageText(cfg.botToken, chatId, msg.message_id, msg.text || '', { reply_markup: { inline_keyboard: newRows } }, cfg.proxyUrl);
    }
    return;
  }

  // 5. Resume monitor: res:<monitorId>
  if (data.startsWith('res:')) {
    const monitorId = data.slice(4);
    const monitor = dbQueries.getMonitorById(monitorId);
    if (!monitor) return;

    dbQueries.updateMonitor(monitorId, { is_paused: 0 });
    await answerCallbackQuery(cfg.botToken, cbId, { text: `▶ Монитор «${monitor.name}» возобновлён`, show_alert: false }, cfg.proxyUrl);

    if (msg && msg.reply_markup) {
      const newRows = msg.reply_markup.inline_keyboard.map((row) =>
        row.map((btn) => {
          if (btn.callback_data === `res:${monitorId}`) {
            return { text: '⏸ На паузу', callback_data: `pau:${monitorId}` };
          }
          return btn;
        })
      );
      await editMessageText(cfg.botToken, chatId, msg.message_id, msg.text || '', { reply_markup: { inline_keyboard: newRows } }, cfg.proxyUrl);
    }
    return;
  }

  // 6. Explain error: exp:<monitorId> (Opens native Telegram modal popup with explanation)
  if (data.startsWith('exp:')) {
    const monitorId = data.slice(4);
    const monitor = dbQueries.getMonitorById(monitorId);
    const heartbeats = dbQueries.getRecentHeartbeats(monitorId, 5);
    const lastFailed = heartbeats.reverse().find((h) => h.status !== 'online');
    const rawError = lastFailed?.error || 'Сбой соединения или таймаут';

    const exp = getErrorExplanation(rawError);

    // Native Telegram Modal Popup! (show_alert: true)
    await answerCallbackQuery(
      cfg.botToken,
      cbId,
      {
        text: exp.shortAlert,
        show_alert: true
      },
      cfg.proxyUrl
    );
    return;
  }

  // 7. Inspect single monitor card: det:<monitorId>
  if (data.startsWith('det:')) {
    const monitorId = data.slice(4);
    await sendSingleMonitorCard(chatId, monitorId, cfg, msg?.message_id, role);
    await answerCallbackQuery(cfg.botToken, cbId, { text: '' }, cfg.proxyUrl);
    return;
  }

  // 8. Navigation menu commands
  if (data === 'cmd:status') {
    await sendStatusMessage(chatId, cfg, msg?.message_id);
    await answerCallbackQuery(cfg.botToken, cbId, { text: 'Сводка обновлена' }, cfg.proxyUrl);
    return;
  }

  if (data === 'cmd:monitors') {
    await sendMonitorsMessage(chatId, cfg, msg?.message_id, role);
    await answerCallbackQuery(cfg.botToken, cbId, { text: 'Список загружен' }, cfg.proxyUrl);
    return;
  }

  if (data === 'cmd:ssl') {
    await sendSslMessage(chatId, cfg, msg?.message_id);
    await answerCallbackQuery(cfg.botToken, cbId, { text: '' }, cfg.proxyUrl);
    return;
  }

  if (data === 'cmd:incidents') {
    await sendIncidentsMessage(chatId, cfg, msg?.message_id);
    await answerCallbackQuery(cfg.botToken, cbId, { text: '' }, cfg.proxyUrl);
    return;
  }

  if (data === 'cmd:help') {
    const helpHtml = getHelpText(role);
    const kb = getHelpKeyboard(role);
    if (msg) {
      await editMessageText(cfg.botToken, chatId, msg.message_id, helpHtml, { reply_markup: kb }, cfg.proxyUrl);
    } else {
      await sendMessage(cfg.botToken, chatId, helpHtml, { reply_markup: kb }, cfg.proxyUrl);
    }
    await answerCallbackQuery(cfg.botToken, cbId, { text: '' }, cfg.proxyUrl);
    return;
  }

  // Fallback acknowledge
  await answerCallbackQuery(cfg.botToken, cbId, {}, cfg.proxyUrl);
}

// --- Specific Views and Helpers ---

async function sendStatusMessage(chatId: string | number, cfg: ActiveTelegramConfig, editMsgId?: number) {
  const monitors = dbQueries.getAllMonitors();
  const activeIncidents = dbQueries.getActiveIncidents();

  let online = 0;
  let down = 0;
  let degraded = 0;
  let paused = 0;
  let totalLatency = 0;
  let latencyCount = 0;
  let uptimeSum = 0;

  for (const m of monitors) {
    if (m.is_paused) {
      paused++;
    } else if (m.status === 'online') {
      online++;
    } else if (m.status === 'down') {
      down++;
    } else if (m.status === 'degraded') {
      degraded++;
    }

    if (m.current_latency > 0 && !m.is_paused) {
      totalLatency += m.current_latency;
      latencyCount++;
    }
    uptimeSum += dbQueries.getMonitorUptime24h(m.id);
  }

  const avgLatency = latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0;
  const avgUptime = monitors.length > 0 ? (uptimeSum / monitors.length).toFixed(2) : '100.00';

  const overallStatus = down > 0 ? '🔴 <b>ЕСТЬ СБОИ В СЕТИ</b>' : degraded > 0 ? '🟡 <b>ЗАМЕЧЕНА ДЕГРАДАЦИЯ</b>' : '🟢 <b>ВСЕ СИСТЕМЫ В НОРМЕ</b>';

  const text = [
    `${overallStatus}`,
    ``,
    `📊 <b>Сводка инфраструктуры:</b>`,
    `• Всего мониторов: <b>${monitors.length}</b>`,
    `• Онлайн: <b>${online}</b> | Сбои: <b>${down}</b> | Деградация: <b>${degraded}</b>`,
    `• На паузе: <b>${paused}</b>`,
    `• Средний отклик: <b>${avgLatency} мс</b>`,
    `• Средний Uptime (24 ч): <b>${avgUptime}%</b>`,
    `• Активных инцидентов: <b>${activeIncidents.length}</b>`,
    ``,
    `⏱ <i>Обновлено: ${new Date().toLocaleString('ru-RU')}</i>`
  ].join('\n');

  const kb: TelegramInlineKeyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Обновить сводку', callback_data: 'cmd:status' },
        { text: '🖥 Мониторы', callback_data: 'cmd:monitors' }
      ],
      [
        { text: '🔒 SSL-сертификаты', callback_data: 'cmd:ssl' },
        { text: '⚠️ Инциденты', callback_data: 'cmd:incidents' }
      ]
    ]
  };

  if (editMsgId) {
    await editMessageText(cfg.botToken, chatId, editMsgId, text, { reply_markup: kb }, cfg.proxyUrl);
  } else {
    await sendMessage(cfg.botToken, chatId, text, { reply_markup: kb }, cfg.proxyUrl);
  }
}

async function sendMonitorsMessage(chatId: string | number, cfg: ActiveTelegramConfig, editMsgId?: number, userRole: 'admin' | 'viewer' = 'admin') {
  const monitors = dbQueries.getAllMonitors();

  if (monitors.length === 0) {
    const text = userRole === 'admin'
      ? 'В системе пока нет добавленных мониторов.\nИспользуйте команду <code>/add &lt;url&gt; [имя]</code> для создания.'
      : 'В системе пока нет добавленных мониторов.\nОжидайте добавления мониторов администратором.';
    if (editMsgId) {
      await editMessageText(cfg.botToken, chatId, editMsgId, text, {}, cfg.proxyUrl);
    } else {
      await sendMessage(cfg.botToken, chatId, text, {}, cfg.proxyUrl);
    }
    return;
  }

  const lines = [
    `🖥 <b>Список мониторов (${monitors.length}):</b>`,
    ``
  ];

  const kbRows: TelegramInlineKeyboard['inline_keyboard'] = [];

  for (const m of monitors) {
    const icon = m.is_paused ? '⏸' : m.status === 'online' ? '🟢' : m.status === 'down' ? '🔴' : '🟡';
    const latency = m.is_paused ? 'пауза' : m.status === 'down' ? 'сбой' : `${m.current_latency} мс`;
    const upt = dbQueries.getMonitorUptime24h(m.id);

    lines.push(`${icon} <b>${escapeHtml(m.name)}</b> — ${latency} <i>(${upt}%)</i>`);

    // Add button row for quick actions
    kbRows.push([
      { text: `${icon} ${m.name}`, callback_data: `det:${m.id}` },
      { text: '🔄 Проверить', callback_data: `chk:${m.id}` }
    ]);
  }

  lines.push(``);
  lines.push(`<i>Нажмите на монитор для просмотра деталей или экспресс-проверки.</i>`);

  // Bottom navigation row
  kbRows.push([
    { text: '📊 Общая сводка', callback_data: 'cmd:status' },
    { text: '🔒 SSL', callback_data: 'cmd:ssl' }
  ]);

  const text = lines.join('\n');

  if (editMsgId) {
    await editMessageText(cfg.botToken, chatId, editMsgId, text, { reply_markup: { inline_keyboard: kbRows } }, cfg.proxyUrl);
  } else {
    await sendMessage(cfg.botToken, chatId, text, { reply_markup: { inline_keyboard: kbRows } }, cfg.proxyUrl);
  }
}

async function sendSingleMonitorCard(chatId: string | number, monitorId: string, cfg: ActiveTelegramConfig, editMsgId?: number, userRole: 'admin' | 'viewer' = 'admin') {
  const m = dbQueries.getMonitorById(monitorId);
  if (!m) return;

  const isAdmin = userRole === 'admin';
  const icon = m.is_paused ? '⏸' : m.status === 'online' ? '🟢' : m.status === 'down' ? '🔴' : '🟡';
  const statusRu = m.is_paused ? 'На паузе' : m.status === 'online' ? 'Онлайн' : m.status === 'down' ? 'Недоступен' : 'Деградация';
  const uptime = dbQueries.getMonitorUptime24h(m.id);

  const cardLines = [
    `${icon} <b>Монитор: ${escapeHtml(m.name)}</b>`,
    ``,
    `📍 <b>Статус:</b> ${statusRu}`,
    `🔗 <b>Адрес (Target):</b> <code>${escapeHtml(m.target)}${m.port ? `:${m.port}` : ''}</code>`,
    `📡 <b>Тип:</b> <code>${escapeHtml(m.type.toUpperCase())}</code>`,
    `⚡ <b>Текущий отклик:</b> <b>${m.current_latency} мс</b>`,
    `📈 <b>Uptime за 24 ч:</b> <b>${uptime}%</b>`,
    `⏱ <b>Интервал проверки:</b> каждые ${m.interval} сек.`,
    m.ssl_days_remaining !== null && m.ssl_days_remaining !== undefined
      ? `🔒 <b>SSL-сертификат:</b> ${m.ssl_days_remaining} дн. до истечения (${escapeHtml(m.ssl_expiry_date || '')})`
      : '',
    ``,
    `<i>Выберите действие для этого сервиса:</i>`
  ].filter(Boolean);

  const kbRows: TelegramInlineKeyboard['inline_keyboard'] = [
    [
      { text: '🔄 Проверить сейчас', callback_data: `chk:${m.id}` }
    ]
  ];

  if (isAdmin) {
    kbRows[0].push({ text: m.is_paused ? '▶ Возобновить' : '⏸ На паузу', callback_data: m.is_paused ? `res:${m.id}` : `pau:${m.id}` });
    kbRows.push([
      { text: '🔕 Заглушить на 1ч', callback_data: `snz:${m.id}:60` },
      { text: 'ℹ️ Диагностика ошибки', callback_data: `exp:${m.id}` }
    ]);
  } else {
    kbRows.push([
      { text: 'ℹ️ Диагностика ошибки', callback_data: `exp:${m.id}` }
    ]);
  }

  kbRows.push([
    { text: '🔙 Назад к списку', callback_data: 'cmd:monitors' }
  ]);

  const text = cardLines.join('\n');

  if (editMsgId) {
    await editMessageText(cfg.botToken, chatId, editMsgId, text, { reply_markup: { inline_keyboard: kbRows } }, cfg.proxyUrl);
  } else {
    await sendMessage(cfg.botToken, chatId, text, { reply_markup: { inline_keyboard: kbRows } }, cfg.proxyUrl);
  }
}

async function handleCheckCommand(chatId: string | number, query: string, cfg: ActiveTelegramConfig) {
  const monitors = dbQueries.getAllMonitors();
  if (monitors.length === 0) {
    await sendMessage(cfg.botToken, chatId, 'Список мониторов пуст.', {}, cfg.proxyUrl);
    return;
  }

  if (!query) {
    // Show buttons to pick which monitor to check
    const kb: TelegramInlineKeyboard = {
      inline_keyboard: monitors.map((m) => [
        { text: `🔍 Проверить ${m.name}`, callback_data: `chk:${m.id}` }
      ])
    };
    await sendMessage(cfg.botToken, chatId, 'Какой сервис хотите проверить прямо сейчас?', { reply_markup: kb }, cfg.proxyUrl);
    return;
  }

  const q = query.toLowerCase();
  const matched = monitors.filter(
    (m) => m.name.toLowerCase().includes(q) || m.target.toLowerCase().includes(q) || m.id.toLowerCase() === q
  );

  if (matched.length === 0) {
    await sendMessage(
      cfg.botToken,
      chatId,
      `❌ Монитор по запросу «${escapeHtml(query)}» не найден.\nИспользуйте <code>/monitors</code> для просмотра списка.`,
      {},
      cfg.proxyUrl
    );
    return;
  }

  if (matched.length === 1) {
    const target = matched[0];
    await sendMessage(cfg.botToken, chatId, `⏳ Выполняется проверка <b>${escapeHtml(target.name)}</b>...`, {}, cfg.proxyUrl);
    const result = await executeMonitorCheck(target);

    const isUp = result.status === 'online';
    const icon = isUp ? '🟢' : result.status === 'degraded' ? '🟡' : '🔴';

    const respText = [
      `${icon} <b>Результат проверки: ${escapeHtml(target.name)}</b>`,
      ``,
      `📍 Статус: <b>${result.status.toUpperCase()}</b>`,
      `⚡ Отклик: <b>${result.latency} мс</b>`,
      result.statusCode ? `📄 Код ответа: <b>${result.statusCode}</b>` : '',
      result.ssl?.daysRemaining !== undefined ? `🔒 SSL: <b>${result.ssl.daysRemaining} дн.</b>` : '',
      result.error ? `<blockquote expandable>⚠️ <b>Ошибка:</b>\n<code>${escapeHtml(result.error)}</code></blockquote>` : ''
    ]
      .filter(Boolean)
      .join('\n');

    const kb: TelegramInlineKeyboard = {
      inline_keyboard: [
        [
          { text: '🔄 Проверить повторно', callback_data: `chk:${target.id}` },
          { text: 'ℹ️ Что за ошибка?', callback_data: `exp:${target.id}` }
        ]
      ]
    };

    await sendMessage(cfg.botToken, chatId, respText, { reply_markup: kb }, cfg.proxyUrl);
  } else {
    // Multiple matches - let user pick
    const kb: TelegramInlineKeyboard = {
      inline_keyboard: matched.map((m) => [
        { text: `${m.name} (${m.target})`, callback_data: `chk:${m.id}` }
      ])
    };
    await sendMessage(cfg.botToken, chatId, `Найдено несколько сервисов. Выберите нужный:`, { reply_markup: kb }, cfg.proxyUrl);
  }
}

async function handlePauseCommand(chatId: string | number, query: string, pause: boolean, cfg: ActiveTelegramConfig) {
  if (!query) {
    const cmdName = pause ? '/pause' : '/resume';
    await sendMessage(
      cfg.botToken,
      chatId,
      `Укажите имя или адрес монитора.\nПример: <code>${cmdName} Google</code>`,
      {},
      cfg.proxyUrl
    );
    return;
  }

  const monitors = dbQueries.getAllMonitors();
  const q = query.toLowerCase();
  const matched = monitors.find(
    (m) => m.name.toLowerCase().includes(q) || m.target.toLowerCase().includes(q) || m.id.toLowerCase() === q
  );

  if (!matched) {
    await sendMessage(cfg.botToken, chatId, `❌ Сервис «${escapeHtml(query)}» не найден.`, {}, cfg.proxyUrl);
    return;
  }

  dbQueries.updateMonitor(matched.id, { is_paused: pause ? 1 : 0 });
  const actionText = pause ? `⏸ Монитор <b>«${escapeHtml(matched.name)}»</b> поставлен на паузу.` : `▶ Монитор <b>«${escapeHtml(matched.name)}»</b> возобновлен.`;

  await sendMessage(cfg.botToken, chatId, actionText, {}, cfg.proxyUrl);
}

async function sendSslMessage(chatId: string | number, cfg: ActiveTelegramConfig, editMsgId?: number) {
  const monitors = dbQueries.getAllMonitors().filter((m) => m.check_ssl === 1 || m.ssl_days_remaining !== null);

  if (monitors.length === 0) {
    const text = '🔒 В системе нет мониторов с активной проверкой SSL-сертификатов.';
    if (editMsgId) {
      await editMessageText(cfg.botToken, chatId, editMsgId, text, {}, cfg.proxyUrl);
    } else {
      await sendMessage(cfg.botToken, chatId, text, {}, cfg.proxyUrl);
    }
    return;
  }

  // Sort by days remaining ascending
  monitors.sort((a, b) => (a.ssl_days_remaining ?? 9999) - (b.ssl_days_remaining ?? 9999));

  const lines = [
    `🔒 <b>Сроки действия SSL-сертификатов:</b>`,
    ``
  ];

  for (const m of monitors) {
    const days = m.ssl_days_remaining;
    let icon = '🟢';
    let textDays = '';

    if (days === null || days === undefined) {
      icon = '⚪';
      textDays = 'ожидание проверки';
    } else if (days <= 0) {
      icon = '🔴';
      textDays = '<b>ИСТЕК!</b>';
    } else if (days <= m.ssl_alert_days) {
      icon = '🟡';
      textDays = `<b>${days} дн. (Скоро истекает!)</b>`;
    } else {
      textDays = `${days} дн.`;
    }

    lines.push(`${icon} <b>${escapeHtml(m.name)}</b>: ${textDays}`);
    if (m.ssl_expiry_date) {
      lines.push(`   <small>Истекает: ${escapeHtml(m.ssl_expiry_date)}</small>`);
    }
  }

  const kb: TelegramInlineKeyboard = {
    inline_keyboard: [
      [
        { text: '📊 Статус', callback_data: 'cmd:status' },
        { text: '🖥 Мониторы', callback_data: 'cmd:monitors' }
      ]
    ]
  };

  const text = lines.join('\n');

  if (editMsgId) {
    await editMessageText(cfg.botToken, chatId, editMsgId, text, { reply_markup: kb }, cfg.proxyUrl);
  } else {
    await sendMessage(cfg.botToken, chatId, text, { reply_markup: kb }, cfg.proxyUrl);
  }
}

async function sendIncidentsMessage(chatId: string | number, cfg: ActiveTelegramConfig, editMsgId?: number) {
  const active = dbQueries.getActiveIncidents();
  const recent = dbQueries.getRecentIncidents(6);

  const lines = [`⚠️ <b>Журнал аварий и инцидентов</b>`, ``];

  if (active.length > 0) {
    lines.push(`🔴 <b>АКТИВНЫЕ СБОИ ПРЯМО СЕЙЧАС (${active.length}):</b>`);
    for (const inc of active) {
      const minAgo = Math.round((Date.now() - inc.started_at) / (1000 * 60));
      lines.push(`• <b>${escapeHtml(inc.monitor_name)}</b>: ${escapeHtml(inc.cause)} <i>(${minAgo} мин назад)</i>`);
    }
    lines.push(``);
  } else {
    lines.push(`🟢 <i>Активных сбоев в данный момент нет. Все сервисы работают штатно.</i>`);
    lines.push(``);
  }

  if (recent.length > 0) {
    lines.push(`📋 <b>Последние устранённые инциденты:</b>`);
    for (const inc of recent) {
      const durationMin = Math.round((inc.duration_seconds || 0) / 60);
      const timeStr = new Date(inc.started_at).toLocaleString('ru-RU');
      lines.push(`• <b>${escapeHtml(inc.monitor_name)}</b>: длился ${durationMin} мин. (${timeStr})`);
    }
  }

  const kb: TelegramInlineKeyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Обновить', callback_data: 'cmd:incidents' },
        { text: '📊 Статус', callback_data: 'cmd:status' }
      ]
    ]
  };

  const text = lines.join('\n');

  if (editMsgId) {
    await editMessageText(cfg.botToken, chatId, editMsgId, text, { reply_markup: kb }, cfg.proxyUrl);
  } else {
    await sendMessage(cfg.botToken, chatId, text, { reply_markup: kb }, cfg.proxyUrl);
  }
}

async function handleAddCommand(chatId: string | number, args: string, cfg: ActiveTelegramConfig) {
  if (!args) {
    await sendMessage(
      cfg.botToken,
      chatId,
      [
        `➕ <b>Добавление нового монитора</b>`,
        ``,
        `Используйте формат:`,
        `<code>/add &lt;URL или IP:PORT&gt; [Имя монитора]</code>`,
        ``,
        `Примеры:`,
        `• <code>/add https://mywebsite.com Мой Сайт</code>`,
        `• <code>/add https://api.myproject.ru/health</code>`,
        `• <code>/add 192.168.1.100:5432 PostgreSQL Сервер</code>`
      ].join('\n'),
      {},
      cfg.proxyUrl
    );
    return;
  }

  const tokens = args.split(/\s+/);
  let target = tokens[0].trim();
  const name = tokens.slice(1).join(' ').trim() || target.replace(/^https?:\/\//i, '').split('/')[0];

  let type = 'http';
  let checkSsl = 0;
  let port: number | null = null;

  if (target.startsWith('https://')) {
    type = 'http,ssl';
    checkSsl = 1;
  } else if (target.startsWith('http://')) {
    type = 'http';
    checkSsl = 0;
  } else if (target.includes(':') && !target.includes('/')) {
    // e.g. 1.2.3.4:8080
    const [host, portStr] = target.split(':');
    port = parseInt(portStr, 10) || null;
    target = host;
    type = 'port';
  } else {
    // If user entered "domain.com", auto-prepend https://
    target = `https://${target}`;
    type = 'http,ssl';
    checkSsl = 1;
  }

  const id = randomUUID();
  const now = Date.now();

  const newMonitor: Partial<MonitorRow> & { id: string; name: string; target: string } = {
    id,
    name,
    type,
    target,
    port,
    interval: 60,
    timeout: 10000,
    retry_count: 2,
    check_ssl: checkSsl,
    ssl_alert_days: 14,
    status: 'pending',
    current_latency: 0,
    last_checked_at: 0,
    last_status_change: now,
    consecutive_failures: 0,
    is_paused: 0,
    created_at: now
  };

  dbQueries.createMonitor(newMonitor);

  await sendMessage(cfg.botToken, chatId, `⏳ Монитор <b>«${escapeHtml(name)}»</b> создан. Выполняется первичная диагностика...`, {}, cfg.proxyUrl);

  const monitorRow = dbQueries.getMonitorById(id);
  if (!monitorRow) return;

  const result = await executeMonitorCheck(monitorRow);
  const isUp = result.status === 'online';
  const icon = isUp ? '🟢' : result.status === 'degraded' ? '🟡' : '🔴';

  const respText = [
    `✅ <b>МОНИТОР УСПЕШНО ДОБАВЛЕН!</b>`,
    ``,
    `📍 Имя: <b>${escapeHtml(name)}</b>`,
    `🔗 Адрес: <code>${escapeHtml(target)}${port ? `:${port}` : ''}</code>`,
    `📡 Тип проверки: <code>${type.toUpperCase()}</code>`,
    `⏱ Интервал: <b>каждые 60 сек</b>`,
    ``,
    `🔍 <b>Первичная проверка:</b> ${icon} <b>${result.status.toUpperCase()}</b>`,
    `⚡ Отклик: <b>${result.latency} мс</b>`,
    result.statusCode ? `📄 HTTP Код: <b>${result.statusCode}</b>` : '',
    result.ssl?.daysRemaining !== undefined ? `🔒 SSL-сертификат: <b>${result.ssl.daysRemaining} дн.</b>` : '',
    result.error ? `<blockquote expandable>⚠️ <b>Сбой:</b>\n<code>${escapeHtml(result.error)}</code></blockquote>` : ''
  ]
    .filter(Boolean)
    .join('\n');

  const kb: TelegramInlineKeyboard = {
    inline_keyboard: [
      [
        { text: '🔄 Проверить сейчас', callback_data: `chk:${id}` },
        { text: '⏸ На паузу', callback_data: `pau:${id}` }
      ],
      [
        { text: '🖥 Список всех мониторов', callback_data: 'cmd:monitors' }
      ]
    ]
  };

  await sendMessage(cfg.botToken, chatId, respText, { reply_markup: kb }, cfg.proxyUrl);
}

function escapeHtml(str: string): string {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getHelpText(role: 'admin' | 'viewer' = 'admin'): string {
  const isAdmin = role === 'admin';
  const roleBadge = isAdmin ? '👑 Администратор' : '👁️ Наблюдатель';

  const lines = [
    `🗼 <b>Watchtower Monitoring Bot</b>`,
    `Круглосуточный мониторинг сервисов, API и SSL-сертификатов.`,
    `👤 <b>Ваша роль:</b> ${roleBadge}`,
    ``,
    `📌 <b>Доступные команды:</b>`,
    `• <b>/status</b> — общая сводка доступности инфраструктуры`,
    `• <b>/monitors</b> — список всех добавленных сервисов`,
    `• <b>/check &lt;имя или ID&gt;</b> — мгновенная экспресс-проверка`,
    `• <b>/ssl</b> — статус и сроки истечения SSL-сертификатов`,
    `• <b>/incidents</b> — журнал недавних сбоев и аварий`
  ];

  if (isAdmin) {
    lines.push(
      `• <b>/pause &lt;имя&gt;</b> — поставить монитор на паузу`,
      `• <b>/resume &lt;имя&gt;</b> — возобновить мониторинг`,
      `• <b>/add &lt;URL&gt; [имя]</b> — добавить новый монитор`
    );
  }

  lines.push(
    ``,
    `<i>Нажмите кнопку ниже для быстрого действия:</i>`
  );

  return lines.join('\n');
}

export function getHelpKeyboard(role: 'admin' | 'viewer' = 'admin'): TelegramInlineKeyboard {
  const isAdmin = role === 'admin';
  const rows: TelegramInlineButton[][] = [
    [
      { text: '📊 Статус инфраструктуры', callback_data: 'cmd:status' },
      { text: '🖥 Мониторы', callback_data: 'cmd:monitors' }
    ],
    [
      { text: '🔒 SSL-сертификаты', callback_data: 'cmd:ssl' },
      { text: '⚠️ Инциденты', callback_data: 'cmd:incidents' }
    ]
  ];

  if (isAdmin) {
    rows.push([
      { text: '➕ Добавить монитор', callback_data: 'cmd:add' }
    ]);
  }

  return {
    inline_keyboard: rows
  };
}

/**
 * Sends a welcome message to newly authorized Telegram users once their User ID is saved in Watchtower.
 */
export async function sendWelcomeToUsers(userIds: string[], rawConfig: any): Promise<void> {
  const token = (rawConfig.botToken || '').trim();
  if (!token || !userIds || userIds.length === 0) return;

  const rawProxy = rawConfig.proxyUrl || '';
  const proxyUrl = rawProxy ? normalizeProxyUrl(rawProxy) : undefined;

  const parsedUsers = parseAllowedUsers(rawConfig.allowedUsers ?? rawConfig.userIds ?? rawConfig.allowedUserIds ?? rawConfig.userId ?? '');

  const kb: TelegramInlineKeyboard = {
    inline_keyboard: [
      [
        { text: '📊 Статус системы', callback_data: 'cmd:status' },
        { text: '🖥 Список мониторов', callback_data: 'cmd:monitors' }
      ],
      [
        { text: 'ℹ️ Справка по командам', callback_data: 'cmd:help' }
      ]
    ]
  };

  for (const uid of userIds) {
    const userRec = parsedUsers.find((u) => u.id === uid) || { id: uid, name: '', role: 'admin' as const };
    const isAdmin = userRec.role === 'admin';

    const welcomeLines = [
      `🎉 <b>Добро пожаловать в Watchtower!</b>`,
      ``,
      isAdmin
        ? `Администратор предоставил вам доступ с правами 👑 <b>Администратора</b>.`
        : `Администратор предоставил вам доступ с правами 👁️ <b>Наблюдателя</b> (только чтение).`,
      ``,
      `Вам доступны следующие возможности прямо из этого чата:`,
      `• 🔔 Мгновенные алерты о сбоях сервисов и SSL-сертификатов`,
      `• 🔄 Интерактивные кнопки перепроверки сервисов`,
      `• 📊 <b>/status</b> — общая сводка доступности и Uptime`,
      `• 🖥 <b>/monitors</b> — список сервисов`,
      `• 🔍 <b>/check &lt;url/имя&gt;</b> — мгновенная экспресс-проверка`,
      `• 🔒 <b>/ssl</b> — статус SSL-сертификатов`,
      `• ⚠️ <b>/incidents</b> — список инцидентов`
    ];

    if (isAdmin) {
      welcomeLines.push(
        `• ➕ <b>/add &lt;url&gt; [имя]</b> — быстрое добавление сервиса`,
        `• ⏸ <b>/pause &lt;id&gt;</b> и ▶️ <b>/resume &lt;id&gt;</b> — управление мониторингом`
      );
    }

    welcomeLines.push(
      ``,
      `<i>Нажмите кнопку ниже или отправьте /start для начала работы:</i>`
    );

    const welcomeHtml = welcomeLines.join('\n');

    try {
      console.log(`[TelegramBot] Sending proactive welcome message to newly authorized user: ${uid} (Role: ${userRec.role})...`);
      const res = await sendMessage(
        token,
        uid,
        welcomeHtml,
        { reply_markup: kb },
        proxyUrl
      );
      if (res.ok) {
        console.log(`[TelegramBot] Welcome message successfully delivered to user ${uid}!`);
      } else {
        console.warn(`[TelegramBot] Telegram API returned error delivering welcome to user ${uid}:`, res.description);
      }
    } catch (err: any) {
      console.warn(`[TelegramBot] Failed to send welcome to user ${uid}:`, err.message);
    }
  }
}

