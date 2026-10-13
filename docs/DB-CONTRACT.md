# 数据库契约（DDL）

> 状态：**SQLite 已实现（2026-09-19，`lib/storage-sqlite.js`）**；`postgres` 驱动
> 仍只有配置契约，本文对它继续作为草案有效。字段与行为从现有实现反推，
> 不发明新语义。方法语义的权威是 `lib/storage-adapter.js` 的 JSDoc typedef。

## 0. 边界（先读这个）

- 真相源问题：DESIGN 决策 4 规定"真相源永远是纯文本，SQLite 只做可重建的索引"。
  本后端是**超出该决策的新形态**（数据库本身成为真相源），已在
  **DESIGN 决策 7（2026-09-19）**补记：数据仍是本机单文件、显式开关默认关、
  存量可迁移可回退，"可审计/可搬走"承诺以 `insight_ops` 表延续。
- 默认关：`database.enabled` 默认 `false`，与"第一次体验必须是它只在我自己电脑上"
  一致。数据库后端是**给想集中存储的用户多一个选项**，不是替代本地文件。
- 契约方法清单：`lib/storage-adapter.js` 的两个 `*_BACKEND_METHODS` 与 JSDoc
  typedef 是行为语义的唯一权威，本文的 SQL 只是把它们翻译一遍。

## 1. 通用约定

| 项 | 约定 | 来源 |
|---|---|---|
| 表名前缀 | `database.tablePrefix`（默认 `dsh_evolution_`），避免撞用户已有表 | `config.js` |
| 驱动 | `sqlite`（`node:sqlite` 内置，零依赖，默认）/ `postgres`（用户自备连接串） | `config.js` |
| SQLite 文件路径 | `database.sqlitePath`，空 = `<dataDir>/index.sqlite` | `config.js` |
| Postgres 连接串 | 从 `database.urlEnv` 指名的环境变量读（默认 `DSH_EVOLUTION_DATABASE_URL`），**不落配置文件** | `config.js` |
| 时间戳 | epoch 毫秒，`BIGINT`（SQLite）/ `BIGINT`（PG）。与 NDJSON 里的 `ts` 同口径，不做秒/毫秒换算 | `ledger.js` |
| 日期键 | `YYYY-MM-DD` 本地时区（`storage.dayKey`），存 `TEXT`。按天分片/清理都靠它 | `storage.js` |
| JSON 列 | SQLite 用 `TEXT`（应用层 JSON.stringify）；PG 用 `JSONB` | — |
| 布尔 | SQLite `INTEGER 0/1`；PG `BOOLEAN` | — |
| DDL 执行时机 | 首次连接时 `CREATE TABLE IF NOT EXISTS` + 版本号表做轻量迁移；**不做**跨版本自动降级 | — |

## 2. 表结构

### 2.1 `{prefix}ledger_events` — 会话账本（已实现）

对应现状：按天分片的 `ledger/YYYY-MM-DD.ndjson`，一行一事件。可空列表示
"该键在原记录上不存在"（与 NDJSON 往返同构：`JSON.stringify` 会丢 undefined 键，
这里用 NULL 表达同一件事）。

```sql
CREATE TABLE IF NOT EXISTS dsh_evolution_ledger_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT, -- SQLite; PG 用 IDENTITY
  sid             TEXT    NOT NULL,                  -- 会话 id
  seq             INTEGER,                           -- 宿主事件序号，可空（老事件没有）
  ts              BIGINT  NOT NULL,                  -- epoch 毫秒
  day             TEXT    NOT NULL,                  -- YYYY-MM-DD，本地时区（记录归属哪天，跨零点正确）
  kind            TEXT    NOT NULL,                  -- turn-start/turn-end/user-message/assistant-message/tool-call/tool-result（LEDGER_KINDS）
  turn            INTEGER,                           -- 轮次，可空
  text            TEXT,                              -- 消息文本（user/assistant），工具事件为空
  tool            TEXT,                              -- 工具名（tool-call/tool-result）
  status          TEXT,                              -- turn-end 的结束状态
  error_code      TEXT,
  error_status    INTEGER,
  failed          INTEGER,                           -- 工具结果失败判定（保守：不确定=0）；非工具事件为 NULL
  tokens_in       BIGINT,                            -- 只有带 usage 的消息才有值（与文件形态一致，不凭空补 0）
  tokens_out      BIGINT,
  tokens_cache_read BIGINT,
  extra           TEXT                               -- JSON：前向兼容。新字段不迁移直接进这里
);
CREATE INDEX IF NOT EXISTS idx_ledger_day   ON dsh_evolution_ledger_events (day);
CREATE INDEX IF NOT EXISTS idx_ledger_sid   ON dsh_evolution_ledger_events (sid, ts);
CREATE INDEX IF NOT EXISTS idx_ledger_kind  ON dsh_evolution_ledger_events (kind);
```

