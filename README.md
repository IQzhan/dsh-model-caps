# dsh-model-caps

[中文](README.zh.md) · **English**

A small [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. For each **custom provider** it fills blank context windows, output caps, and thinking levels, so the chat model menu can offer them the way it offers a built-in provider. Values you already wrote stay. Models are not added or removed.

7 suites. Run `node verify.mjs`.

## What it writes

A custom provider is a `llm-pi-ai` route that has `api`, `baseURL`, and at least one model. Catalog routes such as `openai` or `google` are left alone; their installed catalog already carries these fields.

For each model on that route, a blank field is filled from:

1. The provider's own `GET {baseURL}/models` listing, when it actually publishes the number or the thinking levels.
2. Otherwise [models.dev](https://models.dev/api.json), and only when every record for that model id agrees. Thinking levels are the intersection, not a vote.

`contextWindow`, `maxTokens`, and `reasoningEfforts` are the only fields written. `compat`, `input`, names, and a `reasoningEfforts: false` you set yourself are not touched. A gateway that needs `compat.thinkingFormat` still needs that one line: no listing publishes it.

## Install

```bash
node build-model-caps.mjs
dsh plugin --profile web add ./package
```

Requires Node 24 or newer. Restart `dsh web`. Settings → **Model caps** shows the last sync and a **Sync now** button. Mount, and any later change that leaves a custom model blank, syncs on its own.

## Uninstall

`dsh plugin --profile web remove dsh-model-caps`. Nothing of yours is restored, because nothing of yours was overwritten.
