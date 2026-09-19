# dsh-model-caps

[English](README.md) · **简体中文**

一个轻量的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。它给**自定义供应商**补上空白的上下文窗口、输出上限和思考等级，这样在对话里选模型时，就和内置供应商一样，不用再去 `settings.yaml` 里手写这三项。已经写过的值会保留。不会增删模型。

7 个套件。运行 `node verify.mjs`。

## 它写什么

自定义供应商是 `llm-pi-ai` 里同时带有 `api`、`baseURL` 和至少一个模型的路由。`openai`、`google` 这种目录路由不动，已安装目录里已经有这些字段。

每个模型的空白字段按这个顺序补：

1. 供应商自己的 `GET {baseURL}/models`。列表里真有上下文长度或思考等级时，用它。
2. 否则用 [models.dev](https://models.dev/api.json)。同一个模型 id 的记录必须一致才写入。思考等级取交集，不靠投票。

只写 `contextWindow`、`maxTokens`、`reasoningEfforts`。`compat`、`input`、显示名，以及你写成 `reasoningEfforts: false` 的模型，都不会动。网关若需要 `compat.thinkingFormat`，仍要自己加那一行：没有列表会公布这个开关。

## 安装

```bash
node build-model-caps.mjs
dsh plugin --profile web add ./package
```

需要 Node 24 或更高版本。然后重启 `dsh web`。设置里的 **模型能力** 会显示最近一次同步，并有 **立即同步**。挂载时会同步一次；之后自定义模型又出现空白字段时，也会自己同步。

## 卸载

`dsh plugin --profile web remove dsh-model-caps`。不会去还原任何字段，因为本来就没有覆盖你写过的值。
