# 服务接口契约（OpenAPI）

> 状态：**客户端 + 参考服务端已实现（2026-09-20，DESIGN 决策 8）**——插件侧客户端是
> `lib/storage-remote.js`（`api.enabled + api.storageBackend + baseUrl`，默认关）；
> 可运行的参考服务端在 `scripts/reference-server.mjs`（本地文件后端实现全部端点，
> 也是服务端实现者的对照物）。2026-09-19 校对：schema 与 `storage-adapter.js` 契约、
> `stats()` 实际返回字段对齐；同期的 SQLite 本地数据库后端见 `docs/DB-CONTRACT.md`
> 与 DESIGN 决策 7。`config.api.*`（`lib/config.js`）是
> 已定义的配置契约：`enabled` 默认关、`uploadMode` 默认 `off`、token 走环境变量
> （默认 `DSH_EVOLUTION_TOKEN`）、`timeoutMs` 默认 15 秒。代码里尚无任何外发请求；
> 本文是落地时给双方（插件侧客户端、服务侧实现者）的第一份输入，接口集合
> 直接从 `lib/storage-adapter.js` 的两个后端契约推导，不发明新能力。

## 0. 边界（先读这个）

- 本契约是**存储后端**形态：洞察与账本的增删改查整体搬到服务端。它比
  `uploadMode: redacted`（只上传脱敏摘要）走得更远，隐私含义完全不同 ——
  落地时必须在 DESIGN.md 补决策，并作为**独立开关**提供，默认关。
- 插件不提供也不托管服务（DESIGN 决策 3：作者不做数据控制者）。服务端由
  使用者自建或自选，本文只约束双方之间的协议。
- 方法语义的权威是 `storage-adapter.js` 的 JSDoc typedef；本文只是把每个方法
  翻译成一个端点。实现方漏掉任何一条行为语义（如"写失败保缓冲"）都算不合规。

## 1. 通用约定

| 项 | 约定 | 来源 |
|---|---|---|
| Base URL | `config.api.baseUrl` | `config.js` |
| 版本 | 路径前缀 `/v1`，破坏性变更换 `/v2` | — |
| 鉴权 | `Authorization: Bearer <token>`；token 从 `config.api.tokenEnv` 指名的环境变量读，**不落配置文件**。401/403 时客户端必须停止发送并面板告警，不重试 | `config.js` |
| 响应信封 | 成功 `{ "ok": true, "data": … }`；失败 `{ "ok": false, "error": { "code", "message" } }` | `routes.js` 现有约定 |
| 错误码 | 复用 `ERROR_CODES`：`bad-request` / `not-found` / `not-ready` / `busy` / `internal`；鉴权失败用 HTTP 401/403 + `bad-request` | `routes.js` |
| 超时 | 客户端按 `config.api.timeoutMs` 断开（默认 15s）；服务端应远快于此 | `config.js` |
| 时间戳 | epoch 毫秒（`BIGINT` 语义），与本地 NDJSON 同口径 | `ledger.js` |
| 日期键 | `YYYY-MM-DD` 客户端本地时区，服务端只当字符串 | `storage.js` |
| 内容类型 | `application/json; charset=utf-8`；响应带 `cache-control: no-store` | `routes.js` |

### 1.1 批量与幂等（对接方必须实现）

- **账本批量**：`POST /v1/ledger/events` 一次收一批（客户端 flush 缓冲，通常
  20 条/批）。服务端按 `(sid, ts, seq, kind)` 做去重；同批内重复、跨批重投
  都不得产生重复行。
- **洞察 upsert 不是幂等的**：每次"同一坑再现"都会 `recurrence + 1`，这是设计
  信号。因此重试不能靠服务端按内容去重 —— 请求体必须带 `requestId`（客户端
  生成，UUID），服务端对同一 `requestId` 的重投返回首次结果、不再累加。
  ⚠️ 这是网络传输相对本地文件新增的语义，落地时写进客户端实现。
- **离线容错**：服务不可达/超时/5xx 时，客户端把批次放回本地队列择机重试
  （对应现有 LedgerStore 的"失败保缓冲"纪律），**绝不阻塞宿主会话**；
  面板显示积压量与 `lastError`。

### 1.2 脱敏（`uploadMode: redacted` 的含义）

`redacted` 模式下，出站正文（`text` / `quote` / `detail`）必须先过本地
`lib/redact.js` 管线（密钥掩码、绝对路径去前缀、自定义敏感词），服务端收到的
就是脱敏后文本。`off` 模式下整个客户端不发出任何请求。

## 2. 端点一览（与契约方法的对应）

