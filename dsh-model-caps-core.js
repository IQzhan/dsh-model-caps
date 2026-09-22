/**
 * dsh-model-caps-core — policy with no Cordis and no IO.
 *
 * Lookup: normalize id → collect builtin hits → select → project onto the
 * route api. Per-field merge (DESIGN.md §5): hand-written → listing →
 * builtin projection → models.dev. OpenAI-compatible is the default track;
 * Anthropic is optional. Hand-written fields stay.
 *
 * @module dsh-model-caps-core
 */

const PLUGIN_NAME = 'dsh-model-caps'
const SETTINGS_NS = 'llm-pi-ai'
const CATALOG_URL = 'https://models.dev/api.json'
const MAX_BODY_BYTES = 8 * 1024 * 1024
const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_MODEL_LIMIT = 1000

const LISTABLE_APIS = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
])

/** pi-ai thinking levels, in escalation order. `off` may send nothing. */
const THINKING_LEVELS = Object.freeze([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

/**
 * models.dev fallback dialects when no pi-ai builtin hit projects thinking.
 * Alibaba may host foreign families, so only a modal (native) row may attach
 * `qwen`. DeepSeek / Z.AI / Zhipu rows on their own catalogs are official.
 */
const MAKER_DIALECT = Object.freeze({
  alibaba: { thinkingFormat: 'qwen', budgetField: 'thinking_budget', nativeOnly: true },
  'alibaba-cn': { thinkingFormat: 'qwen', budgetField: 'thinking_budget', nativeOnly: true },
  deepseek: {
    thinkingFormat: 'deepseek',
    requiresReasoningContentOnAssistantMessages: true,
  },
  zai: { thinkingFormat: 'zai' },
  zhipuai: { thinkingFormat: 'zai' },
})

/** Auto-filled thinking formats (builtin projection + models.dev fallback). */
const AUTO_THINKING_FORMATS = new Set(['qwen', 'deepseek', 'zai', 'openai'])

const AUTO_COMPAT_KEYS = new Set([
  'thinkingFormat',
  'supportsReasoningEffort',
  'supportsDeveloperRole',
  'thinkingTokenBudgetField',
  'requiresReasoningContentOnAssistantMessages',
  'forceAdaptiveThinking',
])

const OPENAI_APIS = new Set(['openai-completions', 'openai-responses'])

const ANTHROPIC_DEFAULT_EFFORTS = Object.freeze({
  off: null,
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
})

const TOGGLE_EFFORTS = Object.freeze({ off: null, high: 'high' })

function dialectEligible(provider, native) {
  const rule = MAKER_DIALECT[provider]
  if (rule === undefined) return false
  if (rule.nativeOnly === true) return native === true
  return true
}

const INPUT_MODALITIES = new Set(['text', 'image'])

/**
 * Trainers / first-party catalog routes. Used for models.dev maker pick and
 * for preferring a builtin hit over reseller builtins (opencode, token-plan).
 */
const MAKER_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'google-vertex',
  'deepseek',
  'alibaba',
  'alibaba-cn',
  'zai',
  'zhipuai',
  'zai-coding-cn',
  'moonshotai',
  'moonshotai-cn',
  'minimax',
  'minimax-cn',
  'xiaomi',
  'tencent-tokenhub',
  'mistral',
  'xai',
  'cohere',
])

const LEVEL_ALIASES = Object.freeze({
  off: 'off',
  none: 'off',
  disabled: 'off',
  disable: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  mid: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  'x-high': 'xhigh',
  'extra-high': 'xhigh',
  extra_high: 'xhigh',
  max: 'max',
  ultra: 'max',
  maximum: 'max',
})

function positiveInt(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) {
      return candidate
    }
  }
  return undefined
}

