// 使用方法：npm test -- src/__tests__/main/jsonlWatcherBranchStart.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：验证新旧 Claude Code Branch JSONL 都能产生唯一 isBranchStart

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlWatcher } from '../../main/lib/jsonl/JsonlWatcher'
import type { JsonlRecord } from '../../main/lib/jsonl/JsonlParser'

const tempDirs: string[] = []

function createTranscript(lines: Array<Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-steer-jsonl-watcher-'))
  tempDirs.push(dir)
  const filePath = path.join(dir, '11111111-1111-1111-1111-111111111111.jsonl')
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  return filePath
}

function user(uuid: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
    ...extra,
  }
}

async function readFromStart(filePath: string): Promise<JsonlRecord[]> {
  const records: JsonlRecord[] = []
  const watcher = new JsonlWatcher({
    onRecord: (record) => records.push(record),
    onError: (error) => { throw error },
  })
  watcher.watchFile(filePath, 'branch-session', true)
  await new Promise<void>((resolve) => setTimeout(resolve, 100))
  watcher.close()
  return records
}

afterEach(() => {
  tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))
})

describe('JsonlWatcher Branch start marking', () => {
  it('keeps shared watcher resources until the final consumer releases them', () => {
    const filePath = createTranscript([user('lease-user', 'lease prompt')])
    const watcher = new JsonlWatcher({
      onRecord: () => undefined,
      onError: (error) => { throw error },
    })

    watcher.watchFile(filePath, 'lease-session', false, undefined, 'timeline-a')
    watcher.watchFile(filePath, 'lease-session', false, undefined, 'timeline-b')
    expect(watcher.getResourceSnapshot()).toMatchObject({
      sessions: 1,
      files: 1,
      directories: 3,
      consumers: 2,
    })

    watcher.releaseSessionConsumer('lease-session', 'timeline-a')
    expect(watcher.getResourceSnapshot()).toMatchObject({ files: 1, directories: 3, consumers: 1 })

    watcher.releaseSessionConsumer('lease-session', 'timeline-b')
    expect(watcher.getResourceSnapshot()).toMatchObject({
      sessions: 0,
      files: 0,
      directories: 0,
      consumers: 0,
      inFlightStreams: 0,
    })
    watcher.close()
  })

  it('migrates pre-registered consumer ownership to the real session id without leaking directories', () => {
    const filePath = createTranscript([user('migration-user', 'migration prompt')])
    const watcher = new JsonlWatcher({
      onRecord: () => undefined,
      onError: (error) => { throw error },
    })

    watcher.watchFile(filePath, 'placeholder-session', false, undefined, 'timeline')
    watcher.watchFile(filePath, 'real-session', false, undefined, 'timeline')
    watcher.releaseSessionConsumer('real-session', 'timeline')

    expect(watcher.getResourceSnapshot()).toMatchObject({
      sessions: 0,
      files: 0,
      directories: 0,
      consumers: 0,
    })
    watcher.close()
  })

  it('backfills a transcript that is created after its path was pre-registered', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-steer-jsonl-watcher-late-'))
    tempDirs.push(dir)
    const filePath = path.join(dir, '22222222-2222-2222-2222-222222222222.jsonl')
    const received: Array<{ record: JsonlRecord; sessionId: string }> = []
    const watcher = new JsonlWatcher({
      onRecord: (record, sessionId) => received.push({ record, sessionId }),
      onError: (error) => { throw error },
    })

    watcher.watchFile(filePath, 'placeholder-session', false)
    fs.writeFileSync(filePath, `${JSON.stringify(user('late-user', 'first prompt'))}\n`)
    watcher.watchFile(filePath, 'real-session', true)

    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    watcher.close()

    expect(received.some(({ record, sessionId }) => (
      record.uuid === 'late-user' && sessionId === 'real-session'
    ))).toBe(true)
  })

  it('skips inherited forkedFrom history and marks the first Branch-local user', async () => {
    const forkedFrom = { sessionId: 'parent-session', messageUuid: 'parent-message' }
    const filePath = createTranscript([
      { type: 'attachment', uuid: 'attachment', forkedFrom },
      user('inherited-user', 'parent prompt', { forkedFrom }),
      { type: 'assistant', uuid: 'inherited-answer', message: { role: 'assistant', content: 'parent answer' }, forkedFrom },
      user('branch-user-1', 'first branch prompt'),
      { type: 'assistant', uuid: 'branch-answer', message: { role: 'assistant', content: 'answer' } },
      user('branch-user-2', 'second branch prompt'),
    ])

    const records = await readFromStart(filePath)
    expect(records.filter((record) => record.isBranchStart).map((record) => record.uuid))
      .toEqual(['branch-user-1'])
  })

  it('keeps a forked Branch empty until its first Branch-local user arrives', async () => {
    const forkedFrom = { sessionId: 'parent-session', messageUuid: 'parent-message' }
    const filePath = createTranscript([
      user('inherited-user', 'parent prompt', { forkedFrom }),
      { type: 'assistant', uuid: 'inherited-answer', message: { role: 'assistant', content: 'parent answer' }, forkedFrom },
    ])

    const records = await readFromStart(filePath)
    expect(records.some((record) => record.isBranchStart)).toBe(false)
  })

  it('keeps snapshot precedence when a legacy Branch contains inherited user history', async () => {
    const forkedFrom = { sessionId: 'parent-session', messageUuid: 'parent-message' }
    const filePath = createTranscript([
      user('inherited-user', 'parent history', { forkedFrom }),
      { type: 'file-history-snapshot', messageId: 'parent-message', forkedFrom },
      { type: 'attachment', uuid: 'metadata-between-snapshot-and-user', forkedFrom },
      user('branch-user', 'first branch prompt', { forkedFrom }),
    ])

    const records = await readFromStart(filePath)
    expect(records.filter((record) => record.isBranchStart).map((record) => record.uuid))
      .toEqual(['branch-user'])
  })
})
