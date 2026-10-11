import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TranscriptDiscovery, probeTranscriptIdentity } from '../../main/lib/pty/TranscriptDiscovery'

const id = '824f67b9-457d-423f-8698-c0a677a5d3aa'
const target = { projectKey: 'project', claudeId: id, filePath: `/project/${id}.jsonl` }
afterEach(() => vi.useRealTimers())

describe('TranscriptDiscovery', () => {
  it('survives the old ten-minute cutoff, deduplicates targets and releases all timers after ready', async () => {
    vi.useFakeTimers()
    let exists = false
    const probe = vi.fn(async () => exists ? 'ready' as const : 'waiting' as const)
    const discovery = new TranscriptDiscovery(probe)
    const a = vi.fn(), b = vi.fn()
    discovery.watch(target, new AbortController().signal, a)
    discovery.watch(target, new AbortController().signal, b)
    await vi.advanceTimersByTimeAsync(601_000)
    expect(a).not.toHaveBeenCalled()
    expect(discovery.activeTargets).toBe(1)
    expect(probe).toHaveBeenCalledTimes(602)
    exists = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(discovery.activeTargets).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('serializes slow checks and suppresses callbacks cancelled during an in-flight read', async () => {
    vi.useFakeTimers()
    let finish!: (result: 'ready') => void
    const probe = vi.fn(() => new Promise<'ready'>(resolve => { finish = resolve }))
    const discovery = new TranscriptDiscovery(probe)
    const controller = new AbortController()
    const ready = vi.fn()
    discovery.watch(target, controller.signal, ready)
    await vi.advanceTimersByTimeAsync(610_000)
    expect(probe).toHaveBeenCalledTimes(1)
    controller.abort()
    finish('ready')
    await vi.advanceTimersByTimeAsync(0)
    expect(ready).not.toHaveBeenCalled()
    expect(discovery.activeTargets).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers from filesystem errors and disposal cancels scheduled compensation', async () => {
    vi.useFakeTimers()
    const probe = vi.fn().mockRejectedValueOnce(Object.assign(new Error('unreadable'), { code: 'EACCES' })).mockResolvedValue('waiting')
    const discovery = new TranscriptDiscovery(probe)
    discovery.watch(target, new AbortController().signal, vi.fn())
    await vi.advanceTimersByTimeAsync(1000)
    expect(probe).toHaveBeenCalledTimes(2)
    discovery.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probe).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads actual late directory and partial JSONL without recognizing another session', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'steer-discovery-'))
    const filePath = path.join(directory, 'late', `${id}.jsonl`)
    const actual = { ...target, filePath }
    try {
      expect(await probeTranscriptIdentity(actual)).toBe('waiting')
      await mkdir(path.dirname(filePath))
      await writeFile(filePath, `{"sessionId":"${id}"`)
      expect(await probeTranscriptIdentity(actual)).toBe('waiting')
      await writeFile(filePath, JSON.stringify({ sessionId: id }) + '\n')
      expect(await probeTranscriptIdentity(actual)).toBe('ready')
      await writeFile(filePath, JSON.stringify({ sessionId: 'other' }) + '\n')
      expect(await probeTranscriptIdentity(actual)).toBe('conflict')
      const inherited = (JSON.stringify({ sessionId: 'parent', message: 'inherited' }) + '\n').repeat(2000)
      await writeFile(filePath, inherited + JSON.stringify({ sessionId: id }) + '\n')
      const cursor = { offset: 0, partial: '', dropping: false }
      let outcome = await probeTranscriptIdentity(actual, cursor)
      while (outcome !== 'ready' && cursor.offset < Buffer.byteLength(inherited) + 100) {
        const previousOffset = cursor.offset
        outcome = await probeTranscriptIdentity(actual, cursor)
        if (cursor.offset === previousOffset) break
      }
      expect(outcome).toBe('ready')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