function label(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

function isCustomProvider(profile) {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return false
  if (typeof profile.baseURL !== 'string' || profile.baseURL.length === 0) return false
  if (!LISTABLE_APIS.has(profile.api)) return false
  return Array.isArray(profile.models) && profile.models.length > 0
}

function customRoutes(section) {
  const providers = section?.providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return []
  const routes = []
  for (const [id, profile] of Object.entries(providers)) {
    if (!isCustomProvider(profile)) continue
    routes.push({
      id,
      api: profile.api,
      baseURL: profile.baseURL,
      apiKeyEnv: typeof profile.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0
        ? profile.apiKeyEnv
        : undefined,
      models: profile.models,
    })
  }
  return routes
}

/**
 * Gap identity for "should we hit the network again?". Includes the endpoint
 * and which of the three fields are still blank, so a filled write does not
 * refetch and a newly added model does.
 */
function gapSignature(section) {
  return customRoutes(section).map((route) => {
    const models = route.models.map((model) => {
      const id = typeof model?.id === 'string' ? model.id : ''
      const flags = [
        model?.contextWindow === undefined ? 'c' : '',
        model?.maxTokens === undefined ? 'm' : '',
        model?.reasoningEfforts === undefined ? 'r' : '',
      ].join('')
      return `${id}/${flags}`
    }).join(',')
    return `${route.id}@${route.baseURL}[${models}]`
  }).join('|')
}

function listingUrl(baseURL, api) {
  const base = String(baseURL).replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  const root = base.endsWith('/v1') ? base.slice(0, -3) : base
  return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
}

function listingHeaders(api, apiKey) {
  const headers = { accept: 'application/json' }
  if (api === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (typeof apiKey === 'string' && apiKey.length > 0) headers['x-api-key'] = apiKey
  } else if (typeof apiKey === 'string' && apiKey.length > 0) {
    headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

function levelOf(token) {
  if (token === null) return { level: 'off', wire: null }
  if (typeof token !== 'string') return undefined
  const trimmed = token.trim()
  if (trimmed.length === 0) return undefined
  const level = LEVEL_ALIASES[trimmed.toLowerCase()]
  if (level === undefined) return undefined
  if (level === 'off') {
    return { level, wire: trimmed.toLowerCase() === 'none' ? 'none' : null }
  }
  return { level, wire: trimmed }
}

function finishEfforts(draft) {
  const ordered = {}
  for (const level of THINKING_LEVELS) {
    if (Object.prototype.hasOwnProperty.call(draft, level)) ordered[level] = draft[level]
  }
  const thinks = THINKING_LEVELS.some((level) => level !== 'off' && Object.prototype.hasOwnProperty.call(ordered, level))
  return thinks ? ordered : undefined
}

function effortsFromNames(names, synthesizeOff) {
  if (!Array.isArray(names)) return undefined
  const draft = {}
  let sawOff = false
  for (const name of names) {
    const parsed = levelOf(name)
    if (parsed === undefined || Object.prototype.hasOwnProperty.call(draft, parsed.level)) continue
    if (parsed.level === 'off') sawOff = true
    draft[parsed.level] = parsed.wire
  }
  if (synthesizeOff && !sawOff) draft.off = 'none'
  return finishEfforts(draft)
}

function effortsFromDict(dict) {
  if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) return undefined
  const draft = {}
  for (const [key, wire] of Object.entries(dict)) {
    const parsed = levelOf(key)
    if (parsed === undefined || Object.prototype.hasOwnProperty.call(draft, parsed.level)) continue
    if (wire === null || wire === undefined) {
      if (parsed.level === 'off') draft.off = null
      continue
    }
    if (typeof wire !== 'string' || wire.length === 0) continue
    const lower = wire.trim().toLowerCase()
    draft[parsed.level] = parsed.level === 'off' && (lower === 'off' || lower === 'disabled' || lower === 'disable')
      ? null
      : wire
  }
  return finishEfforts(draft)
}

function effortsFromOptions(options) {
  if (!Array.isArray(options)) return undefined
  const effort = options.find((item) => item !== null && typeof item === 'object' && item.type === 'effort' && Array.isArray(item.values))
  if (effort === undefined) return undefined
  return effortsFromNames(effort.values, false)
}

function effortsFromEntry(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const reasoning = entry.reasoning
  if (reasoning !== null && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    if (Array.isArray(reasoning.supported_efforts)) {
      const efforts = effortsFromNames(reasoning.supported_efforts, reasoning.mandatory !== true)
      if (efforts !== undefined) return efforts
    }
  }
  return effortsFromDict(entry.reasoningEfforts)
    ?? effortsFromDict(entry.reasoning_efforts)
    ?? effortsFromNames(entry.reasoning_efforts, false)
    ?? effortsFromNames(entry.supported_reasoning_efforts, false)
    ?? effortsFromOptions(entry.reasoning_options)
}

function capsFromListingEntry(entry) {
  const contextWindow = positiveInt(
    entry.contextWindow,
    entry.context_window,
    entry.context_length,
    entry.max_input_tokens,
    entry.limit?.context,
    entry.top_provider?.context_length,
  )
  let maxTokens = positiveInt(
    entry.maxOutputTokens,
    entry.max_output_tokens,
    entry.limit?.output,
    entry.top_provider?.max_completion_tokens,
  )
  const loose = positiveInt(entry.max_tokens, entry.maxTokens)
  if (maxTokens === undefined && contextWindow !== undefined && loose !== undefined && loose < contextWindow) {
    maxTokens = loose
  }
  if (maxTokens !== undefined && contextWindow !== undefined && maxTokens >= contextWindow) {
    maxTokens = undefined
  }
  const reasoningEfforts = effortsFromEntry(entry)
  const name = label(entry.name)
  const input = catalogInput(entry.input ?? entry.modalities?.input)
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
    ...name === undefined ? {} : { name },
    ...input === undefined ? {} : { input },
  }
}

function listedRows(body) {
  const listing = body
  const data = listing?.data
  if (Array.isArray(data)) return data.map((raw) => ({ raw }))
  const models = listing?.models
  if (models === null || typeof models !== 'object' || Array.isArray(models)) return []
  return Object.entries(models)
    .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
    .map(([key, raw]) => ({ key, raw }))
}

function readListing(body) {
  const models = []
  for (const row of listedRows(body)) {
    const entry = row.raw
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const id = label(row.key, entry.id)
    if (id === undefined) continue
    models.push({ id, ...capsFromListingEntry(entry) })
  }
  return models
}

function optionShape(options) {
  const list = Array.isArray(options) ? options : []
  const effort = list.find((item) => item !== null && typeof item === 'object' && item.type === 'effort' && Array.isArray(item.values))
  return {
    effort,
    toggle: list.some((item) => item !== null && typeof item === 'object' && item.type === 'toggle'),
    budget: list.some((item) => item !== null && typeof item === 'object' && item.type === 'budget_tokens'),
  }
}

/**
 * Published effort names, plus `off` in the same map when the record can
 * disable thinking. A toggle with no effort list becomes off + one on-level
 * only for a dialect that can send the switch; otherwise the map stays unset.
 */
function effortsFromCatalogOptions(options, dialect) {
  const shape = optionShape(options)
  let draft
  if (shape.effort !== undefined) {
    draft = effortsFromNames(shape.effort.values, false)
    if (draft !== undefined && shape.toggle && !Object.prototype.hasOwnProperty.call(draft, 'off')) {
      draft = finishEfforts({ ...draft, off: null })
    }
  }
  if (draft === undefined && shape.toggle && dialect) {
    draft = { off: null, high: 'high' }
  }
  return { efforts: draft, shape, publishedEffort: shape.effort !== undefined && draft !== undefined && Object.keys(draft).some((level) => level !== 'off' && shape.effort.values.some((value) => levelOf(value)?.level === level)) }
}

/**
 * Wire dialect for a maker row. Alibaba needs a native toggle line
 * (`enable_thinking`); DeepSeek / Z.AI attach whenever a thinking map exists.
 */
function makerCompat(provider, parsed, native) {
  if (!dialectEligible(provider, native) || parsed.efforts === undefined) return undefined
  const rule = MAKER_DIALECT[provider]
  if (rule === undefined) return undefined
  if (rule.thinkingFormat === 'qwen' && !parsed.shape.toggle) return undefined
  const compat = {
    thinkingFormat: rule.thinkingFormat,
    supportsReasoningEffort: parsed.publishedEffort,
  }
  if (rule.budgetField && parsed.shape.budget) {
    compat.thinkingTokenBudgetField = rule.budgetField
  }
  if (rule.requiresReasoningContentOnAssistantMessages === true) {
    compat.requiresReasoningContentOnAssistantMessages = true
  }
  return compat
}

function catalogInput(modalities) {
  if (!Array.isArray(modalities)) return undefined
  const input = []
  for (const modality of ['text', 'image']) {
    if (modalities.includes(modality) && INPUT_MODALITIES.has(modality)) input.push(modality)
  }
  return input.length > 0 ? input : undefined
}

function capsFromCatalogModel(model, provider, native) {
  const dialect = dialectEligible(provider, native)
  const contextWindow = positiveInt(model?.limit?.context)
  const maxTokens = positiveInt(model?.limit?.output)
  const parsed = effortsFromCatalogOptions(model?.reasoning_options, dialect)
  let reasoningEfforts = parsed.efforts
  const thinkingKnown = reasoningEfforts !== undefined || parsed.shape.toggle || model?.reasoning === false
  if (reasoningEfforts === undefined && model?.reasoning === false) reasoningEfforts = false
  const name = label(model?.name)
  const input = catalogInput(model?.modalities?.input)
  const compat = makerCompat(provider, parsed, native)
  if (contextWindow === undefined && maxTokens === undefined && reasoningEfforts === undefined && !thinkingKnown && name === undefined && input === undefined) {
    return undefined
  }
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
    ...name === undefined ? {} : { name },
    ...input === undefined ? {} : { input },
    ...compat === undefined ? {} : { compat },
    thinkingKnown,
  }
}

