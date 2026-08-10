// 使用方法：npm test -- src/__tests__/main/ptySessionBinding.test.ts
// 编译说明：Vitest（纯函数，无 Electron 依赖）
// 代码说明：防止恢复会话在多个同 cwd PTY 中被 SessionStart Hook 误绑

import { describe, expect, it, vi } from 'vitest'
import { resolveSessionStartPty } from '../../main/lib/pty/PtySessionBinding'

describe('resolveSessionStartPty', () => {
  it('目标 Claude 会话已有预绑定时优先使用新 PTY，不采用 cwd 返回的旧 PTY', () => {
    const findSessionByCwd = vi.fn(() => 'pty-old')

    expect(resolveSessionStartPty(
      'claude-main',
      'F:\\project',
      new Map([['claude-main', 'pty-resume-new']]),
      findSessionByCwd,
    )).toEqual({ ptyId: 'pty-resume-new', source: 'exact-binding' })
    expect(findSessionByCwd).not.toHaveBeenCalled()
  })

  it('没有确定性绑定时仍保留 Branch/普通启动依赖的 cwd 兜底', () => {
    expect(resolveSessionStartPty(
      'claude-new',
      '/project',
      new Map(),
      () => 'pty-by-cwd',
    )).toEqual({ ptyId: 'pty-by-cwd', source: 'cwd' })
  })
})
