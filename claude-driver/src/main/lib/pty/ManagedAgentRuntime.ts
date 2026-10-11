import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { promises as fs, statSync } from 'node:fs'
import { normalizeComparablePath } from '../history/HistoryPaths'
import { ManagedSessionCoordinator } from './ManagedSessionCoordinator'
import { TranscriptDiscovery, probeTranscriptIdentity } from './TranscriptDiscovery'
import type { PtyManager } from './PtyManager'
import type { ManagedSession } from '../../../shared/types/managedSession'
import type { HookPayload, PermissionMode } from '../../../shared/types/index'

interface StartInput {
  launchId?: string
  projectId: string
  projectPath: string
  permissionMode: PermissionMode
  model?: string
  resumeSessionId?: string
}
interface RuntimeActions {
  prepare: (session: ManagedSession) => void
  data: (session: ManagedSession, data: string) => void
  exit: (session: ManagedSession, code: number) => void
  retire?: (session: ManagedSession, code: number) => void
  bind: (session: ManagedSession, transcriptPath: string) => void
  watchTranscript: (session: ManagedSession, transcriptPath: string) => void
  configRoot: () => string | undefined
}

/** Owns process attempts and discovery leases; adapters cannot independently claim a PTY. */
export class ManagedAgentRuntime {
  private readonly tokens = new Map<string, string>()
  private readonly discoveries = new Map<string, AbortController>()
  private readonly discovery = new TranscriptDiscovery()
  private disposed = false

  constructor(readonly coordinator: ManagedSessionCoordinator, private readonly pty: PtyManager, private readonly actions: RuntimeActions) {}

  start(input: StartInput): ManagedSession {
    const existing = input.resumeSessionId ? this.coordinator.getByClaude(input.resumeSessionId) : undefined
    if (existing && existing.terminalState !== 'exited') return existing
    const previousFrame = input.resumeSessionId ? this.coordinator.snapshot().sessions
      .filter(item => item.confirmedClaudeId === input.resumeSessionId).at(-1)?.frameId : undefined
    const session = this.coordinator.startManaged({
      launchId: input.launchId, projectId: input.projectId, cwd: input.projectPath,
      resumeClaudeId: input.resumeSessionId, frameId: previousFrame
    })
    if (session.terminalState !== 'exited' && !this.pty.getActiveSessions().includes(session.ptyId)) this.spawn(session, input)
    return this.coordinator.getByAttempt(session.attemptId) ?? session
  }

  private transcriptPath(session: ManagedSession): string | undefined {
    const id = session.confirmedClaudeId ?? session.expectedClaudeId
    if (!id) return undefined
    const root = this.actions.configRoot() || path.join(os.homedir(), '.claude')
    return path.join(root, 'projects', session.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
  }

  private spawn(session: ManagedSession, input: StartInput): void {
    const token = randomUUID()
    this.tokens.set(token, session.attemptId)
    let startupOutput = ''
    let startupError: ManagedSession['startupError'] = 'process-start-failed'
    const options = {
      sessionId: session.ptyId, projectPath: session.cwd, permissionMode: input.permissionMode,
      model: input.model, claudeSessionId: session.mode === 'primary' ? session.expectedClaudeId : undefined,
      managedHookToken: token,
      onData: (_ptyId: string, data: string): void => {
        const current = this.coordinator.getByAttempt(session.attemptId)
        if (!current) return
        if (!current.confirmedClaudeId && !current.inputWriteStarted && current.mode === 'primary') {
          // Bounded startup-only diagnostic buffer, never printed or persisted.
          startupOutput = (startupOutput + data).slice(-4096)
          this.coordinator.noteUnsupportedOption(session.attemptId, startupOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, ''))
        }
        this.actions.data(current, data)
      },
      onExit: (_ptyId: string, code: number): void => {
        this.tokens.delete(token)
        this.cancelDiscovery(session.attemptId)
        const current = this.coordinator.getByAttempt(session.attemptId)
        if (!current) return
        this.actions.retire?.(current, code)
        const retry = this.coordinator.onPtyExit(session.attemptId, session.ptyId, code)
        if (!retry) void this.finishExit(current, code)
        else void this.retryAfterFinalCheck(current, input, code)
      }
    }
    try {
      // cwd must be a usable directory; no history file is required for a new launch.
      let isDirectory: boolean
      try {
        isDirectory = statSync(session.cwd).isDirectory()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        startupError = code === 'ENOENT' ? 'project-directory-missing'
          : code === 'ENOTDIR' ? 'project-directory-invalid' : 'project-directory-unavailable'
        throw error
      }
      if (!isDirectory) {
        startupError = 'project-directory-invalid'
        throw new Error('Project path is not a directory')
      }
      this.actions.prepare(session)
      if (input.resumeSessionId) this.pty.resumeSession({ ...options, resumeSessionId: input.resumeSessionId })
      else this.pty.startSession(options)
      if (session.confirmedClaudeId) this.actions.bind(session, this.transcriptPath(session) ?? '')
      this.watch(session)
    } catch (error) {
      this.tokens.delete(token)
      this.cancelDiscovery(session.attemptId)
      console.error('[ManagedRuntime] startup failed', { launchId: session.launchId, ptyId: session.ptyId, cwd: session.cwd, startupError })
      this.coordinator.onPtyExit(session.attemptId, session.ptyId, 1, startupError)
      this.actions.exit(this.coordinator.getByAttempt(session.attemptId) ?? session, 1)
      throw error
    }
  }

