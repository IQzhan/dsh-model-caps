/**
 * dsh-model-caps-sync — one pass over custom providers.
 *
 * Pipeline: optional pi-ai builtins (projected onto the route api), then the
 * provider listing per field, then models.dev. See DESIGN.md.
 *
 * Outbound requests use the process `fetch` as-is. Proxy policy belongs to
 * the host process (environment or a preload), not this plugin.
 *
 * @module dsh-model-caps-sync
 */

import {
  CATALOG_URL,
  MAX_BODY_BYTES,
  SETTINGS_NS,
  customRoutes,
  indexBuiltins,
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

/** Optional peer: when DSH has pi-ai installed, reuse its proven catalog rows. */
async function loadBuiltins() {
  const indexFrom = (mod) => {
    const providers = typeof mod.getBuiltinProviders === 'function' ? mod.getBuiltinProviders() : []
    const getModels = mod.getBuiltinModels
    if (typeof getModels !== 'function' || !Array.isArray(providers)) return {}
    const rows = []
    for (const provider of providers) {
      const models = getModels(provider)
      if (Array.isArray(models)) rows.push(...models)
    }
    return indexBuiltins(rows)
  }

  try {
    return indexFrom(await import('@earendil-works/pi-ai/providers/all'))
  } catch {
    // Plugin lives under the profile node_modules; pi-ai usually sits under the
    // DSH host tree. Resolve from nearby package.json files, then import by URL.
  }

  try {
    const { existsSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { pathToFileURL } = await import('node:url')
    const { createRequire } = await import('node:module')
    const packageHints = []
    const seedDirs = [process.cwd()]
    if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) {
      seedDirs.push(dirname(process.argv[1]))
    }
    // CJS host bundle exposes __filename; ESM source leaves it unset.
    try {
      // eslint-disable-next-line no-undef
      if (typeof __filename === 'string') seedDirs.push(dirname(__filename))
    } catch { /* ignore */ }
    for (const seed of seedDirs) {
      let dir = seed
      for (let i = 0; i < 12; i += 1) {
        packageHints.push(join(dir, 'package.json'))
        packageHints.push(join(dir, 'packages', 'llm', 'llm-pi-ai', 'package.json'))
        packageHints.push(join(dir, 'apps', 'cli', 'package.json'))
        packageHints.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai', 'package.json'))
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
    const tried = new Set()
    for (const pkg of packageHints) {
      if (!existsSync(pkg) || tried.has(pkg)) continue
      tried.add(pkg)
      let paths = []
      try {
        paths = createRequire(pkg).resolve.paths('@earendil-works/pi-ai') || []
      } catch {
        continue
      }
      for (const root of paths) {
        const file = join(root, '@earendil-works', 'pi-ai', 'dist', 'providers', 'all.js')
        if (!existsSync(file)) continue
        try {
          return indexFrom(await import(pathToFileURL(file).href))
        } catch { /* try next */ }
      }
    }
  } catch { /* ignore */ }

  return {}
}

/**
 * @param io.settings - `describe()` + `mutate(ns, ops, revision)`.
 * @param io.credentials - optional `resolve(ref) -> { value }`.
 * @param io.fetch - `fetch(url, init)`.
 * @param io.timeoutMs - per-request ceiling.
 * @param io.builtins - optional prebuilt index (tests); otherwise loaded from pi-ai.
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

  const builtins = io.builtins ?? await loadBuiltins()

  let planned = planMutations(described.user, listings, catalog, builtins)
  if (planned.ops.length > 0) {
    try {
      await settings.mutate(SETTINGS_NS, planned.ops, described.revision)
    } catch (error) {
      if (error?.code !== 'SETTINGS_CONFLICT') throw error
      const again = settings.describe().find((entry) => entry.ns === SETTINGS_NS)
      planned = planMutations(again?.user, listings, catalog, builtins)
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

export { FETCH_TIMEOUT_MS, loadBuiltins, syncCaps }
