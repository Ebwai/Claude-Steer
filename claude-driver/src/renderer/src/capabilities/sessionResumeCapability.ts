// 使用方法：SessionFrameNode 点击“回到对话”时构造 SESSION_RESUME 请求
// 编译说明：renderer 进程 browser bundle；纯函数可在 Vitest 中直接验证
// 代码说明：恢复会话只依赖稳定 Claude sessionId 和项目，历史框不需要已有 PTY

import type { PermissionMode, Project } from '@shared/types/index'

export interface SessionResumePayload {
  projectId: string
  projectPath: string
  resumeSessionId: string
  permissionMode: PermissionMode
}

/**
 * 历史框所属画布的 projectId 是恢复动作的权威来源。
 * activeSessions 中可能残留旧的、projectId 为空的运行时快照，不能让它覆盖画布上下文。
 */
export function resolveSessionFrameProjectId(
  canvasProjectId: string,
  sessionProjectId?: string | null,
): string {
  return canvasProjectId || sessionProjectId || ''
}

export function buildSessionResumePayload(
  sessionId: string,
  project: Project | undefined,
): SessionResumePayload | null {
  if (!project || !sessionId) return null
  return {
    projectId: project.id,
    projectPath: project.path,
    resumeSessionId: sessionId,
    permissionMode: 'acceptEdits',
  }
}
