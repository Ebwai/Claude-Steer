// 使用方法：渲染进程通过 window.api 调用（window.electron.ipcRenderer 原始 API 仍可使用）
// 编译说明：preload 脚本在受限 Node.js 上下文中运行，通过 contextBridge 暴露给 renderer
// 代码说明：ContextBridge IPC 封装——将 ipcMain handler 映射为类型安全的 window.api 方法

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { IpcChannel } from '../shared/events/ipc-channels'

/**
 * 类型安全的 IPC API，暴露给渲染进程使用
 * - invoke: Renderer → Main 请求（双向，返回 Promise）
 * - on: Main → Renderer 监听（单向推送）
 * - off: 移除监听器
 */
const api = {
  /**
   * 向主进程发送请求并等待响应
   * @example window.api.invoke('project:list')
   */
  invoke: (channel: IpcChannel, ...args: unknown[]): Promise<unknown> => {
    return ipcRenderer.invoke(channel, ...args)
  },

  /**
   * 注册主进程推送事件的监听器（返回取消订阅函数）
   * @example const unsub = window.api.on('hook:event', (payload) => { ... })
   */
  on: (channel: IpcChannel, listener: (...args: unknown[]) => void): (() => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void =>
      listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },

  /**
   * 移除指定通道的所有监听器
   */
  removeAllListeners: (channel: IpcChannel): void => {
    ipcRenderer.removeAllListeners(channel)
  }
}

// 通过 contextBridge 安全暴露给渲染进程
// process.contextIsolated 默认为 true（sandbox: false 不影响 context isolation）
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload] contextBridge expose failed:', error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
