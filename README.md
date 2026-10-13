# dsh-evolution

[![npm version](https://img.shields.io/npm/v/dsh-evolution.svg)](https://www.npmjs.com/package/dsh-evolution)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![node >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
![outbound network: off by default](https://img.shields.io/badge/outbound%20network-off%20by%20default-blue)
![storage: plain text NDJSON](https://img.shields.io/badge/storage-plain%20text%20NDJSON-lightgrey)

> DSH 的**本地优先**自动进化插件：记录你的开发会话，用**你自己已配好的模型**做跨会话复盘，
> 把踩过的坑和有效做法沉淀成本地知识。
>
> **默认不联网、不上传、不写你的代码仓库。** 数据全是磁盘上的人可读文件，随时可以看、可以导出、可以删。

**English (TL;DR)** — `dsh-evolution` is a **local-first** self-evolution plugin for
DSH (the DeepSeek Harness coding agent). It writes your development sessions into a
plain-text NDJSON ledger on your own disk, then reviews those sessions across the board
**with the model you already configured**, so repeated pitfalls and practices surface as
local knowledge and a few relevant items get injected into your next session in the same
repository. Nothing leaves your machine by default: no uploads, no cloud storage, no
writes into your code repository, and every "outbound" capability (model review,
writing a skill draft into your repo, vector search, HTTP backend, database) is opt-in
and budget-capped.

Current status: **Phase 1 — real review + injection** (details in the block below).
Everything from Phase 0 still works, and on top of it a real review runs against a real
model through the host's own `ctx.llm`, writes what it learns into a local insight
library, and injects the relevant few items into your next session in the same
repository. Automatic review is still **off by default**, so leaving the plugin on costs
nothing until you turn it on — the only thing that runs without it is injection of items
already in your library.

> **当前状态：v0.2.0 · Phase 1（真复盘 + 注入）**
> 已经可用：会话账本采集、数据预览、**试跑（看效果、算成本，不调模型）**、脱敏、
> 界面化配置、目录自检；**手动/自动复盘**（用你自己已配好的模型）、**本地洞察库**、
> **检索与注入**、**导出与 skill 草稿**。
> 已经过真机端到端验证：插件 link 进真实 profile、真实 `dsh web` 进程里跑过一次
> **真实模型**复盘，产出的洞察带着证据链进了注入。
> 自动复盘仍默认关闭：**开着插件不会有任何模型费用**，直到你显式打开它。
> 注入只发本地已存的条目，不调模型、不联网。

---

## 为什么做这个

DSH 本身很会干活，但**它不记得你上次踩过什么坑**。每次开新会话，你都得重新解释一遍：
"这个项目的回调守卫要放在幂等判断之前"、"别用 float 存金额"、"发版前必须先跑那个脚本"。

现有的做法通常有两个问题：

1. **要么全在云端** —— 你的全部开发对话上传到别人的服务器。
2. **要么只有事实、没有进化** —— 只是把结论存下来，不会告诉你"这个问题你已经犯过三次了"。

这个插件想做的是第三件事：**在你自己的电脑上，把跨会话的模式找出来**，
在你下次动手前提醒你。而数据不出你的机器。

> 想了解背后的设计取舍，看 [docs/DESIGN.md](docs/DESIGN.md)。

---

## 它到底怎么工作

```
正常对话
  → 每次事件被结构化记进本地账本（纯本地、零成本、不调模型）
  → 攒够 N 轮且会话静默后（或你点「现在复盘」），用你在「配置」页显式指定的那个模型做一次归纳
    （**没指定就一次都不调** —— 插件不会默认用你当前会话用的模型）
  → 归纳结果先过代码层校验（证据链/禁止清单/再脱敏），再写进本地洞察库
  → 下次进这个仓库时，把相关的几条注入到上下文里
```

三个关键设计决定：

| 决定 | 为什么 |
|---|---|
| **账本记录零 LLM、零网络** | 所以可以每轮都记、可以回扫历史，成本近似为零 |
| **只用信号，不记工具的输入输出** | 工具参数与输出体积大、几乎不含可复用决策；记它们等于给自己埋一个越来越大的坑 |
| **默认一切"往外"的行为都关闭** | 上传、写你的仓库、向量化、跨工作区聚合，全部需要你显式打开 |

归纳的产物不是"一句结论"，而是**带证据链的条目**：每条必须能回到某个会话的某一轮
（会话 id + 轮次 + 原文引用），没有证据的会被代码直接拒收。
"复现次数（recurrence）"是一等字段 —— 同一条经验再次出现时是**合并加一**，
而不是在库里再躺一条。这是"进化"和"又一个笔记 App"的分界。

---

## 安装

```bash
dsh plugin --profile web add dsh-evolution
```

装完重启 `dsh web`，侧边栏底部会出现「自动进化」按钮。

> 从源码安装（开发用）：
> ```bash
> git clone https://github.com/wycto/dsh-evolution.git && cd dsh-evolution
> npm run build
> dsh plugin --profile web add "link:<绝对路径>/dsh-evolution"   # 例：link:D:/src/dsh-evolution
> ```
>
> `client/dist/index.js` 是构建产物，但**故意入库** —— 这样想直接从 git 安装的人
> 不需要装 esbuild 就能用（跳过 `npm run build` 即可）。
> 改完 `client/` 记得跑一次 `npm run build` 并提交产物。

### 装完先做这三件事

1. 侧边栏底部点「自动进化」→ **总览** 页，确认「运行中」且数据落点路径符合预期。
2. 去 **数据与隐私** 页点一次「重新自检」，确认目录都能创建。
3. 正常对话几轮，回 **数据预览** 页点刷新 —— 看到记录就说明采集通了。

想试真复盘时，去 **试跑** 页先看一遍（不花钱），再回 **洞察** 页点「现在复盘」。
这一步才会真的调模型、花你自己的额度，所以默认不动手就不会有费用。

---

## 它存了什么，存在哪

**全部在 `~/.dsh-evolution/`**（Windows: `C:\Users\<你>\.dsh-evolution\`）。

```
~/.dsh-evolution/
├── config.json          # 你的配置（纯 JSON，可手改）
├── state.json           # 复盘水位、每日用量、暂停状态等内部状态
├── ledger/
│   └── 2026-09-17.ndjson   # 账本：一行一条事件，按天分片
├── insights/
│   ├── insights.ndjson  # 洞察库：一行一次操作（add/merge/patch/…），只追加
│   └── index.json       # 派生快照：删掉能重建，真相源永远是上面那行日志
├── exports/             # 导出留档（markdown + JSON，一次导出两个文件；可在面板导入回来）
├── skills/              # skill 草稿的默认落点（也可以改成写进仓库，见下）
├── observations/        # 预留空目录：后续放"未过校验的观察"
└── drafts/              # 预留空目录：skill 草稿实际落在 skills/ 或你选的仓库目录
```

**如果开启了 SQLite 后端**（`database.enabled + driver=sqlite`，默认关）：上面账本与
洞察相关的文件不再读写，数据搬进数据目录的 `index.sqlite` 单文件（另有 `-wal` /
`-shm` 两个临时伴生文件，属正常现象）；首次启用会把旧 NDJSON **一次性导入**且
原文件保留，删掉 `index.sqlite` 再重启即回退文件形态。总览页会如实显示当前后端。

想换位置：设环境变量 `DSH_EVOLUTION_HOME`，或在面板「配置」里填数据目录。

### 洞察库为什么是"日志 + 快照"两个文件

`insights.ndjson` 是**真相源**，一行一次操作，只追加：崩溃最多丢最后一行，
不会把整库写坏；删掉 `index.json` 也能从日志完整重建（面板「洞察」页有重建入口）。
所以你可以直接打开日志看"这条结论是哪来的、什么时候晋升的"。

**清空洞察会先留档**：`insights/insights.cleared.<时间戳>.ndjson` 是清空前的整份日志副本 ——
你点"清空"想要的是"看不见了"，而不是"不可恢复了"。

### 一条账本记录长什么样

```jsonc
{"sid":"session-8c32…","seq":412,"ts":1758000000000,"day":"2026-09-17",
 "kind":"user_message","turn":7,"repo":"demo-service",
 "repoRoot":"/home/me/work/demo-service",
 "text":"把订单回调的幂等判断移到守卫之后"}
```

`repoRoot` 是**注入归属判定的依据**：仓库名会撞（两个 `api/`），路径不会。
洞察入库时也会带上仓库根，注入时**优先按路径比对**，只把路径对得上的
条目给这个仓库；升级前的老条目只有仓库名，继续按名字匹配（行为不变）。
宁可少注入，也不要让 B 仓库读到 A 仓库的经验。

### 明确**不会**记录的内容

| 内容 | 记不记 | 说明 |
|---|---|---|
| 你的提问与助手回答 | ✅ 记（截断后可配） | 这是复盘的主要素材 |
| 工具**名字**与成功/失败 | ✅ 记 | 失败信号正是"踩坑"的来源 |
| 工具的**参数**与**输出** | ❌ **不记** | 体积大、噪音多、含大量无关内容 |
| 模型思考过程 | ❌ 不记 | |
| 图片等非文本块 | ❌ 不记 | |
| 绝对路径 | ⚠️ 默认脱敏成 `<path>/文件名` | 见下 |

---

## 隐私

### 脱敏在**写磁盘之前**发生

不是"上传时才脱敏"。你在面板的「脱敏预览」页粘什么文本，就能看到**真正会被记录**的样子。

内置规则（全部可关）：

- `sk-` 前缀的 API key、`Bearer`/`Basic` 凭证
- `key=value` 形式的密钥赋值 —— **保留键名，只掩值**
- JWT、GitHub token、AWS AccessKey、阿里云 AccessKey、私钥块标记
- 绝对路径 → `<path>/文件名`
- 你自己的敏感词表

> **刻意不做的事：不误伤正常代码。**
> `const password = process.env.DB_PASSWORD`、`apiKey = readFromVault()`、
> `this.token = config.db.token` 这类写法**原样保留**。
> 脱敏过头的后果是记忆全变马赛克、功能直接废掉，比漏掉一个密钥更糟。

### 默认值一览（都是最保守的一侧）

| 开关 | 默认 |
|---|---|
| 记录会话账本 | ✅ 开（纯本地） |
| 注入已有洞察到上下文 | ✅ 开（纯本地、零模型调用） |
| **自动复盘（消耗模型额度）** | ❌ 关 |
| **上传到任何服务器** | ❌ 关 |
| **写入你的代码仓库** | ❌ 关（skill 草稿默认落插件目录；改成写仓库时面板还要你勾一次确认） |
| 向量检索（会把正文发往你配的端点） | ❌ 关 |
| 连接数据库（本机 SQLite，显式选择后数据库成为真相源） | ❌ 关 |
| 跨工作区聚合个人画像 | ❌ 关 |

### 三个承诺

1. **不提供、也不托管任何云端服务。** 作者不会接触你的任何数据。
2. **默认不上传、不外发。** 所有外向行为都需要你显式配置。
3. **不做任何面向管理者展示个人画像的功能。** 这是效率工具，不是监控工具。

---

## 面板

侧边栏底部「自动进化」→ 九个页面：

| 页面 | 作用 |
|---|---|
| **总览** | 采集状态、开关一览、历史回扫结果、数据落点；含**模型用量与成本**（次数 / token / 今日预算余量，只统计会花钱的复盘调用） |
| **洞察** | ⭐ 洞察库主体：点「现在复盘」手动跑一次（按钮旁直接写着**这次会用哪个模型**，解析不出来时会指路到配置页）；逐条看**证据链**、来源、被注入过几次；置顶 / 采纳 / 归档 / 切换作用域 / 删除 / 手动合并去重；每页 200 条 + 「加载更多」；另含「个人进化」区块：把够格的条目晋升为跨仓库的个人提醒（可退回）；底部「维护」区可**从日志重建索引**、**清空洞察（先留档）** |
| **试跑** | ⭐ **开启自动复盘前先看这里**：会不会真的跑、会注入哪几段、大概花多少钱。不调模型、不写文件 |
| **数据预览** | 逐条看已写入磁盘的内容；按会话展开折叠摘要（**喂给模型的就是这个**） |
| **注入预览** | ⭐ 显示**逐字的注入文本** —— 下次进这个仓库时会进 system prompt 的东西，原文照抄给你看 |
| **脱敏预览** | 左原文右结果并排对照，逐行差异 |
| **导出与草稿** | 导出 markdown / JSON 留档 + **导入**（选一份导出 JSON 恢复，重复导入零副作用）；把"已复现且你采纳过"的条目生成 `SKILL.md` 草稿（写进仓库前要勾确认） |
| **配置** | 全部配置项，带人话说明，保存即生效（不用重启）。「自动复盘」组顶部有**模型选择器**：把宿主里真实可用的 provider × model 列出来让你**下拉选**（没有手填框），并显示"留空时会用哪个"（详见下节） |
| **数据与隐私** | 这个插件会/不会做什么、脱敏现状、目录自检、你的权利 |

**洞察页是真的能判的**：每条展开后是会话 id + 轮次 + 原文引用，不是"模型说是这样"。
被代码层校验降级或标注过的条目会显示原因（比如"环境类问题不能作为强制约束，已降级为 fact"）。

**注入预览页为什么存在**：信任是靠可见性建立的。与其让你相信"它不会乱塞东西"，
不如把那段文本原样摊开 —— 你能逐字读到它到底写了什么、占了多少预算、哪几条因为预算没进去。

**试跑页为什么必须存在**：归纳质量差的项目，价值是**负的**——错误结论会被注入上下文
并长期生效。所以你可以先看再决定要不要打开开关。它也会如实告诉你
「当前条件下这次会话会不会被抽取」，而不是让你猜。

配置改动会在底部显示"未保存 N 项"，点保存才落盘 —— 避免误触即生效。

---

## 配置项

配置文件是 `~/.dsh-evolution/config.json`，也可以用面板改。**面板是纯数据驱动渲染的**：
配置项的说明、范围、可选值都在 `lib/config.js` 的 `SCHEMA_FIELDS` 里，
加一个配置项不需要动面板代码。

主要分组：`总开关` / `会话账本` / `自动复盘` / `隐私与脱敏` / `本地 skill 落点` /
`接口对接（可选）` / `数据库对接（可选）` / `检索` / `注入` / `导出与草稿`。

### 关于自动复盘（默认关）

`自动复盘` 这一组里，除了总开关还有几个真正影响"会不会花钱、花多少"的项：

| 配置项 | 默认 | 作用 |
|---|---|---|
| `review.enabled` | ❌ 关 | 自动链路的唯一总闸。关着时手动「现在复盘」仍然可用 |
| `review.provider` / `review.model` | 空 | 留空 = 用你当前会话用的模型；也可以指定一个更便宜的。**面板里不用手填模型名**：配置页顶部的选择器会列出宿主里真实可用的模型，选一个就把这两项一起写好（这两个字段在面板上不显示输入框） |
| `review.extractAfterTurns` | 10 | 攒够多少轮才考虑跑一次 |
| `review.idleDebounceMs` | 60000 | 会话静默多久才触发（避免和你抢模型） |
| `review.dailyTokenBudget` | 200000 | 每日 token 预算（默认 20 万，约够跑四十多次复盘），0 = 不限。超了当天直接拒绝，并把原因写进返回值 |
| `review.maxInsightsPerRun` | 5 | 一次最多收几条 —— 这是**质量阀门**，不是省钱开关 |
| `review.minNewRecordsPerRun` | 20 | 同一会话两次复盘之间至少新增多少条记录（防连点按钮重复烧钱） |
| `review.timeoutMs` | 120000 | 单次调用超时，到点 abort 并标成 `TIMEOUT` |
| `review.countUsageAgainstBudget` | ✅ 开 | 这次用量是否计入每日预算（关掉只影响统计） |
| `review.pauseUntil` | 空 | 「暂停 24 小时」写的就是它 |

#### 复盘用哪个模型：必须从列表里选一个，不选就不复盘

**花谁的钱必须是你自己说的。** 复盘曾经"跟随你当前会话用的模型"，现在删掉了：

- 会话模型往往正是你正在用的、**最贵的那一个**。后台功能悄悄顺着它跑，等于为一个你没同意的模型付费；
- 它随你在 DSH 里随手切模型而变，于是"复盘花多少"变成一个你既看不见也控制不了的量；
- 面板上写着"跟随当前会话"，而这条信息在你没打开面板时随时会变 —— 事后没人能复现"当时为什么花这个钱"。

所以语义只剩两种：**配了就用配的，没配就一次都不调**（自动链路直接跳过，手动按钮给出"去配置"的提示）。
只填一半（provider 有而 model 没有，或反过来）同样按"没配"处理 —— 宁可不复盘，也不拿半截配置去猜模型名。

配置页「自动复盘」组顶部的选择器会把宿主里**真实注册**的 provider × model 列出
（对应 `/dsh-evolution/models` 这个只读能力），选一个就同时写好 `review.provider` 与 `review.model`；
面板还会直接告诉你**这次会用哪个、来源是"配置里指定的"还是"未配置，不会复盘"**。

这一项**只有一个下拉，没有任何手填框** —— 能填的入口就会有人填错，而"哪些模型真的可用"
只有宿主知道。所以配置页也不再显示 `review.provider` / `review.model` 两个输入框
（它们仍在配置文件里，由选择器写入）。

几个刻意的细节：

- **列表拿不到就说清楚**：某个提供方的模型列表取不到（超时/401）时，只有它变空，
  其余提供方照常列出，并在下面写明原因 —— 整页空掉会被误读成"一个模型都没有"；
- **单个提供方列模型最多等 4 秒**，目录缓存 60 秒（「刷新」按钮强制取新的），
  所以打开配置页不会卡在一次远端查询上；
- **已有的旧值不会被静默改掉**：如果你之前手改过 `config.json`、填了一个宿主目录里没有的
  model id，下拉里会把它作为「当前配置里的值」显示出来并原样保留（选一个列表里的模型即可覆盖）；
- 试跑页的成本估算用的是**同一个解析结果**，不会出现"按 A 报价、按 B 计费"。

### 关于检索与注入

- `retrieval.candidatePool`（默认 30）先按打分取一个候选池，再按各段预算渲染；
- `retrieval.minRecurrenceToInject`（默认 1）是"至少见过几次才允许注入"；
- `retrieval.perScopeLimit`（默认 12）防止某一类条目把别的段挤掉；
- `inject.*` 是四段各自的条数与字数上限（约束 3 条 / 项目洞察 3 条 / 团队 2 条 / 个人 1 条）。

打分是**确定性**的（同库同配置必然同顺序），否则"试跑看到的"和"真正注入的"会漂移。
排序权重、90 天半衰期、pin 加分这些都写在 `lib/retrieve.js` 里，面板上每条能看到自己的分数构成。

### 关于导出与草稿

- 导出是纯本地行为：`exports/` 下生成一对 `insights-<时间>.md` / `.json`，
  markdown 默认带证据链（`export.includeEvidence`），单次上限 `export.maxEntries`（500 条）。
- **导入**（「导出与草稿」页）：选一份导出的 JSON 恢复。语义是**按 id 恢复**：
  字段（复现次数、证据链、时间戳、人工状态）原样保留，库里已有的 id 自动跳过 ——
  重复导入同一份文件**零副作用**，不会把复现次数越导越高（这是它与"复盘写入"
  的本质区别）。适合换机器、误清空后把数据搬回来。
- skill 草稿的门槛刻意高：默认要求 **复现 ≥2 次**（`export.skillMinRecurrence`）
  且 **你已采纳**（`export.skillRequireAccepted`），最多一次 3 个（`export.skillMaxDrafts`）。
  skill 是"可执行流程"，比一条提醒重得多；把模型的一次性猜测写成流程，比什么都不写更糟。
- 生成的 `SKILL.md` 会先按宿主解析规则**自检一遍**再允许写盘 ——
  格式错了宿主只会静默跳过，表现为"技能没生效"，一个静默失效的生成器比没有这个功能更糟。

### 关于晋升（个人提醒 / 团队规范）

注入的第三、四段（团队规范 / 个人提醒）**只能由你手动晋升**填进去：

- `promotion.personMinRecurrence`（默认 2）：在几次会话里复现过才列为候选。
  跨仓库提醒会出现在**每个**仓库的上下文里，所以门槛比"进本仓库"高。
- `promotion.pinOnPromote`（默认关）：晋升只表示"适用范围更广"，不等于"更重要"。
- **插件不会自动做跨工作区聚合。** 那会把同一台机器上不同雇主/项目的经验混在一起
  （DESIGN 决策 5），所以「洞察」页只列出够格的候选与不够格的原因，点一下才发生。
- 晋升是**移动**不是复制，来源记在条目里，随时可退回原作用域。
- 晋升为**团队规范**会进入跨项目的第三段，影响面更大，所以面板会再要一次确认。

### 关于 skill 落点

面板里可选三种：

| 选项 | 实际路径 | 说明 |
|---|---|---|
| **插件数据目录**（默认） | `~/.dsh-evolution/skills/` | 不碰你的仓库、不需要改任何 DSH 配置 |
| **仓库内 `.agents/skills`** | `<仓库>/.agents/skills/` | DSH **原生发现**，随 git 走，团队天然共享 |
| **仓库内 `.dsh/skills`** | `<仓库>/.dsh/skills/` | DSH 最高优先级的项目根 |
| 自定义路径 | 你填 | ⚠️ **需要你在 DSH 配置里额外加 `customSkillDirs`**，否则写了不生效 |

> ⚠️ DSH 的 skill 发现根按 rank 顺序扫描（`dsh-skill-filesystem` 文档实测）：
>
> | rank | 来源 | 路径 |
> |---|---|---|
> | 100 | `project-dsh` | `<仓库>/.dsh/skills` |
> | 200 | `project-agents` | `<仓库>/.agents/skills` |
> | 300 | `custom` | `Config.customSkillDirs` |
> | 400 | `user-dsh` | `<$DSH_HOME>/skills` |
> | 500 | `user-agents` | `<~/.agents>/skills` |
> | 600 | `bundled` | `$DSH_BUNDLED_SKILL_DIR` |
>
> 项目根 = 包含 `.git` 的最近祖先目录（没有则用当前 cwd）。
> **用列表外的目录名（比如 `.agent` 单数）不会被自动发现** ——
> 这时要么选 `customSkillDirs` 并在 DSH 配置里加一行，要么就落插件数据目录。
> 这是选"自定义路径"时面板会提醒的原因。

### 关于接口与数据库（默认关）

**本插件不实现、也不托管任何服务端。**

- **接口（远程存储已实现）**：`api.enabled + storageBackend + baseUrl` 三者就位后，
  账本与洞察整体读写到该服务（⚠️ 这等于把数据交给那台服务，是显式的隐私决定）。
  token 从 `api.tokenEnv` 指名的环境变量读；401/403 后客户端停止发送。
  服务端可以用仓库附带的参考实现跑起来：`node scripts/reference-server.mjs <数据目录> [端口] [--token <值>]`；
  协议细节见 `docs/API-CONTRACT.md`。改完配置需重启。
- **数据库（SQLite 已实现）**：`database.enabled + driver=sqlite` 打开后，数据
  搬进 Node 内置 `node:sqlite` 的单文件数据库（默认 `<数据目录>/index.sqlite`，
  零依赖、无需编译）。首次启用会把存量 NDJSON **一次性导入**（原文件保留不动，
  删掉数据库文件再重启即可完整回退）；之后数据库就是真相源，本地文件不再读写。
  `postgres` 驱动只有契约（`docs/DB-CONTRACT.md`），打开会得到显式警告并回退文件。
  面板「总览」页的"数据落点"会如实显示当前用的是哪个后端、数据在哪个文件。
  改数据目录 / 数据库路径后需要**重启宿主**才生效（后端在启动时装配一次）。

用途是**把知识存进你更放心的地方 / 共享给团队**，不是把数据交给作者。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | **为什么这么定**：五个核心决策、从 Hermes 学什么/不学什么、Phase 1 设计、已知限制 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **怎么实现的**：五条设计纪律、每个模块的关键契约、踩过的坑 |

> 另有两份**只在开发仓库**的过程文档，不进公开仓库、不进 npm 包：
> `docs/RELEASE.md`（发版与仓库约定：双库工作流、发版流程、命名约定、提交备注规范、环境接入）
> 与 `docs/HANDOFF.md`（会话交接：当前状态、下一步、调研结论索引、代码地图）。
> 它们含内部路径与内网地址，所以这里不给链接。

---

## 开发

```bash
npm run check    # host 半语法检查（20 个文件）
npm run build    # 构建浏览器半（产物 client/dist/index.js）
npm test         # 冒烟测试 169 项 + 集成自检 36 项
npm run pack     # 打包到 release/
```

两个测试脚本分工不同：

| 脚本 | 证明什么 |
|---|---|
| `scripts/smoke.mjs` | **逻辑对**：配置规范化、脱敏规则、事件折叠、账本读写、注入渲染、试跑、洞察库重放与合并、入库校验规则、检索排序、JSON 抽取、复盘编排、导出与 SKILL.md 自检 |
| `scripts/integration.mjs` | **能装上去**：用假 ctx 真实调用 `apply()`，验证模块图可解析、事件订阅与 systemPrompt 段注册发生在正确时机、路由能跑通真实复盘、试跑确实不写文件 |
| `scripts/gui-check.mjs` | **面板真的能渲染**：用 jsdom 按宿主模块契约执行构建产物，把九个页签逐一点开渲染，断言不抛、且该发的 RPC 都发了（需 jsdom，仓库外装一次） |

其中有三项测试专门守**试跑的"不回写"不变式**：对比试跑前后整个数据目录的文件指纹、
确认没创建 `config.json` / `state.json`、以及扫源码确认 `lib/dry-run.js`
没有 import 任何写函数或网络调用。

还有一组**包契约测试**专治"两边不一致"这类静默失效：`package.json` 的 `exports`/`files`
指向的文件必须真实存在、版本号只认 `package.json` 一个来源（host 半运行时读取、面板半构建时注入，
产物里不允许残留占位符或与 package.json 不一致）、
`cordis.patch.yml` 能解析，以及**面板引用的每个 RPC 方法在 host 半都有对应的 `case`** ——
漏一个方法的症状是"点了按钮没反应"，而类型检查和语法检查都发现不了。

改 host 半（`lib/`）需要重启 `dsh web`；改浏览器半（`client/`）跑一次 `npm run build`
后刷新页面即可。

### 目录结构

```
lib/                  host 半（Node，跑在 DSH 进程里）
├── index.js            插件入口：事件订阅、复盘编排、注入段、历史回扫、生命周期
├── routes.js           Host↔Client HTTP 路由
├── config.js           配置模型 + 默认值 + 面板字段表（单一事实来源）
├── config-store.js     配置读写、mtime 变更检测、坏配置备份
├── paths.js            数据目录解析
├── storage.js          原子写 / NDJSON 追加读 / 按天分片 / 保留期截止日
├── storage-adapter.js  存储后端契约与唯一装配点（createStorage）
├── storage-sqlite.js   SQLite 后端（database.enabled+sqlite，node:sqlite 零依赖）
├── ledger.js           事件 → 账本记录折叠 + 会话摘要聚合
├── ledger-store.js     账本读写与缓冲落盘
├── repo.js             git 仓库定位（宁可认不出，不要认错）
├── redact.js           脱敏
├── insights-store.js   洞察库：NDJSON 操作日志（真相源）+ 派生 index.json
├── insight-rules.js    入库前代码层校验：拒收负面断言 / 降级环境类失败 / 强制证据链 / 再脱敏
├── llm.js              ctx.llm 一次性调用封装：稳定失败码、超时、三层 JSON 抽取
├── prompt.js           复盘 prompt（正/负例清单 + 硬性禁止清单）
├── review.js           复盘编排：gate、预算刹车、水位、自动晋升
├── retrieve.js         打分排序 + 纯 JS BM25 全文检索（CJK 二元组）+ 分段配额
├── inject-cache.js     注入编排与缓存：同步读缓存、异步刷新、cwd→仓库根解析
├── inject.js           四段注入渲染 + 预算计算（纯函数，零 IO）
├── export.js           导出 markdown/JSON、导入恢复 + SKILL.md 草稿生成与格式自检
└── dry-run.js          试跑编排（只读：不 import 任何写函数）

client/               浏览器半（React，跑在 Web 里）
├── index.js            面板九页 + 侧边栏入口
├── build.mjs           esbuild 构建脚本
└── dist/index.js       构建产物（随包发布）

scripts/smoke.mjs       冒烟测试（逻辑，169 项）
scripts/integration.mjs 集成自检（能否挂载，36 项）
```

### 五条给后来者的经验

1. **`session/event` 回调里绝不做重活。** 宿主每次 append 都会触发它，
   在这里 `await` 一个 git 子进程或磁盘 IO，会直接拖慢 agent 循环，连"停止"按钮都会失灵。
   所以：回调里只做内存折叠，落盘走缓冲+定时器，git 探测走异步+缓存。

2. **写测试，尤其测脱敏。** 这个仓库的脱敏规则在被冒烟测试覆盖之前，
   连续出过三个静默 bug：正则捕获组编号错位导致规则**永不生效**、
   替换时把键名一起掩掉、负向前瞻被回退绕过导致只掩了半个标识符。
   三个都不报错，只是悄悄做错事。

3. **测试代码本身也会骗你。** 集成自检里最初有 3 个 async 检查写成了同步 `check(fn)`，
   断言失败会变成 unhandled rejection 而**不计入失败数**——看起来全绿，实际什么都没验。
   现在同步/异步分成 `check` / `atest` 两个函数。同一类问题还出过一次：
   测试数据用宿主事件名（`user/message`）当账本 kind（应为 `user_message`），
   摘要静默变空；现在 `foldSessionSummary` 会返回 `suspiciousInput` 把这种情况标出来。

4. **假 ctx 全绿不等于真机能跑。** Phase 1 接完之后，插件被 link 进真实 profile、
   在真实 `dsh web` 进程里跑了一次真实模型复盘，**当场抓到 4 个假 ctx 测不出来的 bug**：
   cordis 里读未声明的 `ctx.llm` 会抛异常（必须走 `ctx.inject(['llm'], cb)`）、
   按会话查账本时没把过滤下推、洞察库用文件指纹做变更检测不可靠、
   复盘报告里 `accepted[].id` 恒为空串。
   四个都能让集成自检保持全绿。**假 ctx 只能证明"接口签名对"，真进程才能证明"契约对"。**

5. **并发 bug 只能靠并发测试抓。** 收尾阶段又抓到三个"平时完全看不到"的问题：
   原子写的临时文件名只用 pid 会撞车、`state.json` 的读-改-写没排队会互相覆盖、
   面板引用的 RPC 方法与 host 的 `case` 会漂移。
   前两个是**让两个写操作真的同时发生**才暴露的 ——
   这类 bug 的验证方式是"制造并发"，不是"再读一遍代码"。

---

## 路线图

- [x] **Phase 0** 账本采集、数据预览、脱敏、界面化配置
- [x] **Phase 1** 单会话复盘（接 `ctx.llm`，用你自己的模型）+ 项目级洞察 + 检索注入 ← *当前*
- [ ] **Phase 2** 个人进化（跨工作区，单独开关）+ 一键导出/删除
  （导出已可用：`导出与草稿` 页能导出全部条目的 markdown / JSON；
  个人进化的**手动通道**已可用：`洞察` 页的「个人进化」区块能把够格的条目
  晋升为跨仓库提醒，也可退回。自动跨工作区聚合**不会做**，理由见 DESIGN 决策 5）
- [ ] **Phase 3** 团队共享（git 仓库模式：把洞察写成 skill 草稿，你决定要不要提交）
  （草稿生成已可用：`SKILL.md` 能生成并自检，团队级晋升规则与评审流程还没做）
- [ ] **Phase 4** 可选能力：向量检索、自带 HTTP 后端

### 已知限制

- **DSH 没在跑的时候不会发生任何复盘。** 没有服务端定时任务，复盘由插件进程内的定时器驱动。
- 复盘会消耗**你自己的**模型额度，所以默认关闭，且提供每日预算刹车。
- 归属判定用 `git rev-parse`：如果你的工作目录本身是个 git 仓库（比如 dotfiles 管理的家目录），
  该会话会被归到那个仓库名下。这是 `rev-parse` 的语义，不是 bug，但值得知道。
- **注入缓存只认真实见过的仓库。** 缓存靠"已知仓库根"表把 cwd 映射到仓库，
  而这张表不 spawn `git`（只在异步路径上探测）。一个从没被插件见过的仓库，
  第一次问答不会注入任何东西 —— 见过一次之后就一直有效。**宁可少注入，不要注错仓库。**
- **升级前的老洞察只有仓库名、没有路径。** 它们继续按名字匹配注入 ——
  如果你有两个同名仓库，老条目仍会同时给两个仓库注入；
  新复盘产出的条目带仓库根（按路径比对），不受影响。
- **账本会随使用增长。** 默认永久保留（这是你的数据，删了就没了）；
  想控制体积可以在配置里设 `ledger.retentionDays`，
  超过 N 天的整天分片会在插件启动时删除 —— 这是本插件唯一会删数据的开关，所以默认是 0。
- **去重合并是尽力而为。** 标题归一化 + 三道闸门的自动合并门槛刻意定得高
  （漏合并只是库里多一条，合错了会虚构复现次数，而复现次数是自动晋升的唯一依据）。
  合不上的可以在「洞察」页手动合并。
- **成本估算是下界，不是预测值。** 面板上的预估按"输入 + 输入 15%"算；
  如果你的默认模型开了高推理强度，思考 token 也按输出计费，实际可能明显更高。
  预算刹车按**真实用量**记，不按估算记。
  真实用量可以在「总览」页看到（最近 30 天的次数 / token / 今日预算余量，
  以及每次调用的状态）；费用仍以你的模型提供方账单为准 —— 单价会变，插件不假装知道。
- **配置项分两类**：一类真的生效（改了立刻有反应）；另一类标着「预留 · 尚未实现」——
  目前只剩接口对接一组（数据库对接的 SQLite 驱动已实现）。预留项显示出来是因为
  那是**契约**（将来接团队服务时配置长什么样），但打开它们不会有任何行为。
  有一条冒烟测试守着"面板上不出现没有代码读、又没标预留的开关"。

---

## 许可

MIT