function pushRecord(index, bucket, record) {
  if (bucket.length === 0) return
  const list = index[bucket] ?? []
  if (list.some((item) => item.provider === record.provider)) return
  list.push(record)
  index[bucket] = list
}

/**
 * Index a models.dev document by exact id, not by the last path segment.
 * `vendor/glm-5.1` is that vendor's alias; folding it into `glm-5.1` is
 * what let fifty reseller subsets vote the menu down to one shared level.
 *
 * A row is native when its family is a modal family on that provider
 * (tied for the largest count). Hosted minority lines are not native.
 */
function indexCatalog(body) {
  const index = {}
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return index
  for (const [providerId, provider] of Object.entries(body)) {
    const models = provider?.models
    if (models === null || typeof models !== 'object') continue
    const entries = Array.isArray(models)
      ? models.map((model) => [typeof model?.id === 'string' ? model.id : '', model])
      : Object.entries(models)
    const familySize = {}
    let providerSize = 0
    for (const [, model] of entries) {
      providerSize += 1
      const family = typeof model?.family === 'string' ? model.family : ''
      if (family.length === 0) continue
      familySize[family] = (familySize[family] ?? 0) + 1
    }
    let maxFamilySize = 0
    for (const size of Object.values(familySize)) {
      if (size > maxFamilySize) maxFamilySize = size
    }
    for (const [key, model] of entries) {
      const family = typeof model?.family === 'string' ? model.family : ''
      const size = family.length > 0 ? familySize[family] ?? 0 : 0
      const native = size > 0 && size === maxFamilySize
      const caps = capsFromCatalogModel(
        model !== null && typeof model === 'object' && !Array.isArray(model)
          ? { ...model, id: typeof model.id === 'string' && model.id.length > 0 ? model.id : key }
          : model,
        providerId,
        native,
      )
      if (caps === undefined) continue
      const record = {
        provider: providerId,
        providerSize,
        familySize: size > 0 ? size : 1,
        native,
        thinkingKnown: caps.thinkingKnown === true,
        ...caps,
      }
      const buckets = new Set()
      if (typeof key === 'string' && key.length > 0 && !key.includes('/')) buckets.add(key)
      if (typeof model?.id === 'string' && model.id.length > 0 && !model.id.includes('/')) buckets.add(model.id)
      for (const id of buckets) {
        pushRecord(index, id, record)
        pushRecord(index, id.toLowerCase(), record)
      }
    }
  }
  return index
}

