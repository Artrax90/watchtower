import { dbQueries } from '../db/index.js';
import { sendTelegramMessage, TelegramConfig } from './telegram.js';
import { sendMaxMessage, MaxConfig } from './max.js';

export type AlertEventType = 'DOWN' | 'UP' | 'DEGRADED' | 'SSL_EXPIRING' | 'SSL_EXPIRED';

export interface AlertContext {
  monitorName: string;
  monitorTarget: string;
  type: AlertEventType;
  error?: string | null;
  latency?: number;
  downtimeDuration?: string;
  sslDaysRemaining?: number | null;
  sslExpiryDate?: string | null;
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
        `📍 Сервис: ${bold(ctx.monitorName)}`,
        `🔗 Адрес: ${code(ctx.monitorTarget)}`,
        `⚠️ Ошибка: ${code(ctx.error || 'Неизвестная ошибка')}`,
        `⏱ Время: ${timeStr}`
      ].join('\n');

    case 'UP':
      return [
        `🟢 ${bold('СЕРВИС ВОССТАНОВЛЕН')}`,
        '',
        `📍 Сервис: ${bold(ctx.monitorName)}`,
        `🔗 Адрес: ${code(ctx.monitorTarget)}`,
        ctx.downtimeDuration ? `⌛ Время простоя: ${bold(ctx.downtimeDuration)}` : '',
        ctx.latency !== undefined ? `⚡ Задержка: ${bold(`${ctx.latency} мс`)}` : '',
        `⏱ Время: ${timeStr}`
      ].filter(Boolean).join('\n');

    case 'DEGRADED':
      return [
        `🟡 ${bold('ДЕГРАДАЦИЯ СЕРВИСА')}`,
        '',
        `📍 Сервис: ${bold(ctx.monitorName)}`,
        `🔗 Адрес: ${code(ctx.monitorTarget)}`,
        ctx.error ? `⚠️ Причина: ${code(ctx.error)}` : '',
        ctx.latency ? `⚡ Задержка: ${bold(`${ctx.latency} мс`)}` : '',
        `⏱ Время: ${timeStr}`
      ].filter(Boolean).join('\n');

    case 'SSL_EXPIRING':
      return [
        `🔒 ${bold('ВНИМАНИЕ: ИСТЕКАЕТ SSL-СЕРТИФИКАТ')}`,
        '',
        `📍 Сервис: ${bold(ctx.monitorName)}`,
        `🔗 Адрес: ${code(ctx.monitorTarget)}`,
        `⏳ Осталось дней: ${bold(`${ctx.sslDaysRemaining}`)}`,
        ctx.sslExpiryDate ? `📅 Дата окончания: ${code(ctx.sslExpiryDate)}` : '',
        `⏱ Время: ${timeStr}`
      ].filter(Boolean).join('\n');

    case 'SSL_EXPIRED':
      return [
        `⛔ ${bold('КРИТИЧЕСКИ: SSL-СЕРТИФИКАТ ИСТЁК')}`,
        '',
        `📍 Сервис: ${bold(ctx.monitorName)}`,
        `🔗 Адрес: ${code(ctx.monitorTarget)}`,
        ctx.error ? `⚠️ Ошибка: ${code(ctx.error)}` : '',
        `⏱ Время: ${timeStr}`
      ].filter(Boolean).join('\n');

    default:
      return `ℹ️ Оповещение от Watchtower: ${ctx.monitorName} (${ctx.type})`;
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
        await sendTelegramMessage(config as TelegramConfig, htmlMsg);
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
  const testText = `🚀 Тестовое оповещение от Watchtower!\nКанал настроен успешно.\nВремя: ${new Date().toLocaleString('ru-RU')}`;

  if (type === 'telegram') {
    return sendTelegramMessage(config as TelegramConfig, testText);
  } else if (type === 'max') {
    return sendMaxMessage(config as MaxConfig, testText);
  }

  return { success: false, error: 'Unknown notification channel type' };
}

export { testProxyConnection } from './telegram.js';
