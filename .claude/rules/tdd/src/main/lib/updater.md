---
paths:
  - "claude-driver/src/main/lib/updater/**/*"
---


<!-- parent: lib -->

### 模块架构图

```mermaid
graph TD
    Updater -->|autoUpdater| EU["electron-updater"]
    Updater -.IPC.UPDATER_*.-> Renderer["renderer"]
```

### 模块概览

- **职责**：应用自动更新包装（仅 packaged 应用激活）。
- **输入**：IPC invoke（UPDATER_CHECK/DOWNLOAD/QUIT_AND_INSTALL）。
- **输出**：IPC push（UPDATER_STATE_CHANGED）。

### API 概览

- **`updater/index.ts`**
  - `initUpdater(mainWindow: BrowserWindow): void`
  - `checkForUpdates(): Promise<void>`
  - `downloadUpdate(): Promise<void>`
  - `quitAndInstall(): void`

### 数据模型

- **`UpdaterState`**（shared/types/AboutSection）：status union（idle/checking/update-available/downloading/downloaded/no-update/error）+ version?、releaseDate?、releaseNotes?、percent?、bytesPerSecond?、error?。

### 关键流程

1. **检查更新**：checkForUpdates -> autoUpdater.checkForUpdates -> checking/update-available/download-progress/downloaded/error 事件
2. **下载**：downloadUpdate -> autoDownload=false（手动触发）
3. **安装**：quitAndInstall -> autoUpdater.quitAndInstall

### 状态机

- **UpdaterState status**：idle -> checking -> update-available -> downloading -> downloaded -> quit-and-install。

### 异常处理

- 仅 `app.isPackaged` 激活（dev 模式跳过）
- autoDownload=false 避免误更新

### 监控与测试

- **日志点**：updater 状态变化。
- **测试缺口 [待补]**：updater 无单测（依赖 electron-updater）。

> 详情请阅读对应 Architecture 块文件：`docs/architecture.md` § main § lib § updater（`.claude/rules/architecture/src/main/lib/updater.md`）