"复盘消费到哪了"沿用 `state.json` 水位文件（零改动）；不引入 `processed` 列 ——
那是另一套写放大方案，除非水位文件被证明不够用，否则不做。

### 2.2 `{prefix}insights` — 洞察当前状态（**设计选项，SQLite 实现未采用**）

实现选择了更小的方案（见 §2.3 与 DESIGN 决策 7）：**只建 ops 表，当前状态靠
每次 load 重放**（量级是"人一生写下的经验"，重放毫秒级）。下面这张物化表
保留为"将来量级大到重放成为瓶颈时"的升级路径 —— 届时它仍然只是 ops 表的
缓存，`rebuildIndex()` = 清空后从 ops 重放。

字段与 `makeInsight()`（insights-store.js）逐一对应，不增不减：

```sql
CREATE TABLE IF NOT EXISTS dsh_evolution_insights (
  id                TEXT PRIMARY KEY,               -- makeId() 生成的短 id
  dedupe_key        TEXT NOT NULL,                  -- type:scope:hash(归一化标题)（dedupeKey）
  type              TEXT NOT NULL,                  -- constraint/pitfall/practice/decision/fact
  scope             TEXT NOT NULL,                  -- session/repo/team/person
  repo              TEXT NOT NULL DEFAULT '',       -- 仓库名（作用域=repo 时必须有归属）
  repo_root         TEXT NOT NULL DEFAULT '',       -- 仓库根绝对路径（归属比对优先走它，撞名不串）
  title             TEXT NOT NULL,                  -- ≤160 字符
  detail            TEXT NOT NULL DEFAULT '',       -- ≤1200 字符
  priority          INTEGER NOT NULL DEFAULT 0,     -- -10..10
  recurrence        INTEGER NOT NULL DEFAULT 1,     -- 复现次数：本项目唯一的"进化"信号
  confidence        REAL    NOT NULL DEFAULT 0.5,   -- 0..1
  derived           INTEGER NOT NULL DEFAULT 0,     -- true=模型归纳；false=人工/确定性推导
  pinned            INTEGER NOT NULL DEFAULT 0,
  accepted          INTEGER NOT NULL DEFAULT 0,
  archived          INTEGER NOT NULL DEFAULT 0,     -- 只归档不删除（curator 纪律）
  injected_count    INTEGER NOT NULL DEFAULT 0,
  last_injected_at  BIGINT,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  first_seen_at     BIGINT NOT NULL,
  last_seen_at      BIGINT NOT NULL,
  origin_session_id TEXT NOT NULL DEFAULT '',       -- 模型自报的第一现场
  promoted_from     TEXT,                            -- JSON：{at, from:{scope,repo,repoRoot}} 晋升来源
  flags             TEXT NOT NULL DEFAULT '[]',      -- JSON：校验器痕迹（environment-failure 等）
  evidence          TEXT NOT NULL DEFAULT '[]'       -- JSON 数组：[{kind,sessionId,turn?,quote,at}]，≤12 条
);
CREATE INDEX IF NOT EXISTS idx_ins_key    ON dsh_evolution_insights (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_ins_scope  ON dsh_evolution_insights (scope, repo_root);
CREATE INDEX IF NOT EXISTS idx_ins_seen   ON dsh_evolution_insights (last_seen_at);
```

去重合并的语义**必须在数据库层保住**（这是 upsert 契约的核心）：

- 同 `dedupe_key` 且同 `repo_root`（或都无路径，退化按名字）→ 合并：
  `recurrence + 1`、`evidence` 归并去重（同会话同轮同 kind 只留一条、留更长引文）、
  title/detail 取更长者、type/priority/confidence 取更重者。
- 同键但归属**不同仓库**（撞名）→ **不合并**，当作新条目。
- 人工状态 `pinned/accepted/archived` 永不被自动合并覆盖。
- 相似度兜底（`findSimilar` 的标题相似度匹配）放在应用层，SQL 只负责精确键。

### 2.3 `{prefix}insight_ops` — 洞察操作日志（真相源，已实现）

对应现状：`insights/insights.ndjson`（追加式操作日志）。**这张表是审计与重建的
根基，不许清理、不许改写**。SQLite 形态下它也是唯一的洞察表：`load()` 每次都
按 `seq` 重放（与文件形态"绝不短路"的纪律一致），`saveIndex()` 退化为空操作。

```sql
CREATE TABLE IF NOT EXISTS dsh_evolution_insight_ops (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,   -- 全局序号 = 重放顺序
  at      BIGINT NOT NULL,                     -- epoch 毫秒
  op      TEXT   NOT NULL,                     -- add/merge/delete/patch/merge-into/migrate/injected/clear（与 appendOp 的 op 字段同枚举）
  id      TEXT,                                -- 目标洞察 id（injected/clear 可空）
  payload TEXT NOT NULL                        -- JSON：op 的原始参数（add 是完整 insight，merge 是证据增量…）
);
```

