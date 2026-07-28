// 使用方法：npm test -- src/__tests__/main/ptyManagerInput.test.ts
// 编译说明：Vitest
// 代码说明：验证程序化行输入按“文本 → 50ms → Enter”发送，且同 Session 串行化。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyManager } from '../../main/lib/pty/PtyManager'

type TestSessionMap = Map<string, {
  pty: { write: ReturnType<typeof vi.fn> }
  sessionId: string
  projectPath: string
  status: 'Running'
  lastActivityAt: number
  heartbeatTimer: null
  timeoutTimer: ReturnType<typeof setTimeout> | null
}>

function getSessions(manager: PtyManager): TestSessionMap {
  return (manager as unknown as { sessions: TestSessionMap }).sessions
}

function installSession(manager: PtyManager, sessionId: string): ReturnType<typeof vi.fn> {
  const write = vi.fn()
  getSessions(manager).set(sessionId, {
    pty: { write },
    sessionId,
    projectPath: 'C:/test/project',
    status: 'Running',
    lastActivityAt: 0,
    heartbeatTimer: null,
    timeoutTimer: null,
  })
  return write
}

describe('PtyManager programmatic line input', () => {
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('writes text and Enter separately with the verified 50ms interval', async () => {
    vi.useFakeTimers()
    const manager = new PtyManager()
    const write = installSession(manager, 'session-1')

    manager.writeToSession('session-1', '制定首个目标')
    await vi.advanceTimersByTimeAsync(0)

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenNthCalledWith(1, '制定首个目标')

    await vi.advanceTimersByTimeAsync(49)
    expect(write).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(write).toHaveBeenNthCalledWith(2, '\r')
  })

  it('serializes multiple lines so their text and Enter cannot interleave', async () => {
    vi.useFakeTimers()
    const manager = new PtyManager()
    const write = installSession(manager, 'session-1')

    manager.writeToSession('session-1', 'first')
    manager.writeToSession('session-1', 'second')
    await vi.advanceTimersByTimeAsync(0)
    expect(write.mock.calls.map(([value]) => value)).toEqual(['first'])

    await vi.advanceTimersByTimeAsync(50)
    expect(write.mock.calls.map(([value]) => value)).toEqual(['first', '\r', 'second'])

    await vi.advanceTimersByTimeAsync(50)
    expect(write.mock.calls.map(([value]) => value)).toEqual(['first', '\r', 'second', '\r'])
  })

  it('does not send a delayed Enter after the Session disappears', async () => {
    vi.useFakeTimers()
    const manager = new PtyManager()
    const write = installSession(manager, 'session-1')

    manager.writeToSession('session-1', 'goal')
    await vi.advanceTimersByTimeAsync(0)
    getSessions(manager).delete('session-1')

    await vi.advanceTimersByTimeAsync(50)
    expect(write.mock.calls.map(([value]) => value)).toEqual(['goal'])
  })
})
