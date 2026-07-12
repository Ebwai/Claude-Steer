# T3 — 自动启动 PTY（acceptEdits 权限）+ 弹出 Claude 终端子窗口 + 发送"创建计划"四字指令

## 技术原理

`PtyManager` 已实现（M2 S2），在主进程全局实例化后供各 IPC Handler 使用。  
**M2 S2 T6 实现后**，`PtyManager.startSession()` 内部自动调用 `TerminalWindowManager.create()`，弹出 xterm.js 终端子窗口。

`SESSION_START` IPC → `ptyManager.startSession()` → 弹出 Claude 终端子窗口；  
`SESSION_INPUT` → `ptyManager.writeToSession()` → `pty.write()`（xterm 通过 onData 看到回显）。  

Step 3 点击"开始"时流程：PROJECT_CREATE → 拿到 projectId → SESSION_START（projectPath, permissionMode=acceptEdits）→ **Claude 终端子窗口弹出** → 等待 100ms 后 SESSION_INPUT("创建计划\n")。

## 原子目标

- [x] main/index.ts：全局 `const ptyManager = new PtyManager()` 实例
- [x] IPC `SESSION_START`：wiring PtyManager.startSession，onData 推送 SESSION_STATUS
- [x] IPC `SESSION_INPUT`：wiring PtyManager.writeToSession
- [x] IPC `SESSION_STOP`：wiring PtyManager.stopSession
- [x] CreateProjectWizard Step 3 "开始"：依次调用 PROJECT_CREATE → SESSION_START → SESSION_INPUT
- [ ] **依赖 M2 S2 T6 完成后**：SESSION_START 触发时自动弹出 Claude 终端子窗口（用户可在前台看到 Claude 工作过程）

## 验收标准

点击"开始"后：
1. 向导关闭，canvas 出现新项目卡片
2. **Claude 终端子窗口自动弹出**，前台显示 Claude 启动过程
3. 控制台打印 `[PtyManager] Starting session ...`
4. Claude 进程启动（可在系统进程管理器看到 claude 进程）
5. "创建计划"指令自动注入，可在终端子窗口中看到 Claude 响应
