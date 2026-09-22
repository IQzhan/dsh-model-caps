import { createRequire } from 'node:module'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const require = createRequire(join(ROOT, 'package', 'package.json'))
let plugin
try {
  plugin = require(join(ROOT, 'package', 'lib', 'index.cjs'))
} catch (error) {
  console.error('host bundle missing; run node build-model-caps.mjs first:', error.message)
  process.exit(1)
}

check('host exports a name', plugin.name, 'dsh-model-caps')
check('host exports apply', typeof plugin.apply, 'function')
check('host injects nothing that might not exist', plugin.inject, [])
check('host default export mirrors apply', typeof plugin.default?.apply, 'function')

const user = {
  providers: {
    'b-ai': {
      api: 'openai-completions',
      baseURL: 'https://api.example/v1',
      apiKeyEnv: 'EXAMPLE_KEY',
      models: [{ id: 'm', name: 'M' }],
    },
  },
}
const mutations = []
const settings = {
  describe: () => [{ ns: 'llm-pi-ai', revision: 1, user }],
  mutate: async (_ns, ops) => {
    mutations.push(ops)
    user.providers['b-ai'] = { ...user.providers['b-ai'], models: ops[0].value }
    for (const listener of listeners) {
      if (listener.event === 'settings/updated') listener.fn('llm-pi-ai')
    }
  },
}
const previousFetch = globalThis.fetch
let fetches = 0
globalThis.fetch = async (url, init) => {
  fetches += 1
  const href = String(url)
  if (href.includes('models.dev')) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        hub: { models: { m: { id: 'm', limit: { context: 4096, output: 1024 } } } },
      }),
    }
  }
  check('listing request carries the test key only as a header', init.headers?.authorization, 'Bearer test-key')
  return { ok: true, status: 200, text: async () => '{"data":[{"id":"m","context_length":8192}]}' }
}

const routes = []
const injected = []
const listeners = []
const ctx = {
  inject: (deps, callback) => {
    injected.push(deps.join(','))
    if (deps[0] === 'webServer') {
      callback({
        webServer: { register: (route) => { routes.push(route); return () => {} } },
        effect: (fn) => fn(),
      })
    } else if (deps[0] === 'credentials') {
      callback({ credentials: { resolve: async () => ({ value: 'test-key' }) } })
    } else {
      callback()
    }
  },
  on: (event, fn) => {
    listeners.push({ event, fn })
    return () => {}
  },
  get: (name) => {
    if (name === 'settings') return settings
    if (name === 'credentials') return { resolve: async () => ({ value: 'test-key' }) }
    return undefined
  },
}

const returned = plugin.apply(ctx)
check('apply returns undefined', returned, undefined)
check('host waits for credentials, webServer, and settings', injected, ['credentials', 'webServer', 'settings'])
check('a prefix route is registered', routes[0]?.kind, 'prefix')
check('the route is under /api/dsh-model-caps', routes[0]?.path, '/api/dsh-model-caps')

const handler = routes[0].handler
let status = 0
let body = ''
await handler(
  { method: 'POST', url: '/api/dsh-model-caps/sync' },
  { writeHead: (code) => { status = code }, end: (text) => { body = text } },
)
const json = JSON.parse(body)
check('sync answers 200', status, 200)
check('the response does not carry the credential', body.includes('test-key'), false)
check('the blank model was filled once', mutations.length >= 1, true)
check('listing context wins over the catalog', mutations[0][0].value[0].contextWindow, 8192)
check('catalog output fills the blank maxTokens', mutations[0][0].value[0].maxTokens, 1024)
check('sync result is an object', typeof json.providers, 'object')

const beforeSave = fetches
const save = listeners.find((listener) => listener.event === 'settings/updated')
check('host listens for settings saves', save !== undefined, true)
save.fn('llm-pi-ai')
const deadline = Date.now() + 2000
while (fetches === beforeSave && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
check('saving the provider syncs again', fetches > beforeSave, true)
let stable = fetches
for (let i = 0; i < 8; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25))
  if (fetches !== stable) {
    stable = fetches
    i = 0
  }
}
check('the plugin write does not sync again', fetches, stable)
check('a save reuses the listing and the catalog once each', fetches - beforeSave, 2)

globalThis.fetch = previousFetch

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
