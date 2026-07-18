import { config } from './config.js'
import { log } from './logger.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Futures month codes -> month number (1-12)
const MONTHS = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 }
const FULL_SYMBOL_RE = /^[A-Z]{1,4}[FGHJKMNQUVXZ]\d$/ // e.g. ESH6, MNQM6
const SIX_HOURS = 6 * 60 * 60 * 1000

/**
 * Minimal, resilient Tradovate REST client for an automated webhook bridge.
 * Handles: token lifecycle (cache + renew + penalty back-off), account resolution,
 * symbol/contract resolution, and order actions (buy/sell/close-all/close-partial).
 */
class TradovateClient {
  constructor() {
    this.accessToken = null
    this.expiresAt = 0        // epoch ms
    this.account = null       // { id, name }
    this.penaltyUntil = 0     // epoch ms — don't call auth before this
    this._authPromise = null
    this._contractCache = new Map() // key -> { id, name, ts }
  }

  // ---- low-level request helper --------------------------------------------
  async _req(method, pathName, { body, auth = true, query } = {}) {
    let url = config.restBase + pathName
    if (query) {
      const qs = new URLSearchParams(query).toString()
      url += (url.includes('?') ? '&' : '?') + qs
    }
    const headers = { 'content-type': 'application/json', accept: 'application/json' }
    if (auth) {
      const token = await this.ensureAuth()
      headers.authorization = 'Bearer ' + token
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
    if (res.status === 401 && auth) {
      // token rejected -> drop it so the next call re-authenticates
      this.accessToken = null
      this.expiresAt = 0
    }
    return { status: res.status, ok: res.ok, data }
  }

  // ---- authentication -------------------------------------------------------
  async ensureAuth() {
    const now = Date.now()
    if (this.accessToken && now < this.expiresAt - 10 * 60 * 1000) return this.accessToken
    if (this._authPromise) return this._authPromise

    const haveToken = !!this.accessToken && now < this.expiresAt
    const op = haveToken ? this._renew() : this._authenticate()
    this._authPromise = op
      .catch(async (e) => {
        if (haveToken) {
          log.warn('token renew failed, re-authenticating', { err: String(e?.message || e) })
          this.accessToken = null
          return this._authenticate()
        }
        throw e
      })
      .finally(() => { this._authPromise = null })
    return this._authPromise
  }

  async _authenticate() {
    const t = config.tradovate
    const base = {
      name: t.name,
      password: t.password,
      appId: t.appId,
      appVersion: t.appVersion,
      cid: isNaN(Number(t.cid)) ? t.cid : Number(t.cid),
      sec: t.sec,
      deviceId: t.deviceId,
      hibpCheck: false,
    }
    if (Date.now() < this.penaltyUntil) {
      await sleep(this.penaltyUntil - Date.now())
    }
    let pTicket = null
    for (let attempt = 1; attempt <= 6; attempt++) {
      const body = pTicket ? { ...base, 'p-ticket': pTicket } : base
      const res = await fetch(config.restBase + '/auth/accessTokenRequest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))

      if (data.accessToken) {
        this._store(data)
        log.info('Tradovate auth OK', { env: config.env, user: data.name, expires: data.expirationTime })
        await this._ensureAccount()
        return this.accessToken
      }
      if (data['p-ticket']) {
        if (data['p-captcha']) {
          this.penaltyUntil = Date.now() + 60 * 60 * 1000
          throw new Error('Tradovate requires CAPTCHA (too many attempts). Log in once manually to clear, then wait ~1h. Check username/password/cid/sec.')
        }
        const wait = Number(data['p-time']) || 60
        log.warn(`Tradovate penalty: waiting ${wait}s then retrying auth`, { attempt })
        pTicket = data['p-ticket']
        await sleep(wait * 1000 + 500)
        continue
      }
      throw new Error('Tradovate auth failed: ' + (data.errorText || JSON.stringify(data)))
    }
    throw new Error('Tradovate auth failed after repeated penalties')
  }

  async _renew() {
    const res = await fetch(config.restBase + '/auth/renewAccessToken', {
      method: 'GET',
      headers: { authorization: 'Bearer ' + this.accessToken, accept: 'application/json' },
    })
    const data = await res.json().catch(() => ({}))
    if (data['p-ticket']) throw new Error('renew penalised')
    if (!data.accessToken) throw new Error('renew failed: ' + (data.errorText || JSON.stringify(data)))
    this._store(data)
    log.info('Tradovate token renewed', { expires: data.expirationTime })
    return this.accessToken
  }

  _store(data) {
    this.accessToken = data.accessToken
    this.mdAccessToken = data.mdAccessToken || this.mdAccessToken
    this.expiresAt = data.expirationTime ? Date.parse(data.expirationTime) : Date.now() + 80 * 60 * 1000
  }

  // ---- accounts -------------------------------------------------------------
  async _ensureAccount() {
    if (this.account) return this.account
    const { ok, data } = await this._req('GET', '/account/list')
    if (!ok || !Array.isArray(data) || !data.length) {
      throw new Error('Could not fetch Tradovate accounts: ' + JSON.stringify(data))
    }
    let acct
    if (config.tradovate.accountId) acct = data.find((a) => a.id === config.tradovate.accountId)
    else if (config.tradovate.accountSpec) acct = data.find((a) => a.name === config.tradovate.accountSpec)
    else acct = data.find((a) => a.active) || data[0]
    if (!acct) {
      throw new Error('No matching Tradovate account. Available: ' + data.map((a) => a.name).join(', '))
    }
    this.account = { id: acct.id, name: acct.name }
    log.info('Using Tradovate account', this.account)
    return this.account
  }

  // ---- symbol / contract resolution ----------------------------------------
  normalizeSymbol(sym) {
    let s = String(sym || '').trim().toUpperCase()
    if (s.includes(':')) s = s.split(':').pop() // CME_MINI:ESH2025 -> ESH2025
    return s
  }

  /**
   * Resolve any TradingView-style symbol to a tradeable Tradovate contract
   * { id, name }. Accepts: full single-digit (ESH6), 2/4-digit year (ESH25 / ESH2025),
   * or a root / continuous symbol (ES, ES1!, @ES) -> auto front-month.
   */
  async resolveContract(sym) {
    const raw = this.normalizeSymbol(sym)
    let m
    if ((m = raw.match(/^([A-Z]{1,4})([FGHJKMNQUVXZ])(\d{4})$/))) // ESH2025
      return this._lookupContract(m[1] + m[2] + m[3].slice(-1))
    if ((m = raw.match(/^([A-Z]{1,4})([FGHJKMNQUVXZ])(\d{2})$/))) // ESH25
      return this._lookupContract(m[1] + m[2] + m[3].slice(-1))
    if (FULL_SYMBOL_RE.test(raw)) // ESH6
      return this._lookupContract(raw)
    const root = raw.replace(/[^A-Z]/g, '') // ES1! / @ES -> ES
    if (!root) throw new Error('Could not parse symbol: ' + sym)
    return this._frontMonth(root)
  }

  async _lookupContract(symbol) {
    const cached = this._contractCache.get(symbol)
    if (cached && Date.now() - cached.ts < SIX_HOURS) return cached
    const { ok, data } = await this._req('GET', '/contract/find', { query: { name: symbol } })
    if (ok && data && data.id) {
      const c = { id: data.id, name: data.name, ts: Date.now() }
      this._contractCache.set(symbol, c)
      return c
    }
    throw new Error('Contract not found on Tradovate: ' + symbol + ' (must be a full dated, tradeable contract)')
  }

  async _frontMonth(root) {
    const key = '@front:' + root
    const cached = this._contractCache.get(key)
    if (cached && Date.now() - cached.ts < SIX_HOURS) return cached

    const { ok, data } = await this._req('GET', '/contract/suggest', { query: { t: root, l: 20 } })
    if (!ok || !Array.isArray(data) || !data.length) throw new Error('No contracts found for root: ' + root)
    const re = new RegExp('^' + root + '([FGHJKMNQUVXZ])(\\d)$')
    const candidates = data.filter((c) => re.test(c.name))
    if (!candidates.length) throw new Error('No dated contracts for root ' + root + ' in: ' + data.map((d) => d.name).join(','))

    // Preferred: pick the nearest contract whose maturity is > frontMonthMinDays away.
    const minMs = config.frontMonthMinDays * 24 * 3600 * 1000
    try {
      for (const c of candidates) {
        if (!c.contractMaturityId) continue
        const r = await this._req('GET', '/contractMaturity/item', { query: { id: c.contractMaturityId } })
        const exp = r.ok && r.data && r.data.expirationDate ? Date.parse(r.data.expirationDate) : NaN
        if (Number.isFinite(exp) && exp - Date.now() > minMs) {
          return this._cacheFront(key, c)
        }
      }
    } catch (e) {
      log.warn('front-month maturity lookup failed, falling back to symbol parsing', { err: String(e?.message || e) })
    }

    // Fallback: parse month/year out of each symbol and choose the nearest future one.
    const now = new Date()
    const parsed = candidates
      .map((c) => {
        const mm = c.name.match(re)
        const month = MONTHS[mm[1]]
        const yd = Number(mm[2])
        const base = Math.floor(now.getFullYear() / 10) * 10
        const year = [base + yd - 10, base + yd, base + yd + 10]
          .reduce((b, y) => (Math.abs(y - now.getFullYear()) < Math.abs(b - now.getFullYear()) ? y : b))
        return { c, exp: new Date(year, month - 1, 15).getTime() }
      })
      .filter((x) => x.exp > Date.now() - 20 * 24 * 3600 * 1000)
      .sort((a, b) => a.exp - b.exp)
    if (!parsed.length) throw new Error('Could not resolve front month for ' + root)
    return this._cacheFront(key, parsed[0].c)
  }

  _cacheFront(key, c) {
    const front = { id: c.id, name: c.name, ts: Date.now() }
    this._contractCache.set(key, front)
    log.info('Resolved front-month contract', { root: key.replace('@front:', ''), symbol: front.name })
    return front
  }

  // ---- order result interpretation -----------------------------------------
  // Tradovate returns HTTP 200 for BOTH accepted and rejected orders.
  _orderResult(status, data, ctx) {
    const reason = data && data.failureReason
    const accepted = !!(data && data.orderId) && (!reason || reason === 'Success')
    if (accepted) return { success: true, orderId: data.orderId, ...ctx }
    const err = (data && (data.failureText || data.failureReason || data.errorText)) || `HTTP ${status}`
    return { success: false, error: err, raw: data, ...ctx }
  }

  // Best-effort: confirm an order's real status (200 + orderId != filled).
  async _confirm(orderId) {
    if (!config.confirmOrders || !orderId) return null
    try {
      await sleep(config.confirmDelayMs)
      const { ok, data } = await this._req('GET', '/order/item', { query: { id: orderId } })
      if (ok && data && data.ordStatus) return data.ordStatus // Filled | Working | Rejected | Canceled ...
    } catch (e) {
      log.warn('order confirm failed', { orderId, err: String(e?.message || e) })
    }
    return null
  }

  // ---- order actions --------------------------------------------------------
  async placeOrder({ action, symbol, qty, orderType = 'Market', price, stopPrice, tif, clOrdId, confirm = true }) {
    const acct = await this._ensureAccount()
    const contract = await this.resolveContract(symbol)
    const body = {
      accountSpec: acct.name,
      accountId: acct.id,
      action, // 'Buy' | 'Sell'
      symbol: contract.name,
      orderQty: Math.abs(Number(qty)),
      orderType, // 'Market' | 'Limit' | 'Stop' | 'StopLimit'
      isAutomated: true,
    }
    if (orderType === 'Limit' || orderType === 'StopLimit') body.price = Number(price)
    if (orderType === 'Stop' || orderType === 'StopLimit') body.stopPrice = Number(stopPrice)
    if (orderType !== 'Market') body.timeInForce = tif || 'GTC'
    if (clOrdId) body.clOrdId = String(clOrdId)

    if (!Number.isFinite(body.orderQty) || body.orderQty <= 0) {
      return { success: false, error: 'Invalid qty: ' + qty, action, symbol: contract.name }
    }

    const { status, data } = await this._req('POST', '/order/placeOrder', { body })
    const result = this._orderResult(status, data, { action, symbol: contract.name, qty: body.orderQty, orderType })
    if (result.success && confirm) {
      const st = await this._confirm(result.orderId)
      if (st) {
        result.status = st
        if (st === 'Rejected') { result.success = false; result.error = 'Order rejected by exchange' }
      }
    }
    return result
  }

  async closeAll(symbol) {
    const acct = await this._ensureAccount()
    const contract = await this.resolveContract(symbol)
    const pos = await this._positionFor(contract.id)
    if (!pos || pos.netPos === 0) {
      return { success: true, flat: true, message: 'No open position for ' + contract.name, symbol: contract.name }
    }
    const { status, data } = await this._req('POST', '/order/liquidatePosition', {
      body: { accountId: acct.id, contractId: contract.id, admin: false },
    })
    const result = this._orderResult(status, data, { action: 'CloseAll', symbol: contract.name, closedQty: Math.abs(pos.netPos) })
    // liquidatePosition flattens the position but does NOT cancel resting orders.
    if (config.cancelOrdersOnClose) {
      result.cancelledOrders = await this._cancelWorkingOrders(contract.id).catch((e) => {
        log.warn('cancel working orders failed', { err: String(e?.message || e) })
        return 0
      })
    }
    return result
  }

  // Reduce a position by a fixed number of contracts (qty) OR a percentage (pct)
  // of the live net position. Always position-aware: never flips the position.
  async closePartial(symbol, { qty, pct } = {}) {
    const contract = await this.resolveContract(symbol)
    const pos = await this._positionFor(contract.id)
    if (!pos || pos.netPos === 0) {
      return { success: true, flat: true, message: 'No open position for ' + contract.name, symbol: contract.name }
    }
    const have = Math.abs(pos.netPos)
    let closeQty
    if (pct != null && Number.isFinite(Number(pct)) && Number(pct) > 0) {
      closeQty = Math.max(1, Math.round((have * Number(pct)) / 100))
    } else {
      closeQty = Math.abs(Number(qty))
    }
    closeQty = Math.min(closeQty, have) // never close more than we hold (no flip)
    if (!Number.isFinite(closeQty) || closeQty <= 0) {
      return { success: false, error: 'Invalid partial size (need qty or pct): qty=' + qty + ' pct=' + pct, symbol: contract.name }
    }
    const side = pos.netPos > 0 ? 'Sell' : 'Buy'
    const r = await this.placeOrder({ action: side, symbol: contract.name, qty: closeQty, orderType: 'Market' })
    return { ...r, action: 'ClosePartial', netPosBefore: pos.netPos, closedQty: closeQty }
  }

  async _positionFor(contractId) {
    const acct = await this._ensureAccount()
    const { ok, data } = await this._req('GET', '/position/list')
    if (!ok || !Array.isArray(data)) return null
    return data.find((p) => p.contractId === contractId && p.accountId === acct.id) || null
  }

  async _cancelWorkingOrders(contractId) {
    const acct = await this._ensureAccount()
    const { ok, data } = await this._req('GET', '/order/list')
    if (!ok || !Array.isArray(data)) return 0
    const open = new Set(['Working', 'PendingNew', 'PendingReplace', 'Suspended', 'Pending'])
    const targets = data.filter((o) => o.accountId === acct.id && o.contractId === contractId && open.has(o.ordStatus))
    let cancelled = 0
    for (const o of targets) {
      const r = await this._req('POST', '/order/cancelOrder', { body: { orderId: o.id } })
      if (r.ok) cancelled++
    }
    if (cancelled) log.info('Cancelled working orders on close', { contractId, cancelled })
    return cancelled
  }

  // ---- status (for the /status endpoint) -----------------------------------
  async getStatus() {
    await this.ensureAuth()
    const acct = await this._ensureAccount()
    const { data } = await this._req('GET', '/position/list')
    const positions = Array.isArray(data)
      ? data.filter((p) => p.netPos !== 0 && p.accountId === acct.id)
        .map((p) => ({ contractId: p.contractId, netPos: p.netPos, netPrice: p.netPrice }))
      : []
    return {
      env: config.env,
      account: acct,
      tokenExpires: this.expiresAt ? new Date(this.expiresAt).toISOString() : null,
      positions,
    }
  }
}

export const tradovate = new TradovateClient()