function concentration(record) {
  if (record.providerSize <= 0) return 0
  return record.familySize / record.providerSize
}

function effortKey(efforts) {
  if (efforts === undefined || efforts === false || efforts === null) return ''
  return THINKING_LEVELS
    .filter((level) => Object.prototype.hasOwnProperty.call(efforts, level))
    .map((level) => `${level}=${String(efforts[level])}`)
    .join(',')
}

/** The effort list published by the most records. One reseller's full enum must not beat it. */
function modeEfforts(records) {
  const counts = new Map()
  for (const record of records) {
    const key = effortKey(record.reasoningEfforts)
    if (key.length === 0) continue
    const hit = counts.get(key) ?? { count: 0, efforts: record.reasoningEfforts }
    hit.count += 1
    counts.set(key, hit)
  }
  let best
  for (const hit of counts.values()) {
    if (best === undefined || hit.count > best.count) best = hit
  }
  return best?.efforts
}

function byConcentration(records) {
  return [...records].sort((left, right) => {
    const share = concentration(right) - concentration(left)
    if (share !== 0) return share
    if (right.familySize !== left.familySize) return right.familySize - left.familySize
    if (left.provider.length !== right.provider.length) return left.provider.length - right.provider.length
    return left.provider < right.provider ? -1 : 1
  })[0]
}

/**
 * Prefer a trainer's own row. Without one, fall back to catalogs where the
 * family's share is highest, taking effort lists as the mode so one specialty
 * host cannot dominate. Dialect compat only rides a native maker dialect row
 * and is stripped on the non-maker fallback.
 */
function selectMaker(records) {
  if (records.length === 0) return undefined
  const makers = records.filter((record) => MAKER_PROVIDERS.has(record.provider))
  if (makers.length > 0) return byConcentration(makers)
  const natives = records.filter((record) => record.native === true)
  const pool = natives.length > 0 ? natives : records
  const host = byConcentration(pool)
  if (host === undefined) return undefined
  const efforts = modeEfforts(pool)
  const next = efforts === undefined
    ? { ...host }
    : { ...host, reasoningEfforts: efforts, thinkingKnown: true }
  if (next.compat !== undefined) delete next.compat
  return next
}

