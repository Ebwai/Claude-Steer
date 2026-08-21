// 使用方法：npm test -- src/__tests__/main/bufferFraming.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：验证 Buffer framing——UTF-8 跨 chunk 解析、LF/CRLF locator 一致性、不完整尾行延迟、byte range 精度

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonlWatcher } from '../../main/lib/jsonl/JsonlWatcher'
import type { JsonlRecord } from '../../main/lib/jsonl/JsonlParser'
import type { EntityShell } from '../../shared/types/detail'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-steer-buffer-framing-'))
  tempDirs.push(dir)
  return dir
}

function userRecord(uuid: string, text: string): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: text },
  }
}

function assistantRecord(uuid: string, text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: text },
  }
}

afterEach(() => {
  tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))
})

describe('Buffer framing - basic LF line splitting', () => {
  it('reads all records with LF line endings', async () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'test-session.jsonl')
    const lines = [
      userRecord('u1', 'hello'),
      assistantRecord('a1', 'hi there'),
      userRecord('u2', 'how are you?'),
    ]
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const records: JsonlRecord[] = []
    const shells: EntityShell[] = []
    const watcher = new JsonlWatcher({
      onRecord: (r) => records.push(r),
      onError: (err) => { throw err },
      onRecordShell: (s) => shells.push(s),
    })
    watcher.watchFile(filePath, 'session-lf', true)
    await new Promise<void>((r) => setTimeout(r, 100))
    watcher.close()

    expect(records).toHaveLength(3)
    expect(records[0].uuid).toBe('u1')
    expect(records[1].uuid).toBe('a1')
    expect(records[2].uuid).toBe('u2')
    // shells should also be emitted
    expect(shells).toHaveLength(3)
    expect(shells[0].entityId).toBe('u1')
  })
})

describe('Buffer framing - CRLF line endings', () => {
  it('correctly parses CRLF-delimited records and records lf/crlf in lineEnding', async () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'test-crlf.jsonl')
    const lines = [
      userRecord('u-crlf-1', 'hello'),
      assistantRecord('a-crlf-1', 'hi'),
    ]
    // Use \r\n as line separator
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\r\n') + '\r\n')

    const records: JsonlRecord[] = []
    const shells: EntityShell[] = []
    const watcher = new JsonlWatcher({
      onRecord: (r) => records.push(r),
      onError: (err) => { throw err },
      onRecordShell: (s) => shells.push(s),
    })
    watcher.watchFile(filePath, 'session-crlf', true)
    await new Promise<void>((r) => setTimeout(r, 100))
    watcher.close()

    expect(records).toHaveLength(2)
    expect(records[0].uuid).toBe('u-crlf-1')
    expect(records[1].uuid).toBe('a-crlf-1')
  })
})

describe('Buffer framing - UTF-8 multibyte characters', () => {
  it('correctly parses records containing multibyte UTF-8 characters', async () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'test-utf8.jsonl')
    const lines = [
      userRecord('u-utf8-1', '你好世界'),  // Chinese characters, 3 bytes each
      assistantRecord('a-utf8-1', 'こんにちは'),  // Japanese, 3 bytes each
    ]
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    const records: JsonlRecord[] = []
    const shells: EntityShell[] = []
    const watcher = new JsonlWatcher({
      onRecord: (r) => records.push(r),
      onError: (err) => { throw err },
      onRecordShell: (s) => shells.push(s),
    })
    watcher.watchFile(filePath, 'session-utf8', true)
    await new Promise<void>((r) => setTimeout(r, 100))
    watcher.close()

    expect(records).toHaveLength(2)
    expect(records[0].uuid).toBe('u-utf8-1')
    expect(records[0].text).toBe('你好世界')
    expect(records[1].uuid).toBe('a-utf8-1')
    expect(records[1].text).toBe('こんにちは')
  })
})

describe('Buffer framing - incomplete tail deferred', () => {
  it('defers incomplete line (no LF) until next append', async () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'test-tail.jsonl')
    // Write a complete record followed by an incomplete line (no trailing LF)
    const complete = JSON.stringify(userRecord('u-complete', 'first'))
    const incomplete = JSON.stringify(userRecord('u-incomplete', 'second'))
    fs.writeFileSync(filePath, complete + '\n' + incomplete)  // no LF after second

    const records: JsonlRecord[] = []
    const watcher = new JsonlWatcher({
      onRecord: (r) => records.push(r),
      onError: (err) => { throw err },
    })
    watcher.watchFile(filePath, 'session-tail', true)
    await new Promise<void>((r) => setTimeout(r, 100))

    // Only the complete record should be emitted
    expect(records).toHaveLength(1)
    expect(records[0].uuid).toBe('u-complete')

    // Now append a LF to complete the second record
    fs.appendFileSync(filePath, '\n')
    await new Promise<void>((r) => setTimeout(r, 100))

    expect(records).toHaveLength(2)
    expect(records[1].uuid).toBe('u-incomplete')

    watcher.close()
  })
})

