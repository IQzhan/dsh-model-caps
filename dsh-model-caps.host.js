/**
 * dsh-model-caps.host.js — Cordis adapter.
 *
 * On mount, and whenever `llm-pi-ai` settings change in a way that leaves a
 * custom model without a context window, output cap, or thinking levels,
 * fill those blanks. A settings section talks to this process over
 * `/api/dsh-model-caps`. `mountModelCaps` returns nothing: Cordis treats
 * `apply`'s return as the plugin effect and rejects a plain object.
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

  const run = async (force) => {
    const settings = typeof ctx.get === 'function' ? ctx.get('settings') : ctx.settings
    if (settings === undefined || typeof settings.describe !== 'function' || typeof settings.mutate !== 'function') {
      last = { ...last, ok: false, running: false, error: 'settings unavailable' }
      return last
    }
    const described = settings.describe().find((entry) => entry.ns === SETTINGS_NS)
    const gap = gapSignature(described?.user)
    if (!force && gap === settledGap) return last
    last = { ...last, running: true, error: null }
    try {
      const result = await syncCaps({
        settings,
        credentials: typeof ctx.get === 'function' ? ctx.get('credentials') : undefined,
        fetch: globalThis.fetch.bind(globalThis),
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
      if (ns === SETTINGS_NS) void enqueue(false)
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
    ctx.inject(['webServer'], registerRoute)
    ctx.inject(['settings'], () => { void enqueue(false) })
  }
}

export { mountModelCaps }
