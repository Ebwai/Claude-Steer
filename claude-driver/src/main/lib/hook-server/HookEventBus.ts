// 使用方法：import { createHookEventBus } from './lib/hook-server/HookEventBus'
//           const bus = createHookEventBus(() => mainWindow)
//           bus.dispatchHook(payload)
//           bus.dispatchStatusLine(data)
// 编译说明：主进程 Node.js 模块
// 代码说明：内部 EventBus——将 Hook 事件和 statusLine 数据通过 webContents.send 推送渲染进程
//           用函数闭包替代 EventEmitter，避免 window 引用时序问题（window 可能在 bus 创建后才就绪）

import type { BrowserWindow } from 'electron'
import type { HookPayload, StatusLineData, HookEvent } from '../../../shared/types/index'
import { IPC } from '../../../shared/events/ipc-channels'
import { getUserHooksForEvent } from '../config/SettingsManager'

type GetWindow = () => BrowserWindow | null

/**
 * 创建 Hook EventBus
 * @param getWindow 返回当前主窗口的函数（延迟获取，避免启动时 window 尚未创建）
 * @param port 仪表盘 Hook Server 端口（用于过滤 app 自身注入的 curl 命令）
 */
export function createHookEventBus(getWindow: GetWindow, port: number): {
  dispatchHook: (payload: HookPayload) => void
  dispatchStatusLine: (data: StatusLineData) => void
} {
  /**
   * 将 Claude Code Hook POST body 解析并包装为内部 HookEvent 结构
   * 丢弃无法解析的字段（健壮性处理）
   */
  function parseHookEvent(payload: HookPayload): HookEvent {
    const userHooks = getUserHooksForEvent(payload.hook_event_name, port, payload.cwd)
    return {
      eventName: payload.hook_event_name,
      sessionId: payload.session_id,
      cwd: payload.cwd,
      transcriptPath: payload.transcript_path ?? null,
      payload,
      receivedAt: Date.now(),
      userHooks: userHooks.length > 0 ? userHooks : undefined,
    }
  }

  /** 安全获取窗口 webContents（窗口可能已关闭或未就绪） */
  function send(channel: string, data: unknown): void {
    const win = getWindow()
    if (!win || win.isDestroyed()) {
      console.warn(`[HookEventBus] Window not ready, dropping event on channel: ${channel}`)
      return
    }
    if (win.webContents.isLoading()) {
      // 页面还在加载中，延迟 500ms 重试一次
      setTimeout(() => {
        const w = getWindow()
        if (w && !w.isDestroyed() && !w.webContents.isLoading()) {
          w.webContents.send(channel, data)
        }
      }, 500)
      return
    }
    win.webContents.send(channel, data)
  }

  return {
    /**
     * 分发 Claude Code Hook 事件到渲染进程
     * 通道：IPC.HOOK_EVENT ('hook:event')
     */
    dispatchHook(payload: HookPayload): void {
      try {
        const event = parseHookEvent(payload)
        send(IPC.HOOK_EVENT, event)
        console.log(`[HookEventBus] Hook event dispatched: ${event.eventName} / session:${event.sessionId}`)
      } catch (err) {
        console.error('[HookEventBus] Failed to dispatch hook event:', err)
      }
    },

    /**
     * 分发 statusLine 状态数据到渲染进程
     * 通道：IPC.STATUS_LINE ('statusline:update')
     */
    dispatchStatusLine(data: StatusLineData): void {
      try {
        send(IPC.STATUS_LINE, data)
      } catch (err) {
        console.error('[HookEventBus] Failed to dispatch statusLine data:', err)
      }
    }
  }
}