- 内存重放用与文件版同一个 `applyOp()`；未知 op **跳过不报错**（向前兼容），
  解析失败的行计入 `badLines` 供面板展示。
- `clearAll` 的留档 = 把 ops 表整表导出成与文件日志**同形状**的 NDJSON，
  所以留档文件可以被 §4 的一次性导入再导回任何一个后端。

## 3. 方法 → SQL 映射

**SQLite 实现采取子类化策略**（`storage-sqlite.js` 继承两个 store、只覆盖持久层），
所以去重合并、晋升、串行化等语义自动与文件实现一致。下表是实现现状
（postgres 实现者按同一张表对齐）：

| 契约方法 | SQL 形态 | 必须保住的行为 |
|---|---|---|
| `ledger.add` | 应用层缓冲（继承，不变），flush 时事务批量 `INSERT` | 同步返回、永不抛；失败保缓冲 + `lastError` |
| `ledger.query` | `WHERE (day IN …) AND (sid = ?) ORDER BY ts DESC LIMIT ?` 后反转为正序 | 截断保留**最近**的 limit 条；`total` 是截断前总数 |
| `ledger.stats` | 聚合：`COUNT`、`COUNT(DISTINCT sid/day)`、`MIN/MAX(day)` | 字段形状与文件版完全一致（含 `pendingBuffered`） |
| `ledger.prune` | `DELETE WHERE day < cutoff`（按天整片） | 0=永不删（不扫描）；截止日**本地时区**（`storage.retentionCutoff`，"保留最近 N 天"=今天往前 N 个自然日） |
| `insights.load/replay` | 按 `seq` 重放 `insight_ops`（与文件版同一个 `applyOp`） | **每次调用重放**，不许"加载过就跳过"（多实例一致性） |
| `insights.upsert` | 继承（内存合并计算）+ `appendOp` 单条 `INSERT`；批量 flush 无需事务（每条 op 本身原子） | 复现+1、证据归并、撞名仓库不合并、人工状态不覆盖 |
| `insights.mutate/merge/migrate/noteInjected/removeBySessions/clearAll` | 同上：逻辑继承，落盘走 ops 表 | clearAll 必须先留档（导出 ops 到用户指定文件）再清 |
| 写串行化 | Promise 队列（`enqueue`，继承）+ 批量 INSERT 用 `BEGIN IMMEDIATE/COMMIT` 包裹 | 复盘（异步批量）与用户手动操作交错不得互相覆盖 |

## 4. 存量数据迁移（已实现）

数据库后端首次启用时做**一次性导入**（不删原文件，原目录保持完整可回退）：

1. `ledger/*.ndjson` → `ledger_events`。**按天为单位导入**：已有的天直接跳过 ——
   所以中断后重跑会从缺的天继续（断点续导），不存在"表非空就永久跳过"的
   部分导入。每天一个独立小事务，**读文件的 await 一律在事务外**
   （事务跨 await 时，同连接的 flushSession 会撞 "cannot start a transaction
   within a transaction"，其 catch 的 ROLLBACK 会拆掉迁移的事务 —— 评审抓过）。
2. `insights/insights.ndjson` → `insight_ops`（真相源整份搬走；**不从
   `index.json` 反推**——那是派生物，可能陈旧。SQLite 实现只建 ops 表，
   "当前状态"由每次 load 重放，见 §2.2）。
3. `config.json` / `state.json` 不动（配置与水位继续是文件）。
4. 导入结果（条数、坏行）进宿主日志与 `createStorage().migration` Promise，
   失败可重跑（幂等：账本按天判重、ops 按表空判重）。

## 5. 验收清单（SQLite 已全部验证，postgres 实现时复跑）

- [x] `database.enabled=false`（默认）时行为与之前**逐字节一致**，测试全绿。
- [x] 开 `enabled=true` 但后端不可用（老 Node 没有内置 sqlite / 文件创建失败）：
      显式告警并整体回退文件后端，宿主与注入流程完全不受阻（离线容错契约）。
- [x] `storage-adapter.js` 的 `findMissingBackendMethods` 对新实现返回空数组
      （冒烟测试守着）。
- [x] 冒烟测试以文件实现与数据库实现**各跑一遍**同一场景（等价性用例：
      账本记录逐条 deepEqual、洞察条目剔除随机 id/时间戳后 deepEqual）。
- [x] `clearAll` 后 ops 留档文件可被再次导入，数据不丢（冒烟验证）。
- [ ] postgres 驱动落地时：同一张映射表 + 同一组等价性用例跑一遍。
