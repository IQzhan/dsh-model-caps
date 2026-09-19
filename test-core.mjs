import {
  CATALOG_URL,
  gapSignature,
  indexCatalog,
  isCustomProvider,
  listingHeaders,
  listingUrl,
  planMutations,
  readListing,
  resolveCaps,
} from './dsh-model-caps-core.js'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const custom = {
  api: 'openai-completions',
  baseURL: 'https://gateway.example/v1',
  models: [{ id: 'm' }],
}
check('a route with api, baseURL, and models is custom', isCustomProvider(custom), true)
check('a catalog route with no api is not custom', isCustomProvider({
  baseURL: 'https://openrouter.ai/api/v1',
  models: [{ id: 'openrouter/free', contextWindow: 1 }],
}), false)
check('an empty model list is not custom', isCustomProvider({ ...custom, models: [] }), false)

check('openai listing url keeps the base path', listingUrl('https://gateway.example/openai/v1/', 'openai-completions'),
  'https://gateway.example/openai/v1/models')
check('anthropic listing url strips one trailing /v1', listingUrl('https://api.anthropic.com/v1', 'anthropic-messages'),
  'https://api.anthropic.com/v1/models?limit=1000')
check('bearer auth is the openai header', listingHeaders('openai-completions', 'k').authorization, 'Bearer k')
check('anthropic auth is x-api-key', listingHeaders('anthropic-messages', 'k')['x-api-key'], 'k')
check('a missing key sends no authorization', listingHeaders('openai-responses', undefined).authorization, undefined)

const openRouter = readListing({
  data: [{
    id: 'acme/think',
    context_length: 262144,
    top_provider: { context_length: 262144, max_completion_tokens: 32768 },
    reasoning: { mandatory: false, supported_efforts: ['xhigh', 'medium'] },
    max_tokens: 999999,
  }],
})
check('openrouter-shaped listing keeps context, output, and an off level', openRouter, [{
  id: 'acme/think',
  contextWindow: 262144,
  maxTokens: 32768,
  reasoningEfforts: { off: 'none', medium: 'medium', xhigh: 'xhigh' },
}])

const mandatory = readListing({
  data: [{ id: 'always', reasoning: { mandatory: true, supported_efforts: ['high', 'max'] } }],
})
check('a mandatory reasoner does not grow a synthetic off', mandatory[0].reasoningEfforts, { high: 'high', max: 'max' })

const loose = readListing({ data: [{ id: 'bare', max_tokens: 1_000_000 }] })
check('a lone max_tokens is not treated as either cap', loose, [{ id: 'bare' }])

const sized = readListing({ data: [{ id: 'sized', context_window: 128000, max_tokens: 4096 }] })
check('max_tokens below the window is the output cap', sized[0], {
  id: 'sized', contextWindow: 128000, maxTokens: 4096,
})

const map = readListing({ models: { 'alias-id': { id: 'canonical', context_length: 1000 } } })
check('a models map uses the property key as the request id', map, [{ id: 'alias-id', contextWindow: 1000 }])

const catalog = indexCatalog({
  bothub: {
    models: {
      'glm-x': {
        id: 'glm-x',
        limit: { context: 1000, output: 100 },
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
      },
    },
  },
  greenpt: {
    models: {
      'vendor/glm-x': {
        id: 'vendor/glm-x',
        limit: { context: 1000, output: 50 },
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
      },
    },
  },
})
check('catalog agreement keeps the shared window and the shared levels', resolveCaps('glm-x', [], catalog), {
  contextWindow: 1000,
  maxTokens: undefined,
  reasoningEfforts: { low: 'low', high: 'high' },
})
check('the provider listing wins a field the catalog also has', resolveCaps('glm-x', [{
  id: 'glm-x', contextWindow: 7, reasoningEfforts: { max: 'max' },
}], catalog), {
  contextWindow: 7,
  maxTokens: undefined,
  reasoningEfforts: { max: 'max' },
})

const section = {
  providers: {
    google: { models: [{ id: 'gemini', contextWindow: 1 }] },
    'b-ai': {
      api: 'openai-completions',
      baseURL: 'https://api.example/v1',
      models: [
        { id: 'kept', name: 'Kept', contextWindow: 3, maxTokens: 2, reasoningEfforts: { off: 'no_think', high: 'high' }, compat: { thinkingFormat: 'chat-template' } },
        { id: 'glm-x', name: 'GLM' },
        { id: 'plain', name: 'Plain', reasoningEfforts: false },
      ],
    },
  },
}
const planned = planMutations(section, { 'b-ai': [] }, catalog)
check('only the custom route is edited', planned.ops.map((op) => op.path), [['providers', 'b-ai', 'models']])
check('one model was filled', planned.filled, { 'b-ai': 1 })
const next = planned.ops[0].value
check('hand-written efforts and compat stay', next[0], section.providers['b-ai'].models[0])
check('a blank model receives the agreed caps', next[1], {
  id: 'glm-x',
  name: 'GLM',
  contextWindow: 1000,
  reasoningEfforts: { low: 'low', high: 'high' },
})
check('reasoningEfforts false is a choice, not a blank', next[2], section.providers['b-ai'].models[2])
check('the input section is not mutated', section.providers['b-ai'].models[1].contextWindow, undefined)

const filled = {
  ...section,
  providers: { ...section.providers, 'b-ai': { ...section.providers['b-ai'], models: next } },
}
check('a filled route has a different gap than the blank one', gapSignature(section) === gapSignature(filled), false)
check('the public catalog url is the documented one', CATALOG_URL, 'https://models.dev/api.json')

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
