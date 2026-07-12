# T1 — Worktree 创建与映射数据库

## 技术原理

Git Worktree 允许同一个 Git 仓库在不同目录下同时 checkout 不同分支，
仪表盘利用此特性为每个 Session 创建隔离的工作环境。

### 映射数据库结构

存储在 `~/.claude-driver/worktree-map.json`：
```json
{
  "<sessionId>": {
    "projectPath": "/home/tony/MyProject",
    "worktreePath": "/home/tony/MyProject/.worktrees/<branchName>",
    "branchName": "claude-session-<uuid>",
    "createdAt": 1713000000000,
    "status": "active" | "merged" | "removed"
  }
}
```

### 前置条件检测

- 非 Git 仓库：`git rev-parse --git-dir` 失败 → 禁用所有 Git 功能，显示灰色提示「此项目未初始化 Git，Git 功能不可用」
- Git 仓库但无 main 分支：提示先执行 `git commit -m "init"` 创建初始提交

## 实现步骤

### 原子目标 1 — Git 仓库检测 IPC [ ]
文件：`src/main/lib/git/GitManager.ts`
- `isGitRepo(projectPath: string): Promise<boolean>` — 执行 `git rev-parse --git-dir`
- 通过 IPC `GIT_IS_REPO` 供渲染进程查询

### 原子目标 2 — Worktree 映射数据库 CRUD [ ]
文件：`src/main/lib/config/WorktreeMapStore.ts`
- 读写 `~/.claude-driver/worktree-map.json`
- 原子性写入（先写临时文件再 rename，防止并发冲突）

### 原子目标 3 — GitManager.createWorktree [ ]
文件：`src/main/lib/git/GitManager.ts`
```typescript
async createWorktree(projectPath: string, sessionId: string): Promise<{
  worktreePath: string
  branchName: string
}>
// 执行：git worktree add -b claude-session-<uuid> <worktreePath>
// 写入映射数据库
```

### 原子目标 4 — 创建 Session 时自动 Worktree [ ]
文件：`src/main/services/SessionService.ts`（扩展）
- `createSession` 方法中：检测是否 Git repo → 是则调用 `createWorktree` → PTY cwd 绑定到 worktreePath
- 非 Git repo：跳过 worktree 创建，PTY cwd 为项目路径，Git 相关按钮全部 disabled

### 原子目标 5 — Session 结束合并询问 [ ]
- `SessionEnd` Hook 到达时：若该 session 有对应 worktree，弹出 Modal 「是否将此分支合并到 main？」
- 用户确认 → 执行 `git merge`（T4 实现）
- 用户取消 → worktree 保留（状态设为 inactive），可后续手动合并

### 原子目标 6 — 渲染进程 Git 状态 Atom [ ]
```typescript
export const sessionGitStateAtom = atomFamily((sessionId: string) =>
  atom<{
    isGitRepo: boolean
    worktreePath: string | null
    branchName: string | null
    commits: CommitRecord[]   // 已快照的 commit 列表
  }>({
    isGitRepo: false,
    worktreePath: null,
    branchName: null,
    commits: []
  })
)
```

## 新增 IPC 通道

- `GIT_IS_REPO` (invoke): `{ projectPath }` → `{ isRepo: boolean }`
- `GIT_CREATE_WORKTREE` (invoke): `{ sessionId, projectPath }` → `{ worktreePath, branchName }`
- `GIT_REMOVE_WORKTREE` (invoke): `{ sessionId }` → `{ ok }`

## 验收标准

- 非 Git 项目：所有 git 按钮灰色，tooltip 显示「未初始化 Git」
- Git 项目启动 Session：自动创建 worktree，可在 `.worktrees/` 目录下找到对应分支目录
- Session 结束：弹出合并询问 Modal
