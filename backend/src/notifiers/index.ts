import { dbQueries } from '../db/index.js';
import { sendTelegramMessage, TelegramConfig } from './telegram.js';
import { sendMaxMessage, MaxConfig } from './max.js';
import { TelegramInlineKeyboard } from './telegramApi.js';

export type AlertEventType = 'DOWN' | 'UP' | 'DEGRADED' | 'SSL_EXPIRING' | 'SSL_EXPIRED';

export interface AlertContext {
  monitorId?: string;
  monitorName: string;
  monitorTarget: string;
  type: AlertEventType;
  error?: string | null;
  latency?: number;
  downtimeDuration?: string;
  sslDaysRemaining?: number | null;
  sslExpiryDate?: string | null;
}

function escapeHtml(str: string): string {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatAlertMessage(ctx: AlertContext, isHtml = true): string {
  const timeStr = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  const bold = (s: string) => (isHtml ? `<b>${s}</b>` : `*${s}*`);
  const code = (s: string) => (isHtml ? `<code>${s}</code>` : `\`${s}\``);

  switch (ctx.type) {
    case 'DOWN':
      return [
        `🔴 ${bold('СЕРВИС НЕДОСТУПЕН')}`,
        '',
        `📍 Сервис: ${bold(escapeHtml(ctx.monitorName))}`,
        `🔗 Адрес: ${code(escapeHtml(ctx.monitorTarget))}`,
        `⏱ Время: <code>${timeStr}</code>`,
        '',
        isHtml
          ? `<blockquote expandable>⚠️ <b>Диагностика сбоя:</b>\n<code>${escapeHtml(ctx.error || 'Неизвестная ошибка подключения')}</code></blockquote>`
          : `⚠️ Ошибка: ${code(ctx.error || 'Неизвестная ошибка')}`
      ].join('\n');

    case 'UP':
      return [
        `🟢 ${bold('СЕРВИС ВОССТАНОВЛЕН')}`,
        '',
        `📍 Сервис: ${bold(escapeHtml(ctx.monitorName))}`,
        `🔗 Адрес: ${code(escapeHtml(ctx.monitorTarget))}`,
        ctx.downtimeDuration ? `⌛ Время простоя: ${bold(ctx.downtimeDuration)}` : '',
        ctx.latency !== undefined ? `⚡ Задержка: ${bold(`${ctx.latency} мс`)}` : '',
        `⏱ Время: <code>${timeStr}</code>`
      ].filter(Boolean).join('\n');

    case 'DEGRADED':
      return [
        `🟡 ${bold('ДЕГРАДАЦИЯ СЕРВИСА')}`,
        '',
        `📍 Сервис: ${bold(escapeHtml(ctx.monitorName))}`,
        `🔗 Адрес: ${code(escapeHtml(ctx.monitorTarget))}`,
        ctx.latency ? `⚡ Задержка отклика: ${bold(`${ctx.latency} мс`)}` : '',
        `⏱ Время: <code>${timeStr}</code>`,
        '',
        ctx.error && isHtml
          ? `<blockquote expandable>⚠️ <b>Причина:</b>\n<code>${escapeHtml(ctx.error)}</code></blockquote>`
          : ctx.error
          ? `⚠️ Причина: ${code(ctx.error)}`
          : ''
      ].filter(Boolean).join('\n');

    case 'SSL_EXPIRING':
      return [
        `🔒 ${bold('ВНИМАНИЕ: ИСТЕКАЕТ SSL-СЕРТИФИКАТ')}`,
        '',
        `📍 Сервис: ${bold(escapeHtml(ctx.monitorName))}`,
        `🔗 Адрес: ${code(escapeHtml(ctx.monitorTarget))}`,
        `⏳ Осталось дней: ${bold(`${ctx.sslDaysRemaining}`)}`,
        ctx.sslExpiryDate ? `📅 Дата окончания: ${code(ctx.sslExpiryDate)}` : '',
        `⏱ Время: <code>${timeStr}</code>`
      ].filter(Boolean).join('\n');

    case 'SSL_EXPIRED':
      return [
        `⛔ ${bold('КРИТИЧЕСКИ: SSL-СЕРТИФИКАТ ИСТЁК')}`,
        '',
        `📍 Сервис: ${bold(escapeHtml(ctx.monitorName))}`,
        `🔗 Адрес: ${code(escapeHtml(ctx.monitorTarget))}`,
        `⏱ Время: <code>${timeStr}</code>`,
        '',
        isHtml
          ? `<blockquote expandable>⚠️ <b>Ошибка:</b>\n<code>${escapeHtml(ctx.error || 'Сертификат просрочен')}</code></blockquote>`
          : `⚠️ Ошибка: ${code(ctx.error || 'Сертификат просрочен')}`
      ].filter(Boolean).join('\n');

    default:
      return `ℹ️ Оповещение от Watchtower: ${escapeHtml(ctx.monitorName)} (${ctx.type})`;
  }
}

export async function broadcastAlert(ctx: AlertContext) {
  const channels = dbQueries.getNotificationChannels();
  const htmlMsg = formatAlertMessage(ctx, true);
  const textMsg = formatAlertMessage(ctx, false);

  for (const ch of channels) {
    if (!ch.is_enabled) continue;

    try {
      const config = JSON.parse(ch.config);
      if (ch.type === 'telegram') {
        let kb: TelegramInlineKeyboard | undefined;
        if (ctx.monitorId) {
          if (ctx.type === 'DOWN') {
            kb = {
              inline_keyboard: [
                [
                  { text: '🔄 Перепроверить', callback_data: `chk:${ctx.monitorId}` },
                  { text: '🔕 Заглушить 1ч', callback_data: `snz:${ctx.monitorId}:60` }
                ],
                [
                  { text: '⏸ На паузу', callback_data: `pau:${ctx.monitorId}` },
                  { text: 'ℹ️ Что за ошибка?', callback_data: `exp:${ctx.monitorId}` }
                ]
              ]
            };
          } else if (ctx.type === 'DEGRADED') {
            kb = {
              inline_keyboard: [
                [
                  { text: '🔄 Перепроверить', callback_data: `chk:${ctx.monitorId}` },
                  { text: '🔕 Заглушить 1ч', callback_data: `snz:${ctx.monitorId}:60` }
                ],
                [
                  { text: 'ℹ️ Что за ошибка?', callback_data: `exp:${ctx.monitorId}` }
                ]
              ]
            };
          } else if (ctx.type === 'UP') {
            kb = {
              inline_keyboard: [
                [
                  { text: '📊 Все мониторы', callback_data: 'cmd:monitors' },
                  { text: '🔄 Проверить снова', callback_data: `chk:${ctx.monitorId}` }
                ]
              ]
            };
          }
        }
        await sendTelegramMessage(config as TelegramConfig, htmlMsg, kb);
      } else if (ch.type === 'max') {
        await sendMaxMessage(config as MaxConfig, textMsg);
      }
    } catch (err) {
      console.error(`Error sending notification to channel ${ch.name} (${ch.type}):`, err);
    }
  }
}

export async function sendTestNotification(
  type: 'telegram' | 'max',
  config: TelegramConfig | MaxConfig
): Promise<{ success: boolean; error?: string }> {
  const timeStr = new Date().toLocaleString('ru-RU');
  const testHtml = [
    `🚀 <b>Тестовое оповещение от Watchtower!</b>`,
    ``,
    `Канал Telegram настроен и готов к работе.`,
    `Бот круглосуточно отслеживает состояние ваших мониторов.`,
    ``,
    `⏱ <i>Время отправки: ${timeStr}</i>`
  ].join('\n');

  const testText = `🚀 Тестовое оповещение от Watchtower!\nКанал настроен успешно.\nВремя: ${timeStr}`;

  if (type === 'telegram') {
    const kb: TelegramInlineKeyboard = {
      inline_keyboard: [
        [
          { text: '📊 Проверить статус', callback_data: 'cmd:status' },
          { text: '🖥 Мониторы', callback_data: 'cmd:monitors' }
        ]
      ]
    };
    return sendTelegramMessage(config as TelegramConfig, testHtml, kb);
  } else if (type === 'max') {
    return sendMaxMessage(config as MaxConfig, testText);
  }

  return { success: false, error: 'Unknown notification channel type' };
}

export { testProxyConnection } from './telegram.js';
export { startTelegramBot, stopTelegramBot, restartTelegramBot } from './telegramBotService.js';
