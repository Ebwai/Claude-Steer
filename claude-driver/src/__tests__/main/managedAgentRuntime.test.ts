import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ManagedAgentRuntime } from '../../main/lib/pty/ManagedAgentRuntime'
import { ManagedSessionCoordinator } from '../../main/lib/pty/ManagedSessionCoordinator'
import type { PtyManager, PtyStartOptions } from '../../main/lib/pty/PtyManager'

const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'steer-runtime-'))
  roots.push(root)
  const launches: PtyStartOptions[] = []
  const pty = { getActiveSessions: () => launches.map(s => s.sessionId), startSession: (s: PtyStartOptions) => launches.push(s), resumeSession: (s: PtyStartOptions) => launches.push(s) }
  const actions = { prepare: vi.fn(), data: vi.fn(), exit: vi.fn(), bind: vi.fn(), watchTranscript: vi.fn(), configRoot: () => root }
  const coordinator = new ManagedSessionCoordinator()
  const runtime = new ManagedAgentRuntime(coordinator, pty as unknown as PtyManager, actions)
  return { root, launches, pty, actions, coordinator, runtime }
}

describe('ManagedAgentRuntime adapters', () => {
  it('starts two independent sessions in an empty project without history', async () => {
    const { runtime, root, launches, coordinator } = await setup()
    try {
      const a = runtime.start({ projectId: 'p', projectPath: root, permissionMode: 'default' })
      const b = runtime.start({ projectId: 'p', projectPath: root, permissionMode: 'default' })
      expect(launches).toHaveLength(2)
      expect(a.ptyId).not.toBe(b.ptyId)
      expect(a.expectedClaudeId).not.toBe(b.expectedClaudeId)
      expect(launches[0].claudeSessionId).toBe(a.expectedClaudeId)
      coordinator.markTerminalReady(a.attemptId)
      expect(coordinator.getByAttempt(a.attemptId)).toMatchObject({ terminalState: 'ready', transcriptState: 'waiting' })
      coordinator.observeInputWrite(a.attemptId, a.ptyId)
      expect(coordinator.getByAttempt(a.attemptId)?.inputWriteStarted).toBe(true)
    } finally { runtime.dispose() }
  })

  it.each(['missing', 'file'] as const)('reports a %s project directory as startup failure without creating a PTY', async (kind) => {
    const { runtime, root, launches, actions, coordinator } = await setup()
    const cwd = path.join(root, 'invalid-project')
    if (kind === 'file') await writeFile(cwd, '')
    try {
      expect(() => runtime.start({ projectId: 'p', projectPath: cwd, permissionMode: 'default' })).toThrow()
      expect(launches).toHaveLength(0)
      expect(actions.prepare).not.toHaveBeenCalled()
      expect(actions.bind).not.toHaveBeenCalled()
      expect(actions.exit).toHaveBeenCalledTimes(1)
      expect(coordinator.snapshot().sessions[0]).toMatchObject({
        terminalState: 'exited', lifecycle: 'failed', transcriptState: 'unavailable',
        startupError: kind === 'missing' ? 'project-directory-missing' : 'project-directory-invalid', exitCode: 1
      })
    } finally { runtime.dispose() }
  })

  it('persists a process spawn failure independently of transcript availability', async () => {
    const { runtime, root, launches, pty, actions, coordinator } = await setup()
    pty.startSession = () => { throw new Error('Cannot create process') }
    try {
      expect(() => runtime.start({ projectId: 'p', projectPath: root, permissionMode: 'default' })).toThrow('Cannot create process')
      const failed = coordinator.snapshot().sessions[0]
      expect(failed).toMatchObject({ lifecycle: 'failed', terminalState: 'exited', transcriptState: 'unavailable', startupError: 'process-start-failed', exitCode: 1 })
      expect(actions.exit).toHaveBeenCalledWith(expect.objectContaining({ startupError: 'process-start-failed' }), 1)
      expect(launches).toHaveLength(0)
    } finally { runtime.dispose() }
  })

  it('recognizes a file written immediately before exit without reviving the PTY', async () => {
    const { runtime, coordinator, launches, root, actions } = await setup()
    try {
      const a = runtime.start({ projectId: 'p', projectPath: root, permissionMode: 'default' })
      const directory = path.join(root, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'))
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, `${a.expectedClaudeId}.jsonl`), JSON.stringify({ sessionId: a.expectedClaudeId, type: 'user' }) + '\n')
      launches[0].onExit(a.ptyId, 0)
      await vi.waitFor(() => expect(actions.exit).toHaveBeenCalledTimes(1))
      expect(coordinator.getByAttempt(a.attemptId)).toMatchObject({ terminalState: 'exited', lifecycle: 'ended', confirmedClaudeId: a.expectedClaudeId, transcriptState: 'ready' })
      expect(coordinator.getByClaude(a.expectedClaudeId!)).toBeUndefined()
    } finally { runtime.dispose() }
  })

  it('cancels retry while its final filesystem check is pending', async () => {
    const { runtime, coordinator, launches, actions, root } = await setup()
    try {
      const a = runtime.start({ projectId: 'p', projectPath: root, permissionMode: 'default' })
      launches[0].onData(a.ptyId, "error: unknown option '--session-id'\n")
      launches[0].onExit(a.ptyId, 1)
      runtime.cancel(a.ptyId)
      await vi.waitFor(() => expect(actions.exit).toHaveBeenCalledTimes(1))
      expect(launches).toHaveLength(1)
      expect(coordinator.getByAttempt(a.attemptId)?.lifecycle).toBe('cancelled')
    } finally { runtime.dispose() }
  })

  it('passes the reserved UUID to the real spawn boundary and uses source evidence for concurrent same-cwd Hooks', async () => {
    const { runtime, coordinator, launches, actions, root } = await setup()
    try {
      const a = runtime.start({ projectId: 'p', projectPath: root, permissionMode: 'default' })
      const b = runtime.start({ projectId: 'p', projectPath: root, permissionMode: 'default' })
      expect(launches[0].claudeSessionId).toBe(a.expectedClaudeId)
      expect(launches[1].claudeSessionId).toBe(b.expectedClaudeId)
      expect(runtime.acceptHook({ session_id: a.expectedClaudeId!, cwd: root, hook_event_name: 'SessionStart' }, launches[1].managedHookToken)).toBeUndefined()
      expect(runtime.acceptHook({ session_id: b.expectedClaudeId!, cwd: root, hook_event_name: 'SessionStart' }, launches[1].managedHookToken)?.ptyId).toBe(b.ptyId)
      expect(coordinator.getByAttempt(a.attemptId)?.confirmedClaudeId).toBeUndefined()
      expect(actions.bind).toHaveBeenCalledTimes(1)
      expect(launches).toHaveLength(2)
    } finally { runtime.dispose() }
  })

  it('waits for process exit before one compatibility launch and rejects the previous source token', async () => {
    const { runtime, coordinator, launches, root } = await setup()
    try {
      const a = runtime.start({ projectId: 'p', projectPath: root, permissionMode: 'default' })
      launches[0].onData(a.ptyId, "error: unknown option '--session-id'\n")
      expect(launches).toHaveLength(1)
      launches[0].onExit(a.ptyId, 1)
      await vi.waitFor(() => expect(launches).toHaveLength(2))
      expect(launches[1].claudeSessionId).toBeUndefined()
      expect(runtime.acceptHook({ session_id: a.expectedClaudeId!, cwd: root, hook_event_name: 'SessionStart' }, launches[0].managedHookToken)).toBeUndefined()
      const retried = coordinator.snapshot().sessions[0]
      expect(retried.frameId).toBe(a.frameId)
      expect(retried.attemptId).not.toBe(a.attemptId)
      launches[1].onData(retried.ptyId, "error: unknown option '--session-id'\n")
      launches[1].onExit(retried.ptyId, 1)
      await vi.waitFor(() => expect(coordinator.getByAttempt(retried.attemptId)?.transcriptState).toBe('unavailable'))
      expect(launches).toHaveLength(2)
    } finally { runtime.dispose() }
  })

  it('does not retry if a transcript exists at final exit check', async () => {
    const { runtime, launches, root, coordinator } = await setup()
    try {
      const a = runtime.start({ projectId: 'p', projectPath: root, permissionMode: 'default' })
      const directory = path.join(root, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'))
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, `${a.expectedClaudeId}.jsonl`), '')
      launches[0].onData(a.ptyId, "error: unknown option '--session-id'\n")
      launches[0].onExit(a.ptyId, 1)
      await vi.waitFor(() => expect(coordinator.getByAttempt(a.attemptId)?.lifecycle).toBe('failed'))
      expect(launches).toHaveLength(1)
    } finally { runtime.dispose() }
  })
})
