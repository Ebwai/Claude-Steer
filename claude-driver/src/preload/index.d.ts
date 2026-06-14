// 代码说明：window.api 的 TypeScript 全局类型声明（供渲染进程 TypeScript 编译器使用）

import { ElectronAPI } from '@electron-toolkit/preload'
import type { IpcChannel } from '../shared/events/ipc-channels'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      invoke: (channel: IpcChannel, ...args: unknown[]) => Promise<unknown>
      on: (channel: IpcChannel, listener: (...args: unknown[]) => void) => () => void
      removeAllListeners: (channel: IpcChannel) => void
    }
  }
}
