/**
 * dsh-model-caps-sync — one pass over custom providers.
 *
 * The provider listing wins per field. Otherwise the model's maker on
 * models.dev supplies the field. Reseller copies are not intersected.
 * A catalog-shaped effort map with no `compat` block is refreshed, because
 * that shape is what an earlier fill wrote. A custom wire is left alone.
 *
 * @module dsh-model-caps-sync
 */

import {
  CATALOG_URL,
  MAX_BODY_BYTES,
  SETTINGS_NS,
  customRoutes,
  listingHeaders,
  listingUrl,
  planMutations,
  readListing,
  indexCatalog,
} from './dsh-model-caps-core.js'

const FETCH_TIMEOUT_MS = 20_000
let cachedProxy

function proxyFromEnv() {
  const names = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']
  for (const name of names) {
    const raw = process.env[name]
    if (typeof raw === 'string' && raw.length > 0) return withScheme(raw)
  }
  return undefined
}

function withScheme(raw) {
  const https = raw.match(/(?:^|;)\s*https=([^;\s]+)/)
  const value = (https?.[1] ?? raw.split(';')[0]).trim()
  if (value.length === 0) return undefined
  return value.includes('://') ? value : `http://${value}`
}

function proxyFromWindows() {
  if (process.platform !== 'win32' || typeof process.getBuiltinModule !== 'function') return undefined
  let execFileSync
  try {
    execFileSync = process.getBuiltinModule('child_process').execFileSync
  } catch {
    return undefined
  }
  try {
    const text = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { encoding: 'utf8', timeout: 2000, windowsHide: true })
    const enabled = text.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/)
    if (enabled === null || Number.parseInt(enabled[1], 16) === 0) return undefined
    const server = text.match(/ProxyServer\s+REG_SZ\s+(\S+)/)
    if (server === null) return undefined
    return withScheme(server[1])
  } catch {
    return undefined
  }
}

/** Node's fetch ignores the operating-system proxy unless one is passed per request. */
function proxyUrl() {
  if (cachedProxy !== undefined) return cachedProxy.length > 0 ? cachedProxy : undefined
  cachedProxy = proxyFromEnv() ?? proxyFromWindows() ?? ''
  return cachedProxy.length > 0 ? cachedProxy : undefined
}

function clip(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 240 ? text.slice(0, 240) : text
}

function decodeChunked(buffer) {
  const chunks = []
  let offset = 0
  while (offset < buffer.length) {
    const line = buffer.indexOf('\r\n', offset)
    if (line < 0) break
    const size = Number.parseInt(buffer.subarray(offset, line).toString('utf8'), 16)
    if (!Number.isFinite(size) || size === 0) break
    const start = line + 2
    chunks.push(buffer.subarray(start, start + size))
    offset = start + size + 2
  }
  return Buffer.concat(chunks)
}

/**
 * DSH installs a direct undici dispatcher, which ignores `fetch`'s proxy option.
 * A CONNECT tunnel does not go through that dispatcher.
 */
function fetchViaConnect(url, headers, timeoutMs, proxy) {
  const target = new URL(url)
  const gate = new URL(proxy)
  const http = process.getBuiltinModule('http')
  const tls = process.getBuiltinModule('tls')
  const port = target.port.length > 0 ? target.port : '443'
  const signal = AbortSignal.timeout(timeoutMs)
  return new Promise((resolve, reject) => {
    let socket
    let secure
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      socket?.destroy()
      secure?.destroy()
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const fail = (error) => {
      const code = error?.code
      finish(new Error(code ? `fetch failed (${code})` : 'fetch failed'))
    }
    signal.addEventListener('abort', () => { fail(new Error('fetch failed (timeout)')) }, { once: true })
    const req = http.request({
      host: gate.hostname,
      port: gate.port.length > 0 ? gate.port : 80,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { host: `${target.hostname}:${port}` },
      signal,
    })
    req.once('error', fail)
    req.once('connect', (response, connected) => {
      socket = connected
      if (response.statusCode !== 200) {
        finish(new Error(`proxy answered ${String(response.statusCode)}`))
        return
      }
      secure = tls.connect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] })
      secure.once('error', fail)
      secure.once('secureConnect', () => {
        const lines = [`GET ${target.pathname}${target.search} HTTP/1.1`, `host: ${target.host}`, 'connection: close']
        for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
        secure.write(`${lines.join('\r\n')}\r\n\r\n`)
      })
      const chunks = []
      secure.on('data', (chunk) => { chunks.push(chunk) })
      secure.once('end', () => {
        const raw = Buffer.concat(chunks)
        const split = raw.indexOf('\r\n\r\n')
        if (split < 0) {
          fail(new Error('fetch failed'))
          return
        }
        const head = raw.subarray(0, split).toString('utf8')
        const status = Number(head.slice(0, head.indexOf('\r\n')).split(' ')[1])
        let body = raw.subarray(split + 4)
        if (/transfer-encoding:\s*chunked/i.test(head)) body = decodeChunked(body)
        const text = body.toString('utf8')
        finish(undefined, {
          ok: status >= 200 && status < 300,
          status,
          text: async () => text,
        })
      })
    })
    req.end()
  })
}

