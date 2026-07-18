import { config } from './config.js'
import { log } from './logger.js'

async function post(url, payload) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!r.ok) log.warn('notifier non-OK response', { url: url.split('?')[0], status: r.status })
    return r.ok
  } catch (e) {
    log.warn('notifier failed', { err: String(e?.message || e) })
    return false
  }
}

/**
 * Sends a human-readable message. Always logs; additionally pushes to Telegram /
 * Discord if those env vars are configured (off by default — logs only).
 */
export async function notify(text, level = 'info') {
  log[level === 'error' ? 'error' : 'info']('NOTIFY ' + text)
  const { telegramToken, telegramChat, discordWebhook } = config.notify
  const tasks = []
  if (telegramToken && telegramChat) {
    tasks.push(post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      chat_id: telegramChat,
      text,
      disable_web_page_preview: true,
    }))
  }
  if (discordWebhook) {
    tasks.push(post(discordWebhook, { content: text }))
  }
  if (tasks.length) await Promise.allSettled(tasks)
}
