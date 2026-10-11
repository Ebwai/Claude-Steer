import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedAgentRuntime } from '../../main/lib/pty/ManagedAgentRuntime'
import { ManagedSessionCoordinator } from '../../main/lib/pty/ManagedSessionCoordinator'
import { JsonlWatcher } from '../../main/lib/jsonl/JsonlWatcher'
import type { PtyManager, PtyStartOptions } from '../../main/lib/pty/PtyManager'
import type { ManagedSession } from '../../shared/types/managedSession'
import type { JsonlRecord } from '../../shared/types/jsonl'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})
const makeRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steer-handoff-'))
  roots.push(root)
  return root
}
const user = (uuid: string, sessionId: string, text: string): string => JSON.stringify({
  type: 'user', uuid, sessionId, message: { role: 'user', content: text }
}) + '\n'

describe('managed transcript content handoff', () => {
  it('attaches content when the first transcript appears after identity binding and keeps reading later messages', async () => {
    const root = makeRoot()
    const configRoot = path.join(root, 'claude-config')
    const records: Array<{ record: JsonlRecord; sessionId: string }> = []
    const watcher = new JsonlWatcher({ onRecord: (record, sessionId) => records.push({ record, sessionId }), onError: error => { throw error } })
    const launches: PtyStartOptions[] = []
    const pty = { getActiveSessions: () => launches.map(item => item.sessionId), startSession: (options: PtyStartOptions) => launches.push(options) }
    const actions = {
      prepare: vi.fn(), data: vi.fn(), bind: vi.fn(), exit: vi.fn(), configRoot: () => configRoot,
      watchTranscript: vi.fn((session: ManagedSession, filePath: string) => {
        watcher.watchFile(filePath, session.confirmedClaudeId!, true, undefined, `managed:${session.launchId}`)
      })
    }
    const coordinator = new ManagedSessionCoordinator()
    const runtime = new ManagedAgentRuntime(coordinator, pty as unknown as PtyManager, actions)
    try {
      const session = runtime.start({ projectId: root, projectPath: root, permissionMode: 'acceptEdits' })
      const claudeId = session.expectedClaudeId!
      const filePath = path.join(configRoot, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), `${claudeId}.jsonl`)
      runtime.acceptHook({ session_id: claudeId, cwd: root, hook_event_name: 'SessionStart' }, launches[0].managedHookToken)
      expect(actions.bind).toHaveBeenCalledTimes(1)
      expect(actions.watchTranscript).not.toHaveBeenCalled()
      // Renderer subscribes before Claude creates even the encoded project directory.
      watcher.watchFile(filePath, claudeId, false, undefined, 'renderer')
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, user('input-1', claudeId, '1+1=') + JSON.stringify({
        type: 'assistant', uuid: 'reply-1', sessionId: claudeId,
        message: { role: 'assistant', content: [{ type: 'text', text: '2' }] }
      }) + '\n')
      await vi.waitFor(() => expect(actions.watchTranscript).toHaveBeenCalledTimes(1), { timeout: 5000 })
      await vi.waitFor(() => expect(records).toHaveLength(2))
      expect(records.map(item => [item.sessionId, item.record.text])).toEqual([[claudeId, '1+1='], [claudeId, '2']])
      expect(coordinator.getByAttempt(session.attemptId)?.transcriptState).toBe('ready')
      const nativeWatcher = (watcher as unknown as { watcher: { getWatched: () => Record<string, string[]> } }).watcher
      await vi.waitFor(() => expect(Object.values(nativeWatcher.getWatched()).flat()).toContain(path.basename(filePath)))
      fs.appendFileSync(filePath, user('input-2', claudeId, '2+2='))
      await vi.waitFor(() => expect(records).toHaveLength(3))
      expect(records[2].record.text).toBe('2+2=')
      watcher.unwatchSession(claudeId)
      expect(watcher.getResourceSnapshot().files).toBe(0)
      expect(watcher.getResourceSnapshot().consumers).toBe(0)
    } finally {
      runtime.dispose()
      await watcher.close()
    }
  })

  it('serializes catch-up reads and drains bytes appended while the first read is active', async () => {
    const root = makeRoot()
    const filePath = path.join(root, 'session.jsonl')
    const first = user('first', 'claude', '1+1=')
    fs.writeFileSync(filePath, first)
    const records: JsonlRecord[] = []
    const stream = new PassThrough()
    const read = vi.spyOn(fs, 'createReadStream').mockImplementationOnce(() => stream as unknown as fs.ReadStream)
    const watcher = new JsonlWatcher({ onRecord: record => records.push(record), onError: error => { throw error } })
    try {
      watcher.watchFile(filePath, 'claude', true)
      fs.appendFileSync(filePath, user('second', 'claude', '2+2='))
      const reader = watcher as unknown as { readNewContent: (file: string) => void }
      reader.readNewContent(filePath)
      reader.readNewContent(filePath)
      expect(read).toHaveBeenCalledTimes(1)
      stream.end(Buffer.from(first))
      await vi.waitFor(() => expect(records).toHaveLength(2))
      expect(records.map(record => record.uuid)).toEqual(['first', 'second'])
      expect(watcher.getResourceSnapshot().inFlightStreams).toBe(0)
    } finally { await watcher.close() }
  })
})