function usesBuiltInFetch(fetchImpl) {
  return fetchImpl === globalThis.fetch && fetchImpl.name === 'fetch'
}

async function readJson(fetchImpl, url, headers, timeoutMs) {
  const proxy = proxyUrl()
  let response
  if (proxy !== undefined && usesBuiltInFetch(fetchImpl)) {
    try {
      response = await fetchViaConnect(url, headers, timeoutMs, proxy)
    } catch {
      response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
    }
  } else {
    const init = {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...proxy === undefined ? {} : { proxy },
    }
    try {
      response = await fetchImpl(url, init)
    } catch (error) {
      if (proxy === undefined) throw error
      response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
    }
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const text = await response.text()
  if (text.length > MAX_BODY_BYTES) throw new Error(`${url} answered with too much data`)
  return JSON.parse(text)
}

async function resolveKey(credentials, ref) {
  if (ref === undefined || credentials === undefined) return undefined
  // Cordis hands out a traceable proxy. Calling `.resolve` on it rebinds
  // `this` to a shadow context whose store is empty, so the listing goes out
  // unauthenticated. The raw service is the object that actually holds keys.
  const raw = credentials[Symbol.for('cordis.original')] ?? credentials
  if (typeof raw.resolve !== 'function') return undefined
  const hit = await raw.resolve(ref)
  const value = hit?.value
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * @param io.settings - `describe()` + `mutate(ns, ops, revision)`.
 * @param io.credentials - optional `resolve(ref) -> { value }`.
 * @param io.fetch - `fetch(url, init)`.
 * @param io.timeoutMs - per-request ceiling.
 */
async function syncCaps(io) {
  const settings = io.settings
  const fetchImpl = io.fetch
  const timeoutMs = io.timeoutMs ?? FETCH_TIMEOUT_MS
  const described = settings.describe().find((entry) => entry.ns === SETTINGS_NS)
  if (described === undefined || described.user === undefined) {
    return { ok: true, skipped: 'no-llm-pi-ai', providers: [], wrote: 0, catalogError: null }
  }
  const routes = customRoutes(described.user)
  if (routes.length === 0) {
    return { ok: true, skipped: 'no-custom-providers', providers: [], wrote: 0, catalogError: null }
  }

  const listings = {}
  const providers = []
  for (const route of routes) {
    const report = { id: route.id, ok: true, filled: 0, error: null }
    try {
      const apiKey = await resolveKey(io.credentials, route.apiKeyEnv)
      const url = listingUrl(route.baseURL, route.api)
      const body = await readJson(fetchImpl, url, listingHeaders(route.api, apiKey), timeoutMs)
      listings[route.id] = readListing(body)
    } catch (error) {
      report.ok = false
      report.error = clip(error)
      listings[route.id] = []
    }
    providers.push(report)
  }

  let catalog = {}
  let catalogError = null
  try {
    const body = await readJson(fetchImpl, CATALOG_URL, { accept: 'application/json' }, timeoutMs)
    catalog = indexCatalog(body)
  } catch (error) {
    catalogError = clip(error)
  }

  let planned = planMutations(described.user, listings, catalog)
  if (planned.ops.length > 0) {
    try {
      await settings.mutate(SETTINGS_NS, planned.ops, described.revision)
    } catch (error) {
      if (error?.code !== 'SETTINGS_CONFLICT') throw error
      const again = settings.describe().find((entry) => entry.ns === SETTINGS_NS)
      planned = planMutations(again?.user, listings, catalog)
      if (planned.ops.length > 0) await settings.mutate(SETTINGS_NS, planned.ops, again?.revision)
    }
  }
  for (const report of providers) report.filled = planned.filled[report.id] ?? 0
  const listingOk = providers.every((report) => report.ok)
  return {
    ok: listingOk && catalogError === null,
    skipped: null,
    providers,
    wrote: planned.ops.length,
    catalogError,
  }
}

export { FETCH_TIMEOUT_MS, syncCaps }