| 端点 | 对应契约方法 |
|---|---|
| `POST /v1/ledger/events` | `ledger.add` + `flushSession`（批量） |
| `GET /v1/ledger/query` | `ledger.query` |
| `GET /v1/ledger/days` | `ledger.listDays` |
| `GET /v1/ledger/stats` | `ledger.stats` |
| `POST /v1/ledger/prune` | `ledger.prune` |
| `GET /v1/insights` | `insights.list` |
| `GET /v1/insights/{id}` | `insights.get` |
| `POST /v1/insights/upsert` | `insights.upsert`（批量） |
| `POST /v1/insights/import` | `insights.importEntries`（按 id 恢复，幂等） |
| `PATCH /v1/insights/{id}` | `insights.mutate` |
| `POST /v1/insights/merge` | `insights.merge` |
| `POST /v1/insights/{id}/migrate` | `insights.migrate` |
| `GET /v1/insights/promotion-candidates` | `insights.promotionCandidates` |
| `POST /v1/insights/note-injected` | `insights.noteInjected` |
| `POST /v1/insights/remove-by-sessions` | `insights.removeBySessions` |
| `POST /v1/insights/clear-all` | `insights.clearAll`（必须留档） |
| `GET /v1/insights/stats` | `insights.stats` |
| `POST /v1/insights/rebuild-index` | `insights.rebuildIndex` |

`replay` / `dir` 不设端点：前者是 `rebuild-index` 的服务端内部实现细节，
后者（数据在哪）在远程形态下没有用户可打印的路径，客户端显示 baseUrl 代替。

## 3. OpenAPI 3.1

