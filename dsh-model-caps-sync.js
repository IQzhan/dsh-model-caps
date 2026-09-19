/**
 * dsh-model-caps-sync — one pass over custom providers.
 *
 * The provider listing wins per field. A public catalog fills a field only
 * when every record that publishes it agrees (thinking levels: the
 * intersection). Blank fields are the only ones written. Failures of one
 * route do not drop the others.
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

function clip(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 240 ? text.slice(0, 240) : text
}

async function readJson(fetchImpl, url, headers, timeoutMs) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const text = await response.text()
  if (text.length > MAX_BODY_BYTES) throw new Error(`${url} answered with too much data`)
  return JSON.parse(text)
}

async function resolveKey(credentials, ref) {
  if (ref === undefined || credentials === undefined || typeof credentials.resolve !== 'function') {
    return undefined
  }
  const hit = await credentials.resolve(ref)
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
