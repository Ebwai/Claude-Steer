# T6 — Claude 终端子窗口（xterm.js + BrowserWindow）

## 技术原理

**为什么用独立 BrowserWindow + xterm.js，而不是系统终端？**
- 系统终端（`gnome-terminal` / `Terminal.app` / `cmd`）是独立进程，无法从 Electron 主进程直接控制其 stdin，无法程序化注入指令
- `BrowserWindow` 是 Electron 原生子窗口，主进程持有引用，可直接调用 `win.webContents.send()` 推送 PTY stdout；渲染进程通过 IPC 回传用户输入给 PTY stdin
- xterm.js 是成熟的浏览器端终端模拟器，原生支持 ANSI 控制码渲染（颜色、光标、滚动），用户体验与系统终端相当

**xterm.js 核心 API**：
- `new Terminal({ cursorBlink: true, fontSize: 13, theme: {...} })` 创建终端实例
- `terminal.open(containerElement)` 挂载到 DOM
- `terminal.write(data)` 渲染 PTY stdout（ANSI 序列）
- `terminal.onData(handler)` 捕获用户键入，通过 IPC 发送给 PTY stdin
- `FitAddon.fit()` 自动适配窗口大小，并通过 IPC 同步 PTY cols/rows

**BrowserWindow 与主进程通信**：
- `ipcMain.on('terminal:input', (e, { sessionId, data }) => pty.write(data))` — 用户输入转发
- `ipcMain.on('terminal:resize', (e, { sessionId, cols, rows }) => pty.resize(cols, rows))` — 窗口尺寸同步
- `win.webContents.send('terminal:data', { sessionId, data })` — PTY stdout 推送给 xterm
- `win.close()` — 程序关闭子窗口（不终止 PTY）

**离线缓冲机制**：子窗口关闭期间，PTY stdout 继续写入环形缓冲（最多 10000 行）。重新打开窗口时，先将缓冲内容回放给 xterm，再切换到实时推送模式。

## 原子目标

### 步骤 1：安装依赖

```bash
npm install xterm @xterm/addon-fit @xterm/addon-web-links
```

注意：`xterm` 需要在渲染进程使用，不需要 electron-rebuild（不是 native addon）

### 步骤 2：创建 `src/main/lib/pty/TerminalWindowManager.ts`

```typescript
// 关键结构
class TerminalWindowManager {
  private windows: Map<string, BrowserWindow>
  private buffers: Map<string, string[]>   // 离线缓冲，环形 10000 行

  create(sessionId: string, pty: IPty, opts: { projectName: string; cwd: string }): BrowserWindow
  reopen(sessionId: string): void          // 重建窗口并回放缓冲
  writeToSession(sessionId: string, text: string): void  // 程序化注入（直接调 pty.write）
  closeWindow(sessionId: string): void     // 仅关闭窗口，保留 PTY
  destroySession(sessionId: string): void  // 关闭窗口 + 清理 PTY 资源
}
```

### 步骤 3：在 electron-vite 配置中添加终端子窗口构建目标

在 `electron.vite.config.ts` 的 renderer 配置中，增加 `terminal` 入口：

```typescript
renderer: {
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html'),
        terminal: resolve(__dirname, 'src/main/windows/terminal/terminal.html')
      }
    }
  }
}
```

### 步骤 4：创建终端子窗口三件套

**`src/main/windows/terminal/terminal.html`**：标准 HTML 页面，加载 `terminal-renderer.ts`，包含全屏 `#terminal-container` div

**`src/main/windows/terminal/terminal-preload.ts`**：ContextBridge 暴露以下 API：
```typescript
contextBridge.exposeInMainWorld('terminalIpc', {
  onData: (callback: (data: string) => void) => ipcRenderer.on('terminal:data', callback)
  sendInput: (sessionId: string, data: string) => ipcRenderer.send('terminal:input', { sessionId, data })
  sendResize: (sessionId: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', { sessionId, cols, rows })
  getSessionId: () => ipcRenderer.invoke('terminal:get-session-id')
})
```

**`src/main/windows/terminal/terminal-renderer.ts`**：
```typescript
const terminal = new Terminal({ cursorBlink: true, fontSize: 13, theme: claudeTheme })
const fitAddon = new FitAddon()
terminal.loadAddon(fitAddon)
terminal.open(document.getElementById('terminal-container'))
fitAddon.fit()

// 接收 PTY stdout
window.terminalIpc.onData((data) => terminal.write(data))

// 用户键入 → PTY stdin
terminal.onData((data) => window.terminalIpc.sendInput(sessionId, data))

// 窗口 resize → PTY cols/rows
window.addEventListener('resize', () => {
  fitAddon.fit()
  window.terminalIpc.sendResize(sessionId, terminal.cols, terminal.rows)
})
```

### 步骤 5：修改 `PtyManager.ts` 集成 TerminalWindowManager

- `startSession()` 内：PTY 创建后调用 `terminalWindowManager.create(sessionId, pty, opts)`
- `writeToSession()` 内：直接调用 `pty.write(text)`（xterm 通过 onData 看到回显，无需额外操作）
- `stopSession()` 内：先调用 `terminalWindowManager.closeWindow(sessionId)`，再 `pty.kill()`

### 步骤 6：添加 IPC Handler（`session.ipc.ts`）

```typescript
// 主 Renderer → Main：请求弹出已有 session 的终端窗口（如窗口被关闭后重新打开）
ipcMain.handle(IPC.TERMINAL_OPEN, (_, { sessionId }) => {
  terminalWindowManager.reopen(sessionId)
})
```

## 验收标准

- [ ] 点击「新建项目」并完成向导 Step 3，自动弹出 Claude 终端子窗口，可看到 Claude 的启动过程
- [ ] 用户可在终端子窗口中直接键入消息，Claude 正常响应
- [ ] 仪表盘主窗口可通过"消息输入行"向同一 Session 注入指令，与用户输入互不干扰
- [ ] 关闭终端子窗口后，PTY 进程继续运行（可从项目监控画布确认 session 状态仍为 Running）
- [ ] 关闭后重新点击「打开终端」可恢复显示，并回放关闭期间的历史输出

## 待优化项

- 终端主题与仪表盘 Claude 配色方案对齐（使用 `tokens.css` 中的颜色变量）
- 支持多标签终端（同一项目多个 Session 的子窗口复用同一个 BrowserWindow，用标签切换）
- 字体大小、行距的设置项接入全局设置
