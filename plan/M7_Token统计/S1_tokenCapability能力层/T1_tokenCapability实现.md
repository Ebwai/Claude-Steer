# T1 — tokenCapability 能力层实现

## 技术原理与选择理由

### 为什么建立 tokenCapability.ts

现有架构所有状态写入都集中在对应 capability 文件中（sessionRegistry / branchRegistry / agentActivity / gitCapability），
token 统计目前没有统一管理点，导致状态分散、写入路径不完整。
新建 `capabilities/tokenCapability.ts`，与架构现有模式完全一致。

### 数据来源分工

| 场景 | 数据来源 | 说明 |
|------|---------|------|
| 运行中框实时显示 | `statusLine.context_window.current_usage` | context window 已用量，~300ms 推送 |
| 历史框 / 项目总计 / 月度统计 | JSONL `message.usage.input_tokens + output_tokens` | 每轮真实 API 消耗，含 cache |
| 实时框消耗累计 | JSONL 追加时 `message.usage`（实时路径） | jsonlHandler 推送过来的记录 |
| 模型信息 | JSONL `message.model` | assistant 行带 model 字段 |

关键区分：statusLine 的 current_usage 是"上下文窗口容量占用"（可回落），
JSONL usage 是"本轮 API 实际消耗"（单调累加）——两者语义不同，分别用于不同显示场景。

### 主进程扫描方案

新增 IPC 通道 `TOKEN_SCAN_FILE`：输入 transcriptPath（一个 JSONL 文件路径），
主进程直接读取并汇总 `message.usage`，返回：
```typescript
{ inputTokens: number, outputTokens: number, model: string | null }
```
优点：汇总在主进程完成，不需要把整个 JSONL 内容发到渲染进程（避免 IPC 传输大量 JSON）。

### atoms 结构

新增两个 atom：
- `sessionTokensAtom = atomFamily(sessionId)` → 存每个 session 的 token 统计
  - `{ inputTokens: number, outputTokens: number, model: string | null }`
- `tokenStatsAtom` 升级为派生 atom（从 activeSessionsAtom + sessionTokensAtom 聚合）
  - 本月统计：过滤 startedAt 在本月范围内的 session 汇总
  - 按项目：groupBy projectId 汇总

---

## 原子目标

### 原子目标 1：新增 atom 定义

**文件**：`renderer/src/atoms/stats.atom.ts`

- [ ] 1.1 新增 `SessionTokens` 接口：`{ inputTokens: number, outputTokens: number, model: string | null }`
- [ ] 1.2 新增 `sessionTokensAtom = atomFamily<SessionTokens>((sessionId) => atom({ inputTokens: 0, outputTokens: 0, model: null }))`
- [ ] 1.3 将 `tokenStatsAtom` 改为**派生 atom**，从 `activeSessionsAtom` + `sessionTokensAtom` 聚合：
  - `monthlyTokens`：过滤本月 session 累加 `inputTokens + outputTokens`
  - `totalCostUsd`：按 `driverConfig` 价格分别计算 input/output（需读取 `driverConfigAtom`）
  - `mostUsedModel`：统计 model 出现次数取最多
  - `costByProject`：按 projectId 分组累加费用
- [ ] 1.4 新增 `driverConfigAtom = atom<DriverConfig>(defaultDriverConfig)`（在 renderer 侧持有 config 镜像，供派生 atom 计算用）
- [ ] 1.5 删除 `todayTokensAtom` 和 `todayCostUsdAtom`（今日费用由 `tokenStatsAtom` 派生，不再单独维护）

---

### 原子目标 2：新增主进程 IPC 通道

**文件**：`shared/events/ipc-channels.ts` + `main/index.ts`

- [ ] 2.1 在 `ipc-channels.ts` 新增常量：`TOKEN_SCAN_FILE = 'token:scan-file'`
- [ ] 2.2 在 `main/index.ts` 新增 handler：
  ```
  ipcMain.handle(IPC.TOKEN_SCAN_FILE, async (_, { transcriptPath }) => {
    // 逐行读 JSONL，累加 message.usage（只读 assistant 行）
    // 返回 { ok: true, inputTokens, outputTokens, model }
    // 文件不存在返回 { ok: false }
  })
  ```
