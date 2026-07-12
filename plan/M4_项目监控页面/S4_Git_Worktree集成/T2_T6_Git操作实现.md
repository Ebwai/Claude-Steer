# T2-T6 — Git 操作实现（合并）

## 技术原理

所有 Git 操作通过 Node.js `child_process.execFile` 调用 git CLI 实现，不使用 libgit2 等原生绑定（跨平台兼容性更好）。

**关键约束（严格遵守）**：
- `git rebase -i` 是交互模式，**严禁在程序中使用**
- 删除节点用 `git rebase --onto`（非交互式）
- 推送前必须检测远程配置，未配置时弹出说明子窗口

## 实现步骤

### T2 — Git 快照（git add/commit）[ ]

#### 原子目标 2.1 — GitManager.commit [ ]
```typescript
async commit(worktreePath: string, message: string): Promise<{ commitHash: string }>
// 执行：cd <worktreePath> && git add -A && git commit -m "<message>"
// 返回：git rev-parse HEAD 获取 commit hash
```

#### 原子目标 2.2 — 节点快照状态标记 [ ]
文件：`src/renderer/src/atoms/timeline.atom.ts`（扩展）
- `TimelineNode` 追加字段：`commitHash?: string; isGitted: boolean`
- `isGitted=true` 时节点颜色改为"已快照"色（非绿色，根据 Session 颜色系选深色变体）
- 合并到 main 后（SessionEnd 合并确认）改为浅绿色

#### 原子目标 2.3 — IPC 处理 [ ]
- `GIT_COMMIT` invoke handler 调用 `GitManager.commit`
- 返回 `commitHash` → 渲染进程更新节点标记

### T3 — 回退操作（git reset --hard）[ ]

#### 原子目标 3.1 — GitManager.resetHard [ ]
```typescript
async resetHard(worktreePath: string, commitHash: string): Promise<void>
// 执行：cd <worktreePath> && git reset --hard <commitHash>
```

#### 原子目标 3.2 — 二次确认 Modal [ ]
文件：`src/renderer/src/features/project-monitor/GitResetConfirmModal.tsx`
- Modal 内容：「此操作将回退到版本 [commitHash前8位]，当前未提交的更改将丢失。确认回退？」
- **确认** 按钮（红色边框）+ **取消** 按钮
- 确认后调用 `IPC.GIT_RESET_HARD`

#### 原子目标 3.3 — Memory 对齐 [ ]
- `git reset --hard` 成功后，向 Session 的 PTY stdin 写入 `/compact` 命令
- 这使 Claude 的记忆状态与代码状态对齐

### T4 — 合并到主线 + 推送到 GitHub [ ]

#### 原子目标 4.1 — GitManager.mergeToMain [ ]
```typescript
async mergeToMain(projectPath: string, branchName: string): Promise<void>
// 执行：cd <projectPath> && git merge <branchName> --no-edit
```

#### 原子目标 4.2 — GitManager.push [ ]
```typescript
async push(projectPath: string, branch: string = 'main'): Promise<void>
// 先检测远程：git remote -v
// 无远程 → 抛出 GitRemoteNotConfiguredError
// 有远程 → 执行：git push origin <branch>
```

#### 原子目标 4.3 — 远程未配置子窗口 [ ]
文件：`src/renderer/src/features/project-monitor/GitRemoteSetupModal.tsx`
- 标题：「配置 GitHub 远程仓库」
- 内容：步骤说明（创建仓库 → `git remote add origin <url>` → 重试推送）
- 关闭按钮

#### 原子目标 4.4 — 项目顶栏"同步到 GitHub"按钮 [ ]
- 点击触发：`GIT_MERGE_AND_PUSH`（先 merge 当前 worktree 分支，再 push）
- 进行中：按钮显示旋转图标 + 「推送中...」文字
- 成功：绿色对勾提示 2s
- 失败（无远程/冲突）：弹出对应说明 Modal

### T5 — 删除节点（非交互式 rebase）[ ]

#### 原子目标 5.1 — 删除区间计算 [ ]
- 输入：用户输入节点索引
- 计算：从该节点到下一个用户输入节点之间的所有节点
- 找出区间内所有 `commitHash`（已 git 的节点）

#### 原子目标 5.2 — GitManager.rebaseDelete [ ]
```typescript
async rebaseDelete(
  worktreePath: string,
  baseCommit: string,     // 删除区间之前的最后一个 commit
  tipCommit: string       // 删除区间结束后的第一个 commit（或 HEAD）
): Promise<void>
// 执行：cd <worktreePath> && git rebase --onto <baseCommit> <firstDeletedCommit>~1 HEAD
// ⚠️ 严禁使用 git rebase -i
```

#### 原子目标 5.3 — JSONL 区间清除 [ ]
- 从 `timelineBySessionAtom` 中删除对应区间的所有节点
- 同步从 `lineInsertionsBySessionAtom` 中删除区间内的 LineInsertion

### T6 — Git 操作错误边界处理 [ ]

#### 原子目标 6.1 — GitErrorHandler [ ]
文件：`src/main/lib/git/GitErrorHandler.ts`
- 解析 git 命令输出，识别常见错误类型：
  - `MERGE_CONFLICT` → 提示「合并冲突，请手动解决后重试」
  - `PERMISSION_DENIED` → 提示「权限不足，请检查 SSH 密钥配置」
  - `WORKTREE_EXISTS` → 提示「该分支的 worktree 已存在，尝试复用」
  - `NOT_GIT_REPO` → 提示「不是 Git 仓库」
- 所有 Git 错误通过 IPC 返回结构化错误对象（`{ type, message, recoveryHint }`）

#### 原子目标 6.2 — GitErrorToast 组件 [ ]
- 在项目监控页右下角显示 toast 通知（3s 自动消失）
- 严重错误（冲突/权限）显示「了解更多」按钮 → 弹出详细说明 Modal

## 新增 IPC 通道

- `GIT_COMMIT` (invoke): `{ sessionId, message }` → `{ commitHash }`
- `GIT_RESET_HARD` (invoke): `{ sessionId, commitHash }` → `{ ok }`
- `GIT_MERGE_AND_PUSH` (invoke): `{ sessionId }` → `{ ok }` | `GitError`
- `GIT_REBASE_DELETE` (invoke): `{ sessionId, baseCommit, tipCommit }` → `{ ok }`
- `GIT_STATUS` (invoke): `{ sessionId }` → `{ currentBranch, uncommittedChanges, lastCommit }`

## 验收标准

- 点击节点"Git 当前版本"：节点颜色改变，commit hash 记录
- 点击已 git 节点"回退"：弹出确认 Modal，确认后代码回到该 commit
- 点击"同步到 GitHub"：merge + push 成功后按钮提示成功
- 无远程配置时：弹出配置说明子窗口
- 删除用户输入节点：对应区间从进程线消失，若有 commit 则从 git 历史删除
- 各类错误场景：友好提示文字，不崩溃
