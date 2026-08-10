// 使用方法：HistoryService.deleteTarget 委托 deleteHistoryTarget
// 编译说明：Electron main / Node.js
// 代码说明：主进程权威计算删除集合；同卷 rename 暂存、失败回滚、崩溃恢复

import fs from 'fs'
import path from 'path'
import type { HistoryDeleteInput, HistoryErrorCode } from '../../../shared/types/history'
import type { HistoryCatalogSnapshot } from './HistoryCatalog'
import {
  assertExistingPathSafe,
  assertPathInside,
  resolveSessionBundle,
  resolveTrashDirectory,
} from './HistoryPaths'

interface TransactionMove {
  source: string
  destination: string
  state: 'pending' | 'moved' | 'rolled-back'
}

interface TransactionManifest {
  operationId: string
  projectPath: string
  claudeDir: string
  scope: 'cluster' | 'branch'
  targetSessionId: string
  sessionIds: string[]
  moves: TransactionMove[]
  phase: 'preparing' | 'committed'
}

export interface HistoryDeletionDeps {
  isSessionRunning: (sessionId: string) => boolean
  unwatchSession: (sessionId: string) => void
}

export interface HistoryDeletionSuccess {
  ok: true
  deletedSessionIds: string[]
  orphanedSessionIds: string[]
  cleanupPending: boolean
  alreadyDeleted?: boolean
}

export interface HistoryDeletionFailure {
  ok: false
  errorCode: HistoryErrorCode
  error: string
}

function errorCode(error: unknown): HistoryErrorCode {
  const code = (error as { code?: string }).code
  if (code === 'HISTORY_OUTSIDE_ROOT') return 'HISTORY_OUTSIDE_ROOT'
  if (code === 'HISTORY_ROLLBACK_FAILED') return 'HISTORY_ROLLBACK_FAILED'
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return 'HISTORY_IO_LOCKED'
  return 'HISTORY_IO_ERROR'
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath)
    return true
  } catch {
    return false
  }
}

async function writeManifest(filePath: string, manifest: TransactionManifest): Promise<void> {
  const tempPath = `${filePath}.tmp`
  await fs.promises.writeFile(tempPath, JSON.stringify(manifest, null, 2), 'utf8')
  await fs.promises.rename(tempPath, filePath)
}

function descendantsOf(snapshot: HistoryCatalogSnapshot, rootSessionId: string): string[] {
  const result: string[] = []
  const queue = [rootSessionId]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    result.push(current)
    queue.push(...(snapshot.childrenByParentId.get(current) ?? []))
  }
  return result
}

async function rollbackMoves(manifest: TransactionManifest, manifestPath: string): Promise<void> {
  const moved = manifest.moves.filter((move) => move.state === 'moved').reverse()
  for (const move of moved) {
    if (!(await pathExists(move.destination))) continue
    await fs.promises.mkdir(path.dirname(move.source), { recursive: true })
    await fs.promises.rename(move.destination, move.source)
    move.state = 'rolled-back'
    await writeManifest(manifestPath, manifest)
  }
}

