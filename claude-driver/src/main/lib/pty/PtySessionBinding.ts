// 使用方法：SessionStart Hook 在 cwd 猜测前先调用 resolveSessionStartPty
// 编译说明：Electron main / Node.js；纯函数可由 Vitest 直接验证
// 代码说明：同一项目存在多个 PTY 时，优先使用 Claude session 已有的确定性绑定

export interface SessionStartPtyResolution {
  ptyId: string | undefined
  source: 'exact-binding' | 'cwd' | 'none'
}

export function resolveSessionStartPty(
  claudeId: string,
  cwd: string,
  claudeToPtyMap: ReadonlyMap<string, string>,
  findSessionByCwd: (cwd: string) => string | undefined
): SessionStartPtyResolution {
  const exactPtyId = claudeToPtyMap.get(claudeId)
  if (exactPtyId) return { ptyId: exactPtyId, source: 'exact-binding' }

  const cwdPtyId = findSessionByCwd(cwd)
  if (cwdPtyId) return { ptyId: cwdPtyId, source: 'cwd' }

  return { ptyId: undefined, source: 'none' }
}
