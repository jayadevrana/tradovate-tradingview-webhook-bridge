import express from 'express'
import crypto from 'node:crypto'
import { config, validateConfig } from './config.js'
import { log } from './logger.js'
import { tradovate } from './tradovate.js'
import { forwardToTradersPost } from './forwarder.js'
import { notify } from './notifier.js'

const app = express()
app.set('trust proxy', true)
// Capture the raw body for ANY content-type (TradingView sends application/json
// for valid JSON, otherwise text/plain — we can't control it).
app.use(express.text({ type: () => true, limit: '64kb' }))

// keep the last N webhooks in memory for the /status page
const recent = []
function remember(entry) { recent.unshift(entry); if (recent.length > 50) recent.pop() }

// simple idempotency: ignore the same id within a 2-minute window
const seen = new Map()
function isDuplicate(id) {
  if (!id) return false
  const now = Date.now()
  for (const [k, ts] of seen) if (now - ts > 120000) seen.delete(k)
  if (seen.has(id)) return true
  seen.set(id, now)
  return false
}

function clientIp(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return xf || req.socket.remoteAddress || ''
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''))
  const bb = Buffer.from(String(b || ''))
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

function parseBody(req) {
  const raw = (req.body || '').toString().trim()
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return v[0] || {}   // accept [{...}] (MT-style) too
    return v
  } catch { return { _text: raw } }
}

// Single-message strategy mode. An invite-only strategy can only emit ONE static
// alert message, so we send TradingView's position placeholders and work out the
// real intent here (entry / scale-out partial / reversal / full exit).
// Returns null when the message has no position info (i.e. it's an explicit signal).
function interpretStrategy(body) {
  const hasPos = body.position != null || body.position_size != null ||
                 body.market_position != null || body.now != null ||
                 body.prev != null || body.prev_market_position != null
  if (!hasPos) return null

  const orderAction = String(body.action ?? body.order_action ?? '').toLowerCase()
  const contracts = Math.abs(Number(body.contracts ?? body.qty ?? 0)) || 0
  const posAfter = Number(body.position ?? body.position_size ?? 0)
  const absPos = Math.abs(posAfter)
  const prev = String(body.prev ?? body.prev_market_position ?? '').toLowerCase()
  const now = String(body.now ?? body.market_position ??
    (posAfter > 0 ? 'long' : posAfter < 0 ? 'short' : 'flat')).toLowerCase()

  // Optional fixed broker-side sizing, independent of the strategy's own size.
  const eqN = Number(body.entryQty ?? body.entry_qty)
  const pqN = Number(body.partialQty ?? body.partial_qty)
  const eQ = Number.isFinite(eqN) && eqN > 0 ? eqN : null
  const pQ = Number.isFinite(pqN) && pqN > 0 ? pqN : null
  const entrySize = eQ != null ? eQ : (contracts || absPos || 1)   // entry / reverse size
  const partialSize = pQ != null ? pQ : (contracts || 1)           // partial-exit size

  if (now === 'flat' || posAfter === 0) return { action: 'close' }                    // full exit -> flatten
  if (prev === 'long' && now === 'short') return { action: 'sell', qty: entrySize }   // reverse to short
  if (prev === 'short' && now === 'long') return { action: 'buy', qty: entrySize }    // reverse to long
  if (now === 'long') {
    if (orderAction === 'sell') return { action: 'close_partial', qty: partialSize }  // scale out long
    return { action: 'buy', qty: entrySize }                                          // enter/add long
  }
  if (now === 'short') {
    if (orderAction === 'buy') return { action: 'close_partial', qty: partialSize }   // scale out short
    return { action: 'sell', qty: entrySize }                                         // enter/add short
  }
  return { action: orderAction === 'sell' ? 'sell' : 'buy', qty: entrySize }
}

const TRADING_ACTIONS = new Set([
  'buy', 'long', 'sell', 'short',
  'close', 'closeall', 'close_all', 'exit', 'flat', 'flatten',
  'close_partial', 'closepartial', 'partial', 'reduce',
])

