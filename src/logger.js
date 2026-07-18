import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[config.logLevel] ?? 20

fs.mkdirSync(config.logDir, { recursive: true })
const stream = fs.createWriteStream(path.join(config.logDir, 'bridge.log'), { flags: 'a' })

const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }
const RESET = '\x1b[0m'

function emit(level, msg, extra) {
  if ((LEVELS[level] || 20) < threshold) return
  const t = new Date().toISOString()
  const rec = { t, level, msg, ...(extra || {}) }
  try { stream.write(JSON.stringify(rec) + '\n') } catch { /* ignore */ }
  const tail = extra && Object.keys(extra).length ? ' ' + JSON.stringify(extra) : ''
  // eslint-disable-next-line no-console
  console.log(`${COLORS[level] || ''}${t} ${level.toUpperCase().padEnd(5)}${RESET} ${msg}${tail}`)
}

export const log = {
  debug: (m, e) => emit('debug', m, e),
  info: (m, e) => emit('info', m, e),
  warn: (m, e) => emit('warn', m, e),
  error: (m, e) => emit('error', m, e),
}