function comparable(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function validateRecoveryManifest(
  manifest: TransactionManifest,
  claudeDir: string,
  operationId: string,
  operationDir: string,
): void {
  if (
    manifest.operationId !== operationId ||
    comparable(manifest.claudeDir) !== comparable(claudeDir)
  ) {
    throw Object.assign(new Error('History deletion recovery manifest identity mismatch.'), {
      code: 'HISTORY_OUTSIDE_ROOT',
    })
  }
  const allowedSources = new Set(
    manifest.sessionIds.flatMap((sessionId) =>
      resolveSessionBundle(claudeDir, sessionId).candidates.map(comparable),
    ),
  )
  for (const move of manifest.moves) {
    assertPathInside(claudeDir, move.source)
    assertPathInside(operationDir, move.destination)
    if (!allowedSources.has(comparable(move.source))) {
      throw Object.assign(new Error(`Unexpected recovery source path: ${move.source}`), {
        code: 'HISTORY_OUTSIDE_ROOT',
      })
    }
  }
}

export async function recoverHistoryDeleteTransactions(claudeDir: string): Promise<void> {
  const trashDir = resolveTrashDirectory(claudeDir)
  let operationIds: string[]
  try {
    operationIds = await fs.promises.readdir(trashDir)
  } catch {
    return
  }
  for (const operationId of operationIds) {
    const operationDir = path.join(trashDir, operationId)
    const manifestPath = path.join(operationDir, 'manifest.json')
    try {
      assertPathInside(trashDir, operationDir)
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as TransactionManifest
      validateRecoveryManifest(manifest, claudeDir, operationId, operationDir)
      if (manifest.phase === 'committed') {
        await fs.promises.rm(operationDir, { recursive: true, force: true })
        console.info(`[HistoryDelete] recovered committed cleanup operation=${operationId}`)
      } else {
        await rollbackMoves(manifest, manifestPath)
        await fs.promises.rm(operationDir, { recursive: true, force: true })
        console.warn(`[HistoryDelete] recovered preparing transaction operation=${operationId}`)
      }
    } catch (error) {
      console.error(`[HistoryDelete] recovery failed operation=${operationId}:`, error)
    }
  }
}

export async function deleteHistoryTarget(
  snapshot: HistoryCatalogSnapshot,
  input: HistoryDeleteInput,
  deps: HistoryDeletionDeps,
): Promise<HistoryDeletionSuccess | HistoryDeletionFailure> {
  const target = snapshot.entriesById.get(input.targetSessionId)
  if (!target) {
    return { ok: true, deletedSessionIds: [input.targetSessionId], orphanedSessionIds: [], cleanupPending: false, alreadyDeleted: true }
  }

  // 主线删除完整 Cluster；Branch 删除以该 Branch 为根的完整后代闭包。
  // 两种范围都不留下指向已删除父节点的孤儿 Branch。
  const sessionIds = descendantsOf(
    snapshot,
    input.scope === 'cluster' ? target.clusterId : target.sessionId,
  )
  const orphanedSessionIds: string[] = []

  const running = sessionIds.find((sessionId) => deps.isSessionRunning(sessionId))
  if (running) {
    console.warn(`[HistoryDelete] rejected running session=${running.slice(0, 8)} operation=${input.operationId}`)
    return { ok: false, errorCode: 'HISTORY_SESSION_RUNNING', error: 'A selected session is still running.' }
  }

  const trashDir = resolveTrashDirectory(snapshot.claudeDir)
  const operationDir = path.join(trashDir, input.operationId)
  const payloadDir = path.join(operationDir, 'payload')
  const manifestPath = path.join(operationDir, 'manifest.json')
  try {
    assertPathInside(trashDir, operationDir)
    if (await pathExists(operationDir)) {
      return { ok: false, errorCode: 'HISTORY_IO_ERROR', error: 'Duplicate history deletion operation.' }
    }

    const moves: TransactionMove[] = []
    for (const sessionId of sessionIds) {
      const bundle = resolveSessionBundle(snapshot.claudeDir, sessionId)
      for (const source of bundle.candidates) {
        if (!(await pathExists(source))) continue
        assertExistingPathSafe(snapshot.claudeDir, source)
        const destination = path.join(payloadDir, path.basename(source))
        assertPathInside(operationDir, destination)
        moves.push({ source, destination, state: 'pending' })
      }
    }
    if (moves.length === 0) {
      return { ok: true, deletedSessionIds: sessionIds, orphanedSessionIds, cleanupPending: false, alreadyDeleted: true }
    }

    await fs.promises.mkdir(payloadDir, { recursive: true })
    const manifest: TransactionManifest = {
      operationId: input.operationId,
      projectPath: snapshot.projectPath,
      claudeDir: snapshot.claudeDir,
      scope: input.scope,
      targetSessionId: input.targetSessionId,
      sessionIds,
      moves,
      phase: 'preparing',
    }
    await writeManifest(manifestPath, manifest)
    sessionIds.forEach((sessionId) => deps.unwatchSession(sessionId))

    try {
      for (const move of moves) {
        await fs.promises.rename(move.source, move.destination)
        move.state = 'moved'
        await writeManifest(manifestPath, manifest)
        console.info(`[HistoryDelete] moved operation=${input.operationId} item=${path.basename(move.source)}`)
      }
    } catch (moveError) {
      console.error(`[HistoryDelete] move failed operation=${input.operationId}, starting rollback:`, moveError)
      try {
        await rollbackMoves(manifest, manifestPath)
        await fs.promises.rm(operationDir, { recursive: true, force: true })
      } catch (rollbackError) {
        console.error(`[HistoryDelete] rollback failed operation=${input.operationId}:`, rollbackError)
        return { ok: false, errorCode: 'HISTORY_ROLLBACK_FAILED', error: String(rollbackError) }
      }
      return { ok: false, errorCode: errorCode(moveError), error: String(moveError) }
    }

    manifest.phase = 'committed'
    await writeManifest(manifestPath, manifest)
    let cleanupPending = false
    try {
      await fs.promises.rm(operationDir, { recursive: true, force: true })
    } catch (cleanupError) {
      cleanupPending = true
      console.error(`[HistoryDelete] committed cleanup pending operation=${input.operationId}:`, cleanupError)
    }
    console.info(`[HistoryDelete] committed operation=${input.operationId} scope=${input.scope} sessions=${sessionIds.length} cleanupPending=${cleanupPending}`)
    return { ok: true, deletedSessionIds: sessionIds, orphanedSessionIds, cleanupPending }
  } catch (error) {
    console.error(`[HistoryDelete] validation failed operation=${input.operationId}:`, error)
    return { ok: false, errorCode: errorCode(error), error: String(error) }
  }
}
