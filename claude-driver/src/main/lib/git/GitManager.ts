// 使用方法：import { GitManager } from './lib/git/GitManager'；在 main/index.ts ipcMain.handle 中使用
// 编译说明：main 进程 Node.js bundle，可使用 child_process、fs 等 Node 内置模块
// 代码说明：G. Git 操作基础设施层——所有 git shell 命令的封装，策略无关（单分支/worktree 均可扩展）

import { execFileSync } from 'child_process'

/** 统一错误提取：优先取 stderr，fallback stdout，最后 String(err) */
function extractGitError(err: unknown): string {
  const e = err as { stderr?: Buffer | string; stdout?: Buffer | string }
  const stderr = e.stderr ? String(e.stderr).trim() : ''
  const stdout = e.stdout ? String(e.stdout).trim() : ''
  return stderr || stdout || String(err)
}

export const GitManager = {
  /** G3: 创建 git 快照（git add -A + git commit）。返回 commitHash（7位 short hash） */
  commit(cwd: string, message: string): { ok: true; commitHash: string } | { ok: false; error: string } {
    console.log(`[GitManager] commit cwd=${cwd} msg=${message.slice(0, 60)}`)
    try {
      execFileSync('git', ['-C', cwd, 'add', '-A'])
      execFileSync('git', ['-C', cwd, 'commit', '-m', message], { encoding: 'utf-8' })
      // rev-parse 比解析 commit 输出文本更可靠，不受 locale / branch 名影响
      const commitHash = execFileSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim()
      console.log(`[GitManager] commit ok hash=${commitHash}`)
      return { ok: true, commitHash }
    } catch (err) {
      const error = extractGitError(err)
      console.error('[GitManager] commit failed:', error)
      return { ok: false, error }
    }
  },

  /** G7: 回退到指定 commit（git reset --hard <hash>） */
  reset(cwd: string, commitHash: string): { ok: true } | { ok: false; error: string } {
    console.log(`[GitManager] reset cwd=${cwd} hash=${commitHash}`)
    try {
      execFileSync('git', ['-C', cwd, 'reset', '--hard', commitHash])
      console.log(`[GitManager] reset ok: ${commitHash}`)
      return { ok: true }
    } catch (err) {
      const error = extractGitError(err)
      console.error('[GitManager] reset failed:', error)
      return { ok: false, error }
    }
  },

  /** 确保目录是 git repo（git init + checkout -b main，幂等） */
  ensureRepo(cwd: string): { ok: true } | { ok: false; error: string } {
    console.log(`[GitManager] ensureRepo cwd=${cwd}`)
    try {
      execFileSync('git', ['-C', cwd, 'init'])
      try {
        execFileSync('git', ['-C', cwd, 'checkout', '-b', 'main'])
        console.log(`[GitManager] ensureRepo created branch main for ${cwd}`)
      } catch {
        // branch already exists or already on main — ignore
        console.log(`[GitManager] ensureRepo branch main already exists for ${cwd}`)
      }
      return { ok: true }
    } catch (err) {
      const error = extractGitError(err)
      console.error('[GitManager] ensureRepo failed:', error)
      return { ok: false, error }
    }
  },

  /** G5: 推送到 GitHub（git push origin <branch>，默认 main）*/
  push(cwd: string, branch = 'main'): { ok: true } | { ok: false; error: string } {
    console.log(`[GitManager] push cwd=${cwd} branch=${branch}`)
    try {
      execFileSync('git', ['-C', cwd, 'push', 'origin', branch], { encoding: 'utf-8' })
      console.log(`[GitManager] push ok: ${branch}`)
      return { ok: true }
    } catch (err) {
      const error = extractGitError(err)
      console.error('[GitManager] push failed:', error)
      return { ok: false, error }
    }
  },

  /**
   * G8: 查询 git 状态（remote 是否配置、当前分支）
   * 用于推送前检查 remote 是否存在
   */
  getStatus(cwd: string): { ok: true; hasRemote: boolean; currentBranch: string } | { ok: false; error: string } {
    console.log(`[GitManager] getStatus cwd=${cwd}`)
    try {
      const remoteOutput = execFileSync('git', ['-C', cwd, 'remote'], { encoding: 'utf-8' }).trim()
      const hasRemote = remoteOutput.length > 0
      let currentBranch = 'main'
      try {
        currentBranch = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim()
      } catch {
        // 新仓库无提交时 rev-parse 会失败，沿用默认值
      }
      console.log(`[GitManager] getStatus hasRemote=${hasRemote} branch=${currentBranch}`)
      return { ok: true, hasRemote, currentBranch }
    } catch (err) {
      const error = extractGitError(err)
      console.error('[GitManager] getStatus failed:', error)
      return { ok: false, error }
    }
  },

  /**
   * G6: 删除指定 commit（git rebase --onto <newBase> <oldBase>）
   * 用法：从历史中移除 commitHash 对应的 commit，后续 commit 接到其父 commit 上
   * 注意：禁止使用 git rebase -i，必须用非交互式 --onto
   */
  deleteCommit(cwd: string, commitHash: string): { ok: true } | { ok: false; error: string } {
    console.log(`[GitManager] deleteCommit cwd=${cwd} hash=${commitHash}`)
    try {
      // git rebase --onto <commitHash>^  <commitHash>
      // 即：把 commitHash 之后的所有 commit 接到 commitHash 的父节点上，相当于删除 commitHash
      execFileSync('git', ['-C', cwd, 'rebase', '--onto', `${commitHash}^`, commitHash], { encoding: 'utf-8' })
      console.log(`[GitManager] deleteCommit ok: ${commitHash}`)
      return { ok: true }
    } catch (err) {
      const error = extractGitError(err)
      console.error('[GitManager] deleteCommit failed:', error)
      return { ok: false, error }
    }
  },
}
