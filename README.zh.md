# dsh-model-caps

[English](README.md) · **简体中文**

一个轻量的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。它给**自定义供应商**补上空白的上下文窗口、输出上限和思考等级，这样在对话里选模型时，就和内置供应商一样，不用再去 `settings.yaml` 里手写这三项。已经写过的值会保留。不会增删模型。

8 个套件。运行 `node verify.mjs`。

## 它写什么

自定义供应商是 `llm-pi-ai` 里同时带有 `api`、`baseURL` 和至少一个模型的路由。`openai`、`google` 这种目录路由不动，已安装目录里已经有这些字段。

每个模型的空白字段按这个顺序补：

1. 供应商自己的 `GET {baseURL}/models`。列表里真有上下文长度或思考等级时，用它。
2. 否则用 [models.dev](https://models.dev/api.json) 里**模型厂商自己的记录**（OpenAI、Z.AI、阿里云、DeepSeek 等）。目录里没有这条 id 时，只把末尾的日历日期剥掉再查（分隔符 `-`、`_`、`:`、`@`，形式 `YYYY-MM-DD` 或 `YYYYMMDD`）。精确 id 仍整行优先，包括它自己的上下文和输出上限。`preview`、`exp`、`-v2` 不是版本。转售商对同一 id 各写一套等级，取交集会把菜单收成大家都有的那一级，所以不用交集。

厂商公布了开关，或等级里有 `none` 时，`off` 和其余等级写在同一份 `reasoningEfforts` 里。只有开关、没有等级列表时，写成「关」加一档「开」，且仅限阿里云 Chat Completions 方言（`thinkingFormat: qwen`，发出 `enable_thinking`）。其它厂商的纯开关不编造等级，思考表留空。既没有开关也没有等级列表时，不写思考表。

写入的字段是 `contextWindow`、`maxTokens`、空白的 `name`、空白的 `input`（只保留 `text` / `image`）、`reasoningEfforts`，以及上述方言的 `compat`。带 `compat` 的模型、你写成 `reasoningEfforts: false` 的模型，以及线值不是标准等级名的思考等级（例如 `no_think`），都不会改。只含标准等级名、又没有 `compat` 的思考等级会按厂商记录刷新，因为那是之前自动补上的形状。不写路由级的思考预算。请求走 `HTTPS_PROXY`，没有时再读系统代理。

## 安装

```bash
node build-model-caps.mjs
dsh plugin --profile web add ./package
```

需要 Node 24 或更高版本。然后重启 `dsh web`。挂载时会补一次；之后在设置里保存供应商，也会再补一次。没有单独的设置页。

## 卸载

`dsh plugin --profile web remove dsh-model-caps`。自定义线值和 `compat` 不会被改。只含标准等级名的思考等级可能会被刷新；卸掉插件不会把这次刷新撤回去。
