import { describe, expect, it, vi } from 'vitest'
import { ManagedSessionCoordinator } from '../../main/lib/pty/ManagedSessionCoordinator'

const input = { projectId: 'project', cwd: 'C:/project' }
const unsupported = "error: unknown option '--session-id'"

describe('ManagedSessionCoordinator', () => {
  it('moves Branch content generation without changing the physical attempt and rejects old file callbacks', () => {
    const coordinator = new ManagedSessionCoordinator()
    const a = coordinator.startManaged(input)
    coordinator.acceptEvidence({ attemptId: a.attemptId, bindingGeneration: 0, claudeId: a.expectedClaudeId!, source: 'hook' })
    const child = coordinator.confirmBranch(a.attemptId, a.expectedClaudeId!, 'child')!
    expect(child.ptyId).toBe(a.ptyId)
    expect(child.attemptId).toBe(a.attemptId)
    expect(child.frameId).toBe('child')
    expect(child.bindingGeneration).toBe(1)
    expect(coordinator.acceptEvidence({ attemptId: a.attemptId, bindingGeneration: 0, claudeId: a.expectedClaudeId!, source: 'exact-file' })).toBe(false)
    expect(coordinator.getByClaude('child')?.ptyId).toBe(a.ptyId)
  })

  it('reserves independent identities for concurrent starts without marking terminal or transcript ready', () => {
    const coordinator = new ManagedSessionCoordinator()
    const a = coordinator.startManaged(input)
    const b = coordinator.startManaged(input)
    expect(a.expectedClaudeId).not.toBe(b.expectedClaudeId)
    expect(a.confirmedClaudeId).toBeUndefined()
    expect(a.terminalState).toBe('starting')
    expect(a.transcriptState).toBe('waiting')
    expect(coordinator.getByClaude(a.expectedClaudeId!)?.ptyId).toBe(a.ptyId)
  })

  it('never invokes legacy identity adapters on primary, including after Hook confirmation', () => {
    const coordinator = new ManagedSessionCoordinator()
    const a = coordinator.startManaged(input)
    const adapter = vi.fn(() => vi.fn())
    expect(coordinator.startIdentityFallback(a.attemptId, adapter)).toBe(false)
    expect(coordinator.acceptEvidence({ attemptId: a.attemptId, bindingGeneration: 0, claudeId: a.expectedClaudeId!, source: 'hook' })).toBe(true)
    expect(coordinator.startIdentityFallback(a.attemptId, adapter)).toBe(false)
    expect(adapter).not.toHaveBeenCalled()
    expect(coordinator.getByAttempt(a.attemptId)?.transcriptState).toBe('waiting')
  })

  it('accepts late exact file idempotently and rejects another session', () => {
    const publish = vi.fn()
    const coordinator = new ManagedSessionCoordinator(publish)
    const a = coordinator.startManaged(input)
    const evidence = { attemptId: a.attemptId, bindingGeneration: 0, claudeId: a.expectedClaudeId!, source: 'exact-file' as const }
    expect(coordinator.acceptEvidence({ ...evidence, claudeId: 'other' })).toBe(false)
    expect(coordinator.acceptEvidence(evidence)).toBe(true)
    const count = publish.mock.calls.length
    expect(coordinator.acceptEvidence(evidence)).toBe(true)
    expect(publish).toHaveBeenCalledTimes(count)
    expect(coordinator.getByAttempt(a.attemptId)?.transcriptState).toBe('ready')
  })

  it('requires exit and final evidence check before retrying, keeps frame, changes physical attempt', () => {
    const coordinator = new ManagedSessionCoordinator()
    const a = coordinator.startManaged(input)
    coordinator.noteUnsupportedOption(a.attemptId, unsupported)
    expect(coordinator.beginCompatibility(a.launchId, a.attemptId, true)).toBeUndefined()
    expect(coordinator.onPtyExit(a.attemptId, a.ptyId, 1)).toBe(true)
    const b = coordinator.beginCompatibility(a.launchId, a.attemptId, true)!
    expect(b.frameId).toBe(a.frameId)
    expect(b.ptyId).not.toBe(a.ptyId)
    expect(b.attemptId).not.toBe(a.attemptId)
    expect(coordinator.acceptEvidence({ attemptId: a.attemptId, bindingGeneration: 0, claudeId: a.expectedClaudeId!, source: 'hook' })).toBe(false)
    expect(coordinator.onPtyExit(a.attemptId, a.ptyId, 1)).toBe(false)
    expect(coordinator.getByAttempt(b.attemptId)?.lifecycle).toBe('starting')
  })

  it('disposes actual legacy adapter after correlated confirmation and rejects unsourced candidates', () => {
    const coordinator = new ManagedSessionCoordinator()
    const a = coordinator.startManaged(input)
    coordinator.noteUnsupportedOption(a.attemptId, unsupported)
    coordinator.onPtyExit(a.attemptId, a.ptyId, 1)
    const b = coordinator.beginCompatibility(a.launchId, a.attemptId, true)!
    const dispose = vi.fn()
    const adapter = vi.fn(() => dispose)
    expect(coordinator.startIdentityFallback(b.attemptId, adapter)).toBe(true)
    const evidence = { attemptId: b.attemptId, bindingGeneration: 0, claudeId: 'compat-id' }
    expect(coordinator.acceptEvidence({ ...evidence, source: 'hook' })).toBe(false)
    expect(coordinator.acceptEvidence({ ...evidence, source: 'correlated-hook' })).toBe(true)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(coordinator.startIdentityFallback(b.attemptId, adapter)).toBe(false)
    expect(adapter).toHaveBeenCalledTimes(1)
    expect(coordinator.acceptEvidence({ ...evidence, source: 'exact-file' })).toBe(true)
  })

  it.each(['input', 'confirmed', 'cancelled', 'ordinary-error', 'successful-exit'])('does not retry after %s', (scenario) => {
    const coordinator = new ManagedSessionCoordinator()
    const a = coordinator.startManaged(input)
    coordinator.noteUnsupportedOption(a.attemptId, scenario === 'ordinary-error' ? 'network timeout' : unsupported)
    if (scenario === 'input') coordinator.observeInputWrite(a.attemptId, a.ptyId)
    if (scenario === 'confirmed') coordinator.acceptEvidence({ attemptId: a.attemptId, bindingGeneration: 0, claudeId: a.expectedClaudeId!, source: 'hook' })
    if (scenario === 'cancelled') coordinator.cancelManaged(a.launchId)
    expect(coordinator.onPtyExit(a.attemptId, a.ptyId, scenario === 'successful-exit' ? 0 : 1)).toBe(false)
    expect(coordinator.beginCompatibility(a.launchId, a.attemptId, true)).toBeUndefined()
  })

  it('rejects stale input before writing and blocks retry when final file evidence exists', () => {
    const coordinator = new ManagedSessionCoordinator()
    const a = coordinator.startManaged(input)
    expect(() => coordinator.observeInputWrite(a.attemptId, 'wrong-pty')).toThrow('STALE_ATTEMPT')
    coordinator.noteUnsupportedOption(a.attemptId, unsupported)
    coordinator.onPtyExit(a.attemptId, a.ptyId, 1)
    expect(coordinator.beginCompatibility(a.launchId, a.attemptId, false)).toBeUndefined()
    expect(coordinator.getByAttempt(a.attemptId)?.lifecycle).toBe('failed')
  })

  it('does not let old exits clear a newly resumed owner, snapshots cannot mutate authority', () => {
    const coordinator = new ManagedSessionCoordinator()
    const a = coordinator.startManaged({ ...input, resumeClaudeId: 'persisted' })
    coordinator.onPtyExit(a.attemptId, a.ptyId, 0)
    const b = coordinator.startManaged({ ...input, resumeClaudeId: 'persisted' })
    coordinator.onPtyExit(a.attemptId, a.ptyId, 0)
    expect(coordinator.getByClaude('persisted')?.ptyId).toBe(b.ptyId)
    coordinator.snapshot().sessions[1].ptyId = 'corrupted'
    expect(coordinator.getByClaude('persisted')?.ptyId).toBe(b.ptyId)
  })
})
