// 使用方法：由主进程 PROJECT_PREPARE_DIR handler 调用
// 编译说明：主进程 Node.js ESM
// 代码说明：创建项目向导 Step 1 的目录准备原子能力，不写项目模板或记录

import fs from 'fs'

export type PrepareProjectDirectoryStatus = 'created' | 'exists'

export interface PrepareProjectDirectoryResult {
  status: PrepareProjectDirectoryStatus
}

export function prepareProjectDirectory(projectPath: string): PrepareProjectDirectoryResult {
  if (!projectPath.trim()) {
    throw new Error('Project path is empty')
  }

  console.log(`[ProjectDirectory] prepare begin: ${projectPath}`)

  try {
    const stat = fs.statSync(projectPath)
    if (!stat.isDirectory()) {
      throw new Error(`Target path exists but is not a directory: ${projectPath}`)
    }
    console.log(`[ProjectDirectory] prepare exists: ${projectPath}`)
    return { status: 'exists' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.error(`[ProjectDirectory] prepare stat failed: ${projectPath}`, error)
      throw error
    }
  }

  fs.mkdirSync(projectPath, { recursive: true })
  console.log(`[ProjectDirectory] prepare created: ${projectPath}`)
  return { status: 'created' }
}
