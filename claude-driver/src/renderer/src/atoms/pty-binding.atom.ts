// 使用方法：import { ptyBindingsAtom } from '@renderer/atoms/pty-binding.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：PTY ↔ Claude Code session 双向绑定表 atom

import { atom } from 'jotai'

export interface PtyBindings {
  /** ptyId → claudeId */
  ptyToClaudeMap: Map<string, string>
  /** claudeId → ptyId */
  claudeToPtyMap: Map<string, string>
}

/**
 * PTY ↔ Claude Code session 双向绑定表
 * 由 PTY_BIND / PTY_UNBIND IPC 事件维护
 * 绑定存在 = 该 PTY 当前有运行中的 Claude Code session
 */
export const ptyBindingsAtom = atom<PtyBindings>({
  ptyToClaudeMap: new Map(),
  claudeToPtyMap: new Map(),
})