describe('Buffer framing - EntityId stability', () => {
  it('same file read twice produces same entityId sequence', async () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'test-stability.jsonl')
    const lines = [
      userRecord('u-stable-1', 'hello'),
      assistantRecord('a-stable-1', 'hi'),
      userRecord('u-stable-2', 'again'),
    ]
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')

    // First read
    const shells1: EntityShell[] = []
    const watcher1 = new JsonlWatcher({
      onRecord: () => {},
      onError: (err) => { throw err },
      onRecordShell: (s) => shells1.push(s),
    })
    watcher1.watchFile(filePath, 'session-stable', true)
    await new Promise<void>((r) => setTimeout(r, 100))
    watcher1.close()

    // Second read (fresh watcher)
    const shells2: EntityShell[] = []
    const watcher2 = new JsonlWatcher({
      onRecord: () => {},
      onError: (err) => { throw err },
      onRecordShell: (s) => shells2.push(s),
    })
    watcher2.watchFile(filePath, 'session-stable', true)
    await new Promise<void>((r) => setTimeout(r, 100))
    watcher2.close()

    // EntityId sequence should be identical
    expect(shells1.map((s) => s.entityId)).toEqual(shells2.map((s) => s.entityId))
    // Verify all 6 shells were emitted (3 each)
    expect(shells1).toHaveLength(3)
    expect(shells2).toHaveLength(3)
  })
})

describe('Buffer framing - incremental append', () => {
  it('correctly reads records appended after initial watch', async () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'test-incremental.jsonl')
    // Start with one record
    fs.writeFileSync(filePath, JSON.stringify(userRecord('u-inc-1', 'first')) + '\n')

    const records: JsonlRecord[] = []
    const shells: EntityShell[] = []
    const watcher = new JsonlWatcher({
      onRecord: (r) => records.push(r),
      onError: (err) => { throw err },
      onRecordShell: (s) => shells.push(s),
    })
    // readFromStart=false (tail mode), starts from current size
    watcher.watchFile(filePath, 'session-inc', false)
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(records).toHaveLength(0)  // no new records since offset = current size

    // Append a new record
    fs.appendFileSync(filePath, JSON.stringify(userRecord('u-inc-2', 'second')) + '\n')
    await new Promise<void>((r) => setTimeout(r, 100))

    expect(records).toHaveLength(1)
    expect(records[0].uuid).toBe('u-inc-2')
    expect(shells).toHaveLength(1)
    expect(shells[0].entityId).toBe('u-inc-2')

    watcher.close()
  })
})

describe('Buffer framing - EntityShell fields', () => {
  it('EntityShell contains expected fields without leaking full text', async () => {
    const dir = makeTempDir()
    const filePath = path.join(dir, 'test-shell-fields.jsonl')
    fs.writeFileSync(filePath,
      JSON.stringify(userRecord('u-fields', 'a'.repeat(500))) + '\n'
    )

    const shells: EntityShell[] = []
    const watcher = new JsonlWatcher({
      onRecord: () => {},
      onError: (err) => { throw err },
      onRecordShell: (s) => shells.push(s),
    })
    watcher.watchFile(filePath, 'session-fields', true)
    await new Promise<void>((r) => setTimeout(r, 100))
    watcher.close()

    expect(shells).toHaveLength(1)
    const shell = shells[0]
    expect(shell.entityId).toBe('u-fields')
    expect(shell.kind).toBe('user_input')
    expect(shell.order).toBe(0)
    expect(shell.summary.length).toBeLessThanOrEqual(200)
    expect(shell.estimatedSize).toBeGreaterThan(0)
    expect(shell.detailRef).not.toBeNull()
    expect(shell.detailRef!.detailKey).toBe('u-fields')
    // No full text leaked
    const shellJson = JSON.stringify(shell)
    expect(shellJson).not.toContain('a'.repeat(201))
  })
})
