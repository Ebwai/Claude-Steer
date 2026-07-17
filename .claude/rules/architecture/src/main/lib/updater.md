---
paths:
  - "claude-driver/src/main/lib/updater/**/*"
---


<!-- parent: lib -->

### 架构图

```mermaid
graph TD
    Updater -->|autoUpdater| EU["electron-updater"]
    Updater -.IPC.UPDATER_*.-> Renderer["renderer"]
```

### 定位与职责

- **职责**：应用自动更新包装。支撑 PRD「全局设置·更新」。
- **边界**：仅 packaged 应用激活；不负责 dev 模式。

### 内部组成

- **index.ts**：initUpdater（绑定 autoUpdater 事件）、checkForUpdates、downloadUpdate、quitAndInstall；autoDownload=false（手动下载）。

### 依赖与联动

- **内部依赖**：electron-updater；electron（app/BrowserWindow）；shared/events（IPC）。
- **通信方式**：经 IPC.UPDATER_CHECK/DOWNLOAD/QUIT_AND_INSTALL/STATE_CHANGED 与渲染层交互。
- **关键交互场景**：检查 -> 下载（progress 推送）-> 下载完成 -> 用户确认 quitAndInstall。

### 技术选型

electron-updater（Electron 官方更新方案，跨平台）。

### 非功能约束

- **健壮性**：仅 `app.isPackaged` 激活；autoDownload=false 避免误更新。
- **可观测性**：checking/update-available/download-progress/downloaded/error 全事件推送。

> 详情请阅读对应 TDD 块文件：`docs/TDD.md` § main § lib § updater（`.claude/rules/tdd/src/main/lib/updater.md`）
