// 使用方法：/branch 预通知时 snapshotTranscriptIds，随后轮询 findNewBranchTranscript
// 编译说明：Electron 主进程 Node.js ESM
// 代码说明：以新 JSONL 的 forkedFrom 为权威事实，在 Hook 丢失时确认 Branch session

import fs from 'node:fs'
import path from 'node:path'

const UUID_JSONL = /^([0-9a-f-]{36})\.jsonl$/i
const HEADER_READ_BYTES = 64 * 1024

export interface BranchTranscriptCandidate {
  sessionId: string
  filePath: string
}

export function snapshotTranscriptIds(projectDir: string): Set<string> {
  try {
    return new Set(
      fs.readdirSync(projectDir)
        .map((name) => UUID_JSONL.exec(name)?.[1])
        .filter((sessionId): sessionId is string => sessionId !== undefined),
    )
  } catch (error) {
    console.warn(`[BranchTranscriptDetector] snapshot failed dir=${projectDir}`, error)
    return new Set()
  }
}

function readHeader(filePath: string): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const size = Math.min(fs.fstatSync(fd).size, HEADER_READ_BYTES)
    const buffer = Buffer.alloc(size)
    const bytesRead = fs.readSync(fd, buffer, 0, size, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    fs.closeSync(fd)
  }
}

export function findNewBranchTranscript(
  projectDir: string,
  parentSessionId: string,
  knownSessionIds: ReadonlySet<string>,
): BranchTranscriptCandidate | null {
  let names: string[]
  try {
    names = fs.readdirSync(projectDir)
  } catch (error) {
    console.warn(`[BranchTranscriptDetector] scan failed dir=${projectDir}`, error)
    return null
  }

  for (const name of names) {
    const sessionId = UUID_JSONL.exec(name)?.[1]
    if (!sessionId || sessionId === parentSessionId || knownSessionIds.has(sessionId)) continue
    const filePath = path.join(projectDir, name)
    try {
      const header = readHeader(filePath)
      for (const line of header.split(/\r?\n/)) {
        if (!line.includes('forkedFrom')) continue
        const record = JSON.parse(line) as { forkedFrom?: { sessionId?: string } }
        if (record.forkedFrom?.sessionId === parentSessionId) {
          return { sessionId, filePath }
        }
      }
    } catch (error) {
      // 文件可能仍在创建或首行尚未写完，下一轮继续检查。
      console.debug(`[BranchTranscriptDetector] candidate not ready file=${filePath}`, error)
    }
  }
  return null
}
