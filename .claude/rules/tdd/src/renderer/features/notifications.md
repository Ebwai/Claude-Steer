---
paths:
  - "claude-driver/src/renderer/src/features/notifications/**/*"
---


<!-- parent: features -->

### 模块架构图

```mermaid
graph TD
    NW["NotificationWindowPage"] --> Store["自建 Jotai vanilla store"]
    Store --> PH["createPermissionHandler"]
    Store --> BH["createPtyBindHandler"]
    Store --> SL["createSessionLifecycle"]
    Store --> PL["projects 加载"]
    NW --> SST["shared/types SessionStatus"]
    NW --> PSS["ProjectSplitSection"]
    PSS --> RP["runningProjectsAtom"]
    PSS --> NI["NotificationItem"]
    NI -->|展开| TDR["toolDetailRender (共享 utility)"]
    NI -->|IPC.PERMISSION_RESPOND| PTY
    NI -->|IPC.PERMISSION_DISMISS| Badge["角标更新"]
    PH -.IPC.HOOK_EVENT.-> Hook["主进程 HookEventBus 广播"]
    BH -.IPC.PTY_BIND/UNBIND.-> Hook
    SL -.IPC.SESSION_STATUS.-> Hook
```

### 模块概览

- **职责**：独立系统级通知窗口（`#/notifications`，独立 BrowserWindow pop-out）。按"正在运行的项目"纵向分割展示权限请求 + insight 报告通知，每条 2 行紧凑布局 + 可展开详情（复用历史面板触发线可视化）。
- **输入**：IPC.HOOK_EVENT（PermissionRequest）/ PTY_BIND / PTY_UNBIND / SESSION_STATUS / PROJECT_LIST / INSIGHT_REPORT_READY（均由主进程广播）；SESSION_STATUS 的 `status` 字段使用 shared `SessionStatus` 联合类型。
- **输出**：UI 渲染 + IPC.PERMISSION_RESPOND / PERMISSION_DISMISS。

### API 概览

- **`NotificationWindowPage`**：窗口页根。自建 JotaiProvider + vanilla store，注册 handler 工厂子集（createPermissionHandler + createPtyBindHandler + createSessionLifecycle + projects 加载）。订阅 IPC.HOOK_EVENT / PTY_BIND / PTY_UNBIND / SESSION_STATUS / PROJECT_LIST / INSIGHT_REPORT_READY。
- **`ProjectSplitSection`**：项目分割区。读 `runningProjectsAtom`，纵向排列每个运行中项目的分割区（项目名头 + 独立滚动通知列表）。项目停止运行时分割区及通知移除。
- **`NotificationItem`**：单条通知项（2 行）。Line 1：Agent 框名称（`req.agentName`）+ 调用名称 + 展开按钮 + 关闭按钮。Line 2：4 交互 Yes/No（同意/同意+消息/拒绝/拒绝+消息，逻辑同原 RequestApprovalPanel）。展开显示 `toolDetailRender` 详情。
- **`toolDetailRender.tsx`**（共享 utility）：`renderToolDetail(toolName, badgeContent, t)` + `buildToolCompact(toolName, badgeContent, t)` + `hasToolDetail(toolName, badgeContent)`。从 LineInsertionItem 抽取，供 LineInsertionItem 和 NotificationItem 共用。

### 数据模型

- **`RunningProject`**：`{ projectId: string; name: string; sessionCount: number }`。由 `runningProjectsAtom` 派生（复用 LeftPanel projectSessions 逻辑：ptySessionIds.has + Running/Paused + pathMatches）。
- **`InsightNotification`**：`{ id: string; title: string; message: string; reportPath: string; createdAt: number }`。本地 state（`insightNotifs`），由 INSIGHT_REPORT_READY 事件触发，按 `filePath` 去重。
- 复用 `PermissionRequest`（requestId/sessionId/agentName/toolName/toolInput/description/receivedAt）、`Session`（claudeId/projectId/status/cwd）、`Project`（id/name/path）、`SessionStatus`（`Running | Paused | Interrupted | Completed`，shared 层唯一状态定义）。

### 关键流程

