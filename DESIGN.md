# dsh-model-caps design

**English** · [中文](DESIGN.zh.md)

This document is the **design source of truth**. Implementation and README behavior must follow it.

## Goals

For DSH **custom providers**, fill blank context windows, output caps, thinking menus, and wire-related `compat` so chat can offer levels and **send correct payloads**. Hand-written fields stay. Models are not added or removed.

Constraints:

1. **Default track is OpenAI-compatible** (`openai-completions` / `openai-responses`): OpenAI-only must still reach expected config.
2. **Anthropic Messages is an optional user choice** when a vendor speaks both; the system never forces the protocol dropdown.
3. **One custom provider route has one `api` and one `baseURL`**. Multi-protocol needs multiple provider entries.
4. **Few allowlists, wide matching**: prefer rules and the installed pi-ai catalog; per-model exception tables stay near zero.

## Layers (decoupling)

| Layer | Owns | Does not own |
|---|---|---|
| Route `api` | User-chosen wire protocol | Guessing the vendor |
| Installed pi-ai catalog | Proven protocol + `compat` + level maps | Custom gateway URLs |
| Semantic → protocol projection | Map a catalog hit onto the **current** route api | Long per-model tables |
| models.dev | Capability cards (windows, control shapes) | Source of truth for `thinkingFormat` |
| Maker dialect fallback | Only when no builtin hit | The primary path |
| Hand-written settings | Highest priority | — |

## Pipeline

```text
Normalize model id
  → Look up the pi-ai builtin index (may multi-hit)
  → Prefer same api, else a maker provider row; project onto the route api
  → If OpenAI route lacks a Completions thinkingFormat, overlay a **maker**
    OpenAI wire when one exists; Anthropic hits may fill a menu only (never
    invent `thinkingFormat: deepseek` — Completions cannot emit adaptive)
  → Merge fields (§5): listing → builtin projection → models.dev
  → Never overwrite hand-written fields
```

### 1. Id normalization (rules, not lists)

- Compare case-insensitively
- Drop a `scheme:` prefix; take the segment after the last `/`
- Peel a trailing calendar date
- Peel a `vN.M` dotted minor when more name follows (`deepseek-v4.1-flash` → `deepseek-v4-flash`); bare `mimo-v2.5` stays
- Do **not** fold `FlashX` into `Flash`

### 2. Builtin hit selection

The same id may appear under several builtin providers with conflicting `compat` (official `deepseek` vs reseller `qwen`).

Order:

1. Prefer `builtin.api === route.api`. If that projection has no Completions `thinkingFormat`, overlay a **maker** same-family OpenAI wire when one exists. Anthropic-only hits may still supply a thinking **menu**, but not a fabricated Completions dialect.
2. Else prefer a maker provider row
3. Else do not attach thinking wire; sizes only when safe

### 3. Protocol projection

| Route api | Builtin api | Behavior |
|---|---|---|
| OpenAI family | OpenAI family | Copy thinking `compat` subset + efforts from `thinkingLevelMap`; toggle-only with no map → `off` + one on-level; **always** set `supportsDeveloperRole: false` (custom gateways reject `developer`) |
| OpenAI family | `anthropic-messages` with reasoning | **Weak projection**: menu (+ sizes) only. Do **not** invent `thinkingFormat: deepseek` — that emits `thinking.type=enabled`, which adaptive-native gateways reject (`adaptive`/`disabled` only exist on the Anthropic transport) |
| Anthropic | Anthropic | Copy; default Anthropic menu when no map; carry `forceAdaptiveThinking` if the builtin has it |
| Anthropic | OpenAI family | Weak projection: menu only |
| Uncertain | — | Leave thinking `compat` unset |

Never copy builtin `baseUrl` / `provider`. The custom `baseURL` always wins.

### 4. models.dev fallback

When the builtin misses or only has sizes:

- Fill windows / efforts / fallback dialect from the maker row
- Alibaba `qwen` only on a native family; DeepSeek / Z.AI on their own catalog rows
- Toggle with no dialect evidence: do not invent levels

### 5. Merge priority (per field)

```text
hand-written
  → provider listing
    → builtin projection
      → models.dev maker row
```

`compat` never comes from the listing. Builtin projection beats models.dev fallback. Auto `compat` may refresh; hand-written or non-auto blocks stay.

## Explicit non-goals

- Do not infer `thinkingFormat` from models.dev `toggle` shape alone
- Do not silently switch a Completions route to Anthropic
- Do not invent effort menus without evidence
- Do not maintain long per-model exception tables

## Module boundaries

| Module | Role |
|---|---|
| `dsh-model-caps-core.js` | Pure policy: index, match, project, merge, planMutations |
| `dsh-model-caps-sync.js` | IO: listing, models.dev, optional builtin load, mutate |
| `dsh-model-caps.host.js` | Cordis mount and triggers |
| Builtins | Optional runtime `@earendil-works/pi-ai`; absent → models.dev fallback only |

## Acceptance

- OpenAI-only custom routes: builtin DeepSeek / Kimi / GLM keep correct Completions wires; Anthropic-only models (e.g. MiniMax-M3) get a menu without a fabricated `thinkingFormat`
- User-chosen Anthropic + MiniMax Anthropic URL: use the Anthropic builtin row (`forceAdaptiveThinking` when present); no M3 allowlist
- Hand-written `compat` / non-standard wires stay
- `node verify.mjs` passes (including `test-design.mjs` cross matrix)
