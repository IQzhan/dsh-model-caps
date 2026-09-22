# dsh-model-caps

[中文](README.zh.md) · **English**

A small [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. For each **custom provider** it fills blank context windows, output caps, thinking levels, and thinking wire `compat`, so the chat model menu can offer them the way it offers a built-in provider. Values you already wrote stay. Models are not added or removed.

**Design:** [DESIGN.md](DESIGN.md) (source of truth). OpenAI-compatible is the default track; Anthropic is an optional user choice. One custom route has one `api`.

8 suites. Run `node verify.mjs`.

## What it writes

A custom provider is a `llm-pi-ai` route that has `api`, `baseURL`, and at least one model. Catalog routes such as `openai` or `google` are left alone.

Per field, blanks merge in this order (see [DESIGN.md](DESIGN.md) §5):

1. The provider's own `GET {baseURL}/models` listing (sizes / levels it publishes).
2. **pi-ai builtins** (when available): match by normalized id, prefer the same `api`, else a maker row; **project** onto the route protocol. OpenAI routes may overlay a **maker** Completions `thinkingFormat`; Anthropic-only hits supply a menu, not a fabricated `deepseek` wire (Completions cannot emit `adaptive`).
3. [models.dev](https://models.dev/api.json) maker rows for remaining gaps (thin dialect fallback when no builtin hit).

Id lookup: exact → drop `scheme:` / path leaf → peel a trailing calendar date → peel `vN.M` when more name follows (`deepseek-v4.1-flash` → `deepseek-v4-flash`; bare `mimo-v2.5` stays). `FlashX` and `Flash` stay distinct.

`contextWindow`, `maxTokens`, blank `name`, blank `input` (`text` / `image`), `reasoningEfforts`, and auto `compat` are written. Hand-written `compat`, `reasoningEfforts: false`, and non-standard effort wires stay. Catalog-shaped auto fills may refresh. Route-level thinking budgets are not written.

## Install

```bash
node build-model-caps.mjs
dsh plugin --profile web add ./package
```

Requires Node 24 or newer. Restart `dsh web`. Caps fill on mount, and again when you save the provider in Settings. There is no separate settings page.

## Uninstall

`dsh plugin --profile web remove dsh-model-caps`. A custom wire or a `compat` block is not overwritten. A catalog-shaped effort map can be refreshed; removing the plugin does not roll that back.
