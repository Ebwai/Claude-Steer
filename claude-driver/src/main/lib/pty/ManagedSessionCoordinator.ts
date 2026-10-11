// Main owns identity decisions. Reserving a UUID never marks the terminal ready.
import { randomUUID } from 'node:crypto'
import type { ManagedChange, ManagedSession, ManagedSnapshot } from '../../../shared/types/managedSession'

export interface BindingEvidence {
  attemptId: string
  bindingGeneration: number
  claudeId: string
  source: 'hook' | 'exact-file' | 'correlated-hook'
  transcriptPath?: string
}

export class ManagedSessionCoordinator {
  private readonly instanceId = randomUUID()
  private revision = 0
  private readonly sessions = new Map<string, ManagedSession>()
  private readonly attempts = new Map<string, string>()
  private readonly expected = new Map<string, string>()
  private readonly confirmed = new Map<string, string>()
  private readonly rejectedOptions = new Set<string>()
  private readonly identityLeases = new Map<string, () => void>()

  constructor(private readonly publish: (change: ManagedChange) => void = () => {}) {}

  startManaged(input: { projectId: string; cwd: string; launchId?: string; frameId?: string; resumeClaudeId?: string }): ManagedSession {
    const launchId = input.launchId ?? randomUUID()
    const previous = this.sessions.get(launchId)
    if (previous) return { ...previous }
    const claudeId = input.resumeClaudeId ?? randomUUID()
    if (this.expected.has(claudeId) || this.confirmed.has(claudeId)) throw new Error('SESSION_ALREADY_MANAGED')
    const session: ManagedSession = {
      launchId, frameId: input.frameId ?? claudeId,
      attemptId: randomUUID(), ptyId: randomUUID(), projectId: input.projectId, cwd: input.cwd,
      expectedClaudeId: claudeId, confirmedClaudeId: input.resumeClaudeId,
      mode: input.resumeClaudeId ? 'resume' : 'primary',
      identityState: input.resumeClaudeId ? 'confirmed' : 'expected',
      transcriptState: 'waiting', terminalState: 'starting', lifecycle: 'starting',
      inputWriteStarted: false, compatibilityTried: false, bindingGeneration: 0, revision: 0, startedAt: Date.now()
    }
    this.sessions.set(launchId, session)
    this.attempts.set(session.attemptId, launchId)
    this.expected.set(claudeId, launchId)
    if (input.resumeClaudeId) this.confirmed.set(claudeId, launchId)
    this.emit(session, 'reserved')
    return { ...session }
  }

  snapshot(): ManagedSnapshot {
    return { instanceId: this.instanceId, revision: this.revision, sessions: [...this.sessions.values()].map(s => ({ ...s })) }
  }

  getByAttempt(attemptId: string): ManagedSession | undefined {
    const session = this.current(attemptId)
    return session ? { ...session } : undefined
  }

  getByClaude(claudeId: string): ManagedSession | undefined {
    const launchId = this.confirmed.get(claudeId) ?? this.expected.get(claudeId)
    const session = launchId ? this.sessions.get(launchId) : undefined
    return session ? { ...session } : undefined
  }

  getByPty(ptyId: string): ManagedSession | undefined {
    const session = [...this.sessions.values()].find(s => s.ptyId === ptyId)
    return session ? { ...session } : undefined
  }

  acceptEvidence(evidence: BindingEvidence): boolean {
    const session = this.current(evidence.attemptId)
    if (!session || !this.live(session) || session.bindingGeneration !== evidence.bindingGeneration) {
      return this.reject(evidence, 'stale-or-ended')
    }
    if (session.confirmedClaudeId && session.confirmedClaudeId !== evidence.claudeId) return this.reject(evidence, 'confirmed-id-conflict')
    if (session.expectedClaudeId && session.expectedClaudeId !== evidence.claudeId) return this.reject(evidence, 'expected-id-conflict')
    if (!session.confirmedClaudeId && session.mode === 'compatibility' && evidence.source !== 'correlated-hook') {
      return this.reject(evidence, 'compatibility-requires-source')
    }
    const owner = this.confirmed.get(evidence.claudeId) ?? this.expected.get(evidence.claudeId)
    if (owner && owner !== session.launchId) return this.reject(evidence, 'identity-already-owned')
    const changed = session.confirmedClaudeId !== evidence.claudeId ||
      (evidence.transcriptPath !== undefined && evidence.transcriptPath !== session.transcriptPath) ||
      (evidence.source === 'exact-file' && session.transcriptState !== 'ready')
    session.confirmedClaudeId = evidence.claudeId
    session.identityState = 'confirmed'
    session.lifecycle = 'active'
    if (evidence.transcriptPath) session.transcriptPath = evidence.transcriptPath
    if (evidence.source === 'exact-file') session.transcriptState = 'ready'
    this.confirmed.set(evidence.claudeId, session.launchId)
    this.releaseIdentityLease(session.attemptId)
    this.rejectedOptions.delete(session.attemptId)
    if (changed) this.emit(session, `confirmed:${evidence.source}`)
    return true
  }

