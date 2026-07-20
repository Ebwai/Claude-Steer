---
paths:
  - "claude-driver/src/main/lib/hook-server/**/*"
---


<!-- parent: lib -->

### 架构图

```mermaid
graph TD
    HookServer -->|POST /hooks /statusline| Http["Node http :39521"]
    HookServer --> HookEventBus
    HookEventBus -->|enrich| SettingsManager["config/SettingsManager getUserHooksForEvent"]
    HookEventBus -.webContents.send.-> MW["mainWindow"]
    HookEventBus -.webContents.send.-> NW["notificationWindow"]
```

### 定位与职责

- **职责**：三通道主通道。零依赖 HTTP Server 接收 Claude Code Hook 事件 + statusLine 数据，EventBus 解析为 `HookEvent` 推送渲染层。映射 PRD「机制·Token 捕获」（statusLine 入口）、「机制·上下文更新机制」（PostToolUse/PostCompact）、「机制·Subagent/Branch 显示逻辑」、「机制·系统通知推送」（PermissionRequest）。
- **边界**：负责接收与分发；不负责业务处理（renderer business/）、不负责 PTY（pty）。

### 内部组成

- **HookServer.ts**：Node 原生 `http` 模块，监听 127.0.0.1，接收 POST `/hooks` 与 `/statusline`；端口冲突触发 `onPortConflict` 回调而非崩溃。
- **HookEventBus.ts**：解析 Hook payload -> `HookEvent`（enrich user_hooks via getUserHooksForEvent）；闭包 `getWindow()` 避免 window 时序问题；页面加载中时 500ms 后重试 send。

### 依赖与联动

- **内部依赖**：shared/types（HookPayload/StatusLineData/HookEvent）；shared/events（IPC）；config/SettingsManager（getUserHooksForEvent）。
- **通信方式**：HTTP 接收 Claude Code POST；webContents.send 推送 IPC.HOOK_EVENT/STATUS_LINE。
- **关键交互场景**：①Claude Code 发 Hook -> HookServer -> HookEventBus.dispatchHook -> IPC.HOOK_EVENT；②statusLine 每 ~300ms -> dispatchStatusLine -> IPC.STATUS_LINE；③端口占用 -> onPortConflict 回调。

### 技术选型

Node 原生 http（零依赖，避免 express 体积）；闭包 getWindow 解耦窗口生命周期。

### 非功能约束

- **健壮性**：端口冲突不崩（回调上层处理）；页面加载中 send 重试 500ms。
- **可观测性**：Hook 事件全部经 IPC 推送可追踪。

> 详情请阅读对应 TDD 块文件：`docs/TDD.md` § main § lib § hook-server（`.claude/rules/tdd/src/main/lib/hook-server.md`）
