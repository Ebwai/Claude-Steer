# T3 — Hook 事件解析 + 内部 EventBus + IPC 推送

## 技术原理

**EventBus 职责**：将三通道（Hook/statusLine/JSONL）的原始数据统一路由到渲染进程。
- 不使用 Node.js 原生 `EventEmitter`（无 TypeScript 泛型支持）
- 直接通过 `BrowserWindow.webContents.send(channel, payload)` 推送（架构 §3.2 Event Bus）

**Hook 事件解析**：
- 从 HTTP POST body 中提取 `hook_event_name`、`session_id`、`tool_name` 等字段
- 包装为内部 `HookEvent` 结构（加 `receivedAt` 时间戳）后推送

## 原子步骤

### 步骤 1：创建 `src/main/lib/hook-server/HookEventBus.ts`
- `createHookEventBus(getWindow)` — 返回 `dispatch(event)` 函数
- `dispatch` 内部通过 `mainWindow.webContents.send(IPC.HOOK_EVENT, event)` 推送

### 步骤 2：在 `src/main/index.ts` 中串联 HookServer + EventBus
- `startHookServer` 的 `onHookEvent` 回调调用 `dispatch`
- `onStatusLine` 回调调用 `mainWindow.webContents.send(IPC.STATUS_LINE, data)`

## 验收标准

- [ ] `src/main/lib/hook-server/HookEventBus.ts` 存在
- [ ] `npm run typecheck:node` 通过
- [ ] main/index.ts 串联 HookServer + EventBus（已调用 startHookServer + injectHookConfig）