  private async finishExit(session: ManagedSession, code: number): Promise<void> {
    const target = this.transcriptPath(session)
    try {
      if (!target) throw Object.assign(new Error('No transcript identity'), { code: 'ENOENT' })
      const file = await fs.open(target, 'r')
      const size = await file.stat().then(stat => stat.size).finally(() => file.close())
      let proven = Boolean(session.confirmedClaudeId)
      if (!proven && session.expectedClaudeId) {
        const cursor = { offset: 0, partial: '', dropping: false }
        while (!this.disposed && cursor.offset < size) {
          const before = cursor.offset
          const result = await probeTranscriptIdentity({ projectKey: path.dirname(target), filePath: target, claudeId: session.expectedClaudeId }, cursor)
          if (result === 'ready') { proven = true; break }
          if (cursor.offset === before) break
        }
      }
      if (proven) this.coordinator.finishTranscript(session.attemptId, 'ready', target, undefined, session.expectedClaudeId)
      else this.coordinator.finishTranscript(session.attemptId, 'unavailable', undefined, 'unconfirmed-transcript-at-exit')
    } catch (error) {
      const absent = (error as NodeJS.ErrnoException).code === 'ENOENT'
      this.coordinator.finishTranscript(session.attemptId, 'unavailable', undefined, absent ? 'no-transcript-at-exit' : 'transcript-unreadable-at-exit')
      if (!absent) console.error('[ManagedRuntime] final transcript check failed', { attemptId: session.attemptId, error })
    }
    this.actions.exit(this.coordinator.getByAttempt(session.attemptId) ?? session, code)
  }

  private async retryAfterFinalCheck(session: ManagedSession, input: StartInput, code: number): Promise<void> {
    let absent = false
    try {
      const target = this.transcriptPath(session)
      if (target) await fs.stat(target)
    } catch (error) {
      absent = (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
    if (this.disposed) return
    const next = this.coordinator.beginCompatibility(session.launchId, session.attemptId, absent)
    if (next) {
      console.info('[ManagedRuntime] compatibility retry', { launchId: next.launchId, attemptId: next.attemptId })
      try { this.spawn(next, input) } catch (error) { console.error('[ManagedRuntime] compatibility start failed', error) }
    } else this.actions.exit(session, code)
  }

  sourceSession(sourceToken: string): ManagedSession | undefined {
    const attempt = this.tokens.get(sourceToken)
    return attempt ? this.coordinator.getByAttempt(attempt) : undefined
  }

  /** Source token is supplied by HTTP headers and resolved against live Main-owned attempts. */
  acceptHook(payload: HookPayload, sourceToken?: string): ManagedSession | undefined {
    const sourcedAttempt = sourceToken ? this.tokens.get(sourceToken) : undefined
    if (sourceToken && !sourcedAttempt) return undefined
    const session = sourcedAttempt ? this.coordinator.getByAttempt(sourcedAttempt) : this.coordinator.getByClaude(payload.session_id)
    if (!session) return undefined
    if (normalizeComparablePath(payload.cwd) !== normalizeComparablePath(session.cwd)) return undefined
    if (!this.coordinator.acceptEvidence({
      attemptId: session.attemptId, bindingGeneration: session.bindingGeneration,
      claudeId: payload.session_id, source: sourcedAttempt ? 'correlated-hook' : 'hook'
    })) return undefined
    const current = this.coordinator.getByAttempt(session.attemptId)!
    const target = this.transcriptPath(current)
    if (target && !session.confirmedClaudeId) this.actions.bind(current, target)
    this.watch(current)
    return current
  }

  private watch(session: ManagedSession): void {
    const filePath = this.transcriptPath(session)
    if (!filePath || session.transcriptState === 'ready' || this.discoveries.has(session.attemptId)) return
    const controller = new AbortController()
    this.discoveries.set(session.attemptId, controller)
    this.discovery.watch({ projectKey: path.dirname(filePath), claudeId: session.confirmedClaudeId ?? session.expectedClaudeId!, filePath }, controller.signal, (target) => {
      this.discoveries.delete(session.attemptId)
      if (this.coordinator.acceptEvidence({ attemptId: session.attemptId, bindingGeneration: session.bindingGeneration, claudeId: target.claudeId, source: 'exact-file', transcriptPath: target.filePath })) {
        const current = this.coordinator.getByAttempt(session.attemptId)!
        this.actions.bind(current, target.filePath)
        // Identity binding alone cannot recover a Windows watch registered before the directory existed.
        console.info('[ManagedRuntime] transcript ready; attaching content watch', { attemptId: current.attemptId, claudeId: target.claudeId, filePath: target.filePath })
        this.actions.watchTranscript(current, target.filePath)
      }
    })
  }

  confirmBranch(ptyId: string, parentId: string, childId: string): boolean {
    const current = this.coordinator.getByPty(ptyId)
    if (!current) return false
    const child = this.coordinator.confirmBranch(current.attemptId, parentId, childId)
    if (!child) return false
    this.cancelDiscovery(child.attemptId)
    this.actions.bind(child, this.transcriptPath(child) ?? '')
    this.watch(child)
    return true
  }

  cancel(ptyId: string): void {
    const session = this.coordinator.getByPty(ptyId)
    if (!session) return
    this.coordinator.cancelManaged(session.launchId)
    this.cancelDiscovery(session.attemptId)
  }

  private cancelDiscovery(attemptId: string): void {
    this.discoveries.get(attemptId)?.abort()
    this.discoveries.delete(attemptId)
  }

  dispose(): void {
    this.disposed = true
    for (const session of this.coordinator.snapshot().sessions) this.cancel(session.ptyId)
    this.tokens.clear()
    this.discovery.dispose()
  }
}
