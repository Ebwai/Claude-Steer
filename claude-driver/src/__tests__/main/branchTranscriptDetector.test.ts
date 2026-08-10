// 使用方法：npm test -- src/__tests__/main/branchTranscriptDetector.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：验证 Hook 缺失时可用新 JSONL 的 forkedFrom 确认 Branch

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findNewBranchTranscript,
  snapshotTranscriptIds,
} from '../../main/lib/pty/BranchTranscriptDetector'

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-steer-branch-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  tempDirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }))
})

describe('BranchTranscriptDetector', () => {
  it('finds only a newly-created transcript whose forkedFrom points to the parent', () => {
    const dir = createTempDir()
    const parentId = '11111111-1111-1111-1111-111111111111'
    const unrelatedId = '22222222-2222-2222-2222-222222222222'
    const branchId = '33333333-3333-3333-3333-333333333333'
    fs.writeFileSync(path.join(dir, `${parentId}.jsonl`), '{}\n')
    fs.writeFileSync(path.join(dir, `${unrelatedId}.jsonl`), '{}\n')
    const known = snapshotTranscriptIds(dir)

    fs.writeFileSync(
      path.join(dir, `${branchId}.jsonl`),
      `${JSON.stringify({ sessionId: branchId, forkedFrom: { sessionId: parentId, messageUuid: 'm1' } })}\n`,
    )

    expect(findNewBranchTranscript(dir, parentId, known)).toEqual({
      sessionId: branchId,
      filePath: path.join(dir, `${branchId}.jsonl`),
    })
  })

  it('ignores new transcripts that do not descend from the requested parent', () => {
    const dir = createTempDir()
    const branchId = '44444444-4444-4444-4444-444444444444'
    fs.writeFileSync(
      path.join(dir, `${branchId}.jsonl`),
      `${JSON.stringify({ forkedFrom: { sessionId: 'different-parent' } })}\n`,
    )

    expect(findNewBranchTranscript(dir, 'expected-parent', new Set())).toBeNull()
  })
})
