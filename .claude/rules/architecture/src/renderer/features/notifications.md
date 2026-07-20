---
paths:
  - "claude-driver/src/renderer/src/features/notifications/**/*"
---


<!-- parent: features -->

### 架构图

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
    NI -->|展开| TDR["renderToolDetail (共享 utility)"]
    NI -->|IPC.PERMISSION_RESPOND| PTY
    NI -->|IPC.PERMISSION_DISMISS| Badge["角标更新"]
    PH -.IPC.HOOK_EVENT.-> Hook["主进程 HookEventBus 广播"]
    BH -.IPC.PTY_BIND/UNBIND.-> Hook
    SL -.IPC.SESSION_STATUS.-> Hook
```

### 定位与职责

- **职责**：独立系统级通知窗口（`#/notifications`，独立 BrowserWindow，不设 parent，alwaysOnTop 可配置）。按"正在运行的项目"纵向分割展示权限请求 + insight 报告通知，每条 2 行紧凑布局 + 可展开详情（复用历史面板触发线可视化：工具类橙 / 经验类棕）。映射 PRD「概念三：消息通知界面（独立通知窗口）」。
- **边界**：通知窗口 UI + 自建 Jotai store + handler 工厂子集；不负责桌面通知（main notification）、不负责主窗口 tab（已移除）。

### 内部组成

- **NotificationWindowPage.tsx**：窗口页根。自建 JotaiProvider + vanilla store，注册 handler 工厂子集（createPermissionHandler + createPtyBindHandler + createSessionLifecycle + projects 加载）。订阅 IPC.HOOK_EVENT/PTY_BIND/PTY_UNBIND/SESSION_STATUS/PROJECT_LIST/INSIGHT_REPORT_READY。
- **ProjectSplitSection.tsx**：项目分割区组件。读 `runningProjectsAtom`（派生 atom），纵向排列每个运行中项目的分割区（项目名头 + 独立滚动通知列表）。项目停止运行时分割区及其通知全部移除。
- **NotificationItem.tsx**：单条通知项（2 行布局）。Line 1：Agent 框名称（`req.agentName`，主线程/Agent(xxxxxx)）+ 调用名称 + 展开按钮 + 关闭按钮。Line 2：4 交互 Yes/No（同意/同意+消息/拒绝/拒绝+消息，逻辑同原 RequestApprovalPanel：消息随输入框发送，底层 TUI 按键序列）。点击展开显示 `renderToolDetail` 工具调用详情。
- **toolDetailRender.tsx**（共享 utility）：从 LineInsertionItem 抽取 `renderToolDetail` + `buildToolCompact` + `hasToolDetail`，供 LineInsertionItem 和 NotificationItem 共用（DRY）。

### 依赖与联动

- **内部依赖**：atoms（permission/session-core/projects/pty-binding/runningProjects）；business/handler 工厂（permissionHandler/ptyBindHandler/sessionLifecycle）；shared/toolDetailRender；shared/events（IPC）；shared/types（SessionStatus，作为主窗口与通知窗口唯一的会话状态类型来源）。
- **通信方式**：
  - 主进程 HookEventBus 广播 IPC.HOOK_EVENT/PTY_BIND/PTY_UNBIND/SESSION_STATUS 到 mainWindow + 通知窗口（两个 renderer 各自 handler 处理，独立 store）；SESSION_STATUS 的状态字段统一受 shared `SessionStatus` 约束，不在通知窗口重复定义宽泛状态类型
  - IPC.PROJECT_LIST 由通知窗口 invoke 获取项目列表
  - IPC.INSIGHT_REPORT_READY 由主进程 `sendToRenderers` 广播到通知窗口（insight PTY 完成时触发，通知窗口自动创建 + 1s 延迟等待页面加载）
  - IPC.PERMISSION_RESPOND（TUI 按键序列 -> PTY stdin rawWrite；同意=回车，拒绝=Down×2+回车，附加=Tab+文字+回车）
  - IPC.PERMISSION_DISMISS（关闭通知，只更新角标，不发送按键）
- **关键交互场景**：
  - 权限请求 -> 主进程广播 IPC.HOOK_EVENT -> 通知窗口 permissionHandler 处理 -> permissionRequestsAtom 更新 -> ProjectSplitSection 渲染对应项目分割区
  - 项目 session 启动/停止 -> ptyBindHandler + sessionLifecycle 更新 activeSessionsAtom + ptySessionIdsAtom -> runningProjectsAtom 派生更新 -> 分割区增减
  - **PTY 退出清理**（关键）：通知窗口有独立 Jotai store，PTY 退出时需完整清理链路——主进程 `onExit` → `sendToRenderers(SESSION_STATUS, {status:'Completed'})` + `sendToRenderers(PTY_UNBIND, {ptyId, claudeId})` → 渲染进程 `handleUnbind` → `unbindPty` + `removeFromRealtime` → `ptySessionIdsAtom` 清理 → `runningProjectsAtom` 重新计算 → 项目分组消失。**不能依赖 `SessionEnd` Hook**（PTY 退出时不一定触发）；**不能用 `unbindPtyFromClaudeSession(sid)`**（迁移后 `claudeToPtyMap` key 为真实 claudeId，lookup 失败 early return）。`removeFromRealtime` 是 `ptySessionIdsAtom` 的唯一写入口之一，必须与 `addToRealtime`（PTY_BIND 时）配对调用。
  - **Insight 报告通知**：主进程 insight PTY 完成 → `openNotificationWindow()` 自动创建（幂等）→ 1s 延迟 → `sendToRenderers(INSIGHT_REPORT_READY)` → 通知窗口监听 → `insightNotifs` 本地 state 更新（按 `filePath` 去重）→ "系统通知" 分割区渲染 → 用户点击"查看报告" → `shell.openExternal(reportPath)`
  - 展开详情 -> NotificationItem 读 `req.toolInput` -> 转为 badgeContent -> `renderToolDetail` 渲染（复用历史面板触发线可视化）
  - 关闭通知 -> IPC.PERMISSION_DISMISS -> 主进程 decrementBadge
  - 窗口关闭按钮 -> 隐藏到托盘（窗口存活）；新通知来时恢复显示+抢焦点

### 技术选型

React + Jotai（自建 vanilla store）；handler 工厂复用（createPermissionHandler / createPtyBindHandler / createSessionLifecycle）；共享 toolDetailRender utility。

### 非功能约束

- **自包含**：通知窗口有独立 Jotai store，注册 handler 工厂子集，不依赖 mainWindow renderer 存活。
- **健壮性**：权限请求无超时（Agent 一直等待）；多请求按项目分割区 FIFO 堆叠。
- **窗口管理**：不设 parent（独立于主窗口）；alwaysOnTop 可配置（默认开，DriverConfig `notifWindowAlwaysOnTop`）；关闭 = 隐藏到托盘；新通知来时恢复+抢焦点（可配置默认开，DriverConfig `notifWindowAutoOpen`）。
- **性能**：handler 工厂子集（仅 permission + session，不含 jsonl/timeline/branch），开销可控。

> 详情请阅读对应 TDD 块文件：`docs/TDD.md` § renderer § features § notifications（`.claude/rules/tdd/src/renderer/features/notifications.md`）
