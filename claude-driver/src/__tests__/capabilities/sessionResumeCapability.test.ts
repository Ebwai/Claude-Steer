// 使用方法：npm test -- src/__tests__/capabilities/sessionResumeCapability.test.ts
// 编译说明：Vitest（纯函数，无 DOM）
// 代码说明：防止历史工作框因没有当前 ptyId 而无法构造恢复请求

import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/types/index'
import {
  buildSessionResumePayload,
  resolveSessionFrameProjectId,
} from '@renderer/capabilities/sessionResumeCapability'

const project: Project = {
  id: 'project-1',
  name: 'demo',
  path: 'F:\\projects\\demo',
  claimStatus: 1,
  isGitRepo: true,
  activeSessionId: null,
  sessionIds: ['claude-session-1'],
  lastActiveAt: 1,
}

describe('buildSessionResumePayload', () => {
  it('uses the owning canvas project when a stale active session has no projectId', () => {
    expect(resolveSessionFrameProjectId('project-1', '')).toBe('project-1')
  })

  it('builds a history resume request without requiring an existing PTY id', () => {
    expect(buildSessionResumePayload('claude-session-1', project)).toEqual({
      projectId: 'project-1',
      projectPath: 'F:\\projects\\demo',
      resumeSessionId: 'claude-session-1',
      permissionMode: 'acceptEdits',
    })
  })

  it('rejects a resume request when the project is unavailable', () => {
    expect(buildSessionResumePayload('claude-session-1', undefined)).toBeNull()
  })
})