function calendarDate(year, month, day) {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/**
 * A trailing calendar date is a snapshot of the same model.
 * Separators are `-`, `_`, `:`, and `@`. `preview` and `-v2` are not versions.
 * `qwen3.7-flash-2026-07-15` and `claude-sonnet-4@20250514` both peel.
 */
function datedVersionBase(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined
  const iso = /^(.*)[-_:@](\d{4})-(\d{2})-(\d{2})$/.exec(modelId)
  if (iso !== null && iso[1].length > 0 && calendarDate(iso[2], iso[3], iso[4])) return iso[1]
  const compact = /^(.*)[-_:@](\d{4})(\d{2})(\d{2})$/.exec(modelId)
  if (compact !== null && compact[1].length > 0 && calendarDate(compact[2], compact[3], compact[4])) return compact[1]
  return undefined
}

/**
 * A dotted minor after `vN` when more name follows: `deepseek-v4.1-flash` →
 * `deepseek-v4-flash`. Bare `mimo-v2.5` stays (the `.5` is the product id).
 */
function minorVersionBase(modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return undefined
  const match = /^(.*-v\d+)\.\d+(-.+)$/i.exec(modelId)
  if (match === null) return undefined
  return `${match[1]}${match[2]}`
}

/** Peel dated snapshots, then `vN.M-…` minors, one step at a time. */
function versionBase(modelId) {
  return datedVersionBase(modelId) ?? minorVersionBase(modelId)
}

/**
 * Gateway ids often prefix a trainer id: `ZHIPU/GLM-5.3-FlashX`, `hf:zai-org/…`.
 * Lookup peels those at query time. The index still stores only unslashed ids.
 */
function schemeRest(modelId) {
  if (typeof modelId !== 'string') return undefined
  const match = /^([A-Za-z][A-Za-z0-9+-]{0,15}):(.+)$/.exec(modelId)
  if (match === null) return undefined
  return match[2].length > 0 ? match[2] : undefined
}

function pathLeaf(modelId) {
  if (typeof modelId !== 'string' || !modelId.includes('/')) return undefined
  const leaf = modelId.slice(modelId.lastIndexOf('/') + 1)
  return leaf.length > 0 ? leaf : undefined
}

function lookupCandidates(modelId) {
  const out = []
  const seen = new Set()
  const push = (id) => {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) return
    seen.add(id)
    out.push(id)
  }
  push(modelId)
  const rest = schemeRest(modelId)
  if (rest !== undefined) push(rest)
  for (const id of [...out]) {
    const leaf = pathLeaf(id)
    if (leaf !== undefined) push(leaf)
  }
  return out
}

function recordsAt(catalog, modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return []
  return catalog[modelId.toLowerCase()] ?? []
}

function catalogRecords(catalog, modelId) {
  const out = []
  const seenProviders = new Set()
  for (const candidate of lookupCandidates(modelId)) {
    const seen = new Set()
    let id = candidate
    while (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id)
      for (const row of recordsAt(catalog, id)) {
        if (seenProviders.has(row.provider)) continue
        seenProviders.add(row.provider)
        out.push(row)
      }
      const base = versionBase(id)
      if (base === undefined) break
      id = base
    }
  }
  return out
}

function sameModelId(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()
}

/** Exact listing id wins each field. Alias or dated rows fill only blanks. */
function listingFor(listed, modelId) {
  const rows = []
  for (const candidate of lookupCandidates(modelId)) {
    const seen = new Set()
    let id = candidate
    while (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id)
      const hit = listed.find((item) => sameModelId(item.id, id))
      if (hit !== undefined && !rows.includes(hit)) rows.push(hit)
      const base = versionBase(id)
      if (base === undefined) break
      id = base
    }
  }
  const pick = (field) => {
    for (const row of rows) {
      if (row[field] !== undefined) return row[field]
    }
    return undefined
  }
  return {
    contextWindow: pick('contextWindow'),
    maxTokens: pick('maxTokens'),
    reasoningEfforts: pick('reasoningEfforts'),
    name: pick('name'),
    input: pick('input'),
  }
}

function standardWire(level, wire) {
  if (wire === null) return level === 'off'
  if (typeof wire !== 'string') return false
  const token = wire.trim().toLowerCase()
  if (token === 'none') return level === 'off'
  return token === level
}

/** A map whose wires are only the level names (or `none` for off) is a catalog fill, not a hand-written dialect. */
function catalogShaped(efforts) {
  if (efforts === null || typeof efforts !== 'object' || Array.isArray(efforts)) return false
  const keys = Object.keys(efforts)
  if (keys.length === 0) return false
  return keys.every((key) => THINKING_LEVELS.includes(key) && standardWire(key, efforts[key]))
}

function effortsEqual(left, right) {
  if (left === right) return true
  if (left === false || right === false || left == null || right == null) return false
  if (typeof left !== 'object' || typeof right !== 'object') return false
  for (const level of THINKING_LEVELS) {
    if (left[level] !== right[level]) return false
  }
  return true
}

function effortsFromThinkingMap(map) {
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return undefined
  const draft = {}
  for (const level of THINKING_LEVELS) {
    if (!Object.prototype.hasOwnProperty.call(map, level)) continue
    const wire = map[level]
    if (wire === null) {
      if (level === 'off') draft.off = null
      continue
    }
    if (typeof wire === 'string' && wire.length > 0) draft[level] = wire
  }
  return finishEfforts(draft)
}

function pickOpenAiThinkingCompat(compat) {
  if (compat === null || typeof compat !== 'object' || Array.isArray(compat)) return undefined
  const out = {}
  for (const key of [
    'thinkingFormat',
    'supportsReasoningEffort',
    'thinkingTokenBudgetField',
    'requiresReasoningContentOnAssistantMessages',
  ]) {
    if (compat[key] !== undefined) out[key] = compat[key]
  }
  // Custom OpenAI-compatible gateways reject `developer`; pi-ai sends that
  // role to any reasoning model whose URL looks like OpenAI unless this is false.
  if (Object.keys(out).length > 0) out.supportsDeveloperRole = false
  return Object.keys(out).length > 0 ? out : undefined
}

