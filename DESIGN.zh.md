# dsh-model-caps 设计

[English](DESIGN.md) · **简体中文**

本文是本插件的**唯一设计真源**。实现与 README 行为描述须与此一致。

## 目标

为 DSH **自定义供应商**自动补全空白的上下文窗口、输出上限、思考菜单与线协议相关 `compat`，使对话可选档位并**正确发包**。手写字段保留。不增删模型。

约束：

1. **默认轨是 OpenAI 兼容**（`openai-completions` / `openai-responses`）：只选 OpenAI 也应达到预期配置。
2. **Anthropic Messages 是用户可选增强轨**：部分厂商双协议时由用户自选；系统不强迫改协议。
3. **一个自定义供应商只有一种 `api`、一个 `baseURL`**（产品约束）。多协议需求用多个供应商条目表达。
4. **少名单、广匹配**：优先规则与内置目录，单模型特例尽量为零。

## 分层（解耦）

| 层 | 职责 | 非职责 |
|---|---|---|
| 路由 `api` | 用户选定的发包协议 | 猜测厂商 |
| 内置目录（pi-ai） | 已验证的协议 + `compat` + 等级图 | 自定义网关 URL |
| 思考语义 → 协议投影 | 把内置行投到**当前**路由协议 | 按型号写死长表 |
| models.dev | 能力卡（窗口、控件形状） | `thinkingFormat` 真源 |
| 厂商方言兜底 | 仅无内置命中时 | 主路径 |
| 手写 settings | 最高优先级 | — |

## 流水线

```text
规范化 model id
  → 在 pi-ai 内置索引中查找（可多命中）
  → 选择：同 api 优先，否则 maker 供应商行；投影到当前路由 api
  → 若 OpenAI 路由缺少 Completions `thinkingFormat`：仅从 **maker** 的 OpenAI
    命中叠加线协议；Anthropic 命中最多补菜单，**绝不**伪造 `thinkingFormat: deepseek`
    （Completions 发不出 adaptive）
  → 按 §5 合并字段：listing → 内置投影 → models.dev
  → 手写字段永不覆盖
```

### 1. id 规范化（规则，非名单）

- 小写比较
- 去掉 `scheme:` 前缀；取 `/` 后最后一段（如 `ZHIPU/GLM-5.3-Flash` → `glm-5.3-flash`）
- 剥末尾日历日期（`-2026-07-15`、`@20250514` 等）
- 剥 `vN.M` 小数点补丁且后面还有段名（`deepseek-v4.1-flash` → `deepseek-v4-flash`）；裸 `mimo-v2.5` 不剥
- **不**把 `FlashX` 折叠为 `Flash`

### 2. 内置命中选择

同一 id 可出现在多家内置路由，且 `compat` 可能冲突（如官方 `deepseek` vs 寄售 `qwen`）。

选择顺序：

1. `内置.api === 路由.api`。若该投影没有 Completions `thinkingFormat`，则仅从 **maker** 的同族 OpenAI 命中叠加线协议。Anthropic 命中可补思考**菜单**，但不伪造 Completions 方言。
2. 否则：`provider` 属于 maker 集合（短名单：openai、anthropic、deepseek、moonshotai、minimax、zai、alibaba…）
3. 仍冲突：不套思考线，仅可套双方安全的容量字段

### 3. 协议投影

**中间事实**来自命中行：`reasoning`、`thinkingLevelMap`、`compat`、容量。

| 路由 api | 内置行 api | 行为 |
|---|---|---|
| OpenAI 系 | OpenAI 系 | 拷贝思考相关 `compat` 子集 + 由 map 得到 `reasoningEfforts`；仅开关形且无 map 时写 `off`+一档开；**始终**写 `supportsDeveloperRole: false`（自定义网关拒 `developer`） |
| OpenAI 系 | `anthropic-messages` 且 reasoning | **弱投影**：仅菜单（+容量）。**不**伪造 `thinkingFormat: deepseek`——该方言发 `thinking.type=enabled`，而 adaptive 原生网关只要 `adaptive`/`disabled`（仅 Anthropic 传输能发） |
| Anthropic | Anthropic | 拷贝；无 map 时用 Anthropic 默认档；若内置带 `forceAdaptiveThinking` 则带上 |
| Anthropic | OpenAI 系 | 弱投影：仅菜单档，不发明 Anthropic 专用开关 |
| 协议无把握 | — | 不写思考 `compat` |

不拷贝内置 `baseUrl` / `provider`。自定义 `baseURL` 始终保留。

### 4. models.dev 兜底

内置未命中或仅有容量时：

- 用厂商行补窗口、等级、（兜底）方言
- 阿里 `qwen` 仅挂本族；DeepSeek / Z.AI 挂自家目录行
- 纯 toggle 且无方言证据：不编造等级

### 5. 合并优先级（每字段）

```text
手写
  → 供应商 listing
    → 内置投影
      → models.dev 厂商行
```

`compat`：listing 不提供；内置投影优先于 models.dev 兜底。自动写入的 `compat` 可在刷新时更新；含手写键或非自动方言的块不碰。

## 明确不做什么

- 不因 models.dev 的 `toggle` 形状单独猜方言（K2 vs K3 等会撞车）
- 不在 `openai-completions` 路由上静默改成 Anthropic
- 不为「菜单好看」在无证据时编造等级
- 不维护按模型 id 的长特例表

## 模块边界

| 模块 | 内容 |
|---|---|
| `dsh-model-caps-core.js` | 纯策略：索引、匹配、投影、合并、planMutations |
| `dsh-model-caps-sync.js` | IO：listing、models.dev、可选加载内置目录、mutate |
| `dsh-model-caps.host.js` | Cordis 挂载与触发 |
| 内置目录 | 运行时可选依赖 `@earendil-works/pi-ai`；缺失则仅 models.dev 兜底 |

## 检验标准

- 自定义路由仅 OpenAI 时：命中内置的 DeepSeek / Kimi / GLM 保留正确 Completions 线协议；仅有 Anthropic 行的模型（如 MiniMax-M3）只补菜单，不伪造 `thinkingFormat`
- 用户自选 Anthropic + MiniMax 官方 Anthropic URL：套用内置 Anthropic 行（含 `forceAdaptiveThinking`），无需额外 M3 名单
- 手写 `compat` / 非标准线值保留
- `node verify.mjs` 全绿（含 `test-design.mjs` 设计交叉矩阵）
