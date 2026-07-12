# T1 — UI 显示接入

## 技术原理

所有 UI 只读 atom，不直接调用 tokenCapability 写入函数。
数据流：tokenCapability 写入 → atom 自动派生 → UI 订阅重渲染。

---

## 原子目标

### 原子目标 1：session 框底部 token 显示

**位置**：框底部，"打开终端"那一行的中间位置（即 `sfn-footer` 区域）

**文件**：`renderer/src/features/project-monitor/canvas/SessionFrameNode.tsx`

- [ ] 1.1 在 `sfn-footer` 中间插入 token 显示元素：
  - 读取 `sessionTokensAtom(sessionId)`
  - 显示格式：`↑ {fmtTokens(inputTokens + outputTokens)}`（input+output 总消耗）
  - 若为 0 则不显示（与现有框头部 token 逻辑一致）
- [ ] 1.2 框头部右侧的 `sfn-tokens`（当前显示 `session.tokenUsage.current`）改为：
  - 运行中（status=Running）：继续显示 `context_window.current_usage`（实时上下文占用，来自 statusLine）
  - 已完成（status=Completed/Interrupted）：显示 `sessionTokensAtom` 的 total（实际消耗）
  - 理由：运行中看"上下文剩余"更有意义，结束后看"总消耗"更有意义
- [ ] 1.3 样式：底部 token 字体比框头部小一级，颜色用 `--tx-3`（次要文本色），左右居中对齐

---

### 原子目标 2：每个项目的 token 总消耗显示

**位置**：项目监控面板（ProjectMonitorPage），具体位置待确认——可以是 ProjectSettingsBar 或 ProjectTabBar 中适当位置显示该项目所有 session 的 token 总和

**文件**：`renderer/src/features/project-monitor/ProjectSettingsBar.tsx`（或 ProjectTabBar.tsx，取决于布局空间）

- [ ] 2.1 新建派生查询：`projectTotalTokensAtom = atomFamily(projectId)` → 从 `activeSessionsAtom` 过滤该项目的所有 session，再从 `sessionTokensAtom` 求和
  - 位置：`atoms/stats.atom.ts` 中
- [ ] 2.2 在 `ProjectSettingsBar` 右端适当位置显示：`项目累计 {fmtTokens(total)} tok`
  - 若为 0 则不显示

---

### 原子目标 3：全局监控面板数据接通

**文件**：`renderer/src/features/global-monitor/RightPanel.tsx`

- [ ] 3.1 `tokenStatsAtom` 现在是派生 atom，UI 无需修改，数据自动流入
- [ ] 3.2 确认"今日费用"显示：`todayCostUsdAtom` 被删除后，改为读 `tokenStatsAtom` 中今日范围的子集
  - 在 `stats.atom.ts` 新增 `todayCostUsdAtom`（派生，过滤 startedAt 在今日范围）
- [ ] 3.3 `driverConfigAtom` 在应用启动时从 IPC 加载（`GlobalSettingsModal` 已有读取逻辑，需要在加载后同步调用 `setDriverConfig`）

---

### 原子目标 4：driverConfig 价格联动

**文件**：`renderer/src/features/settings/GlobalSettingsModal.tsx`

- [ ] 4.1 全局设置 Modal 保存 driverConfig 后，调用 `setDriverConfig(store, newConfig)`
- [ ] 4.2 应用启动时（`App.tsx` 或 `useIpcBridge`）读取 driverConfig 并调用 `setDriverConfig` 初始化

---

### 原子目标 5：历史加载时触发 token 扫描

**文件**：`renderer/src/hooks/useHistoryLoader.ts`

- [ ] 5.1 在写入 `activeSessionsAtom` 后（第 57-79 行之后），遍历 metas：
  - 若 `meta.transcriptPath` 存在，调用 `updateSessionTokensFromFile(store, meta.claudeId, meta.transcriptPath)`
- [ ] 5.2 多个 session 并发扫描：`Promise.allSettled`（不阻塞历史加载主流程）
- [ ] 5.3 日志输出：`[TokenCapability] Scanned ${claudeId.slice(0,8)}: input=${inputTokens} output=${outputTokens} model=${model}`

---

### 验收标准（检查节点）

1. session 框底部正确显示该 session 的 token 总消耗（非零）
2. 运行中框的框头部显示实时 context_window 用量，完成后切换为总消耗
3. 全局监控面板"本月 Token"、"累计费用"、"常用模型"均显示真实数值
4. 修改设置中的 token 单价，全局费用自动重算（无需重启）
5. 项目监控面板设置栏显示该项目累计 token

---

## 待优化项

- 项目总消耗的位置选择（ProjectSettingsBar 还是框标题旁）需要在实际开发中根据布局空间决定
- 历史扫描可以增加缓存：扫描结果持久化到 `~/.claude-driver/token-cache.json`，避免每次切换项目重扫（当前方案不做，等有性能问题再加）