/** Per-key merge: primary wins, fallback fills blanks (builtin over models.dev). */
function mergeCompat(primary, fallback) {
  if (primary === undefined) return fallback
  if (fallback === undefined) return primary
  return { ...fallback, ...primary }
}

/** OpenAI custom routes: thinking models must keep the system role. */
function guardOpenAiGateway(caps, routeApi) {
  if (!OPENAI_APIS.has(routeApi)) return caps
  const thinks = caps.reasoningEfforts !== undefined && caps.reasoningEfforts !== false
  const hasWire = caps.compat !== undefined
  if (!thinks && !hasWire) return caps
  return {
    ...caps,
    compat: { ...(caps.compat ?? {}), supportsDeveloperRole: false },
  }
}

function builtinInput(input) {
  if (!Array.isArray(input)) return undefined
  const next = input.filter((modality) => INPUT_MODALITIES.has(modality))
  return next.length > 0 ? next : undefined
}

/**
 * Index pi-ai builtin model objects (or plain fixtures) by normalized id.
 * Does not store baseUrl — custom routes keep their own endpoint.
 */
function indexBuiltins(models) {
  const index = {}
  if (!Array.isArray(models)) return index
  for (const model of models) {
    if (model === null || typeof model !== 'object' || Array.isArray(model)) continue
    const id = label(model.id)
    if (id === undefined) continue
    const api = label(model.api)
    if (api === undefined || !LISTABLE_APIS.has(api)) continue
    const provider = label(model.provider) ?? ''
    const record = {
      provider,
      api,
      contextWindow: positiveInt(model.contextWindow),
      maxTokens: positiveInt(model.maxTokens),
      name: label(model.name),
      input: builtinInput(model.input),
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap !== null && typeof model.thinkingLevelMap === 'object'
        ? model.thinkingLevelMap
        : undefined,
      compat: model.compat !== null && typeof model.compat === 'object' && !Array.isArray(model.compat)
        ? model.compat
        : undefined,
    }
    pushRecord(index, id.toLowerCase(), record)
  }
  return index
}

function builtinRecords(builtins, modelId) {
  const out = []
  const seenKey = new Set()
  for (const candidate of lookupCandidates(modelId)) {
    const seen = new Set()
    let id = candidate
    while (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
      seen.add(id)
      for (const row of recordsAt(builtins, id)) {
        const key = `${row.provider}\0${row.api}`
        if (seenKey.has(key)) continue
        seenKey.add(key)
        out.push(row)
      }
      const base = versionBase(id)
      if (base === undefined) break
      id = base
    }
  }
  return out
}

/** Same-api hits first, then maker providers, then any remaining hit. */
function selectBuiltin(records, routeApi) {
  if (!Array.isArray(records) || records.length === 0) return undefined
  const same = typeof routeApi === 'string'
    ? records.filter((record) => record.api === routeApi)
    : []
  const pool = same.length > 0 ? same : records
  const makers = pool.filter((record) => MAKER_PROVIDERS.has(record.provider))
  const prefer = makers.length > 0 ? makers : pool
  return [...prefer].sort((left, right) => {
    if (left.provider.length !== right.provider.length) return left.provider.length - right.provider.length
    return left.provider < right.provider ? -1 : 1
  })[0]
}

/**
 * Project one builtin row onto the custom route's api (DESIGN.md §3).
 * OpenAI is the default track; Anthropic rows project onto OpenAI via thinking.type.
 */
function projectBuiltin(record, routeApi) {
  if (record === undefined || typeof routeApi !== 'string') return undefined
  const contextWindow = record.contextWindow
  const maxTokens = record.maxTokens
  const name = record.name
  const input = record.input
  const fromMap = effortsFromThinkingMap(record.thinkingLevelMap)
  let reasoningEfforts
  let compat
  let thinkingKnown = false

  if (record.reasoning === false) {
    reasoningEfforts = false
    thinkingKnown = true
  } else if (OPENAI_APIS.has(routeApi)) {
    if (OPENAI_APIS.has(record.api)) {
      compat = pickOpenAiThinkingCompat(record.compat)
      reasoningEfforts = fromMap
      if (reasoningEfforts === undefined && record.reasoning === true && compat?.thinkingFormat !== undefined
        && compat.supportsReasoningEffort === false) {
        reasoningEfforts = { ...TOGGLE_EFFORTS }
      }
      thinkingKnown = reasoningEfforts !== undefined || record.reasoning === true
    } else if (record.api === 'anthropic-messages' && record.reasoning === true) {
      // Menu + sizes only. Do not invent a Completions thinkingFormat:
      // pi-ai's `deepseek` dialect sends thinking.type=enabled/disabled, but
      // adaptive-native Anthropic rows (and some OpenAI gateways that mirror
      // them) only accept adaptive/disabled — which the Completions transport
      // cannot emit. Fabricating deepseek is a wrong cross-protocol guess.
      reasoningEfforts = fromMap ?? { ...TOGGLE_EFFORTS }
      thinkingKnown = true
    }
  } else if (routeApi === 'anthropic-messages') {
    if (record.api === 'anthropic-messages' && record.reasoning === true) {
      reasoningEfforts = fromMap ?? { ...ANTHROPIC_DEFAULT_EFFORTS }
      thinkingKnown = true
      if (record.compat?.forceAdaptiveThinking === true) {
        compat = { forceAdaptiveThinking: true }
      }
    } else if (OPENAI_APIS.has(record.api) && record.reasoning === true) {
      reasoningEfforts = fromMap ?? { ...ANTHROPIC_DEFAULT_EFFORTS }
      thinkingKnown = true
    }
  }

  if (contextWindow === undefined && maxTokens === undefined && reasoningEfforts === undefined
    && !thinkingKnown && name === undefined && input === undefined && compat === undefined) {
    return undefined
  }
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
    ...name === undefined ? {} : { name },
    ...input === undefined ? {} : { input },
    ...compat === undefined ? {} : { compat },
    thinkingKnown,
  }
}

