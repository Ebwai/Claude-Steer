// 使用方法：import { NotificationService } from './lib/notification/NotificationService'
//           NotificationService.init(() => mainWindow)
//           NotificationService.notify('标题', '内容')
//           NotificationService.incrementBadge() / decrementBadge()
// 编译说明：主进程 Node.js 模块
// 代码说明：系统通知服务——发送 Electron 原生桌面通知 + 管理任务栏角标
//           三平台角标策略：Linux/macOS → app.setBadgeCount；Windows → setOverlayIcon 红点
//           角标计数由主进程维护（pendingPermissionCount），渲染层不参与计数

import { app, nativeImage } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../../shared/events/ipc-channels'

// Windows 用：16×16 红圆点（内联 Base64 PNG，避免外部文件依赖）
const RED_DOT_BASE64 =
  'data:image/png;base64,' +
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlz' +
  'AAALEwAACxMBAJqcGAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZxjeSBQAAABnSURB' +
  'VDiNY2CgJPifgYGBgZGBgYERihmxMIYBAwMDA+P///8ZGBiI1P////8ZiNVMtAEMDAwMjP//Mwz9' +
  'BgYGhv8MDAz/GRgY/jMwMPxnYGD4T7QBZMPAQL8BGBgYGEhpAAD3fBHGnMdwOAAAAABJRU5ErkJggg=='

type GetWindow = () => BrowserWindow | null

let getWindowFn: GetWindow = () => null
let pendingCount = 0

/** 初始化服务，传入获取主窗口的函数（延迟获取避免时序问题） */
function init(getWindow: GetWindow): void {
  getWindowFn = getWindow
}

/** 发送系统级桌面通知（仅在 Notification.isSupported() 时发送） */
function notify(title: string, body: string): void {
  try {
    // 动态 import Notification（避免渲染进程误引用时报错）
    const { Notification } = require('electron') as typeof import('electron')
    if (!Notification.isSupported()) {
      console.log('[NotifSvc] Notification.isSupported=false, skip')
      return
    }
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      const win = getWindowFn()
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.focus()
        // 通知渲染层切换到 notifications tab
        win.webContents.send(IPC.NOTIFICATION_FOCUS_TAB)
      }
    })
    n.show()
    console.log(`[NotifSvc] notify: title="${title}" body="${body.slice(0, 60)}"`)
  } catch (err) {
    console.error('[NotifSvc] notify failed:', err)
  }
}

/** 更新任务栏角标（跨平台分支） */
function setBadge(n: number): void {
  const win = getWindowFn()
  console.log(`[NotifSvc] setBadge: n=${n} platform=${process.platform}`)

  try {
    if (process.platform === 'win32') {
      if (!win || win.isDestroyed()) return
      if (n > 0) {
        const icon = nativeImage.createFromDataURL(RED_DOT_BASE64)
        win.setOverlayIcon(icon, `${n} 待处理`)
      } else {
        win.setOverlayIcon(null, '')
      }
    } else if (process.platform === 'darwin') {
      app.dock?.setBadge(n > 0 ? String(n) : '')
    } else {
      // Linux（Ubuntu/GNOME Unity Dock）
      app.setBadgeCount(n)
    }
  } catch (err) {
    console.error('[NotifSvc] setBadge failed:', err)
  }
}

/** 新权限请求到达：角标 +1 */
function incrementBadge(): void {
  pendingCount++
  setBadge(pendingCount)
}

/** 权限请求处理完毕：角标 -1（不低于 0） */
function decrementBadge(): void {
  if (pendingCount > 0) pendingCount--
  setBadge(pendingCount)
}

/** 重置角标为 0（应用聚焦时可选调用） */
function resetBadge(): void {
  pendingCount = 0
  setBadge(0)
}

export const NotificationService = {
  init,
  notify,
  setBadge,
  incrementBadge,
  decrementBadge,
  resetBadge,
}
