/** Lightweight Main-owned lifecycle; transcript contents remain in the Session domain. */
export interface ManagedSession {
  launchId: string
  frameId: string
  attemptId: string
  ptyId: string
  projectId: string
  cwd: string
  expectedClaudeId?: string
  confirmedClaudeId?: string
  transcriptPath?: string
  mode: 'primary' | 'compatibility' | 'resume' | 'branch'
  identityState: 'expected' | 'confirmed' | 'conflict'
  transcriptState: 'waiting' | 'ready' | 'unavailable'
  terminalState: 'starting' | 'ready' | 'exited'
  lifecycle: 'starting' | 'active' | 'retry-pending' | 'failed' | 'cancelled' | 'ended'
  inputWriteStarted: boolean
  compatibilityTried: boolean
  bindingGeneration: number
  revision: number
  startedAt: number
  reason?: string
}

export interface ManagedSnapshot {
  instanceId: string
  revision: number
  sessions: ManagedSession[]
}

export interface ManagedChange {
  instanceId: string
  revision: number
  session: ManagedSession
}
