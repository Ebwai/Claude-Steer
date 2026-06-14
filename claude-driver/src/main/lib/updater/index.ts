// 使用方法：由 main/index.ts 在 app.whenReady() 中调用 initUpdater(mainWindow)
// 编译说明：主进程 Node.js ESM，仅在 app.isPackaged 时启用
// 代码说明：electron-updater 封装——绑定 autoUpdater 事件并转发为 IPC push 到渲染进程

import { autoUpdater } from 'electron-updater'
import { app, BrowserWindow } from 'electron'
import { IPC } from '../../../shared/events/ipc-channels'

let win: BrowserWindow | null = null

export function initUpdater(mainWindow: BrowserWindow): void {
  if (!app.isPackaged) {
    console.log('[Updater] Skipped (not packaged)')
    return
  }

  win = mainWindow

  autoUpdater.autoDownload = false
  autoUpdater.logger = console

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for update...')
    win?.webContents.send(IPC.UPDATER_STATE_CHANGED, { status: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    console.log('[Updater] Update available:', info.version)
    const notes = info.releaseNotes
      ? (Array.isArray(info.releaseNotes)
        ? info.releaseNotes.map((n) => n.note).join('\n')
        : String(info.releaseNotes))
      : null
    win?.webContents.send(IPC.UPDATER_STATE_CHANGED, {
      status: 'update-available',
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: notes,
    })
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] Already up to date')
    win?.webContents.send(IPC.UPDATER_STATE_CHANGED, { status: 'no-update' })
  })

  autoUpdater.on('download-progress', (progress) => {
    win?.webContents.send(IPC.UPDATER_STATE_CHANGED, {
      status: 'downloading',
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    })
  })

  autoUpdater.on('update-downloaded', (event) => {
    console.log('[Updater] Downloaded:', event.version)
    win?.webContents.send(IPC.UPDATER_STATE_CHANGED, {
      status: 'downloaded',
      version: event.version,
    })
  })

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message)
    win?.webContents.send(IPC.UPDATER_STATE_CHANGED, {
      status: 'error',
      error: err.message,
    })
  })
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    console.log('[Updater] Check skipped (not packaged)')
    return
  }
  console.log('[Updater] Manual check triggered')
  await autoUpdater.checkForUpdates()
}

export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) {
    console.log('[Updater] Download skipped (not packaged)')
    return
  }
  console.log('[Updater] Manual download triggered')
  await autoUpdater.downloadUpdate()
}

export function quitAndInstall(): void {
  if (!app.isPackaged) {
    console.log('[Updater] Quit-and-install skipped (not packaged)')
    return
  }
  console.log('[Updater] Quit and install triggered')
  autoUpdater.quitAndInstall()
}
