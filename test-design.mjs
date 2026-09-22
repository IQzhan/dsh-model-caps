/**
 * Design acceptance + cross-protocol matrix (DESIGN.md / DESIGN.zh.md).
 * Fails the suite if the pipeline drifts from the design source of truth.
 */
import {
  applyCaps,
  indexBuiltins,
  indexCatalog,
  planMutations,
  projectBuiltin,
  resolveCaps,
  selectBuiltin,
} from './dsh-model-caps-core.js'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}
function ok(label, condition) {
  check(label, Boolean(condition), true)
}

const builtins = indexBuiltins([
  {
    id: 'MiniMax-M3',
    provider: 'minimax',
    api: 'anthropic-messages',
    reasoning: true,
    contextWindow: 1048576,
    maxTokens: 512000,
    name: 'MiniMax-M3',
    input: ['text', 'image'],
    compat: { forceAdaptiveThinking: true },
  },
  {
    id: 'MiniMax-M3',
    provider: 'opencode',
    api: 'openai-completions',
    reasoning: true,
    contextWindow: 1000,
    maxTokens: 100,
  },
  {
    id: 'kimi-k2.6',
    provider: 'moonshotai',
    api: 'openai-completions',
    reasoning: true,
    contextWindow: 262144,
    maxTokens: 262144,
    compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false },
  },
  {
    id: 'kimi-k2.6',
    provider: 'qwen-token-plan',
    api: 'openai-completions',
    reasoning: true,
    compat: { thinkingFormat: 'qwen', supportsReasoningEffort: false },
  },
  {
    id: 'kimi-k3',
    provider: 'moonshotai',
    api: 'openai-completions',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', high: 'high', max: 'max' },
    compat: {
      thinkingFormat: 'openai',
      supportsReasoningEffort: true,
      requiresReasoningContentOnAssistantMessages: true,
    },
  },
  {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    api: 'openai-completions',
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 384000,
    thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
    compat: {
      thinkingFormat: 'deepseek',
      requiresReasoningContentOnAssistantMessages: true,
    },
  },
  {
    id: 'glm-5.3-flash',
    provider: 'zai',
    api: 'openai-completions',
    reasoning: true,
    thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
    compat: { thinkingFormat: 'zai', supportsReasoningEffort: true },
  },
  {
    id: 'gpt-x',
    provider: 'openai',
    api: 'openai-responses',
    reasoning: true,
    thinkingLevelMap: { low: 'low', high: 'high' },
    contextWindow: 4000,
    maxTokens: 100,
  },
])

const catalog = indexCatalog({
  'alibaba-cn': {
    models: {
      'qwen3.7-flash': {
        id: 'qwen3.7-flash',
        family: 'qwen',
        reasoning: true,
        limit: { context: 1000000, output: 65536 },
        reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens' }],
      },
      'qwen-plus': {
        id: 'qwen-plus',
        family: 'qwen',
        reasoning: true,
        limit: { context: 1, output: 1 },
        reasoning_options: [{ type: 'toggle' }],
      },
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        family: 'deepseek-flash',
        reasoning: true,
        limit: { context: 999, output: 99 },
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['high', 'max'] }],
      },
    },
  },
  deepseek: {
    models: {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        family: 'deepseek-flash',
        reasoning: true,
        limit: { context: 1000000, output: 384000 },
        reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: ['low', 'high', 'max'] }],
      },
      twin: { id: 'twin', family: 'deepseek-flash', limit: { context: 1, output: 1 } },
    },
  },
  google: {
    models: {
      'gemini-toggle': {
        id: 'gemini-toggle',
        family: 'gemini',
        reasoning: true,
        limit: { context: 10, output: 2 },
        reasoning_options: [{ type: 'toggle' }],
      },
    },
  },
})

// --- Design §1 id normalization ---
ok('scheme+path reaches bare builtin id', resolveCaps(
  'hf:minimax/MiniMax-M3', [], {}, builtins, 'openai-completions',
).reasoningEfforts?.high === 'high')
ok('scheme+path does not invent Completions deepseek for Anthropic-only MiniMax', resolveCaps(
  'hf:minimax/MiniMax-M3', [], {}, builtins, 'openai-completions',
).compat?.thinkingFormat === undefined)
ok('dated leaf peels to undated builtin', resolveCaps(
  'deepseek-v4-flash-2026-07-15', [], {}, builtins, 'openai-completions',
).compat?.thinkingFormat === 'deepseek')
ok('vN.M minor peels when more name follows', resolveCaps(
  'deepseek-v4.1-flash', [], catalog, {}, 'openai-completions',
).compat?.thinkingFormat === 'deepseek')
ok('bare vN.M product id is not peeled', resolveCaps(
  'mimo-v2.5', [], catalog, {}, 'openai-completions',
).compat?.thinkingFormat === undefined)