const ORDER_TYPES = { market: 'Market', limit: 'Limit', stop: 'Stop', stoplimit: 'StopLimit' }
function normType(s) { return ORDER_TYPES[String(s || 'market').toLowerCase().replace(/[^a-z]/g, '')] || 'Market' }

// --- routes ----------------------------------------------------------------
app.get('/', (req, res) => res.json({ service: 'tradovate-tv-bridge', ok: true }))

app.get('/health', (req, res) => res.json({
  status: 'ok', env: config.env, dryRun: config.dryRun, live: config.isLive, time: new Date().toISOString(),
}))

app.get('/status', async (req, res) => {
  if (!safeEqual(req.query.secret, config.webhookSecret)) return res.status(401).json({ error: 'unauthorized' })
  if (config.traderspostUrl) {
    return res.json({ route: 'traderspost-forward', env: config.env, dryRun: config.dryRun, recent })
  }
  try {
    const s = await tradovate.getStatus()
    res.json({ ...s, dryRun: config.dryRun, recent })
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
})

app.post('/webhook', async (req, res) => {
  const ip = clientIp(req)
  const body = parseBody(req)
  const entry = { t: new Date().toISOString(), ip, body }

  // --- auth (4xx is fine: TradingView does NOT retry 4xx) ---
  const secret = body.secret ?? body.passphrase ?? req.query.secret ?? req.headers['x-webhook-secret']
  if (!config.webhookSecret || !safeEqual(secret, config.webhookSecret)) {
    log.warn('Rejected webhook: bad/missing secret', { ip })
    remember({ ...entry, result: { success: false, error: 'bad secret' } })
    return res.status(401).json({ error: 'unauthorized' })
  }
  if (config.enforceIpAllowlist && config.allowedIps.length && !config.allowedIps.includes(ip)) {
    log.warn('Rejected webhook: IP not allow-listed', { ip })
    return res.status(403).json({ error: 'ip not allowed' })
  }

  // --- idempotency ---
  const dedupeId = body.id ?? body.client_order_id ?? null
  if (isDuplicate(dedupeId)) {
    log.info('Duplicate webhook ignored', { id: dedupeId })
    return res.status(200).json({ success: true, duplicate: true })
  }

  let action = String(body.action ?? body.side ?? '').toLowerCase().trim()
  const symbol = body.symbol ?? body.ticker ?? ''
  let qty = Number(body.qty ?? body.quantity ?? body.contracts ?? config.defaultQty)
  const orderType = normType(body.order_type ?? body.orderType)
  const price = body.price != null ? Number(body.price) : undefined
  const stopPrice = body.stopPrice != null ? Number(body.stopPrice) : (body.stop != null ? Number(body.stop) : undefined)

  // Single-message strategy mode: derive the real intent from position placeholders.
  const intent = interpretStrategy(body)
  if (intent) {
    if (Number.isFinite(intent.qty)) qty = intent.qty
    log.info('Strategy signal interpreted', {
      from: { action, prev: body.prev ?? body.prev_market_position, now: body.now ?? body.market_position, pos: body.position ?? body.position_size, contracts: body.contracts },
      to: { action: intent.action, qty },
    })
    action = intent.action
  }

  log.info('Webhook received', { ip, action, symbol, qty, orderType, dryRun: config.dryRun })

  // IMPORTANT: respond 200 for anything we processed (success OR business
  // rejection OR internal error). TradingView retries 5xx up to 3x -> would
  // place duplicate orders. We surface failures in the JSON body + logs instead.
  let result
  try {
    if (config.dryRun && TRADING_ACTIONS.has(action)) {
      result = { success: true, dryRun: true, wouldDo: { action, symbol, qty, orderType, price, pct: body.pct ?? body.percent } }
    } else {
      result = await dispatch({ action, symbol, qty, orderType, price, stopPrice, body })
    }
  } catch (e) {
    result = { success: false, error: String(e?.message || e) }
    log.error('Webhook handler error', { err: result.error, action, symbol })
  }

  remember({ ...entry, result })
  notify(formatNotify(action, symbol, result), result.success === false ? 'error' : 'info').catch(() => {})
  return res.status(200).json(result)
})

async function dispatch({ action, symbol, qty, orderType, price, stopPrice, body }) {
  // Forward/white-label mode: translate + send to TradersPost (for prop accounts).
  if (config.traderspostUrl) {
    if (['message', 'ping', 'notify'].includes(action)) {
      return { success: true, message: body.message || body._text || 'ping' }
    }
    const pct = body.pct ?? body.percent
    return forwardToTradersPost({ action, symbol, qty, pct: pct != null ? Number(pct) : undefined, price, test: body.test === true })
  }
  switch (action) {
    case 'buy': case 'long':
      return tradovate.placeOrder({ action: 'Buy', symbol, qty, orderType, price, stopPrice, clOrdId: body.client_order_id })
    case 'sell': case 'short':
      return tradovate.placeOrder({ action: 'Sell', symbol, qty, orderType, price, stopPrice, clOrdId: body.client_order_id })
    case 'close': case 'closeall': case 'close_all': case 'exit': case 'flat': case 'flatten':
      return tradovate.closeAll(symbol)
    case 'close_partial': case 'closepartial': case 'partial': case 'reduce': {
      const pct = body.pct ?? body.percent
      return tradovate.closePartial(symbol, { qty, pct: pct != null ? Number(pct) : undefined })
    }
    case 'message': case 'ping': case 'notify':
      return { success: true, message: body.message || body._text || 'ping' }
    default:
      return { success: false, error: `Unknown action "${action}". Use: buy | sell | close | close_partial | message` }
  }
}

function formatNotify(action, symbol, r) {
  const sym = symbol || ''
  if (r.success === false) return `❌ ${action.toUpperCase()} ${sym} FAILED: ${r.error}`
  if (r.dryRun) return `🧪 DRY-RUN ${action.toUpperCase()} ${sym} ${JSON.stringify(r.wouldDo)}`
  if (['message', 'ping', 'notify'].includes(action)) return `💬 ${r.message}`
  if (r.flat) return `➡️ ${sym}: ${r.message}`
  const st = r.status ? ` [${r.status}]` : ''
  const c = r.cancelledOrders ? ` (cancelled ${r.cancelledOrders} orders)` : ''
  return `✅ ${action.toUpperCase()} ${sym} qty=${r.qty ?? r.closedQty ?? ''} orderId=${r.orderId ?? '-'}${st}${c}`
}

export function start() {
  const missing = validateConfig()
  if (missing.length) {
    log.error('Missing required configuration — fill these in .env then restart', { missing })
    log.error('See README "Client credentials checklist".')
  }

  app.listen(config.server.port, config.server.host, () => {
    log.info('TradingView -> Tradovate bridge listening', {
      url: `http://${config.server.host}:${config.server.port}`, env: config.env, dryRun: config.dryRun,
      route: config.traderspostUrl ? 'traderspost-forward' : 'tradovate-direct',
    })
    log.info(`Webhook endpoint: POST http://<server-ip>:${config.server.port}/webhook`)
    if (config.traderspostUrl) log.info('FORWARD MODE: signals are translated + forwarded to TradersPost.')
    if (config.dryRun) log.warn('DRY_RUN is ON — nothing will be placed/forwarded. Set DRY_RUN=false to trade.')
    if (config.isLive) log.warn('LIVE MODE — real-money orders are ENABLED.')
  })

  // Warm up auth + keep the token fresh (direct Tradovate mode only).
  if (!missing.length && !config.traderspostUrl) {
    tradovate.ensureAuth().catch((e) => log.error('Initial Tradovate auth failed', { err: String(e?.message || e) }))
    setInterval(() => {
      tradovate.ensureAuth().catch((e) => log.warn('Background token refresh failed', { err: String(e?.message || e) }))
    }, 15 * 60 * 1000).unref()
  }
}
