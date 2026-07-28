// 使用方法：npm test -- src/__tests__/main/projectDirectory.test.ts
// 编译说明：Vitest Node 环境
// 代码说明：创建项目 Step 1 目录准备原子能力回归测试

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareProjectDirectory } from '../../main/lib/projects/ProjectDirectory'

describe('prepareProjectDirectory', () => {
  let testRoot: string

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-steer-project-dir-'))
  })

  afterEach(() => {
    if (testRoot.startsWith(os.tmpdir()) && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it('creates a missing nested project directory', () => {
    const target = path.join(testRoot, 'parent', 'project')

    expect(prepareProjectDirectory(target)).toEqual({ status: 'created' })
    expect(fs.statSync(target).isDirectory()).toBe(true)
  })

  it('reports an existing directory without changing its contents', () => {
    const target = path.join(testRoot, 'existing')
    fs.mkdirSync(target)
    const marker = path.join(target, 'asset.txt')
    fs.writeFileSync(marker, 'keep-me', 'utf-8')

    expect(prepareProjectDirectory(target)).toEqual({ status: 'exists' })
    expect(fs.readFileSync(marker, 'utf-8')).toBe('keep-me')
  })

  it('rejects an existing non-directory path', () => {
    const target = path.join(testRoot, 'project')
    fs.writeFileSync(target, 'not-a-directory', 'utf-8')

    expect(() => prepareProjectDirectory(target)).toThrow('not a directory')
    expect(fs.readFileSync(target, 'utf-8')).toBe('not-a-directory')
  })

  it('rejects an empty path', () => {
    expect(() => prepareProjectDirectory('  ')).toThrow('Project path is empty')
  })
})