const flashCatalog = indexCatalog({
  zai: {
    models: {
      'glm-5.3-flash': {
        id: 'glm-5.3-flash', family: 'glm', name: 'Flash',
        limit: { context: 1, output: 1 },
        reasoning_options: [{ type: 'effort', values: ['high'] }],
      },
      'glm-5.3-flashx': {
        id: 'glm-5.3-flashx', family: 'glm', name: 'FlashX',
        limit: { context: 2, output: 2 },
        reasoning_options: [{ type: 'effort', values: ['low'] }],
      },
      other: { id: 'other', family: 'other', limit: { context: 1, output: 1 } },
    },
  },
})
check('Flash and FlashX stay distinct SKUs', [
  resolveCaps('ZHIPU/GLM-5.3-Flash', [], flashCatalog, {}, 'openai-completions').name,
  resolveCaps('ZHIPU/GLM-5.3-FlashX', [], flashCatalog, {}, 'openai-completions').name,
], ['Flash', 'FlashX'])

// --- Design §2 / §3 OpenAI default track ---
const m3OpenAi = resolveCaps('MiniMax-M3', [], {}, builtins, 'openai-completions')
check('OpenAI-only MiniMax-M3 gets menu without fabricated deepseek wire', m3OpenAi.compat, {
  supportsDeveloperRole: false,
})
ok('OpenAI-only MiniMax-M3 keeps Completions-track sizes from same-api hit', m3OpenAi.contextWindow === 1000)
ok('OpenAI-only MiniMax-M3 does not invent thinkingFormat from Anthropic', m3OpenAi.compat?.thinkingFormat === undefined)
ok('OpenAI-only MiniMax-M3 still offers a thinking menu', m3OpenAi.reasoningEfforts?.high === 'high')
ok('OpenAI-only MiniMax-M3 does not invent forceAdaptiveThinking', m3OpenAi.compat?.forceAdaptiveThinking === undefined)

const m3Anthropic = resolveCaps('MiniMax-M3', [], {}, builtins, 'anthropic-messages')
ok('Anthropic route uses Anthropic maker sizes', m3Anthropic.contextWindow === 1048576)
ok('Anthropic route carries forceAdaptiveThinking from builtin', m3Anthropic.compat?.forceAdaptiveThinking === true)
ok('Anthropic route does not attach Completions thinkingFormat', m3Anthropic.compat?.thinkingFormat === undefined)

check('Kimi K2 OpenAI track uses deepseek dialect from maker builtin', resolveCaps(
  'kimi-k2.6', [], {}, builtins, 'openai-completions',
).compat?.thinkingFormat, 'deepseek')
check('Kimi K3 OpenAI track uses openai dialect + effort map', resolveCaps(
  'kimi-k3', [], {}, builtins, 'openai-completions',
), {
  reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
  effortsKnown: true,
  compat: {
    thinkingFormat: 'openai',
    supportsReasoningEffort: true,
    requiresReasoningContentOnAssistantMessages: true,
    supportsDeveloperRole: false,
  },
})
ok('OpenAI thinking models always disable developer role', resolveCaps(
  'qwen3.7-flash', [], catalog, {}, 'openai-completions',
).compat?.supportsDeveloperRole === false)
check('DeepSeek OpenAI track uses builtin map+compat', resolveCaps(
  'deepseek-v4-flash', [], {}, builtins, 'openai-completions',
).compat?.thinkingFormat, 'deepseek')
check('GLM OpenAI track uses zai dialect', resolveCaps(
  'glm-5.3-flash', [], {}, builtins, 'openai-completions',
).compat?.thinkingFormat, 'zai')

const responses = resolveCaps('gpt-x', [], {}, builtins, 'openai-responses')
check('openai-responses is on the OpenAI default track', {
  efforts: responses.reasoningEfforts,
  window: responses.contextWindow,
}, { efforts: { low: 'low', high: 'high' }, window: 4000 })

// --- Design §3 Anthropic ← OpenAI weak projection ---
const weak = projectBuiltin({
  provider: 'moonshotai',
  api: 'openai-completions',
  reasoning: true,
  thinkingLevelMap: { high: 'high' },
  compat: { thinkingFormat: 'deepseek', forceAdaptiveThinking: true },
}, 'anthropic-messages')
ok('Anthropic←OpenAI projects menu only', weak.reasoningEfforts?.high === 'high')
ok('Anthropic←OpenAI does not invent forceAdaptiveThinking', weak.compat === undefined)
ok('Anthropic←OpenAI does not copy Completions thinkingFormat', weak.compat?.thinkingFormat === undefined)

// --- Design §2 maker beats reseller ---
check('maker moonshotai beats qwen-token-plan reseller', selectBuiltin(
  builtins['kimi-k2.6'], 'openai-completions',
)?.provider, 'moonshotai')

