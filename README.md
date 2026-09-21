# dsh-model-caps

[中文](README.zh.md) · **English**

A small [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. For each **custom provider** it fills blank context windows, output caps, and thinking levels, so the chat model menu can offer them the way it offers a built-in provider. Values you already wrote stay. Models are not added or removed.

7 suites. Run `node verify.mjs`.

## What it writes

A custom provider is a `llm-pi-ai` route that has `api`, `baseURL`, and at least one model. Catalog routes such as `openai` or `google` are left alone; their installed catalog already carries these fields.

For each model on that route, a blank field is filled from:

1. The provider's own `GET {baseURL}/models` listing, when it actually publishes the number or the thinking levels.
2. Otherwise [models.dev](https://models.dev/api.json), using the **maker's** record (OpenAI, Z.AI, Alibaba, DeepSeek, and the other trainers). An id with no row of its own falls back through a trailing calendar date (`-`, `_`, `:`, or `@`, as `YYYY-MM-DD` or `YYYYMMDD`) to that undated id. An exact catalog id still wins, including its own context and output. `preview`, `exp`, and `-v2` are not versions. Reseller copies of one id disagree, and intersecting them collapses the menu to the one level every copy repeated.

`off` is written into the same `reasoningEfforts` map as the other levels when the maker publishes a toggle or an `none` value. A toggle with no effort list is `off` plus one on-level, and only for the Alibaba Chat Completions dialect (`thinkingFormat: qwen`, `enable_thinking`). Any other toggle is left unset rather than given invented levels. A maker that publishes neither a toggle nor an effort list does not get a thinking map.

`contextWindow`, `maxTokens`, blank `name`, blank `input` (`text` / `image` only), `reasoningEfforts`, and that dialect's `compat` are the fields written. A model with `compat`, a `reasoningEfforts: false` you set yourself, and any effort wire that is not a standard level name (for example `no_think`) stay. A map that only repeats catalog level names and has no `compat` block is refreshed from the maker, because that shape is what an earlier fill wrote. Route-level thinking budgets are not written. Requests use `HTTPS_PROXY` when it is set, and otherwise the operating-system proxy.

## Install

```bash
node build-model-caps.mjs
dsh plugin --profile web add ./package
```

Requires Node 24 or newer. Restart `dsh web`. Caps fill on mount, and again when you save the provider in Settings. There is no separate settings page.

## Uninstall

`dsh plugin --profile web remove dsh-model-caps`. A custom wire or a `compat` block is not overwritten. A catalog-shaped effort map can be refreshed; removing the plugin does not roll that back.
