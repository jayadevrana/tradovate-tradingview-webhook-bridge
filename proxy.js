// Zero-dependency reverse proxy for port 80 so the Tradovate bridge can coexist
// with the existing MT5 bridge on the same box.
//   /tradovate/*  -> Tradovate Node app (prefix stripped)
//   everything else -> MT5 bridge (passed through unchanged)
import http from 'node:http'

const PORT = Number(process.env.PROXY_PORT || 80)
const HOST = process.env.PROXY_HOST || '0.0.0.0'
const PREFIX = process.env.TRADOVATE_PREFIX || '/tradovate'

function parseUp(s, def) {
  const [host, port] = String(s || def).split(':')
  return { host, port: Number(port) }
}
const TRADO = parseUp(process.env.TRADOVATE_UPSTREAM, '127.0.0.1:8081')
const MT5 = parseUp(process.env.MT5_UPSTREAM, '127.0.0.1:8090')

const server = http.createServer((req, res) => {
  let target, path
  if (req.url === PREFIX || req.url.startsWith(PREFIX + '/')) {
    target = TRADO
    path = req.url.slice(PREFIX.length) || '/'
    if (!path.startsWith('/')) path = '/' + path
  } else {
    target = MT5
    path = req.url
  }
  const up = http.request(
    { host: target.host, port: target.port, method: req.method, path, headers: req.headers, timeout: 15000 },
    (upRes) => { res.writeHead(upRes.statusCode || 502, upRes.headers); upRes.pipe(res) }
  )
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'upstream unavailable', upstream: `${target.host}:${target.port}`, detail: String(e.message) }))
  })
  up.on('timeout', () => up.destroy(new Error('upstream timeout')))
  req.pipe(up)
})

server.listen(PORT, HOST, () => {
  console.log(`[edge-proxy] listening :${PORT}  ${PREFIX}/* -> ${TRADO.host}:${TRADO.port}  |  * -> ${MT5.host}:${MT5.port}`)
})