```yaml
openapi: 3.1.0
info:
  title: dsh-evolution storage backend
  version: 0.1.0-draft
  description: >
    dsh-evolution 的远程存储后端契约（草案）。方法语义见 lib/storage-adapter.js
    的 JSDoc typedef；本文只定义传输层。所有响应使用统一信封。
servers:
  - url: "{baseUrl}/v1"
    variables:
      baseUrl:
        default: https://evolution.example.invalid
security:
  - bearerAuth: []

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
  schemas:
    Envelope:
      type: object
      required: [ok]
      properties:
        ok: { type: boolean }
        data: { type: object }
        error:
          type: object
          required: [code, message]
          properties:
            code:
              type: string
              enum: [bad-request, not-found, not-ready, busy, internal]
            message: { type: string }

    LedgerEvent:
      type: object
      required: [sid, ts, day, kind]
      properties:
        sid: { type: string, description: 会话 id }
        seq: { type: integer, description: 宿主事件序号，可缺省 }
        ts: { type: integer, description: epoch 毫秒 }
        day: { type: string, pattern: '^\d{4}-\d{2}-\d{2}$', description: 归属日期（客户端本地时区） }
        kind:
          type: string
          enum: [turn-start, turn-end, user-message, assistant-message, tool-call, tool-result]
        turn: { type: integer }
        text: { type: string }
        tool: { type: string }
        status: { type: string }
        errorCode: { type: string }
        errorStatus: { type: integer }
        failed: { type: boolean }
        tokensIn: { type: integer }
        tokensOut: { type: integer }
        tokensCacheRead: { type: integer }

    LedgerQueryResult:
      type: object
      properties:
        records: { type: array, items: { $ref: '#/components/schemas/LedgerEvent' } }
        total: { type: integer, description: 截断前的总命中数 }
        badLines: { type: integer, description: 无法解析的行数（如实上报，不静默丢） }
        days: { type: array, items: { type: string } }

    LedgerStats:
      type: object
      properties:
        days: { type: integer }
        firstDay: { type: string }
        lastDay: { type: string }
        records: { type: integer }
        sessions: { type: integer }
        badLines: { type: integer }
        pendingBuffered: { type: integer, description: 仍在客户端缓冲、尚未发出的条数（远程形态下服务端恒为 0） }
        written: { type: integer }
        lastError: { type: string }

    Evidence:
      type: object
      required: [kind, sessionId, quote, at]
      properties:
        kind: { type: string, default: session }
        sessionId: { type: string }
        turn: { type: integer }
        quote: { type: string, maxLength: 240 }
        at: { type: integer }

    InsightInput:
      type: object
      required: [title]
      properties:
        type: { type: string, enum: [constraint, pitfall, practice, decision, fact], default: fact }
        scope: { type: string, enum: [session, repo, team, person], default: repo }
        repo: { type: string }
        repoRoot: { type: string, description: 仓库根绝对路径，撞名仓库的归属依据 }
        title: { type: string, maxLength: 160 }
        detail: { type: string, maxLength: 1200 }
        priority: { type: integer, minimum: -10, maximum: 10 }
        confidence: { type: number, minimum: 0, maximum: 1 }
        derived: { type: boolean }
        evidence: { type: array, maxItems: 12, items: { $ref: '#/components/schemas/Evidence' } }
        originSessionId: { type: string }

    Insight:
      allOf:
        - $ref: '#/components/schemas/InsightInput'
        - type: object
          properties:
            id: { type: string }
            key: { type: string, description: 去重键 type:scope:hash(归一化标题) }
            recurrence: { type: integer, minimum: 1 }
            pinned: { type: boolean }
            accepted: { type: boolean }
            archived: { type: boolean }
            injectedCount: { type: integer }
            lastInjectedAt: { type: integer, nullable: true }
            createdAt: { type: integer }
            updatedAt: { type: integer }
            firstSeenAt: { type: integer }
            lastSeenAt: { type: integer }
            promotedFrom:
              nullable: true
              type: object
              properties:
                at: { type: integer }
                from: { type: object }
            flags: { type: array, items: { type: string } }

    UpsertResult:
      type: object
      properties:
        added: { type: array, items: { $ref: '#/components/schemas/Insight' } }
        merged: { type: array, items: { $ref: '#/components/schemas/Insight' } }
        rejected: { type: array, items: { type: string } }

    PromotionCandidates:
      type: object
      properties:
        minRecurrence: { type: integer }
        eligible: { type: array, items: { $ref: '#/components/schemas/Insight' } }
        skipped:
          type: array
          items:
            type: object
            properties:
              id: { type: string }
              title: { type: string }
              reason: { type: string }

    InsightsStats:
      type: object
      properties:
        total: { type: integer }
        active: { type: integer }
        archived: { type: integer }
        pinned: { type: integer }
        accepted: { type: integer }
        withEvidence: { type: integer, description: 带证据链的条数 }
        recurred: { type: integer, description: 复现次数 >1 的条数（"进化"信号） }
        byType: { type: object, additionalProperties: { type: integer } }
        byScope: { type: object, additionalProperties: { type: integer } }
        badLines: { type: integer, description: 真相源中无法解析的行数 }
        appended: { type: integer }
        logFile: { type: string, description: 服务端真相源位置，仅诊断用；客户端不展示 }
        lastError: { type: string }

paths:
  /ledger/events:
    post:
      summary: 批量追加账本事件（ledger.add + flushSession）
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [events]
              properties:
                events: { type: array, items: { $ref: '#/components/schemas/LedgerEvent' } }
      responses:
        '200':
          description: 已接收（accepted 为去重后实际写入数）
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data:
                    type: object
                    properties:
                      accepted: { type: integer }
        '401': { $ref: '#/components/schemas/Envelope' }

  /ledger/query:
    get:
      summary: 查询账本（ledger.query）
      parameters:
        - { name: days, in: query, schema: { type: integer, default: 7 }, description: 最近 N 天；0=不限 }
        - { name: sessionId, in: query, schema: { type: string } }
        - { name: limit, in: query, schema: { type: integer, default: 20000 }, description: 截断时保留最近的 N 条 }
      responses:
        '200':
          description: 查询结果
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data: { $ref: '#/components/schemas/LedgerQueryResult' }

  /ledger/days:
    get:
      summary: 已有账本日期，倒序（ledger.listDays）
      responses:
        '200':
          description: 日期列表
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data: { type: array, items: { type: string } }

  /ledger/stats:
    get:
      summary: 账本汇总（ledger.stats）
      responses:
        '200':
          description: 统计
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data: { $ref: '#/components/schemas/LedgerStats' }

  /ledger/prune:
    post:
      summary: 清理过期账本（ledger.prune）。删除用户数据的操作，按天整片删
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                retentionDays: { type: integer, description: 0=永久保留（不删） }
      responses:
        '200':
          description: 清理结果
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data:
                    type: object
                    properties:
                      removed: { type: integer }
                      scanned: { type: integer }

  /insights:
    get:
      summary: 洞察列表（insights.list）。必须返回深拷贝语义（服务端不共享内部对象）
      parameters:
        - { name: includeArchived, in: query, schema: { type: boolean, default: false } }
      responses:
        '200':
          description: 条目数组
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data: { type: array, items: { $ref: '#/components/schemas/Insight' } }

  /insights/{id}:
    get:
      summary: 单条洞察（insights.get）
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '200':
          description: 条目
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data: { $ref: '#/components/schemas/Insight' }
        '404':
          description: 不存在（error.code=not-found）

    patch:
      summary: 人工操作：置顶/采纳/归档/改类型/改作用域/删除（insights.mutate）
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                patch:
                  type: object
                  properties:
                    pinned: { type: boolean }
                    accepted: { type: boolean }
                    archived: { type: boolean }
                    priority: { type: integer }
                    title: { type: string }
                    detail: { type: string }
                    type: { type: string, enum: [constraint, pitfall, practice, decision, fact] }
                    scope: { type: string, enum: [session, repo, team, person] }
                    repo: { type: string }
                    repoRoot: { type: string }
                    deleted: { type: boolean, description: true=删除 }
                reason: { type: string }
      responses:
        '200':
          description: 更新后的条目
        '404':
          description: 不存在

  /insights/upsert:
    post:
      summary: 批量写入观察，去重合并（insights.upsert）。⚠️ 非幂等：必须带 requestId 防重试累加
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [insights]
              properties:
                requestId:
                  type: string
                  format: uuid
                  description: 客户端生成；服务端对同一 id 的重投返回首次结果
                reason: { type: string }
                insights: { type: array, items: { $ref: '#/components/schemas/InsightInput' } }
      responses:
        '200':
          description: 写入结果
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data: { $ref: '#/components/schemas/UpsertResult' }

  /insights/import:
    post:
      summary: 恢复一份导出（insights.importEntries）。按 id 插入-或-跳过，重复导入零副作用
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [entries]
              properties:
                requestId: { type: string, format: uuid }
                reason: { type: string }
                entries:
                  type: array
                  description: 导出 JSON 里 insights 数组的原样条目（必须有 id 与 title）
                  items: { type: object }
      responses:
        '200':
          description: 恢复结果
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data:
                    type: object
                    properties:
                      added: { type: array, items: { $ref: '#/components/schemas/Insight' } }
                      skipped: { type: integer }
                      unattributed: { type: integer, description: repo 作用域但归属双空的条目数（永不注入，给面板提示口径） }

  /insights/merge:
    post:
      summary: 手动合并两条（insights.merge）
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [fromId, toId]
              properties:
                fromId: { type: string }
                toId: { type: string }
                reason: { type: string }
      responses:
        '200': { description: 合并后的条目 }
        '404': { description: 目标不存在 }

  /insights/{id}/migrate:
    post:
      summary: 迁移作用域（晋升/退回，insights.migrate）。晋升必须留下来源记录
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [scope]
              properties:
                scope: { type: string, enum: [session, repo, team, person] }
      responses:
        '200': { description: 迁移后的条目 }
        '404': { description: 不存在 }

  /insights/promotion-candidates:
    get:
      summary: 晋升候选与不够格原因（insights.promotionCandidates）。只列不做
      parameters:
        - { name: minRecurrence, in: query, schema: { type: integer, default: 2 } }
        - { name: excludePerson, in: query, schema: { type: boolean, default: true } }
      responses:
        '200':
          description: 候选
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data: { $ref: '#/components/schemas/PromotionCandidates' }

  /insights/note-injected:
    post:
      summary: 记录注入计数（insights.noteInjected）。只是统计，失败不阻塞
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [ids]
              properties:
                ids: { type: array, items: { type: string } }
      responses:
        '200': { description: 已记录 }

  /insights/remove-by-sessions:
    post:
      summary: 删除来源会话对应的洞察（insights.removeBySessions）
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [sessionIds]
              properties:
                sessionIds: { type: array, items: { type: string } }
      responses:
        '200':
          description: 受影响的洞察 id
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data: { type: array, items: { type: string } }

  /insights/clear-all:
    post:
      summary: 清空洞察（insights.clearAll）。⚠️ 服务端必须先留档再清，不是静默删除
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                archiveTo: { type: string, description: 留档路径（服务端本地） }
      responses:
        '200':
          description: 清空结果
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data:
                    type: object
                    properties:
                      removed: { type: integer }
                      archivedTo: { type: string }

  /insights/stats:
    get:
      summary: 洞察汇总（insights.stats）
      responses:
        '200':
          description: 统计
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean, const: true }
                  data: { $ref: '#/components/schemas/InsightsStats' }

  /insights/rebuild-index:
    post:
      summary: 从真相源重建派生索引（insights.rebuildIndex）
      responses:
        '200': { description: 重建完成 }
```

## 4. 验收清单

- [x] `api.enabled=false`（默认）时插件发出的网络请求为 **0**（默认装配文件后端，冒烟断言）。
- [x] 客户端已实现：等价性（本地直连 vs 经契约，账本逐条 deepEqual、洞察剔除
      随机字段后 deepEqual）、离线容错（失败保缓冲、错误进 lastError）、
      401 后永久停止发送（冒烟守着）。
- [ ] 服务不可达：本地缓冲保留、面板显示积压与错误，宿主会话零阻塞。
- [ ] 同一 `requestId` 的 upsert 重投不改变 recurrence。
- [ ] `redacted` 模式下抓包看到的正文与本地 `redact()` 输出一致。
- [ ] 清空接口确实返回了留档位置，且留档可重新导入。
