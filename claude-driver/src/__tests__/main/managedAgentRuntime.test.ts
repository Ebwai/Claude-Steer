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
  const actions = { prepare: vi.fn(), data: vi.fn(), exit: vi.fn(), bind: vi.fn(), configRoot: () => root }
  const coordinator = new ManagedSessionCoordinator()
  const runtime = new ManagedAgentRuntime(coordinator, pty as unknown as PtyManager, actions)
  return { root, launches, actions, coordinator, runtime }
}

describe('ManagedAgentRuntime adapters', () => {
  it('recognizes a file written immediately before exit without reviving the PTY', async () => {
    const { runtime, coordinator, launches, root, actions } = await setup()
    try {
      const a = runtime.start({ projectId: 'p', projectPath: '/project', permissionMode: 'default' })
      const directory = path.join(root, 'projects', '-project')
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, `${a.expectedClaudeId}.jsonl`), JSON.stringify({ sessionId: a.expectedClaudeId, type: 'user' }) + '\n')
      launches[0].onExit(a.ptyId, 0)
      await vi.waitFor(() => expect(actions.exit).toHaveBeenCalledTimes(1))
      expect(coordinator.getByAttempt(a.attemptId)).toMatchObject({ terminalState: 'exited', lifecycle: 'ended', confirmedClaudeId: a.expectedClaudeId, transcriptState: 'ready' })
      expect(coordinator.getByClaude(a.expectedClaudeId!)).toBeUndefined()
    } finally { runtime.dispose() }
  })

  it('cancels retry while its final filesystem check is pending', async () => {
    const { runtime, coordinator, launches, actions } = await setup()
    try {
      const a = runtime.start({ projectId: 'p', projectPath: '/project', permissionMode: 'default' })
      launches[0].onData(a.ptyId, "error: unknown option '--session-id'\n")
      launches[0].onExit(a.ptyId, 1)
      runtime.cancel(a.ptyId)
      await vi.waitFor(() => expect(actions.exit).toHaveBeenCalledTimes(1))
      expect(launches).toHaveLength(1)
      expect(coordinator.getByAttempt(a.attemptId)?.lifecycle).toBe('cancelled')
    } finally { runtime.dispose() }
  })

  it('passes the reserved UUID to the real spawn boundary and uses source evidence for concurrent same-cwd Hooks', async () => {
    const { runtime, coordinator, launches, actions } = await setup()
    try {
      const a = runtime.start({ projectId: 'p', projectPath: '/project', permissionMode: 'default' })
      const b = runtime.start({ projectId: 'p', projectPath: '/project', permissionMode: 'default' })
      expect(launches[0].claudeSessionId).toBe(a.expectedClaudeId)
      expect(launches[1].claudeSessionId).toBe(b.expectedClaudeId)
      expect(runtime.acceptHook({ session_id: a.expectedClaudeId!, cwd: '/project', hook_event_name: 'SessionStart' }, launches[1].managedHookToken)).toBeUndefined()
      expect(runtime.acceptHook({ session_id: b.expectedClaudeId!, cwd: '/project', hook_event_name: 'SessionStart' }, launches[1].managedHookToken)?.ptyId).toBe(b.ptyId)
      expect(coordinator.getByAttempt(a.attemptId)?.confirmedClaudeId).toBeUndefined()
      expect(actions.bind).toHaveBeenCalledTimes(1)
      expect(launches).toHaveLength(2)
    } finally { runtime.dispose() }
  })

  it('waits for process exit before one compatibility launch and rejects the previous source token', async () => {
    const { runtime, coordinator, launches } = await setup()
    try {
      const a = runtime.start({ projectId: 'p', projectPath: '/project', permissionMode: 'default' })
      launches[0].onData(a.ptyId, "error: unknown option '--session-id'\n")
      expect(launches).toHaveLength(1)
      launches[0].onExit(a.ptyId, 1)
      await vi.waitFor(() => expect(launches).toHaveLength(2))
      expect(launches[1].claudeSessionId).toBeUndefined()
      expect(runtime.acceptHook({ session_id: a.expectedClaudeId!, cwd: '/project', hook_event_name: 'SessionStart' }, launches[0].managedHookToken)).toBeUndefined()
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
      const a = runtime.start({ projectId: 'p', projectPath: '/project', permissionMode: 'default' })
      const directory = path.join(root, 'projects', '-project')
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, `${a.expectedClaudeId}.jsonl`), '')
      launches[0].onData(a.ptyId, "error: unknown option '--session-id'\n")
      launches[0].onExit(a.ptyId, 1)
      await vi.waitFor(() => expect(coordinator.getByAttempt(a.attemptId)?.lifecycle).toBe('failed'))
      expect(launches).toHaveLength(1)
    } finally { runtime.dispose() }
  })
})