/** True when a projection already carries a usable thinking menu or wire. */
function hasThinkingProjection(projected) {
  if (projected === undefined) return false
  if (projected.compat?.thinkingFormat !== undefined) return true
  return projected.reasoningEfforts !== undefined && projected.reasoningEfforts !== false
}

/** Completions thinkingFormat is gateway dialect — only trust maker OpenAI rows. */
function hasMakerThinkingWire(row, routeApi) {
  if (!MAKER_PROVIDERS.has(row.provider)) return false
  const projected = projectBuiltin(row, routeApi)
  return projected?.compat?.thinkingFormat !== undefined
}

/**
 * Same-api hits may be weak resellers (reasoning:true, no wire). Overlay a
 * maker Completions thinkingFormat when one exists. Never invent a wire from
 * Anthropic projection alone (adaptive vs enabled are different dialects).
 * Menu-only fill copies efforts without a thinkingFormat.
 */
function overlayThinking(primary, hits, routeApi) {
  if (primary === undefined) return primary
  let next = primary
  if (next.compat?.thinkingFormat === undefined) {
    const wired = hits.filter((row) => hasMakerThinkingWire(row, routeApi))
    const projected = projectBuiltin(selectBuiltin(wired, routeApi), routeApi)
    if (projected?.compat?.thinkingFormat !== undefined) {
      next = {
        ...next,
        ...projected.reasoningEfforts !== undefined ? { reasoningEfforts: projected.reasoningEfforts } : {},
        compat: mergeCompat(projected.compat, next.compat),
        thinkingKnown: next.thinkingKnown === true || projected.thinkingKnown === true,
      }
    }
  }
  if (next.reasoningEfforts === undefined) {
    const menus = hits.filter((row) => {
      const projected = projectBuiltin(row, routeApi)
      return projected?.reasoningEfforts !== undefined && projected.reasoningEfforts !== false
    })
    const projected = projectBuiltin(selectBuiltin(menus, routeApi), routeApi)
    if (projected?.reasoningEfforts !== undefined && projected.reasoningEfforts !== false) {
      next = {
        ...next,
        reasoningEfforts: projected.reasoningEfforts,
        thinkingKnown: next.thinkingKnown === true || projected.thinkingKnown === true,
      }
    }
  }
  return next
}

function resolveCaps(modelId, listed, catalog, builtins, routeApi) {
  const api = routeApi ?? 'openai-completions'
  const fromList = listingFor(listed, modelId)
  const hits = builtinRecords(builtins ?? {}, modelId)
  let builtin = projectBuiltin(selectBuiltin(hits, api), api)
  if (OPENAI_APIS.has(api)) builtin = overlayThinking(builtin, hits, api)
  const maker = selectMaker(catalogRecords(catalog, modelId))
  let reasoningEfforts = fromList.reasoningEfforts ?? builtin?.reasoningEfforts ?? maker?.reasoningEfforts
  const compat = mergeCompat(builtin?.compat, maker?.compat)
  // A thinking wire without a menu is not usable in chat; invent off+one on-level.
  if (
    reasoningEfforts === undefined
    && compat?.thinkingFormat !== undefined
    && (builtin?.thinkingKnown === true || maker?.thinkingKnown === true)
    && compat.supportsReasoningEffort !== true
  ) {
    reasoningEfforts = { ...TOGGLE_EFFORTS }
  }
  return guardOpenAiGateway({
    contextWindow: fromList.contextWindow ?? builtin?.contextWindow ?? maker?.contextWindow,
    maxTokens: fromList.maxTokens ?? builtin?.maxTokens ?? maker?.maxTokens,
    reasoningEfforts,
    effortsKnown: fromList.reasoningEfforts !== undefined
      || builtin?.thinkingKnown === true
      || maker?.thinkingKnown === true
      || reasoningEfforts !== undefined,
    ...fromList.name !== undefined || builtin?.name !== undefined || maker?.name !== undefined
      ? { name: fromList.name ?? builtin?.name ?? maker?.name }
      : {},
    ...fromList.input !== undefined || builtin?.input !== undefined || maker?.input !== undefined
      ? { input: fromList.input ?? builtin?.input ?? maker?.input }
      : {},
    ...compat === undefined ? {} : { compat },
  }, api)
}