- [ ] 2.3 在 `preload/index.ts` 暴露新通道（`invoke` 白名单）
- [ ] 2.4 在 `preload/index.d.ts` 补充类型声明

---

### 原子目标 3：新建 tokenCapability.ts

**文件**：`renderer/src/capabilities/tokenCapability.ts`

对外暴露以下函数（所有写操作的唯一入口）：

```typescript
// 从 JSONL 文件路径扫描并写入 sessionTokensAtom
updateSessionTokensFromFile(store, claudeId, transcriptPath): Promise<void>

// 从实时 JsonlRecord 增量更新 sessionTokensAtom（jsonlHandler 调用）
addTokensFromRecord(store, claudeId, record: JsonlRecord): void

// 从 driverConfig 更新 driverConfigAtom（GlobalSettingsModal 保存后调用）
setDriverConfig(store, config: DriverConfig): void

// 查询单个 session 的 token 统计
getSessionTokens(store, sessionId): SessionTokens
```

约束：`tokenStatsAtom` 是派生 atom，不需要写入函数，订阅后自动重算。

---

### 原子目标 4：修改 statusLineHandler

**文件**：`renderer/src/business/statusLineHandler.ts`

- [ ] 4.1 删除对 `todayTokensAtom` 的写入（该 atom 将被删除）
- [ ] 4.2 保留对 `latestStatusLineAtom` 的写入（框的 context window 实时显示仍用 statusLine）
- [ ] 4.3 statusLine 中的 `current_usage` 通过 `patchSession(tokenUsage)` 更新到 session 上（现在已有，继续保留）

---

### 原子目标 5：修改 jsonlHandler

**文件**：`renderer/src/business/jsonlHandler.ts`

- [ ] 5.1 在 `handleRecord` 中：若 `record.type === 'assistant'`，调用 `addTokensFromRecord(store, claudeId, record)`
- [ ] 5.2 在 `handleBatchRecords` 中：同样对每条 assistant 记录调用 `addTokensFromRecord`

---

### 原子目标 6：修改 JsonlParser 解析 usage 字段

**文件**：`main/lib/jsonl/JsonlParser.ts` + `shared/types/jsonl.ts`

- [ ] 6.1 在 `JsonlRecord` 接口新增可选字段：
  ```typescript
  usage?: { inputTokens: number; outputTokens: number }
  model?: string
  ```
- [ ] 6.2 在 `parseJsonlLine` 中，解析 assistant 行时提取：
  ```
  message.usage.input_tokens + message.usage.cache_creation_input_tokens
    + message.usage.cache_read_input_tokens → inputTokens
  message.usage.output_tokens → outputTokens
  message.model → model
  ```
  注：cache token 计入 inputTokens 是因为它们确实被消耗了（cache 命中/创建均按价格计算）

---

### 验收标准（检查节点）

1. 打开一个有历史的项目，历史面板中每个 session 框**底部**显示非零 token 数值
2. 运行一个真实 Claude Code 任务，框底部的 token 数值**随每轮响应递增**
3. 全局监控右侧面板"本月 Token"显示非零值（为当月所有 session 的累计）
4. 全局监控右侧"累计费用"根据设置中配置的 input/output 价格正确计算（修改价格后重算）
5. 项目监控面板**不显示**月度统计（只在全局监控面板显示）
6. 每个项目的 token 总消耗 = 该项目所有框（session）的 token 之和

---

## 待优化项

- cache token 的精确计费（cache 命中比 input 便宜，可按各模型实际价格细化）
- subagent JSONL 的 token 是否归入主 session（当前方案：归入主 session，因为 subagent 是主 session 的子任务）
- 月度统计跨月边界（当前用 `new Date()` 取本月范围，时区问题暂不处理）
