import { config } from './config.js'
import { log } from './logger.js'

// Translate a Blue Algo signal into TradersPost's webhook schema.
//   buy/sell        -> action buy/sell (position-aware: closes opposite, opens new)
//   close/exit      -> action exit  (full flatten)
//   close_partial   -> action exit + quantity (or percent_of_position)
function toTradersPost({ action, symbol, qty, pct, price, test }) {
  const base = { ticker: symbol }
  if (price != null && Number.isFinite(Number(price))) base.signalPrice = Number(price)
  if (test) base.test = true

  switch (action) {
    case 'buy': case 'long':
      return { ...base, action: 'buy', quantity: qty }
    case 'sell': case 'short':
      return { ...base, action: 'sell', quantity: qty }
    case 'close': case 'closeall': case 'close_all': case 'exit': case 'flat': case 'flatten':
      return { ...base, action: 'exit' }
    case 'close_partial': case 'closepartial': case 'partial': case 'reduce':
      if (pct != null && Number.isFinite(Number(pct)) && Number(pct) > 0) {
        return { ...base, action: 'exit', quantity: Number(pct), quantityType: 'percent_of_position' }
      }
      return { ...base, action: 'exit', quantity: qty }
    default:
      return null
  }
}

export async function forwardToTradersPost({ action, symbol, qty, pct, price, test }) {
  const payload = toTradersPost({ action, symbol, qty, pct, price, test })
  if (!payload) return { success: false, error: `Unknown action "${action}". Use: buy | sell | close | close_partial` }
  if (!payload.ticker) return { success: false, error: 'Missing symbol/ticker' }

  try {
    const res = await fetch(config.traderspostUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const text = await res.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
    if (res.ok) {
      log.info('Forwarded to TradersPost', { payload, status: res.status })
      return { success: true, forwarded: payload, response: data }
    }
    log.error('TradersPost rejected signal', { status: res.status, payload, response: data })
    return { success: false, error: `TradersPost HTTP ${res.status}`, forwarded: payload, response: data }
  } catch (e) {
    log.error('Forward to TradersPost failed', { err: String(e?.message || e), payload })
    return { success: false, error: String(e?.message || e), forwarded: payload }
  }
}
