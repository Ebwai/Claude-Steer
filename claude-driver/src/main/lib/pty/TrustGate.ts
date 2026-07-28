// 使用方法：应用托管 Session spawn 前 createTrustGate，onData 调 inspect，就绪/退出时清理
// 编译说明：主进程 Node.js ESM
// 代码说明：受控启动阶段的项目预信任 + Claude trust folder 对话框单次兜底

import { ensureProjectTrusted } from '../config/ClaudeJsonManager'
import { stripAnsi } from './AnsiStripper'

export type TrustGateState = 'armed' | 'handled' | 'ready' | 'disposed'

export interface TrustGateOptions {
  sessionId: string
  projectPath: string
  confirmTrust: (input: string) => void
  preTrust?: (projectPath: string) => void
}

export interface TrustGate {
  readonly state: TrustGateState
  inspect(data: string): boolean
  deferUntilReady(action: () => void, label: string): boolean
  markReady(reason: string): void
  dispose(reason: string): void
}

const MAX_STARTUP_BUFFER_CHARS = 4096

function isTrustDialog(text: string): boolean {
  const plain = text.toLowerCase()
  const compact = plain.replace(/\s+/g, '')

  const hasQuestion =
    /do\s*you\s*trust(?:\s*the|\s*this|\s*these)?\s*(?:files|folder|directory|project)/i.test(plain) ||
    compact.includes('doyoutrustthefilesinthisfolder') ||
    compact.includes('isthisaprojectyoucreatedoroneyoutrust')

  const hasConfirmationOption =
    /\byes\b[^\n]*(?:trust|continue)/i.test(plain) ||
    /i\s*trust\s*this\s*(?:folder|directory|project)/i.test(plain) ||
    compact.includes('yesitrustthisfolder') ||
    compact.includes('itrustthisproject')

  return hasQuestion && hasConfirmationOption
}

export function createTrustGate(options: TrustGateOptions): TrustGate {
  let state: TrustGateState = 'armed'
  let startupBuffer = ''
  const pendingActions: Array<{ action: () => void; label: string }> = []

  try {
    const preTrust = options.preTrust ?? ensureProjectTrusted
    preTrust(options.projectPath)
    console.log(`[TrustGate] armed: session=${options.sessionId} path=${options.projectPath}`)
  } catch (error) {
    console.error(
      `[TrustGate] pre-trust failed, startup fallback remains armed: session=${options.sessionId} path=${options.projectPath}`,
      error,
    )
  }

  return {
    get state(): TrustGateState {
      return state
    },

    inspect(data: string): boolean {
      if (state !== 'armed') return false

      startupBuffer = `${startupBuffer}${stripAnsi(data)}`.slice(-MAX_STARTUP_BUFFER_CHARS)
      if (!isTrustDialog(startupBuffer)) return false

      state = 'handled'
      console.log(`[TrustGate] trust dialog confirmed once: session=${options.sessionId}`)
      options.confirmTrust('\r')
      return true
    },

    deferUntilReady(action: () => void, label: string): boolean {
      if (state !== 'armed' && state !== 'handled') return false
      pendingActions.push({ action, label })
      console.log(
        `[TrustGate] deferred startup action: session=${options.sessionId} label=${label} state=${state} pending=${pendingActions.length}`,
      )
      return true
    },

    markReady(reason: string): void {
      if (state !== 'armed' && state !== 'handled') return
      state = 'ready'
      startupBuffer = ''
      const actions = pendingActions.splice(0)
      console.log(
        `[TrustGate] ready: session=${options.sessionId} reason=${reason} deferredActions=${actions.length}`,
      )
      for (const { action, label } of actions) {
        try {
          action()
          console.log(`[TrustGate] deferred action flushed: session=${options.sessionId} label=${label}`)
        } catch (error) {
          console.error(
            `[TrustGate] deferred action failed: session=${options.sessionId} label=${label}`,
            error,
          )
        }
      }
    },

    dispose(reason: string): void {
      if (state === 'disposed') return
      const droppedActions = pendingActions.length
      state = 'disposed'
      startupBuffer = ''
      pendingActions.length = 0
      console.log(
        `[TrustGate] disposed: session=${options.sessionId} reason=${reason} droppedActions=${droppedActions}`,
      )
    },
  }
}
