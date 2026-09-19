/**
 * dsh-model-caps-core — policy with no Cordis and no IO.
 *
 * Decides which routes are custom providers, reads a model listing or a
 * public catalog into context / output / thinking-level caps, and plans the
 * settings edits that fill only the fields a model does not already have.
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
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
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

function bareId(id) {
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

function capsFromCatalogModel(model) {
  const contextWindow = positiveInt(model?.limit?.context)
  const maxTokens = positiveInt(model?.limit?.output)
  const reasoningEfforts = effortsFromOptions(model?.reasoning_options)
  if (contextWindow === undefined && maxTokens === undefined && reasoningEfforts === undefined) return undefined
  return {
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...reasoningEfforts === undefined ? {} : { reasoningEfforts },
  }
}

function pushCap(index, bucket, caps) {
  if (bucket.length === 0) return
  const list = index[bucket] ?? []
  if (list.includes(caps)) return
  list.push(caps)
  index[bucket] = list
}

/**
 * Index a models.dev document by exact id and by its lower-case form.
 * One model is stored once per bucket. Callers intersect the bucket, so a
 * level is kept only when every record that publishes efforts agrees.
 */
function indexCatalog(body) {
  const index = {}
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return index
  for (const provider of Object.values(body)) {
    const models = provider?.models
    if (models === null || typeof models !== 'object') continue
    const entries = Array.isArray(models)
      ? models.map((model) => [typeof model?.id === 'string' ? model.id : '', model])
      : Object.entries(models)
    for (const [key, model] of entries) {
      const caps = capsFromCatalogModel(model)
      if (caps === undefined) continue
      const buckets = new Set()
      if (typeof key === 'string' && key.length > 0) buckets.add(key)
      if (typeof model?.id === 'string' && model.id.length > 0) buckets.add(model.id)
      for (const id of [...buckets]) buckets.add(bareId(id))
      for (const id of buckets) {
        pushCap(index, id, caps)
        pushCap(index, id.toLowerCase(), caps)
      }
    }
  }
  return index
}

function agreeNumber(records, field) {
  const values = []
  for (const record of records) {
    if (record[field] !== undefined) values.push(record[field])
  }
  if (values.length === 0) return undefined
  return values.every((value) => value === values[0]) ? values[0] : undefined
}

function pickWire(level, wires) {
  if (wires.every((wire) => wire === wires[0])) return wires[0]
  if (level === 'off') {
    if (wires.includes('none')) return 'none'
    if (wires.includes(null)) return null
    return wires.find((wire) => typeof wire === 'string') ?? null
  }
  return level
}

function intersectEfforts(lists) {
  const draft = {}
  for (const level of THINKING_LEVELS) {
    if (!lists.every((efforts) => Object.prototype.hasOwnProperty.call(efforts, level))) continue
    draft[level] = pickWire(level, lists.map((efforts) => efforts[level]))
  }
  return finishEfforts(draft)
}

function agreeEfforts(records) {
  const lists = records.map((record) => record.reasoningEfforts).filter((efforts) => efforts !== undefined)
  if (lists.length === 0) return undefined
  return intersectEfforts(lists)
}

function catalogRecords(catalog, modelId) {
  const exact = catalog[modelId]
  if (exact !== undefined && exact.length > 0) return exact
  const lower = catalog[modelId.toLowerCase()]
  return lower ?? []
}

function resolveCaps(modelId, listed, catalog) {
  const fromList = listed.find((item) => item.id === modelId) ?? {}
  const agreed = catalogRecords(catalog, modelId)
  return {
    contextWindow: fromList.contextWindow ?? agreeNumber(agreed, 'contextWindow'),
    maxTokens: fromList.maxTokens ?? agreeNumber(agreed, 'maxTokens'),
    reasoningEfforts: fromList.reasoningEfforts ?? agreeEfforts(agreed),
  }
}

function applyCaps(model, caps) {
  if (model === null || typeof model !== 'object' || Array.isArray(model)) return model
  const next = { ...model }
  let changed = false
  if (model.contextWindow === undefined && caps.contextWindow !== undefined) {
    next.contextWindow = caps.contextWindow
    changed = true
  }
  if (model.maxTokens === undefined && caps.maxTokens !== undefined) {
    next.maxTokens = caps.maxTokens
    changed = true
  }
  if (model.reasoningEfforts === undefined && caps.reasoningEfforts !== undefined) {
    next.reasoningEfforts = caps.reasoningEfforts
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
