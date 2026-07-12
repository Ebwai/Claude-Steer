# T1 — 主进程 39521 端口 HTTP Server

## 技术原理

**使用 Node.js 原生 `http` 模块**（无需 express）：
- 两条路由：`POST /hooks`（Claude Hook 事件）、`POST /statusline`（桥接脚本状态数据）
- 主进程启动时调用 `startHookServer(port, handlers)`，返回 `http.Server` 实例
- **端口冲突检测**：监听 `'error'` 事件，`err.code === 'EADDRINUSE'` 时通过 `ipcMain` 向渲染进程发送通知，渲染进程弹窗提示用户修改端口

## 原子步骤

### 步骤 1：创建 `src/main/lib/hook-server/HookServer.ts`
- 导出 `startHookServer(port, onHook, onStatusLine)` 函数
- 解析请求体 JSON（手动 `data` 事件拼接，无 body-parser 依赖）
- 端口冲突时 emit 事件通知调用方

### 步骤 2：在 `src/main/index.ts` 中初始化 HookServer
- `app.whenReady()` 时调用 `startHookServer`
- Hook 事件通过 `webContents.send(IPC.HOOK_EVENT, event)` 推送渲染进程
- statusLine 数据通过 `webContents.send(IPC.STATUS_LINE, data)` 推送

### 步骤 3：端口冲突弹窗（骨架）
- 冲突时通过 `ipcMain` → renderer 侧 `window.api.on('notification:new', ...)` 显示提示
- 具体 Modal UI 在 M5 S2 实现，此处只保证事件发出

## 验收标准

- [ ] `src/main/lib/hook-server/HookServer.ts` 存在
- [ ] `npm run typecheck:node` 通过
- [ ] 手动 `curl -X POST http://127.0.0.1:39521/hooks -d '{}'` 返回 200（dev 模式下）

## 待优化项

- 端口号应从 `~/.claude-driver/config.json` 读取（M5 S2 配置模块实现后对接）
