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
  reseller: {
    models: {
      'glm-x': {
        id: 'glm-x',
        family: 'glm',
        limit: { context: 1000, output: 10 },
        reasoning_options: [{ type: 'effort', values: ['high'] }],
      },
      other: { id: 'other', family: 'other', limit: { context: 1, output: 1 } },
    },
  },
  zai: {
    models: {
      'glm-x': {
        id: 'glm-x',
        family: 'glm',
        limit: { context: 8000, output: 200 },
        reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
      },
      'glm-y': { id: 'glm-y', family: 'glm', limit: { context: 1, output: 1 } },
    },
  },
  greenpt: {
    models: {
      'vendor/glm-x': {
        id: 'vendor/glm-x',
        family: 'glm',
        limit: { context: 1000, output: 50 },
        reasoning_options: [{ type: 'effort', values: ['none', 'low', 'high'] }],
      },
    },
  },
})
check('the maker record wins over a reseller that only repeats high', resolveCaps('glm-x', [], catalog), {
  contextWindow: 8000,
  maxTokens: 200,
  reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
  effortsKnown: true,
})
check('a slashed reseller id is not folded onto the bare id', catalog['glm-x'].some((record) => record.provider === 'greenpt'), false)

const fallback = indexCatalog({
  tiny: {
    models: {
      m: {
        family: 'm',
        limit: { context: 10, output: 1 },
        reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }],
      },
    },
  },
  alpha: {
    models: {
      m: { family: 'm', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
      n: { family: 'n', limit: { context: 1, output: 1 } },
    },
  },
  beta: {
    models: {
      m: { family: 'm', reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] },
      n: { family: 'n', limit: { context: 1, output: 1 } },
    },
  },
})
check('without a maker, the common effort list beats one host that lists every level', resolveCaps('m', [], fallback).reasoningEfforts, {
  low: 'low', high: 'high',
})
check('the provider listing wins a field the catalog also has', resolveCaps('glm-x', [{
  id: 'glm-x', contextWindow: 7, reasoningEfforts: { max: 'max' },
}], catalog), {
  contextWindow: 7,
  maxTokens: 200,
  reasoningEfforts: { max: 'max' },
  effortsKnown: true,
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
        { id: 'glm-x', name: 'Stale', reasoningEfforts: { high: 'high' } },
        { id: 'plain', name: 'Plain', reasoningEfforts: false },
      ],
    },
  },
}
const planned = planMutations(section, { 'b-ai': [] }, catalog)
check('only the custom route is edited', planned.ops.map((op) => op.path), [['providers', 'b-ai', 'models']])
check('two models were filled', planned.filled, { 'b-ai': 2 })
const next = planned.ops[0].value
check('hand-written efforts and compat stay', next[0], section.providers['b-ai'].models[0])
check('a blank model receives the maker caps', next[1], {
  id: 'glm-x',
  name: 'GLM',
  contextWindow: 8000,
  maxTokens: 200,
  reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
})
check('a catalog-shaped high-only map is replaced with the maker levels', next[2], {
  id: 'glm-x',
  name: 'Stale',
  reasoningEfforts: { low: 'low', high: 'high', max: 'max' },
  contextWindow: 8000,
  maxTokens: 200,
})
check('reasoningEfforts false is a choice, not a blank', next[3], section.providers['b-ai'].models[3])
check('the input section is not mutated', section.providers['b-ai'].models[1].contextWindow, undefined)

const filled = {
  ...section,
  providers: { ...section.providers, 'b-ai': { ...section.providers['b-ai'], models: next } },
}
check('a filled route has a different gap than the blank one', gapSignature(section) === gapSignature(filled), false)
check('the public catalog url is the documented one', CATALOG_URL, 'https://models.dev/api.json')

