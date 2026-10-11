// 使用方法：npm test -- src/__tests__/main/trustGate.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：应用托管 Session 启动期 TrustGate 识别与安全边界回归测试

import { describe, expect, it, vi } from 'vitest'
import { createTrustGate } from '../../main/lib/pty/TrustGate'

const QUESTION = 'Do you trust the files in this folder?'
const OPTION = '❯ 1. Yes, I trust this folder'

function createTestGate(): {
  gate: ReturnType<typeof createTrustGate>
  confirmTrust: ReturnType<typeof vi.fn>
  preTrust: ReturnType<typeof vi.fn>
} {
  const confirmTrust = vi.fn()
  const preTrust = vi.fn()
  const gate = createTrustGate({
    sessionId: 'test-session',
    projectPath: 'C:/test/project',
    confirmTrust,
    preTrust,
  })
  return { gate, confirmTrust, preTrust }
}

describe('TrustGate', () => {
  it('pre-trusts the target path when armed', () => {
    const { gate, preTrust } = createTestGate()

    expect(preTrust).toHaveBeenCalledWith('C:/test/project')
    expect(gate.state).toBe('armed')
  })

  it('confirms a complete trust dialog exactly once', () => {
    const { gate, confirmTrust } = createTestGate()

    expect(gate.inspect(`${QUESTION}\n${OPTION}`)).toBe(true)
    expect(gate.state).toBe('handled')
    expect(confirmTrust).toHaveBeenCalledTimes(1)
    expect(confirmTrust).toHaveBeenCalledWith('\r')

    gate.inspect(`${QUESTION}\n${OPTION}`)
    expect(confirmTrust).toHaveBeenCalledTimes(1)
  })

  it('recognizes a trust dialog split across output chunks', () => {
    const { gate, confirmTrust } = createTestGate()

    expect(gate.inspect('Do you trust the files ')).toBe(false)
    expect(gate.inspect('in this folder?\n❯ 1. Yes, I trust this folder')).toBe(true)
    expect(confirmTrust).toHaveBeenCalledTimes(1)
  })

  it('recognizes ANSI-decorated and whitespace-compressed output', () => {
    const { gate, confirmTrust } = createTestGate()
    const output = '\u001b[1mIsthisaprojectyoucreatedoroneyoutrust?\u001b[0m\n1.Yes,Itrustthisfolder'

    expect(gate.inspect(output)).toBe(true)
    expect(confirmTrust).toHaveBeenCalledTimes(1)
  })

  it('does not act on a single trust-like phrase', () => {
    const { gate, confirmTrust } = createTestGate()

    expect(gate.inspect('I trust this project and its tests.')).toBe(false)
    expect(confirmTrust).not.toHaveBeenCalled()
    expect(gate.state).toBe('armed')
  })

  it('does not inspect output after markReady or dispose', () => {
    const readyCase = createTestGate()
    readyCase.gate.markReady('first-session-input')
    expect(readyCase.gate.inspect(`${QUESTION}\n${OPTION}`)).toBe(false)
    expect(readyCase.confirmTrust).not.toHaveBeenCalled()

    const disposedCase = createTestGate()
    disposedCase.gate.dispose('session-exit')
    expect(disposedCase.gate.inspect(`${QUESTION}\n${OPTION}`)).toBe(false)
    expect(disposedCase.confirmTrust).not.toHaveBeenCalled()
  })

  it('keeps the startup fallback armed when pre-trust fails', () => {
    const confirmTrust = vi.fn()
    const gate = createTrustGate({
      sessionId: 'fallback-session',
      projectPath: 'C:/test/project',
      confirmTrust,
      preTrust: () => {
        throw new Error('write failed')
      },
    })

    expect(gate.state).toBe('armed')
    expect(gate.inspect(`${QUESTION}\n${OPTION}`)).toBe(true)
    expect(confirmTrust).toHaveBeenCalledWith('\r')
  })

  it('recognizes the Windows Quick safety check prompt captured in production', () => {
    const { gate, confirmTrust } = createTestGate()
    const output = [
      'Accessing workspace:',
      'F:\\claude_project\\Test1',
      'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).',
      "Claude Code'll be able to read, edit, and execute files here.",
      'Security guide',
      '❯ 1. Yes, I trust this folder',
      '  2. No, exit',
      'Enter to confirm · Esc to cancel',
    ].join('\n')

    expect(gate.inspect(output)).toBe(true)
    expect(confirmTrust).toHaveBeenCalledWith('\r')
  })

  it('defers programmatic input until a handled trust prompt reaches ready state', () => {
    const { gate } = createTestGate()
    const sendInput = vi.fn()

    expect(gate.deferUntilReady(sendInput, 'programmatic-session-input')).toBe(true)
    expect(sendInput).not.toHaveBeenCalled()
    expect(gate.inspect('Quick safety check: Is this a project you created or one you trust?\n1. Yes, I trust this folder')).toBe(true)
    expect(gate.state).toBe('handled')
    expect(sendInput).not.toHaveBeenCalled()

    gate.markReady('claude-session-bound')
    expect(gate.state).toBe('ready')
    expect(sendInput).toHaveBeenCalledTimes(1)
  })

  it('flushes deferred input when the normal Claude input prompt is visible before a transcript exists', () => {
    const { gate, confirmTrust } = createTestGate()
    const sendInput = vi.fn()

    expect(gate.deferUntilReady(sendInput, 'programmatic-session-input')).toBe(true)
    expect(gate.inspect('\u001b[9;1H❯\u00a0\u001b[7m \u001b[27m')).toBe(false)

    expect(gate.state).toBe('ready')
    expect(sendInput).toHaveBeenCalledTimes(1)
    expect(confirmTrust).not.toHaveBeenCalled()
  })

  it('does not treat the trust-dialog selection marker as the normal input prompt', () => {
    const { gate } = createTestGate()
    const sendInput = vi.fn()

    gate.deferUntilReady(sendInput, 'programmatic-session-input')
    expect(gate.inspect(`${QUESTION}\n${OPTION}`)).toBe(true)

    expect(gate.state).toBe('handled')
    expect(sendInput).not.toHaveBeenCalled()
  })

  it('flushes deferred input when the normal prompt appears after trust confirmation', () => {
    const { gate, confirmTrust } = createTestGate()
    const sendInput = vi.fn()

    gate.deferUntilReady(sendInput, 'programmatic-session-input')
    expect(gate.inspect(`${QUESTION}\n${OPTION}`)).toBe(true)
    expect(sendInput).not.toHaveBeenCalled()

    expect(gate.inspect('\u001b[9;1H❯\u00a0\u001b[7m \u001b[27m')).toBe(false)
    expect(gate.state).toBe('ready')
    expect(confirmTrust).toHaveBeenCalledTimes(1)
    expect(sendInput).toHaveBeenCalledTimes(1)
  })

  it('drops deferred input when startup is disposed', () => {
    const { gate } = createTestGate()
    const sendInput = vi.fn()

    const cancel = vi.fn()
    expect(gate.deferUntilReady(sendInput, 'programmatic-session-input', cancel)).toBe(true)
    gate.dispose('session-exit')
    expect(cancel).toHaveBeenCalledTimes(1)
    gate.markReady('late-bind')

    expect(sendInput).not.toHaveBeenCalled()
  })
})