  /** Only compatibility may invoke old candidate adapters; primary success never starts them. */
  startIdentityFallback(attemptId: string, start: () => () => void): boolean {
    const session = this.current(attemptId)
    if (!session || !this.live(session) || session.mode !== 'compatibility' || session.confirmedClaudeId || this.identityLeases.has(attemptId)) return false
    const dispose = start()
    // The adapter can synchronously confirm or cancel while starting.
    if (this.current(attemptId) !== session || !this.live(session) || session.confirmedClaudeId) dispose()
    else this.identityLeases.set(attemptId, dispose)
    return true
  }

  observeInputWrite(attemptId: string, ptyId: string): void {
    const session = this.current(attemptId)
    if (!session || session.ptyId !== ptyId || !this.live(session)) throw new Error('STALE_ATTEMPT')
    if (!session.inputWriteStarted) {
      session.inputWriteStarted = true
      this.rejectedOptions.delete(attemptId)
      this.emit(session, 'input-write-started')
    }
  }

  markTerminalReady(attemptId: string): void {
    const session = this.current(attemptId)
    if (!session || !this.live(session) || session.terminalState === 'ready') return
    session.terminalState = 'ready'
    this.rejectedOptions.delete(attemptId)
    this.emit(session, 'terminal-ready')
  }

