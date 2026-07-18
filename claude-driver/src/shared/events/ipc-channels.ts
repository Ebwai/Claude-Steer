// 使用方法：import { IPC } from '@renderer/shared/events/ipc-channels'
// 编译说明：此文件在 renderer 进程中作为 TypeScript 模块编译；main 进程通过相对路径引用
// 代码说明：定义跨进程 IPC 通道名常量，避免字符串硬编码导致的通道名不一致问题

export const IPC = {
  // ── Main → Renderer 推送（单向 send）────────────────────────────────────
  /** Claude Code Hook 事件（PreToolUse / PostToolUse / SubagentStart 等） */
  HOOK_EVENT: 'hook:event',
  /** statusLine token/model/context 刷新（~300ms 一次） */
  STATUS_LINE: 'statusline:update',
  /** Plan 文件状态变更（DOING / DONE 等） */
  PLAN_UPDATED: 'plan:updated',
  /** 进程状态变化（Running / Paused / Interrupted / Completed） */
  SESSION_STATUS: 'session:status',
  /** 新权限请求 / Agent 通知 */
  NOTIFICATION: 'notification:new',

  // ── Renderer → Main 请求（双向 invoke，返回 Promise）────────────────────
  /** 创建/注册新项目 */
  PROJECT_CREATE: 'project:create',
  /** 获取已知项目列表 */
  PROJECT_LIST: 'project:list',
  /** 启动 PTY 进程（新建 session） */
  SESSION_START: 'session:start',
  /** 向 PTY stdin 写入文本 */
  SESSION_INPUT: 'session:input',
  /** 停止正在运行的 session */
  SESSION_STOP: 'session:stop',
  /** 恢复历史 session（claude --resume） */
  SESSION_RESUME: 'session:resume',
  /** 确保目录是 git repo（若未初始化则 git init + checkout -b main） */
  GIT_ENSURE_REPO: 'git:ensure-repo',
  /** 创建 Git 快照（git add -A + git commit） */
  GIT_COMMIT: 'git:commit',
  /** 回退到指定 commit（git reset --hard） */
  GIT_RESET: 'git:reset',
  /** 删除指定 commit（git rebase --onto，非交互式） */
  GIT_DELETE_COMMIT: 'git:delete-commit',
  /** 推送到 GitHub（git push origin <branch>） */
  GIT_PUSH: 'git:push',
  /** 查询 git 状态（remote 是否配置、当前分支）*/
  GIT_GET_STATUS: 'git:get-status',
  /** 读取并回放某 session 的全部 git 标记，返回 GitMark[] */
  GIT_MARKS_LOAD: 'git:marks-load',
  /** 追加一条 git 标记到 <claudeId>.git-marks.jsonl */
  GIT_MARK_SAVE: 'git:mark-save',
  /** 从 <claudeId>.git-marks.jsonl 中删除指定 nodeId 的标记（重写文件） */
  GIT_MARK_DELETE: 'git:mark-delete',
  /** 读取配置字段 */
  CONFIG_READ: 'config:read',
  /** 写入配置字段 */
  CONFIG_WRITE: 'config:write',
  /** 扫描目录，返回含 CLAUDE.md 的项目路径列表 */
  PROJECT_SCAN: 'project:scan',
  /** 批量更新项目认领状态（claimStatus） */
  PROJECT_UPDATE: 'project:update',
  /** 打开原生目录选择对话框，返回选中路径或 null */
  DIALOG_OPEN_DIR: 'dialog:open-dir',
  /** 用系统默认程序打开指定路径（文件夹/文件） */
  SHELL_OPEN_PATH: 'shell:open-path',
  /** 开始监听 JSONL 文件（历史 readFromStart=true / 实时 readFromStart=false） */
  JSONL_WATCH: 'jsonl:watch',
  /** Main → Renderer 批量推送历史 JSONL 记录 */
  JSONL_RECORDS: 'jsonl:records',
  /** Main → Renderer 推送单条实时 JSONL 记录 */
  JSONL_RECORD: 'jsonl:record',
  /** Main → Renderer 推送单条 subagent JSONL 记录（含 agentId） */
  JSONL_SUBAGENT_RECORD: 'jsonl:subagent-record',
  /** Main → Renderer 推送单个项目更新（session 启动/停止后通知渲染层刷新） */
  PROJECT_UPDATED: 'project:updated',
  /** 读取项目 plan/overall_plan.md 内容 */
  PLAN_READ: 'plan:read',
  /** 读取项目级 .claude/settings.json */
  PROJECT_SETTINGS_READ: 'project-settings:read',
  /** 写入项目级 .claude/settings.json（单字段 patch） */
  PROJECT_SETTINGS_WRITE: 'project-settings:write',
  /** 权限请求审批（y/n + 可选附加信息 → PTY stdin） */
  PERMISSION_RESPOND: 'permission:respond',
  /** 关闭权限请求（只更新角标，不发送按键） */
  PERMISSION_DISMISS: 'permission:dismiss',
  /** /branch 关系通知：child session 与 parent session 的关联（Main → Renderer push） */
  SESSION_BRANCH_LINK: 'session:branch-link',
  /** PTY ↔ Claude Code session 绑定（SessionStart 触发，Main → Renderer push）
   *  payload: { ptyId, claudeId, transcriptPath, cwd } */
  PTY_BIND: 'pty:bind',
  /** PTY ↔ Claude Code session 解绑（SessionEnd 触发，Main → Renderer push）
   *  payload: { ptyId, claudeId } */
  PTY_UNBIND: 'pty:unbind',
  /** /branch JSONL 起始点：file-history-snapshot 的 messageId，用于过滤父历史（Main → Renderer push） */
  JSONL_BRANCH_SNAPSHOT: 'jsonl:branch-snapshot',
  /** 扫描项目历史 session 元数据（renderer → main 请求） */
  PROJECT_HISTORY_SCAN: 'project:history-scan',
  /** 追加一条完整插入线到 <claudeId>.insertions.jsonl */
  INSERTION_APPEND: 'insertion:append',
  /** 追加一条补丁行（id + 变更字段）到 <claudeId>.insertions.jsonl */
  INSERTION_PATCH: 'insertion:patch',
  /** 读取并重放某 session 的全部插入线，返回 LineInsertion[] */
  INSERTIONS_LOAD: 'insertions:load',
  /** 追加一条 subagent 内部工具插入线到 subagents/agent-<agentId>.insertions.jsonl */
  INSERTION_SUBAGENT_APPEND: 'insertion:subagent-append',
  /** 追加一条 subagent 内部工具补丁行（状态变更） */
  INSERTION_SUBAGENT_PATCH: 'insertion:subagent-patch',
  /** Main → Renderer 推送 batch subagent 内部工具插入线（历史加载时用） */
  JSONL_SUBAGENT_INSERTIONS: 'jsonl:subagent-insertions',
  /** 打开独立终端窗口（xterm.js BrowserWindow）*/
  TERM_WINDOW_OPEN: 'term-window:open',
  /** 关闭独立终端窗口 */
  TERM_WINDOW_CLOSE: 'term-window:close',
  /** 读取项目级 .claude/agents/ 目录中的 agent 列表 */
  AGENT_LIST_PROJECT: 'agent:list-project',
  /** 主进程 → 终端窗口 推送 PTY 原始输出（仅终端窗口可收） */
  TERM_DATA: 'term:data',
  /** 终端窗口 → 主进程 PTY resize */
  TERM_RESIZE: 'term:resize',
  /** 持久化 session startedAt 到 <claudeId>.meta.json（renderer → main invoke） */
  SESSION_META_WRITE: 'session:meta-write',
  /** 追加一条 Milestone 到 <claudeId>.milestones.jsonl */
  MILESTONE_SAVE: 'milestone:save',
  /** 读取并重放某 session 的全部 Milestones，返回 Milestone[] */
  MILESTONES_LOAD: 'milestones:load',
  /** 主进程 → 渲染进程：桌面通知被点击，切换到通知 tab */
  NOTIFICATION_FOCUS_TAB: 'notification:focus-tab',

  /** 设置项目某个 MCP server 的启用/禁用状态
   *  payload: { projectPath, serverName, enabled, source: 'mcp.json' | 'global' } */
  MCP_SET_ENABLED: 'mcp:set-enabled',
  /** 设置项目某个 Skill 的启用/禁用状态（写 .claude/settings.local.json permissions.deny）
   *  payload: { projectPath, skillName, enabled } */
  SKILL_SET_ENABLED: 'skill:set-enabled',

  // ── M5 S2 全局设置 Modal ──────────────────────────────────────────────────
  /** 读取 ~/.claude-driver/config.json + 应用版本号 */
  DRIVER_CONFIG_READ: 'driver-config:read',
  /** 测试 API Key 连通性（发极短请求） */
  API_TEST: 'api:test',
  /** 读取 ~/.claude/settings.json 的 env 块（provider 配置） */
  PROVIDER_CONFIG_READ: 'provider-config:read',
  /** 读取 ~/.claude/settings.json 中非分组的顶层字段（语言/权限/记忆/偏好等） */
  CLAUDE_SETTINGS_READ: 'claude-settings:read',
  /** 批量写入 ~/.claude/settings.json 的 env 块（合并模式） */
  PROVIDER_CONFIG_WRITE: 'provider-config:write',
  /** 测试 Provider endpoint 连通性（向自定义 baseUrl 发请求） */
  API_TEST_PROVIDER: 'api:test-provider',
  /** 将 ~/.claude-driver/config.json 复制到指定路径 */
  CONFIG_EXPORT: 'config:export',
  /** 从指定路径读取、校验并写入 ~/.claude-driver/config.json */
  CONFIG_IMPORT: 'config:import',
  /** 弹出系统文件保存对话框，返回用户选择的路径或 null */
  DIALOG_SAVE_FILE: 'dialog:save-file',
  /** 弹出系统文件打开对话框，返回用户选择的路径或 null */
  DIALOG_OPEN_FILE: 'dialog:open-file',

  // ── M6 S2 定时触发 ───────────────────────────────────────────────────────
  /** 读取本地持久化任务列表（含 PTY 活跃状态）renderer → main invoke */
  SCHEDULER_LIST:   'scheduler:list',
  /** 创建新 loop 任务（或向已有 session 追加）renderer → main invoke */
  SCHEDULER_CREATE: 'scheduler:create',
  /** 暂停/恢复某个项目的 loop PTY renderer → main invoke */
  SCHEDULER_TOGGLE: 'scheduler:toggle',
  /** 删除一个任务记录（仅本地）renderer → main invoke */
  SCHEDULER_DELETE: 'scheduler:delete',

  // ── M6 S1 灵魂交流 ───────────────────────────────────────────────────────
  /**
   * 启动临时 insight PTY（在用户 home 目录启动裸 claude → 发 /insights → 完成后自动销毁）
   * renderer → main invoke；返回 { ok: boolean; error?: string }
   */
  INSIGHT_RUN: 'insight:run',
  /** 报告文件已就绪通知（main → renderer push，payload: { filePath: string }） */
  INSIGHT_REPORT_READY: 'insight:report-ready',
  /** 在 home 目录裸启 Claude PTY 供用户闲聊（renderer → main invoke；返回 { ok, sessionId }） */
  CHAT_START: 'chat:start',
  /** 打开聊天气泡窗口（renderer → main invoke；payload: { sessionId }） */
  CHAT_WINDOW_OPEN: 'chat:window-open',
  /** 主进程 → 聊天窗口推送解析后的消息（stream-json 单条）*/
  CHAT_MESSAGE: 'chat:message',
  /** 在新 BrowserWindow 中打开本地 HTML 文件（renderer → main invoke） */
  OPEN_WEBVIEW: 'open:webview',

  // ── M7 Token 统计 ────────────────────────────────────────────────────────────
  /**
   * 扫描单个 JSONL 文件汇总 token 消耗（renderer → main invoke）
   * payload: { transcriptPath: string }
   * 返回: { ok: true; inputTokens: number; outputTokens: number;
   *         cacheCreationTokens: number; cacheReadTokens: number; model: string | null }
   *   or: { ok: false; error: string }
   */
  TOKEN_SCAN_FILE: 'token:scan-file',

  // ── M6 S3 远程交互（cc-connect）────────────────────────────────────────────
  /** 检测 cc-connect 安装状态（renderer → main invoke；返回 { installed, version? }） */
  CC_CONNECT_CHECK: 'cc-connect:check',
  /** 启动 cc-connect 服务（renderer → main invoke；返回 { ok }） */
  CC_CONNECT_START: 'cc-connect:start',
  /** 停止 cc-connect 服务（renderer → main invoke；返回 { ok }） */
  CC_CONNECT_STOP: 'cc-connect:stop',
  /** 查询运行状态（renderer → main invoke；返回 { running }） */
  CC_CONNECT_STATUS: 'cc-connect:status',
  /** 保存项目飞书 bot 配置并重新生成 toml（renderer → main invoke；payload: { projectId, bot }；返回 { ok }） */
  CC_CONNECT_CONFIG_SAVE: 'cc-connect:config-save',
  /** 从 config.toml 读取指定项目的配置（renderer → main invoke；payload: { projectName }；返回 { found, config }） */
  CC_CONNECT_CONFIG_READ: 'cc-connect:config-read',
  /** 启动临时 PTY 向 Claude 发安装提示词，自动打开终端窗口（renderer → main invoke；返回 { ok }） */
  CC_CONNECT_INSTALL: 'cc-connect:install',
  /** cc-connect 实时日志推送（main → renderer push；payload: { log: string }） */
  CC_CONNECT_LOG: 'cc-connect:log',

  // ── 应用更新 ──────────────────────────────────────────────────
  /** 触发版本检查（renderer → main invoke） */
  UPDATER_CHECK: 'updater:check',
  /** 触发下载更新（renderer → main invoke） */
  UPDATER_DOWNLOAD: 'updater:download',
  /** 退出并安装更新（renderer → main invoke） */
  UPDATER_QUIT_AND_INSTALL: 'updater:quit-and-install',
  /** 更新状态变化推送（main → renderer push，payload: UpdaterState） */
  UPDATER_STATE_CHANGED: 'updater:state-changed',

  // ── 作者推荐 ──────────────────────────────────────────────────────
  /** 读取 author_recommend 分类推荐数据（renderer → main invoke；payload: { category }；返回 RecommendItem[]） */
  RECOMMEND_GET: 'recommend:get',
} as const

/** IPC 通道名的联合类型，用于类型安全的 ipcMain.handle / ipcRenderer.invoke */
export type IpcChannel = (typeof IPC)[keyof typeof IPC]
