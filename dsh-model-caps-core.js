/**
 * dsh-model-caps-core — policy with no Cordis and no IO.
 *
 * Decides which routes are custom providers, reads a model listing or a
 * public catalog into context / output / thinking caps, and plans the
 * settings edits. A blank field is filled from the provider listing, then
 * from the model's maker on models.dev. A trailing calendar date falls
 * back to that undated id only when the snapshot itself has no row.
 * Reseller copies of the same id are not intersected.
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
 * Spellings a listing may use for a thinking level. The value is the level
 * the chat menu shows; the original token stays the wire spelling unless it
 * is an off-synonym, which sends nothing except the explicit `none`.
 */
/**
 * models.dev repeats every popular id under resellers, and those copies
 * publish different effort subsets. The trainer's own provider is the
 * record that names the levels. Anyone else is a fallback.
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
  'moonshotai',
  'minimax',
  'xiaomi',
  'tencent-tokenhub',
  'mistral',
  'xai',
  'cohere',
])

/**
 * Makers whose hybrid thinking is `enable_thinking` on Chat Completions.
 * pi-ai's `qwen` format sends that boolean from whether a level is selected,
 * and sends `reasoning_effort` only when `supportsReasoningEffort` is set.
 */
const QWEN_THINKING = new Set(['alibaba', 'alibaba-cn'])

const INPUT_MODALITIES = new Set(['text', 'image'])

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

function qwenCompat(provider, parsed) {
  if (!QWEN_THINKING.has(provider) || !parsed.shape.toggle || parsed.efforts === undefined) return undefined
  const compat = {
    thinkingFormat: 'qwen',
    supportsReasoningEffort: parsed.publishedEffort,
  }
  if (parsed.shape.budget) compat.thinkingTokenBudgetField = 'thinking_budget'
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

function capsFromCatalogModel(model, provider) {
  const contextWindow = positiveInt(model?.limit?.context)
  const maxTokens = positiveInt(model?.limit?.output)
  const parsed = effortsFromCatalogOptions(model?.reasoning_options, QWEN_THINKING.has(provider))
  let reasoningEfforts = parsed.efforts
  const thinkingKnown = reasoningEfforts !== undefined || parsed.shape.toggle || model?.reasoning === false
  if (reasoningEfforts === undefined && model?.reasoning === false) reasoningEfforts = false
  const name = label(model?.name)
  const input = catalogInput(model?.modalities?.input)
  const compat = qwenCompat(provider, parsed)
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
    for (const [key, model] of entries) {
      const caps = capsFromCatalogModel(model, providerId)
      if (caps === undefined) continue
      const family = typeof model?.family === 'string' ? model.family : ''
      const record = {
        provider: providerId,
        providerSize,
        familySize: family.length > 0 ? familySize[family] ?? 0 : 1,
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

/** The trainer when one is present, otherwise the catalog that is mostly this family. */
function selectMaker(records) {
  if (records.length === 0) return undefined
  const makers = records.filter((record) => MAKER_PROVIDERS.has(record.provider))
  if (makers.length > 0) return byConcentration(makers)
  const host = byConcentration(records)
  const efforts = modeEfforts(records)
  if (host === undefined) return undefined
  if (efforts === undefined) return host
  return { ...host, reasoningEfforts: efforts, thinkingKnown: true }
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

function recordsAt(catalog, modelId) {
  if (typeof modelId !== 'string' || modelId.length === 0) return []
  const exact = catalog[modelId]
  if (exact !== undefined && exact.length > 0) return exact
  const lower = catalog[modelId.toLowerCase()]
  return lower ?? []
}

function catalogRecords(catalog, modelId) {
  const seen = new Set()
  let id = modelId
  while (typeof id === 'string' && id.length > 0 && !seen.has(id)) {
    seen.add(id)
    const found = recordsAt(catalog, id)
    if (found.length > 0) return found
    const base = datedVersionBase(id)
    if (base === undefined) return []
    id = base
  }
  return []
}

function sameModelId(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase()
}

/** Exact listing row wins each field. A dated id with a blank field borrows that field from the undated row. */
function listingFor(listed, modelId) {
  const exact = listed.find((item) => item.id === modelId)
  let donor
  const seen = new Set()
  let id = modelId
  while (donor === undefined && typeof id === 'string' && !seen.has(id)) {
    seen.add(id)
    const base = datedVersionBase(id)
    if (base === undefined) break
    donor = listed.find((item) => sameModelId(item.id, base))
    id = base
  }
  if (donor === undefined) return exact ?? {}
  return {
    contextWindow: exact?.contextWindow ?? donor.contextWindow,
    maxTokens: exact?.maxTokens ?? donor.maxTokens,
    reasoningEfforts: exact?.reasoningEfforts ?? donor.reasoningEfforts,
    name: exact?.name ?? donor.name,
    input: exact?.input ?? donor.input,
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

function resolveCaps(modelId, listed, catalog) {
  const fromList = listingFor(listed, modelId)
  const records = catalogRecords(catalog, modelId)
  const maker = selectMaker(records)
  const reasoningEfforts = fromList.reasoningEfforts ?? maker?.reasoningEfforts
  const compat = fromList.reasoningEfforts !== undefined ? undefined : maker?.compat
  return {
    contextWindow: fromList.contextWindow ?? maker?.contextWindow,
    maxTokens: fromList.maxTokens ?? maker?.maxTokens,
    reasoningEfforts,
    effortsKnown: fromList.reasoningEfforts !== undefined || maker?.thinkingKnown === true,
    ...fromList.name !== undefined || maker?.name !== undefined ? { name: fromList.name ?? maker?.name } : {},
    ...fromList.input !== undefined || maker?.input !== undefined ? { input: fromList.input ?? maker?.input } : {},
    ...compat === undefined ? {} : { compat },
  }
}

function applyCaps(model, caps) {
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
  const refresh = model.compat === undefined && catalogShaped(model.reasoningEfforts)
  if (model.reasoningEfforts === undefined && caps.reasoningEfforts !== undefined) {
    next.reasoningEfforts = caps.reasoningEfforts
    changed = true
  } else if (refresh && caps.effortsKnown && !effortsEqual(model.reasoningEfforts, caps.reasoningEfforts)) {
    if (caps.reasoningEfforts === undefined) delete next.reasoningEfforts
    else next.reasoningEfforts = caps.reasoningEfforts
    changed = true
  }
  const wroteEfforts = model.reasoningEfforts === undefined && next.reasoningEfforts !== undefined
  if (model.compat === undefined && caps.compat !== undefined && (wroteEfforts || refresh)) {
    next.compat = caps.compat
    changed = true
  }
  return changed ? next : model
}

/**
 * Settings path ops that replace a custom route's `models` array.
 * Hand-written fields stay. Routes the installed catalog already describes
 * (no `api`) are left alone. Returns no op when nothing was blank.
 */
function planMutations(section, listings, catalog) {
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
      const next = applyCaps(model, resolveCaps(model.id, listed, catalog))
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
  indexCatalog,
  isCustomProvider,
  listingHeaders,
  listingUrl,
  planMutations,
  readListing,
  resolveCaps,
}