1. **权限请求到达**：主进程 HookEventBus 广播 IPC.HOOK_EVENT -> 通知窗口 createPermissionHandler 处理 PermissionRequest -> enqueueRequest -> permissionRequestsAtom 更新 -> ProjectSplitSection 按 projectId 分组渲染。
2. **项目分割区变化**：session 启动/停止 -> ptyBindHandler + sessionLifecycle 更新 activeSessionsAtom + ptySessionIdsAtom -> runningProjectsAtom 派生更新 -> 分割区增减（项目停止时分割区及通知全部移除）。
3. **PTY 退出清理**（关键）：主进程 `onExit` → `sendToRenderers(SESSION_STATUS, {status:'Completed'})`；通知窗口在 IPC 解构边界将 payload 声明为 `{ sessionId: string; status?: SessionStatus }`，无 status 的普通 PTY data 推送直接忽略，有 status 时安全写入 `activeSessionsAtom`；随后 `sendToRenderers(PTY_UNBIND, {ptyId, claudeId})` → `handleUnbind` → `unbindPty` + `removeFromRealtime` → `ptySessionIdsAtom` 移除该 claudeId → `runningProjectsAtom` 重新计算 → 项目分组消失。不依赖 SessionEnd Hook。
4. **Insight 报告通知**：主进程 insight PTY 完成 → `openNotificationWindow()` 自动创建通知窗口（幂等）→ 1s 延迟等待页面加载 → `sendToRenderers(INSIGHT_REPORT_READY, {filePath})` → 通知窗口 `useEffect` 中 `window.api.on` 监听 → `setInsightNotifs` 更新本地 state（按 `filePath` 去重）→ "系统通知" 分割区渲染 insight 通知项 → 用户点击"查看报告" → `shell.openExternal(reportPath)` 打开浏览器。
4. **展开详情**：NotificationItem 点击展开 -> 读 `req.toolInput` -> 转为 badgeContent（Record<string,string>）-> `renderToolDetail` 渲染工具详情（Read: filePath+range / Write: filePath+content / Edit: filePath+old+new / Bash: command+description / Grep: pattern+path / ...）。颜色复用历史面板 type 配色（工具类橙 #e6430d / 经验类棕 #DA7756）。
5. **审批操作**：同意/拒绝（±消息）-> IPC.PERMISSION_RESPOND -> 主进程 rawWrite TUI 按键序列（同意=`\r`，拒绝=`\x1b[B`×2+`\r`，附加=`\t`+msg+`\r`，逐个按键间隔 ~50ms）。关闭 -> IPC.PERMISSION_DISMISS -> 主进程 decrementBadge。
6. **窗口管理**：
   - 创建：权限请求来时自动打开（可配置 `notifWindowAutoOpen` 默认开）+ 用户点顶栏按钮手动打开 + insight 报告完成时自动打开（`openNotificationWindow()` 幂等）
   - 窗口属性：不设 parent（独立于主窗口）、alwaysOnTop 可配置（`notifWindowAlwaysOnTop` 默认开）、600×600 正方形
   - 关闭：隐藏到托盘（窗口存活，不销毁）
   - 恢复：新通知来时恢复显示+抢焦点（`show()`+`focus()`）
   - 单例：已存在则聚焦

### 状态机

无。

### 异常处理

- 权限请求无超时（Agent 一直等待）；多请求按项目分割区 FIFO 堆叠。
- 窗口已关闭（隐藏）时新通知到达 -> 自动恢复显示+抢焦点。
- Handler 工厂子集（仅 permission + session，不含 jsonl/timeline/branch），开销可控。

### 监控与测试

- **日志点**：通知窗口创建/隐藏/恢复；PermissionRequest 处理；runningProjectsAtom 变化。
- **测试缺口 [待补]**：通知窗口 UI 组件无单测。

**测试清单**：

| 测试点 | 测试类型 | 测试场景 | 预期结果 |
|--------|---------|---------|----------|
| PTY 退出清理 | 集成 | PTY 进程退出，SESSION_STATUS Completed 到达 | activeSessionsAtom 状态更新为 Completed |
| SessionStatus 类型约束 | 静态检查 | 通知窗口将 SESSION_STATUS 写入 activeSessionsAtom | 复用 shared SessionStatus，TypeScript 无 string 赋值错误 |
| PTY_UNBIND 清理 ptySessionIds | 集成 | PTY_UNBIND 到达通知窗口 | handleUnbind 调用 removeFromRealtime，ptySessionIdsAtom 移除该 claudeId |
| runningProjectsAtom 重算 | 单元 | ptySessionIdsAtom 移除 + activeSessionsAtom Completed | runningProjectsAtom 不再包含该项目 |
| 项目分组消失 | E2E | 项目所有终端关闭 | 通知窗口中该项目分割区消失 |

> 详情请阅读对应 Architecture 块文件：`docs/architecture.md` § renderer § features § notifications（`.claude/rules/architecture/src/renderer/features/notifications.md`）
