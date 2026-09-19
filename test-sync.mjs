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

check('a failed listing still fills from an agreeing catalog', result.providers[0].filled, 1)
check('the listing failure is reported without a response body', result.providers[0].error, 'https://api.example/v1/models answered 401')
check('the write targets llm-pi-ai at the revision that was read', mutations[0].ns, 'llm-pi-ai')
check('the write expected that revision', mutations[0].expected, 4)
check('the blank model gained catalog caps', mutations[0].models[0], {
  id: 'glm-x',
  name: 'GLM',
  contextWindow: 1000,
  maxTokens: 200,
  reasoningEfforts: { low: 'low', high: 'high' },
})
check('the hand-written model was copied through', mutations[0].models[1].contextWindow, 9)
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

const failed = results.filter((entry) => !entry.ok)
for (const entry of results) {
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}${entry.ok ? '' : `\n      expected ${JSON.stringify(entry.expected)}\n      actual   ${JSON.stringify(entry.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