// Overlay Completions wires only from maker OpenAI rows — not reseller dialects.
ok('maker OpenAI wire overlays onto weak same-api row', (() => {
  const local = indexBuiltins([
    {
      id: 'wired-x',
      provider: 'opencode',
      api: 'openai-completions',
      reasoning: true,
      contextWindow: 11,
    },
    {
      id: 'wired-x',
      provider: 'moonshotai',
      api: 'openai-completions',
      reasoning: true,
      contextWindow: 99,
      compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false },
    },
  ])
  const caps = resolveCaps('wired-x', [], {}, local, 'openai-completions')
  return caps.contextWindow === 99
    && caps.compat?.thinkingFormat === 'deepseek'
    && caps.reasoningEfforts?.high === 'high'
})())
ok('reseller OpenAI wire is not overlaid onto another gateway', (() => {
  const local = indexBuiltins([
    {
      id: 'wired-y',
      provider: 'opencode',
      api: 'openai-completions',
      reasoning: true,
      contextWindow: 11,
    },
    {
      id: 'wired-y',
      provider: 'acme-gateway',
      api: 'openai-completions',
      reasoning: true,
      contextWindow: 99,
      compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false },
    },
    {
      id: 'wired-y',
      provider: 'minimax',
      api: 'anthropic-messages',
      reasoning: true,
      contextWindow: 50,
    },
  ])
  const caps = resolveCaps('wired-y', [], {}, local, 'openai-completions')
  return caps.contextWindow === 11
    && caps.compat?.thinkingFormat === undefined
    && caps.reasoningEfforts?.high === 'high'
    && caps.compat?.supportsDeveloperRole === false
})())

// --- Design §4 models.dev fallback ---
const qwen = resolveCaps('qwen3.7-flash', [], catalog, {}, 'openai-completions')
check('models.dev fallback attaches qwen for native Alibaba', qwen.compat?.thinkingFormat, 'qwen')
ok('models.dev toggle without dialect invents no map', resolveCaps(
  'gemini-toggle', [], catalog, {}, 'openai-completions',
).reasoningEfforts === undefined)

const hostedDeepseek = resolveCaps('deepseek-v4-flash', [], catalog, {}, 'openai-completions')
check('without builtins, DeepSeek maker dialect wins over Alibaba host', hostedDeepseek.compat?.thinkingFormat, 'deepseek')

// --- Design §5 merge priority ---
check('listing sizes beat builtin sizes', resolveCaps(
  'MiniMax-M3',
  [{ id: 'MiniMax-M3', contextWindow: 7, maxTokens: 3 }],
  {},
  builtins,
  'openai-completions',
).contextWindow, 7)
check('listing efforts beat builtin efforts; builtin compat remains', (() => {
  const caps = resolveCaps(
    'deepseek-v4-flash',
    [{ id: 'deepseek-v4-flash', reasoningEfforts: { max: 'max' } }],
    catalog,
    builtins,
    'openai-completions',
  )
  return {
    efforts: caps.reasoningEfforts,
    format: caps.compat?.thinkingFormat,
  }
})(), { efforts: { max: 'max' }, format: 'deepseek' })

check('builtin compat beats models.dev dialect when both exist', resolveCaps(
  'deepseek-v4-flash',
  [],
  catalog,
  builtins,
  'openai-completions',
).compat?.requiresReasoningContentOnAssistantMessages, true)

const handwritten = applyCaps({
  id: 'kimi-k2.6',
  reasoningEfforts: { off: 'no_think', high: 'high' },
  compat: { thinkingFormat: 'chat-template' },
}, resolveCaps('kimi-k2.6', [], {}, builtins, 'openai-completions'))
check('hand-written compat and non-standard wires stay', {
  efforts: handwritten.reasoningEfforts,
  compat: handwritten.compat,
}, {
  efforts: { off: 'no_think', high: 'high' },
  compat: { thinkingFormat: 'chat-template' },
})
ok('blank sizes may still fill under hand-written thinking', handwritten.contextWindow === 262144)

// --- Design: never rewrite route api / baseURL ---
const planned = planMutations({
  providers: {
    gateway: {
      api: 'openai-completions',
      baseURL: 'https://gateway.example/v1',
      models: [{ id: 'MiniMax-M3' }, { id: 'kimi-k2.6' }],
    },
  },
}, { gateway: [] }, {}, builtins)
ok('planMutations only edits models path', planned.ops.length === 1
  && planned.ops[0].path.join('.') === 'providers.gateway.models')
ok('kimi keeps maker Completions deepseek wire', planned.ops[0].value.find((m) => m.id === 'kimi-k2.6')?.compat?.thinkingFormat === 'deepseek')
ok('MiniMax-M3 does not get fabricated deepseek wire on OpenAI route', planned.ops[0].value.find((m) => m.id === 'MiniMax-M3')?.compat?.thinkingFormat === undefined)
ok('MiniMax-M3 still gets a thinking menu on OpenAI route', planned.ops[0].value.find((m) => m.id === 'MiniMax-M3')?.reasoningEfforts?.high === 'high')
ok('planMutations never injects api onto model entries', planned.ops[0].value.every(
  (model) => model.api === undefined && model.baseURL === undefined && model.baseUrl === undefined,
))

// --- Design: no silent protocol switch ---
ok('resolveCaps never returns a route api field', resolveCaps(
  'MiniMax-M3', [], {}, builtins, 'openai-completions',
).api === undefined)

// --- Cross: empty builtins still uses models.dev ---
ok('empty builtins still fills from models.dev', resolveCaps(
  'qwen3.7-flash', [], catalog, {}, 'openai-completions',
).contextWindow === 1000000)

const failed = results.filter((result) => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
