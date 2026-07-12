# T1 — PTY 启动 / 停止 / 心跳检测

## 技术原理

**node-pty 工作方式**：
- `pty.spawn('claude', args, { cwd, env, cols, rows })` 返回 `IPty` 实例
- `pty.onData(data => ...)` 接收 stdout（含 ANSI 控制码）
- `pty.write(text)` 写入 stdin（注意行尾必须是 `\r`，不是 `\n`）
- `pty.kill('SIGTERM')` 终止进程

**心跳检测**：每 10s 调用 `pty.pid` 检查进程是否还活着（`process.kill(pid, 0)` 方式）

**PTYManager 设计**：
- 维护 `Map<sessionId, PtyInstance>` 管理多个并发 session
- 每个 PtyInstance 包含：`pty`、`sessionId`、`projectPath`、`status`、`heartbeatTimer`、`timeoutTimer`
- 启动时同时激活心跳定时器（10s）和超时定时器（30min）

## 原子步骤

### 步骤 1：创建 `src/main/lib/pty/PtyManager.ts`
- `PtyManager` 类：`startSession(opts)` / `stopSession(sessionId)` / `writeToSession(sessionId, text)` / `getStatus(sessionId)`
- `opts`：`{ sessionId, projectPath, permissionMode, model?, onData, onExit }`

### 步骤 2：在 IPC handler 中接入 PtyManager（SESSION_START / SESSION_STOP / SESSION_INPUT）

## 验收标准

- [ ] `src/main/lib/pty/PtyManager.ts` 存在
- [ ] `npm run typecheck:node` 通过

## 待优化项

- stdin 消息队列（Q1-Q3）在 T3 实现
- ANSI 过滤在 T2 实现
