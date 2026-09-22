import { syncCaps } from './dsh-model-caps-sync.js'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const user = {
  providers: {
    'b-ai': {
      api: 'openai-completions',
      baseURL: 'https://api.example/v1',
      apiKeyEnv: 'EXAMPLE_KEY',
      models: [{ id: 'glm-x', name: 'GLM' }, { id: 'kept', contextWindow: 9, maxTokens: 8, reasoningEfforts: { high: 'high' } }],
    },
    google: { models: [{ id: 'gemini' }] },
  },
}
let revision = 4
const mutations = []
const calls = []
const settings = {
  describe: () => [{ ns: 'llm-pi-ai', revision, user }],
  mutate: async (ns, ops, expected) => {
    mutations.push({ ns, expected, models: ops[0]?.value })
    revision += 1
    user.providers['b-ai'] = { ...user.providers['b-ai'], models: ops[0].value }
  },
}
const credentials = {
  resolve: async (ref) => {
    check('the credential ref is the profile name, not a secret', ref, 'EXAMPLE_KEY')
    return { value: 'test-key' }
  },
}

const result = await syncCaps({
  settings,
  credentials,
  timeoutMs: 1000,
  fetch: async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers?.authorization, apiKey: init.headers?.['x-api-key'] })
    if (String(url).includes('models.dev')) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          hub: {
            models: {
              'glm-x': {
                id: 'glm-x',
                limit: { context: 1000, output: 200 },
                reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
              },
            },
          },
        }),
      }
    }
    return { ok: false, status: 401, text: async () => '{"error":"no"}' }
  },
})

check('a failed listing still fills from an agreeing catalog', result.providers[0].filled, 2)
check('the listing failure is reported without a response body', result.providers[0].error, 'https://api.example/v1/models answered 401')
check('the write targets llm-pi-ai at the revision that was read', mutations[0].ns, 'llm-pi-ai')
check('the write expected that revision', mutations[0].expected, 4)
check('the blank model gained catalog caps', mutations[0].models[0], {
  id: 'glm-x',
  name: 'GLM',
  contextWindow: 1000,
  maxTokens: 200,
  reasoningEfforts: { low: 'low', high: 'high' },
  compat: { supportsDeveloperRole: false },
})
check('the hand-written model was copied through', mutations[0].models[1].contextWindow, 9)
check('existing thinking menus also get the developer-role guard', mutations[0].models[1].compat, {
  supportsDeveloperRole: false,
})
check('the key traveled only as a bearer header', calls[0].authorization, 'Bearer test-key')
check('the key is not an anthropic header on this route', calls[0].apiKey, undefined)
check('google was not listed', calls.some((call) => String(call.url).includes('google')), false)

const again = await syncCaps({
  settings,
  credentials,
  timeoutMs: 1000,
  fetch: async () => ({ ok: true, text: async () => '{"data":[]}' }),
})
check('a second pass does not write models that are already filled', again.wrote, 0)

const cordis = {
  resolve: async () => ({ value: 'shadow' }),
  [Symbol.for('cordis.original')]: {
    resolve: async (ref) => {
      check('cordis unwrap uses the raw credential store', ref, 'EXAMPLE_KEY')
      return { value: 'real-key' }
    },
  },
}
const cordisCalls = []
await syncCaps({
  settings: {
    describe: () => [{
      ns: 'llm-pi-ai',
      revision: 1,
      user: {
        providers: {
          only: {
            api: 'openai-completions',
            baseURL: 'https://api.example/v1',
            apiKeyEnv: 'EXAMPLE_KEY',
            models: [{ id: 'x' }],
          },
        },
      },
    }],
    mutate: async () => {},
  },
  credentials: cordis,
  timeoutMs: 1000,
  fetch: async (url, init) => {
    cordisCalls.push(init)
    check('fetch is not given a proxy option', Object.prototype.hasOwnProperty.call(init, 'proxy'), false)
    if (String(url).includes('models.dev')) {
      return { ok: true, text: async () => '{"hub":{"models":{}}}' }
    }
    check('the listing uses the unwrapped key', init.headers?.authorization, 'Bearer real-key')
    return { ok: true, text: async () => '{"data":[]}' }
  },
})
check('cordis unwrap reached the listing', cordisCalls.length >= 1, true)

let conflictTries = 0
const conflictUser = {
  providers: {
    only: {
      api: 'openai-completions',
      baseURL: 'https://api.example/v1',
      models: [{ id: 'glm-x', name: 'GLM' }],
    },
  },
}
let conflictRevision = 1
const conflictMutations = []
await syncCaps({
  settings: {
    describe: () => [{ ns: 'llm-pi-ai', revision: conflictRevision, user: conflictUser }],
    mutate: async (ns, ops, expected) => {
      conflictMutations.push({ expected, models: ops[0]?.value })
      conflictTries += 1
      if (conflictTries === 1) {
        const error = new Error('conflict')
        error.code = 'SETTINGS_CONFLICT'
        conflictRevision = 2
        throw error
      }
      conflictRevision += 1
      conflictUser.providers.only.models = ops[0].value
    },
  },
  timeoutMs: 1000,
  fetch: async (url) => {
    if (String(url).includes('models.dev')) {
      return {
        ok: true,
        text: async () => JSON.stringify({
          zai: {
            models: {
              'glm-x': {
                id: 'glm-x',
                family: 'glm',
                limit: { context: 1000, output: 200 },
                reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
              },
            },
          },
        }),
      }
    }
    return { ok: true, text: async () => '{"data":[]}' }
  },
})
check('a settings conflict is retried once', conflictTries, 2)
check('the retry write uses the fresh revision', conflictMutations[1].expected, 2)
check('the retry still fills the blank model', conflictMutations[1].models[0].contextWindow, 1000)

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}${entry.ok ? '' : `\n      expected ${JSON.stringify(entry.expected)}\n      actual   ${JSON.stringify(entry.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