  /** Caller supplies an observed startup parser diagnostic, never ordinary model output. */
  noteUnsupportedOption(attemptId: string, diagnostic: string): boolean {
    const session = this.current(attemptId)
    if (!session || !this.live(session) || session.mode !== 'primary' || session.confirmedClaudeId || session.inputWriteStarted) return false
    if (session.terminalState === 'ready' || !/^error: unknown option ['"]--session-id['"]\s*$/.test(diagnostic.trim())) return false
    this.rejectedOptions.add(attemptId)
    this.emit(session, 'session-id-option-rejected')
    return true
  }

  onPtyExit(attemptId: string, ptyId: string, exitCode: number): boolean {
    const session = this.current(attemptId)
    if (!session || session.ptyId !== ptyId || session.terminalState === 'exited') return false
    const retry = this.live(session) && session.mode === 'primary' && !session.compatibilityTried &&
      !session.confirmedClaudeId && !session.inputWriteStarted && exitCode !== 0 && this.rejectedOptions.has(attemptId)
    session.terminalState = 'exited'
    session.lifecycle = session.lifecycle === 'cancelled' ? 'cancelled' : retry ? 'retry-pending' : exitCode === 0 ? 'ended' : 'failed'
    this.releaseIdentityLease(attemptId)
    this.releaseIndexes(session)
    this.emit(session, retry ? 'awaiting-final-evidence-check' : `pty-exited:${exitCode}`)
    return retry
  }

  /** Required final evidence check is supplied by the process/filesystem adapter. */
  beginCompatibility(launchId: string, previousAttemptId: string, noSessionCreated: boolean): ManagedSession | undefined {
    const session = this.sessions.get(launchId)
    if (!session || session.attemptId !== previousAttemptId || session.lifecycle !== 'retry-pending' || session.compatibilityTried) return undefined
    if (!noSessionCreated) {
      session.lifecycle = 'failed'
      this.emit(session, 'compatibility-blocked-by-session-evidence')
      return undefined
    }
    this.attempts.delete(previousAttemptId)
    this.rejectedOptions.delete(previousAttemptId)
    session.attemptId = randomUUID()
    session.ptyId = randomUUID()
    session.expectedClaudeId = undefined
    session.mode = 'compatibility'
    session.compatibilityTried = true
    session.terminalState = 'starting'
    session.lifecycle = 'starting'
    this.attempts.set(session.attemptId, launchId)
    this.emit(session, 'compatibility-start')
    return { ...session }
  }

  cancelManaged(launchId: string): void {
    const session = this.sessions.get(launchId)
    if (!session || ['cancelled', 'ended', 'failed'].includes(session.lifecycle)) return
    session.lifecycle = 'cancelled'
    this.releaseIdentityLease(session.attemptId)
    this.releaseIndexes(session)
    this.emit(session, 'cancelled')
  }

  /** Explicit parent/child proof is checked by the Branch adapter before this transition. */
  confirmBranch(attemptId: string, parentClaudeId: string, childClaudeId: string): ManagedSession | undefined {
    const session = this.current(attemptId)
    if (!session || !this.live(session) || session.confirmedClaudeId !== parentClaudeId || parentClaudeId === childClaudeId) return undefined
    const owner = this.confirmed.get(childClaudeId) ?? this.expected.get(childClaudeId)
    if (owner && owner !== session.launchId) return undefined
    this.releaseIndexes(session)
    this.releaseIdentityLease(attemptId)
    session.bindingGeneration++
    session.mode = 'branch'
    session.frameId = childClaudeId
    session.startedAt = Date.now()
    session.expectedClaudeId = childClaudeId
    session.confirmedClaudeId = childClaudeId
    session.transcriptPath = undefined
    session.transcriptState = 'waiting'
    session.identityState = 'confirmed'
    this.expected.set(childClaudeId, session.launchId)
    this.confirmed.set(childClaudeId, session.launchId)
    this.emit(session, 'branch-confirmed')
    return { ...session }
  }

  finishTranscript(attemptId: string, state: 'ready' | 'unavailable', filePath?: string, reason?: string, provenClaudeId?: string): void {
    const session = this.current(attemptId)
    if (!session || session.terminalState !== 'exited' || session.lifecycle === 'retry-pending') return
    if (provenClaudeId && provenClaudeId === session.expectedClaudeId) {
      session.confirmedClaudeId = provenClaudeId
      session.identityState = 'confirmed'
    }
    session.transcriptState = state
    if (state === 'ready' && filePath) session.transcriptPath = filePath
    this.emit(session, reason ?? `final-transcript:${state}`)
  }

  /** Renderer may release ended shells; live records cannot be evicted. */
  releaseEnded(launchId: string): boolean {
    const session = this.sessions.get(launchId)
    if (!session || session.terminalState !== 'exited' || session.lifecycle === 'retry-pending' || session.transcriptState === 'waiting') return false
    this.releaseIndexes(session)
    this.releaseIdentityLease(session.attemptId)
    this.rejectedOptions.delete(session.attemptId)
    this.attempts.delete(session.attemptId)
    this.sessions.delete(launchId)
    this.revision++
    return true
  }

  private current(attemptId: string): ManagedSession | undefined {
    const id = this.attempts.get(attemptId)
    const session = id ? this.sessions.get(id) : undefined
    return session?.attemptId === attemptId ? session : undefined
  }

  private live(session: ManagedSession): boolean {
    return session.terminalState !== 'exited' && ['starting', 'active'].includes(session.lifecycle)
  }

  private releaseIndexes(session: ManagedSession): void {
    if (session.expectedClaudeId && this.expected.get(session.expectedClaudeId) === session.launchId) this.expected.delete(session.expectedClaudeId)
    if (session.confirmedClaudeId && this.confirmed.get(session.confirmedClaudeId) === session.launchId) this.confirmed.delete(session.confirmedClaudeId)
  }

  private releaseIdentityLease(attemptId: string): void {
    const dispose = this.identityLeases.get(attemptId)
    this.identityLeases.delete(attemptId)
    dispose?.()
  }

  private reject(evidence: BindingEvidence, reason: string): false {
    console.warn('[ManagedSession] evidence rejected', { attemptId: evidence.attemptId, claudeId: evidence.claudeId, source: evidence.source, reason })
    return false
  }

  private emit(session: ManagedSession, reason: string): void {
    session.revision = ++this.revision
    session.reason = reason
    console.info('[ManagedSession]', { launchId: session.launchId, attemptId: session.attemptId, ptyId: session.ptyId, reason, revision: session.revision })
    this.publish({ instanceId: this.instanceId, revision: this.revision, session: { ...session } })
  }
}