const dated = indexCatalog({
  'alibaba-cn': {
    models: {
      'qwen3.7-flash': {
        id: 'qwen3.7-flash',
        family: 'qwen',
        reasoning: true,
        limit: { context: 1000000, output: 65536 },
        reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens' }],
      },
    },
  },
  hyper: {
    models: {
      'qwen3.7-flash': {
        id: 'qwen3.7-flash',
        family: 'qwen',
        limit: { context: 1000, output: 10 },
        reasoning_options: [{ type: 'effort', values: ['none', 'minimal', 'low', 'medium', 'high'] }],
      },
    },
  },
  openai: {
    models: {
      'gpt-x': {
        id: 'gpt-x',
        family: 'gpt',
        limit: { context: 4000, output: 100 },
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
      'gpt-x-2026-07-15': {
        id: 'gpt-x-2026-07-15',
        family: 'gpt',
        limit: { context: 9, output: 8 },
        reasoning_options: [{ type: 'effort', values: ['max'] }],
      },
    },
  },
})
check('a dated snapshot inherits the undated maker, and a toggle is not turned into reseller levels', resolveCaps('qwen3.7-flash-2026-07-15', [], dated), {
  contextWindow: 1000000,
  maxTokens: 65536,
  reasoningEfforts: { off: null, high: 'high' },
  effortsKnown: true,
  compat: {
    thinkingFormat: 'qwen',
    supportsReasoningEffort: false,
    thinkingTokenBudgetField: 'thinking_budget',
  },
})
check('a compact date suffix is the same snapshot', resolveCaps('qwen3.7-flash-20260715', [], dated).contextWindow, 1000000)
check('an exact dated catalog id beats the undated model', resolveCaps('gpt-x-2026-07-15', [], dated).reasoningEfforts, { max: 'max' })
check('a non-date suffix is not treated as a version', resolveCaps('gpt-x-v2', [], dated).effortsKnown, false)
check('an impossible date is not stripped', resolveCaps('qwen3.7-flash-2026-13-40', [], dated).contextWindow, undefined)
check('a dated listing row borrows a blank field from the undated row', resolveCaps('gpt-x-2026-07-15', [
  { id: 'gpt-x-2026-07-15', contextWindow: 3 },
  { id: 'gpt-x', reasoningEfforts: { low: 'low' } },
], dated), {
  contextWindow: 3,
  maxTokens: 8,
  reasoningEfforts: { low: 'low' },
  effortsKnown: true,
})

const datedSection = {
  providers: {
    dashscope: {
      api: 'openai-completions',
      baseURL: 'https://dashscope.example/v1',
      models: [
        { id: 'qwen3.7-flash-2026-07-15', name: 'snapshot' },
        { id: 'qwen3.7-flash-2026-07-15', name: 'hand', reasoningEfforts: { off: 'no_think' }, compat: { thinkingFormat: 'chat-template' } },
      ],
    },
  },
}
const datedPlan = planMutations(datedSection, { dashscope: [] }, dated)
const datedNext = datedPlan.ops[0].value
check('a blank dated model receives the undated context, output, and an off switch', datedNext[0], {
  id: 'qwen3.7-flash-2026-07-15',
  name: 'snapshot',
  contextWindow: 1000000,
  maxTokens: 65536,
  reasoningEfforts: { off: null, high: 'high' },
  compat: {
    thinkingFormat: 'qwen',
    supportsReasoningEffort: false,
    thinkingTokenBudgetField: 'thinking_budget',
  },
})
check('a hand-written dated model keeps its efforts and compat', datedNext[1], {
  id: 'qwen3.7-flash-2026-07-15',
  name: 'hand',
  reasoningEfforts: { off: 'no_think' },
  compat: { thinkingFormat: 'chat-template' },
  contextWindow: 1000000,
  maxTokens: 65536,
})

const shapes = indexCatalog({
  anthropic: {
    models: {
      'claude-sonnet-4': {
        id: 'claude-sonnet-4',
        name: 'Sonnet',
        family: 'claude',
        reasoning: true,
        modalities: { input: ['text', 'image', 'video'] },
        limit: { context: 200000, output: 64000 },
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
    },
  },
  google: {
    models: {
      'gemini-2.5-flash': {
        id: 'gemini-2.5-flash',
        family: 'gemini',
        reasoning: true,
        limit: { context: 1000000, output: 65536 },
        reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens' }],
      },
    },
  },
  'alibaba-cn': {
    models: {
      'qwen3.8-flash': {
        name: 'Qwen 3.8 Flash',
        family: 'qwen',
        reasoning: true,
        limit: { context: 1000000, output: 131072 },
        reasoning_options: [
          { type: 'toggle' },
          { type: 'effort', values: ['low', 'medium', 'xhigh'] },
          { type: 'budget_tokens' },
        ],
      },
    },
  },
})
check('an @ compact date peels to the undated id', resolveCaps('claude-sonnet-4@20250514', [], shapes).contextWindow, 200000)
check('an underscore iso date peels to the undated id', resolveCaps('claude-sonnet-4_2026-07-15', [], shapes).maxTokens, 64000)
check('preview is not a version suffix', resolveCaps('qwen3.7-flash-preview', [], dated).effortsKnown, false)
check('an effort list without a switch does not grow an off level', resolveCaps('gpt-x', [], dated).reasoningEfforts, {
  low: 'low', high: 'high',
})
check('a toggle without a known dialect does not invent a thinking map', resolveCaps('gemini-2.5-flash', [], shapes).reasoningEfforts, undefined)
check('a toggle without a known dialect is still a known thinking shape', resolveCaps('gemini-2.5-flash', [], shapes).effortsKnown, true)
check('a toggle and an effort list share one map that can turn thinking off', resolveCaps('qwen3.8-flash', [], shapes), {
  contextWindow: 1000000,
  maxTokens: 131072,
  reasoningEfforts: { off: null, low: 'low', medium: 'medium', xhigh: 'xhigh' },
  effortsKnown: true,
  name: 'Qwen 3.8 Flash',
  compat: {
    thinkingFormat: 'qwen',
    supportsReasoningEffort: true,
    thinkingTokenBudgetField: 'thinking_budget',
  },
})
const named = planMutations({
  providers: {
    gateway: {
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      models: [{ id: 'claude-sonnet-4@20250514' }],
    },
  },
}, { gateway: [] }, shapes)
check('a blank snapshot receives name, modalities, and the undated caps', named.ops[0].value[0], {
  id: 'claude-sonnet-4@20250514',
  name: 'Sonnet',
  contextWindow: 200000,
  maxTokens: 64000,
  input: ['text', 'image'],
  reasoningEfforts: { low: 'low', high: 'high' },
})

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
