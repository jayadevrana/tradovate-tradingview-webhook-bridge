import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function bool(v, def = false) {
  if (v == null || v === '') return def
  return /^(1|true|yes|on)$/i.test(String(v).trim())
}
function num(v, def) {
  const n = Number(v)
  return Number.isFinite(n) ? n : def
}

const ENV = (process.env.TRADOVATE_ENV || 'demo').toLowerCase()
const isLive = ENV === 'live'

// REST + market-data base URLs per environment.
const REST_BASE = isLive
  ? 'https://live.tradovateapi.com/v1'
  : 'https://demo.tradovateapi.com/v1'
const MD_BASE = isLive
  ? 'wss://md.tradovateapi.com/v1/websocket'
  : 'wss://md-demo.tradovateapi.com/v1/websocket'

// A stable deviceId helps Tradovate recognise this app and avoid extra throttling.
const DEVICE_FILE = path.join(ROOT, '.device-id')
let deviceId = process.env.TRADOVATE_DEVICE_ID
if (!deviceId) {
  try { deviceId = fs.readFileSync(DEVICE_FILE, 'utf8').trim() } catch { /* ignore */ }
  if (!deviceId) {
    deviceId = crypto.randomUUID()
    try { fs.writeFileSync(DEVICE_FILE, deviceId) } catch { /* ignore */ }
  }
}

export const config = {
  env: ENV,
  isLive,
  restBase: REST_BASE,
  mdBase: MD_BASE,
  tradovate: {
    name: process.env.TRADOVATE_USERNAME || '',
    password: process.env.TRADOVATE_PASSWORD || '',
    appId: process.env.TRADOVATE_APP_ID || 'TV-Bridge',
    appVersion: process.env.TRADOVATE_APP_VERSION || '1.0',
    cid: process.env.TRADOVATE_CID || '',
    sec: process.env.TRADOVATE_SEC || '',
    deviceId,
    accountSpec: process.env.TRADOVATE_ACCOUNT_SPEC || '',
    accountId: process.env.TRADOVATE_ACCOUNT_ID ? num(process.env.TRADOVATE_ACCOUNT_ID, null) : null,
  },
  server: {
    port: num(process.env.PORT, 80),
    host: process.env.HOST || '0.0.0.0',
  },
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  enforceIpAllowlist: bool(process.env.ENFORCE_IP_ALLOWLIST, false),
  allowedIps: (process.env.ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean),
  defaultQty: num(process.env.DEFAULT_QTY, 1),
  dryRun: bool(process.env.DRY_RUN, false),
  // Forward/white-label mode: when set, the bridge translates incoming signals into
  // TradersPost's format and forwards them to this URL (used for prop accounts that
  // can't use the direct Tradovate API). In this mode Tradovate creds aren't required.
  traderspostUrl: process.env.TRADERSPOST_WEBHOOK_URL || '',
  // Behaviour toggles
  frontMonthMinDays: num(process.env.FRONT_MONTH_MIN_DAYS, 3), // skip near-expiry contract when auto-resolving a root
  cancelOrdersOnClose: bool(process.env.CANCEL_ORDERS_ON_CLOSE, true), // also cancel resting orders on "close"
  confirmOrders: bool(process.env.CONFIRM_ORDERS, true), // poll order status after placing (200 != filled)
  confirmDelayMs: num(process.env.CONFIRM_DELAY_MS, 700),
  logLevel: process.env.LOG_LEVEL || 'info',
  logDir: process.env.LOG_DIR || path.join(ROOT, 'logs'),
  notify: {
    telegramToken: process.env.NOTIFY_TELEGRAM_TOKEN || '',
    telegramChat: process.env.NOTIFY_TELEGRAM_CHAT || '',
    discordWebhook: process.env.NOTIFY_DISCORD_WEBHOOK || '',
  },
}

// TradingView's published webhook source IP addresses (for optional allow-listing).
export const TRADINGVIEW_IPS = ['52.89.214.238', '34.212.75.30', '54.218.53.128', '52.32.178.7']

// Returns the list of REQUIRED settings that are still missing.
export function validateConfig() {
  const missing = []
  if (!config.webhookSecret || config.webhookSecret === 'CHANGE_ME_to_a_long_random_string') {
    missing.push('WEBHOOK_SECRET')
  }
  // Forward mode (TradersPost) doesn't need Tradovate credentials.
  if (!config.traderspostUrl) {
    const t = config.tradovate
    if (!t.name) missing.push('TRADOVATE_USERNAME')
    if (!t.password) missing.push('TRADOVATE_PASSWORD')
    if (!t.cid) missing.push('TRADOVATE_CID')
    if (!t.sec) missing.push('TRADOVATE_SEC')
  }
  return missing
}
