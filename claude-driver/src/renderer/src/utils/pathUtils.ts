// 使用方法：import { pathMatches } from '@renderer/utils/pathUtils'
// 编译说明：renderer 进程 browser bundle（不可使用 Node path 模块）
// 代码说明：跨平台路径前缀匹配——将 \ 归一化为 / 后比较，确保 Windows 路径正确匹配

/**
 * 检查 cwd 是否等于 basePath，或是 basePath 的子目录
 * 跨平台安全：先将所有反斜杠归一化为正斜杠再比较
 */
export function pathMatches(cwd: string, basePath: string): boolean {
  const nCwd = cwd.replace(/\\/g, '/').toLowerCase()
  const nBase = basePath.replace(/\\/g, '/').toLowerCase()
  return nCwd === nBase || nCwd.startsWith(nBase + '/')
}