/** A `compat` block that only carries auto-filled thinking / gateway fields. */
function catalogDialect(compat) {
  if (compat === null || typeof compat !== 'object' || Array.isArray(compat)) return false
  const keys = Object.keys(compat)
  if (keys.length === 0) return false
  if (!keys.every((key) => AUTO_COMPAT_KEYS.has(key))) return false
  if (compat.thinkingFormat !== undefined && !AUTO_THINKING_FORMATS.has(compat.thinkingFormat)) return false
  return true
}

function applyCaps(model, caps, routeApi) {
  if (model === null || typeof model !== 'object' || Array.isArray(model)) return model
  const next = { ...model }
  let changed = false
  if ((model.name === undefined || model.name === '') && typeof caps.name === 'string' && caps.name.length > 0) {
    next.name = caps.name
    changed = true
  }
  if (model.contextWindow === undefined && caps.contextWindow !== undefined) {
    next.contextWindow = caps.contextWindow
    changed = true
  }
  if (model.maxTokens === undefined && caps.maxTokens !== undefined) {
    next.maxTokens = caps.maxTokens
    changed = true
  }
  const blankInput = !Array.isArray(model.input) || model.input.length === 0
  if (blankInput && Array.isArray(caps.input) && caps.input.length > 0) {
    next.input = caps.input
    changed = true
  }
  const refresh = (model.compat === undefined || catalogDialect(model.compat))
    && catalogShaped(model.reasoningEfforts)
  if (model.reasoningEfforts === undefined && caps.reasoningEfforts !== undefined) {
    next.reasoningEfforts = caps.reasoningEfforts
    changed = true
  } else if (refresh && caps.effortsKnown && !effortsEqual(model.reasoningEfforts, caps.reasoningEfforts)) {
    if (caps.reasoningEfforts === undefined) delete next.reasoningEfforts
    else next.reasoningEfforts = caps.reasoningEfforts
    changed = true
  }
  // Auto compat (incl. supportsDeveloperRole) may refresh even when efforts already match.
  // Do not strip auto compat when sources are unknown (catalog/listing down).
  if (model.compat === undefined || catalogDialect(model.compat)) {
    if (caps.compat !== undefined) {
      if (JSON.stringify(next.compat) !== JSON.stringify(caps.compat)) {
        next.compat = caps.compat
        changed = true
      }
    } else if (
      catalogDialect(model.compat)
      && caps.effortsKnown
      && (caps.reasoningEfforts === false || caps.reasoningEfforts === undefined)
    ) {
      delete next.compat
      changed = true
    }
  }
  // Existing thinking menus on OpenAI custom routes still need the gateway guard,
  // even when resolveCaps has nothing new from listing/catalog/builtins.
  if (
    OPENAI_APIS.has(routeApi)
    && next.reasoningEfforts !== undefined
    && next.reasoningEfforts !== false
    && (next.compat === undefined || catalogDialect(next.compat))
    && next.compat?.supportsDeveloperRole !== false
  ) {
    next.compat = { ...(next.compat ?? {}), supportsDeveloperRole: false }
    changed = true
  }
  return changed ? next : model
}

/**
 * Settings path ops that replace a custom route's `models` array.
 * Hand-written fields stay. Routes the installed catalog already describes
 * (no `api`) are left alone. Returns no op when nothing was blank.
 */
function planMutations(section, listings, catalog, builtins) {
  const providers = section?.providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
    return { ops: [], filled: {} }
  }
  const ops = []
  const filled = {}
  for (const [id, profile] of Object.entries(providers)) {
    if (!isCustomProvider(profile)) continue
    const listed = listings[id] ?? []
    let count = 0
    const models = profile.models.map((model) => {
      if (typeof model?.id !== 'string') return model
      const next = applyCaps(model, resolveCaps(model.id, listed, catalog, builtins, profile.api), profile.api)
      if (next !== model) count += 1
      return next
    })
    filled[id] = count
    if (count > 0) {
      ops.push({ op: 'set', path: ['providers', id, 'models'], value: models })
    }
  }
  return { ops, filled }
}

export {
  ANTHROPIC_VERSION,
  CATALOG_URL,
  LISTABLE_APIS,
  MAX_BODY_BYTES,
  PLUGIN_NAME,
  SETTINGS_NS,
  THINKING_LEVELS,
  applyCaps,
  customRoutes,
  gapSignature,
  indexBuiltins,
  indexCatalog,
  isCustomProvider,
  listingHeaders,
  listingUrl,
  planMutations,
  projectBuiltin,
  readListing,
  resolveCaps,
  selectBuiltin,
}
