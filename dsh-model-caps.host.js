/**
 * dsh-model-caps.host.js — Cordis adapter.
 *
 * On mount, and whenever the user saves `llm-pi-ai` settings, fill blank
 * caps. The plugin's own write is ignored so it does not sync again.
 * `mountModelCaps` returns nothing: Cordis treats `apply`'s return as the
 * plugin effect and rejects a plain object.
 *
 * @module dsh-model-caps/host
 */

function mountModelCaps(ctx) {
  let last = {
    ok: true,
    running: false,
    at: null,
    error: null,
    skipped: null,
    wrote: 0,
    providers: [],
    catalogError: null,
  }
  let chain = Promise.resolve()
  let settledGap = null
  let credentials
  let ownWrite = 0

  const run = async (force) => {
    const settings = typeof ctx.get === 'function' ? ctx.get('settings') : ctx.settings
    if (settings === undefined || typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') {
      last = { ...last, ok: false, running: false, error: 'settings unavailable' }
      return last
    }
    const described = settings.describe().find((entry) => entry.ns === SETTINGS_NS)
    const gap = gapSignature(described?.user)
    if (!force && gap === settledGap) return last
    const guarded = {
      describe: () => settings.describe(),
      mutate: async (ns, ops, revision) => {
        ownWrite += 1
        try {
          return await settings.mutate(ns, ops, revision)
        } finally {
          ownWrite -= 1
        }
      },
    }
    last = { ...last, running: true, error: null }
    try {
      const result = await syncCaps({
        settings: guarded,
        credentials,
        fetch: globalThis.fetch,
      })
      const next = settings.describe().find((entry) => entry.ns === SETTINGS_NS)
      settledGap = gapSignature(next?.user)
      last = {
        ok: result.ok,
        running: false,
        at: new Date().toISOString(),
        error: null,
        skipped: result.skipped,
        wrote: result.wrote,
        providers: result.providers,
        catalogError: result.catalogError,
      }
    } catch (error) {
      last = {
        ...last,
        ok: false,
        running: false,
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
    return last
  }

  const enqueue = (force) => {
    const job = chain.then(() => run(force))
    chain = job.catch(() => {})
    return job
  }

  if (typeof ctx.on === 'function') {
    ctx.on('settings/updated', (ns) => {
      if (ns !== SETTINGS_NS || ownWrite > 0) return
      void enqueue(true)
    })
  }

  const sendJson = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  const serve = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = decodeURIComponent(url.pathname.replace(/^\/api\/dsh-model-caps\/?/, '')) || 'status'
    try {
      if ((method === 'status' || method === 'health') && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(res, 200, last)
        return
      }
      if (method === 'sync' && req.method === 'POST') {
        sendJson(res, 200, await enqueue(true))
        return
      }
      sendJson(res, 404, { error: `unknown method ${JSON.stringify(method)}` })
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const registerRoute = (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/api/dsh-model-caps',
      handler: serve,
    }))
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['credentials'], (scope) => {
      credentials = scope.credentials
      // The settings hook may have already run a pass before this service
      // existed. Force one more so that pass is not the one that sticks.
      void enqueue(true)
    })
    ctx.inject(['webServer'], registerRoute)
    ctx.inject(['settings'], () => { void enqueue(false) })
  }
}

export { mountModelCaps }
