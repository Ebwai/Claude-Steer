// 使用方法：由 main/lib/history 内部调用，不接受 renderer 提供的待删除绝对路径
// 编译说明：Electron main / Node.js
// 代码说明：Claude 项目目录编码、跨平台路径匹配与可信 Session bundle 构造

import fs from 'fs'
import os from 'os'
import path from 'path'

const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]+$/

export interface SessionBundlePaths {
  sessionId: string
  candidates: string[]
}

export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-')
}

export function resolveProjectDirectory(projectPath: string, homeDir = os.homedir()): string {
  return path.join(homeDir, '.claude', 'projects', encodeProjectPath(projectPath))
}

export function normalizeComparablePath(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function pathMatchesProject(cwd: string, projectPath: string): boolean {
  const normalizedCwd = normalizeComparablePath(cwd)
  const normalizedProject = normalizeComparablePath(projectPath)
  return normalizedCwd === normalizedProject || normalizedCwd.startsWith(`${normalizedProject}/`)
}

export function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw Object.assign(new Error(`Unsafe history session id: ${sessionId}`), {
      code: 'HISTORY_OUTSIDE_ROOT'
    })
  }
}

export function resolveSessionBundle(claudeDir: string, sessionId: string): SessionBundlePaths {
  assertSafeSessionId(sessionId)
  const base = path.resolve(claudeDir)
  const candidates = [
    path.join(base, `${sessionId}.jsonl`),
    path.join(base, `${sessionId}.meta.json`),
    path.join(base, `${sessionId}.insertions.jsonl`),
    path.join(base, `${sessionId}.milestones.jsonl`),
    path.join(base, `${sessionId}.git-marks.jsonl`),
    path.join(base, `${sessionId}.resources.jsonl`),
    path.join(base, sessionId)
  ]
  for (const candidate of candidates) assertPathInside(base, candidate)
  return { sessionId, candidates }
}

export function assertPathInside(rootDir: string, candidate: string): void {
  const root = path.resolve(rootDir)
  const resolved = path.resolve(candidate)
  const relative = path.relative(root, resolved)
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) return
  throw Object.assign(new Error(`History path escapes project directory: ${candidate}`), {
    code: 'HISTORY_OUTSIDE_ROOT'
  })
}

export function assertExistingPathSafe(rootDir: string, candidate: string): void {
  assertPathInside(rootDir, candidate)
  const stat = fs.lstatSync(candidate)
  if (stat.isSymbolicLink()) {
    throw Object.assign(
      new Error(`Symbolic link is not a valid history deletion target: ${candidate}`),
      {
        code: 'HISTORY_OUTSIDE_ROOT'
      }
    )
  }
  const realRoot = fs.realpathSync(rootDir)
  const realCandidate = fs.realpathSync(candidate)
  assertPathInside(realRoot, realCandidate)
}

export function resolveTrashDirectory(claudeDir: string): string {
  const trash = path.join(path.resolve(claudeDir), '.claude-steer-trash')
  assertPathInside(claudeDir, trash)
  return trash
}
