# Important_Info — 项目特殊知识（避坑地图）

> 记录一切与通识认知不同的关键点，防止重复踩同一个坑。
> **来源标注**：每条记录注明来源位置，便于追溯。

---

## [PRD规范] Plan 文件格式：以 TODO/DOING/DONE 为准

- **内容**：仪表盘解析项目 plan 文件时，状态枚举使用 `TODO` / `DOING` / `DONE`（大写）。格式为 `- [STATUS] 描述`。
- **特别注意**：CLAUDE_Steer 项目自身的 plan-management 规则使用 `[ ]` / `[x]` / `[!]` 格式（这是 CLAUDE_Steer 内部规范），但 **Claude Driver 仪表盘作为产品**，其 plan 解析器遵循 PRD §4.2 定义的 TODO/DOING/DONE 标准。两者**不混用**。
- **来源**：用户 2026-04-14 明确确认，PRD §4.2 为准

---

## [进程机制] statusLine 桥接脚本是被动调用脚本，非持久进程

- **内容**：Claude Code 每约 300ms **fork 一次**桥接脚本（`sh` 调用），将 JSON 写入脚本的 stdin，脚本读取后立即退出。脚本生命周期极短。
- **关键推论**：
  1. 桥接脚本**不能** `import` 任何 Node.js 模块或启动服务，只能用 shell 内置命令（`read` + `curl`）
  2. 脚本必须 `chmod +x` 才能被调用
  3. 多次调用间**没有状态共享**（每次都是全新进程）
- **Windows 差异**：生成 `.ps1` 文件，在 settings.json 中注册为 `powershell -File <path>`
- **来源**：架构.md §9 分析，PRD §2.1 表格（statusLine 数据来源 A）

---

## [数据路径] JSONL 路径发现策略：以 statusLine.transcript_path 为权威来源

- **内容**：一个项目可能有多个历史 session JSONL 文件（不同时间启动）。判断"当前正在运行的 session"对应哪个 JSONL，**必须使用 statusLine 返回的 `transcript_path` 字段**，而不是根据 cwd 路径猜测。
- **`transcript_path` 的限制**：首次 API 调用之前该字段为 `null`，需要等第一次工具调用后才能获取。在此之前可用 cwd 匹配 + 最新修改时间作为临时方案。
- **来源**：PRD §2.2 数据存储表（statusLine 来源 B 说明）

---

## [数据路径] JSONL 路径编码规则

- **内容**：项目绝对路径编码为 JSONL 目录名时，规则为：**所有非字母数字字符（包括下划线）全部替换为 `-`**，只有字母和数字保留。
- **示例**：`/home/tony/Skills_Test` → `-home-tony-Skills-Test`（`/` 转 `-`，**`_` 也转 `-`**）
- **修正记录**：旧记录以为 `_` 保留（`/[^a-zA-Z0-9_]/g`），2026-04-27 实测 `/home/tony/Skills-Test` 目录存在而 `-home-tony-Skills_Test` 不存在，确认下划线也被替换。
- **实际规则**：`path.replace(/[^a-zA-Z0-9]/g, '-')`
- **注意**：`~` 展开后再编码（`~` = `/home/tony`），不是对 `~` 本身编码
- **影响范围**：`autoWatchTranscript` 和 `PROJECT_HISTORY_SCAN` IPC handler 两处均已修复（`src/main/index.ts`）
- **来源**：2026-04-27 Skills_Test 项目重启后历史工作面板不显示，实测验证

---

## [数据路径] Subagent JSONL 路径在主 session 目录下的子目录

- **内容**：Subagent 的 JSONL 路径为：`~/.claude/projects/<encoded-path>/<session-uuid>/subagents/<subagent-uuid>.jsonl`（不是直接在 `<encoded-path>/` 下）
- **监听方式**：chokidar 需配置 `{ depth: 3 }` 来覆盖 `subagents/<uuid>/` 子目录层级
- **来源**：PRD §2.2 数据存储表

---

## [进程管理] Hook 注册必须 merge，不能覆盖

- **内容**：仪表盘启动时向 `~/.claude/settings.json` 注入 Hook 配置。若用户已有自定义 hooks，**必须读取现有配置后合并**，不能直接覆盖写入 `hooks` 字段。
- **并发风险**：Claude Code 运行时也可能写 settings.json，需使用原子写入（写 tmp 文件 + rename）防止文件损坏。
- **来源**：架构.md M2 深度评估（风险 2）

---

## [构建配置] node-pty 是 Native Addon，需要 electron-rebuild

- **内容**：`node-pty` 包含 `.node` 原生二进制，必须针对当前 Electron 版本重新编译。在 electron-vite 中需要：
  1. 配置 `externalizeDepsPlugin({ exclude: ['node-pty'] })` 的反向操作 —— 即**不**将 node-pty externalize 给渲染进程（主进程 OK，渲染进程禁止 import）
  2. 安装 `electron-rebuild`，在 `postinstall` 中执行 `electron-rebuild -f -w node-pty`
  3. 打包时需要配置 `extraResources` 将 `.node` 文件包含进去
- **来源**：架构.md M1 深度评估，electron-vite 官方文档

---

## [UI架构] @xyflow/react 仅用于全局监控画板，进程线使用 CSS 滚动布局

- **内容**：`@xyflow/react` 包体约 200KB，仅在**全局监控页左半画板**（项目卡片节点 + 连线）使用。
- **项目监控页右侧"进程线画布"**：使用**自定义 CSS 滚动容器 + React 组件列表**实现，不使用 @xyflow/react（demo HTML 已验证可行，见 `project_monitor_scene1.html`）
- **原因**：进程线是线性时间轴，不需要平移/缩放/任意连线等画板能力；CSS 布局性能更好
- **来源**：UI demo 分析，架构.md §3.4 深度说明

---

## [功能限制] Auto-Dream 字段禁止读写

- **内容**：`autoDreamEnabled` 字段对应 `services/autoDream/` 内部功能，在 Claude Code 2.1.104 中已通过**编译时裁剪**（`AUTO_DREAM_ENABLED` feature flag）完全禁用，生产二进制中该功能不存在。
- **仪表盘行为**：点击"Auto-Dream"卡片 → 显示"此功能 Claude Code 暂时未全面开放，敬请期待"弹窗，**不向 settings.json 写入任何字段**
- **来源**：PRD §10 已确认事项 2，PRD 附录 C

---

## [命令拼写] /insight 正确命令为复数形式 /insights

- **内容**：调用洞见报告功能的正确 Claude Code 命令是 `/insights`（**复数**），不是 `/insight`
- **代码实现时**：通过 PTY stdin 发送 `/insights\n`
- **来源**：PRD §3.5 灵魂交流 Modal 说明

---

## [网络] 端口 39521 冲突时必须弹窗提示

- **内容**：仪表盘启动时，若 39521 端口被其他进程占用，**必须弹出窗口提示用户**，引导其在全局设置中修改端口号。不能静默失败或直接报错退出。
- **端口修改后**：需同步更新 settings.json 中的 Hook URL（`http://127.0.0.1:<新端口>/hooks`）和 statusLine 桥接脚本的 POST URL
- **来源**：PRD §D.3 原子功能 NW1，架构.md §4.1

---

## [跨平台] Windows 任务栏角标行为与 macOS/Linux 不同

- **内容**：Electron 的 `setBadgeCount()` 在 Windows 上**不支持数字角标**，只能设置覆盖图标（overlay icon）。
- **处理方式**：使用 `process.platform === 'win32'` 判断，Windows 平台改用 `setOverlayIcon()` 显示红色圆点，而非数字
- **来源**：架构.md M5 深度评估

---

## [Git] 非 Git 仓库项目需要优雅降级

- **内容**：并非所有项目都是 Git 仓库。如果项目目录下没有 `.git`，`git worktree add` 等命令会失败。
- **处理方式**：启动 PTY 前检测项目是否为 Git repo（`git -C <path> rev-parse --git-dir`），如果不是，Git 相关功能（快照/回退/Worktree）全部禁用，相关按钮显示为灰色并附提示 "非 Git 仓库，版本管理功能不可用"
- **来源**：架构.md M4 深度评估（子系统 3）

---

## [Jotai] IPC→Atom 桥接模式：在根组件用 store.set 更新原子

- **内容**：Jotai 原子状态需要被 Main Process 通过 IPC 推送更新。推荐模式：
  ```typescript
  // App.tsx 根组件挂载时
  const store = useStore()
  useEffect(() => {
    window.ipcRenderer.on('hook:event', (_, payload) => {
      store.set(activeSessionsAtom, prev => updateSession(prev, payload))
    })
    return () => window.ipcRenderer.removeAllListeners('hook:event')
  }, [store])
  ```
  注意：`store.set` 来自 Jotai 的 `useStore()` hook（Vanilla Store API），不需要 React Context。
- **来源**：架构.md §3.4 Jotai 架构设计

---

## [目录结构] 共享类型在 src/shared/（非 renderer 子目录）

- **内容**：跨进程共享的 TypeScript 类型（`types/index.ts`、`events/ipc-channels.ts`、`constants/index.ts`）存放在 **`src/shared/`**（项目顶层），而非 `src/renderer/src/shared/`。
- **原因**：`tsconfig.node.json` 的 `include` 范围是 `src/main/**/*` 和 `src/preload/**/*`，无法访问 `src/renderer/` 目录。共享类型提升到 `src/shared/` 后，两个 tsconfig 都通过 `"include"` 显式包含它。
- **import 规则**：
  - main 进程：相对路径 `'../shared/...'` 或等效路径
  - renderer 进程：`@shared/*` alias（已在 tsconfig.web.json + electron.vite.config.ts 配置）
  - preload：相对路径 `'../shared/...'`
- **来源**：M2 S1 T1 执行时发现，2026-04-14

---

## [构建环境] Node.js 版本约束：需要 ≥ 22.12.0

- **内容**：`electron-vite@5.0.0` 要求 Node.js `^20.19.0 || >=22.12.0`；`@electron/rebuild@4.x`（被 electron-builder postinstall 调用）要求 Node.js `>=22.12.0`。
- **系统默认 Node 18.20.8 会导致**：
  1. `electron-vite dev` 可能运行但有版本警告
  2. `npm run postinstall`（即 `electron-builder install-app-deps`）内部调用 `@electron/rebuild`，报 `TypeError: util.styleText is not a function`（`util.styleText` 仅 Node ≥20 有）并构建失败
- **解决方案**：通过 nvm 切换到 Node 22 LTS，`source ~/.nvm/nvm.sh && nvm use 22`，然后在该 shell 下执行所有 npm 命令
- **注意**：每个新终端会话都需要重新 `source ~/.nvm/nvm.sh && nvm use 22`，系统默认 Node 版本未更改
- **来源**：M1 S1 T2 执行过程中实际踩坑，2026-04-14

---

## [项目识别] 路径前缀去重的边界条件

- **内容**：初始化 SOP 扫描项目时，`/home/tony/proj` 和 `/home/tony/proj/plan` 归属同一项目（前者是后者的严格路径前缀）。
- **去重规则**：对路径数组排序后，逐一检查是否被前一个路径作为**严格前缀**包含（需确保前缀后跟 `/` 而不是同前缀的不同项目名，如 `/home/tony/proj` 和 `/home/tony/proj2` 是两个不同项目）
- **来源**：PRD §3.1.5 项目去重合并规则

---

## [初始化] 项目初始化时运行配置脚本写入用户级 settings.json 默认值

- **内容**：新环境首次使用 CLAUDE_Steer 时，需运行配置脚本将用户级 `~/.claude/settings.json` 写入推荐默认值，避免每次手动配置。
- **关键默认值**：
  ```json
  {
    "outputStyle": "Explanatory"
  }
  ```
- **注意**：必须用**合并写入**（读取现有配置后 merge），不能覆盖已有字段（用户可能已有自定义配置）。
- **操作方式**：在项目根目录执行 `node scripts/init-settings.js`（脚本待创建）
- **来源**：用户 2026-04-17 要求

---

## [布局] Flex 高度链断裂：app-content 必须同时设置 display:flex

- **内容**：`.app-content` 作为 flex 子项用 `flex: 1` 获得高度，但子页面（如 `ProjectMonitorPage`）也用 `flex: 1` 继承高度时，**必须让 `.app-content` 同时设置 `display: flex; flex-direction: column`**，否则子页面拿不到高度，底部出现大片黑色空白。
- **典型症状**：子页面 `flex: 1` 无效，只按内容高度渲染，底部剩余区域显示父容器背景色。
- **对比**：`height: 100%` 不依赖父级是否是 flex 容器，可绕过此问题（`GlobalMonitorPage` 就用了此方式）；但统一风格推荐父子都用 flex。
- **修复位置**：`src/renderer/src/App.css`，`.app-content` 加 `display: flex; flex-direction: column`
- **来源**：2026-04-16 页面全屏问题排查

---

## [布局] Flex row 子项不撑满高度：用 align-self: stretch 强制

- **内容**：在 `flex-direction: row` 容器中，子项默认通过 `align-items: stretch` 撑满交叉轴（高度）。但当父容器有 `overflow: hidden` 时，浏览器高度计算可能不稳定，导致子项实际高度不足。
- **解决方案**：在需要撑满的子项上**显式设置 `align-self: stretch`**，覆盖隐式继承行为，强制撑满。
- **适用场景**：`LeftPanel`（`.lp-container`）和 `ProcessLineCanvas`（`.plc-container`）都需要此设置。
- **来源**：2026-04-16 项目监控页面左右两列底部不对齐问题排查

---

## [布局] 移除条件面板时必须同时回收其弹性占位

- **内容**：`LeftPanel` 是 column flex 布局；聚合通知审批框迁移到独立窗口后，若只移除 `RequestApprovalPanel`、仍保留其相邻的 `<div style={{ flex: 1, minHeight: 0 }} />`，该空节点会继续分走剩余高度，导致 Agent 实时列表的可视框提前结束。
- **正确约束**：`.lp-agent-list` 是 `ContextPanel` 上方唯一的弹性区域，使用 `flex: 1; min-height: 0; overflow-y: auto`；列表后直接渲染 `ContextPanel`，两者边界重合。
- **通用原则**：迁移或删除 column flex 中的条件面板时，必须一并审计为它服务的 spacer、margin、固定高度和 `flex` 权重，不能只删除组件节点。
- **实现位置**：`src/renderer/src/features/project-monitor/LeftPanel.tsx`、`LeftPanel.css`
- **来源**：M11 实时工作区纵向空间回收，2026-07-20

---

## [进程线] SubagentBlock 与 Agent badge 配对：用 tool_use_id 精确匹配

- **内容**：`PreToolUse` 和对应的 `PostToolUse` Hook 事件携带**相同的 `tool_use_id`**。"分配任务"插入线应存储此 ID，"返回任务结果"插入线通过相同 ID 精确查找对应的分配线，从而复用 `Agent{n}:type` 标签和 `customWidth`。
- **禁止用顺序匹配**：FIFO（先进先出）假设"先分配先返回"，在并行 Agent 场景中完全错误——两个 Agent 的返回顺序不确定。
- **类型声明**：`HookPayloadToolUse` 需要添加 `tool_use_id?: string` 字段；`LineInsertion` 需要添加 `toolUseId?: string` 字段。
- **来源**：2026-04-16 多 Subagent 返回结果全变成 Agent2 问题排查

---

## [Hook机制] /branch 命令的真实 Hook 触发链路

- **内容**：`/branch` 是 Claude CLI 的 REPL 内部命令，**不经过 `UserPromptSubmit` Hook**，也不会创建新 PTY 进程。真实链路为：
  1. 父 session 收到 **`Notification` Hook**，`payload.message` 包含 `"Branched conversation"`（注意 stdout 里单词间是 Unicode 制表线 U+2500 `─`，但 Hook 的 message 字段是干净文本，用正则 `/Branched.{0,20}conversation/i` 匹配）
  2. 接着子 session 触发 **`SessionStart` Hook**（`session_id` 是 Claude Code 内部新 session ID）
  3. 子 session **不创建新 PTY 进程**，在同一 PTY 内运行
- **仪表盘处理**：主进程在 `onHookEvent` 回调中：`Notification` 时记录 `pendingBranchBySession.set(parentId, Date.now())`，`SessionStart` 时检查 pending 并推送 `SESSION_BRANCH_LINK` IPC 事件到渲染层
- **渲染层**：收到 `SESSION_BRANCH_LINK` 后，手动将子 session 注册到 `activeSessionsAtom`（继承父 session 的 cwd/projectId），并写入 `sessionRelationsAtom`
- **来源**：M4 S3 T7 实现过程中实际验证，2026-04-18

---

## [进程线] SessionFrameNode 框宽与 overflow 设置

- **内容**：`SessionFrameNode` 的 `.sfn-frame` 和 `.sfn-timeline-area` 若设置 `overflow: hidden`，会裁切向左伸出的 `SubagentBlock`（最大可伸出 600+px）。
- **正确设置**：`overflow: visible`（对 `.sfn-frame`、`.sfn-timeline-area`、`.sfn-timeline-area .ptl-container` 三处），让 SubagentBlock 自然溢出到框边界外，@xyflow canvas 允许节点内容向负坐标溢出。
- **框宽**：`FRAME_WIDTH`（`useSessionFrameLayout.ts`）与 `.sfn-frame` 的 `width` 必须保持同步，目前设为 1500px。
- **坐标系**：轴 `left: 750px`（框宽的一半），`padding-left: 770px`（轴右侧 20px 开始内容），CSS 变量 `--ins-axis-left: 750px`、`--ins-padding-left: 770px`。
- **来源**：2026-04-16 SubagentBlock 超出虚线框问题排查

---

## [Hook机制] `claude -r`（resume）不触发 SessionStart Hook

- **内容**：用 `claude -r <oldSessionId>` 恢复/继续一个旧 session 时，Claude Code **不会触发 `SessionStart` Hook**。这是 resume 专有路径，与普通启动不同。
- **唯一绑定时机**：主进程中，`autoWatchTranscript` 的 `tryRegister` 回调检测到新的 JSONL 文件时是唯一一次可以建立 PTY↔ClaudeId 绑定的机会。此时必须用已知的 `parentPtyId` 执行 `bindPtyToClaudeSession(parentPtyId, newClaudeId, ...)`，而非 `sessionId`。
- **`autoWatchTranscript` 签名扩展**：需添加 `isPtyId: boolean` 和 `parentPtyId?: string` 两个参数，在 `isPtyId === false && parentPtyId` 时走 resume 绑定路径（跳过 PTY ptyId 作为 key 的早绑定）。
- **来源**：M4 S3 /branch 功能修复，2026-04-19

---

## [竞态] SESSION_BRANCH_LINK confirm 必须在 autoWatchTranscript 之前发送

- **内容**：branch 场景下，renderer 正确的 IPC 到达顺序应为：
  1. `SESSION_BRANCH_LINK confirm { parent=父PTY, child=旧ClaudeId }` — **先到**（renderer 进入 PENDING_BIND）
  2. `PTY_BIND { ptyId=父PTY, claudeId=新ClaudeId }` — **后到**（branchHandler 在 PENDING_BIND 状态正确处理）
- **旧 bug**：若 `autoWatchTranscript()` 调用在 `SESSION_BRANCH_LINK confirm` 发送之前，则当 `autoWatchTranscript` 同步找到已存在的 JSONL 文件时，PTY_BIND 会先发出，renderer 在 `PENDING_CONFIRM`（不是 `PENDING_BIND`）状态收到 PTY_BIND，`ptyBindHandler` 直接 `addToRealtime` → 新 session 显示 "Agent"。
- **修复**：在 `onHookEvent` 的 branch 确认块中，**先** `webContents.send(SESSION_BRANCH_LINK confirm)` **再** 调用 `autoWatchTranscript()`，保证 renderer 先进入 PENDING_BIND 再收到 PTY_BIND。
- **推论不变**：在 `PTY_BIND` handler 中读 `sessionRelationsAtom` 来做 relation migration 仍然失败（relation 由 branchHandler 在 handlePtyBind 内部写入，不是 PTY_BIND handler 写入的）。
- **实现位置**：`src/main/index.ts` → `onHookEvent` → branch 确认块
- **来源**：M4 S3 /branch 竞态修复，2026-04-19（记录）；2026-04-24（修复顺序 bug）

---

## [状态设计] sessionRelationsAtom 的 key 永远是 childSessionId（claudeId），禁止迁移到 ptyId

- **内容**：`sessionRelationsAtom` 的 Map key 始终是 `childSessionId`（Claude Code 内部 UUID，旧 branch claudeId），value 的 `parentSessionId` 字段是父 PTY 的 UUID。这两套 ID 完全不同，不可互换。
- **禁止做的事**：在 `PTY_BIND` handler 中把 relation 的 key 从 claudeId 迁移到 ptyId——这会造成 `parentSessionId === key` 的自引用，破坏 canvas 连线逻辑。
- **正确查法（LeftPanel）**：查"这个 ptyId 是否是某个 branch 的 parent"，用反向遍历：
  ```typescript
  const isBranchSession = Array.from(sessionRelations.values()).some(
    (r) => r.type === 'branch' && r.parentSessionId === sess.id
  )
  ```
  而不是 `sessionRelations.get(sess.id)?.type === 'branch'`（这会用 ptyId 当 childId 去查，永远找不到）。
- **来源**：M4 S3 /branch 功能修复，2026-04-19

---

## [Hook机制] Claude Code Hook 只支持 `type: "command"`，不支持 `type: "http"`

- **内容**：Claude Code settings.json 的 hook 配置**只接受 `type: "command"`**（shell 命令），JSON payload 通过 stdin 传入。`type: "http"` 格式在文档中不存在，写入后被**静默忽略**，hook 永远不会触发。
- **正确写法**：用 `curl -d @-` 将 stdin JSON 转发到本地 HTTP server：
  ```json
  { "hooks": [{ "type": "command", "command": "curl -s -X POST http://127.0.0.1:39521/hooks -H 'Content-Type: application/json' -d @-" }] }
  ```
- **排查方法**：在 project-level `.claude/settings.json` 写一个 command hook，`cd /your/project && claude --print "hello"`，若 server 收到请求则 hook 机制正常工作。
- **已修复位置**：`src/main/lib/config/SettingsManager.ts` 的 `injectHookConfig` 和 `removeHookConfig`。
- **来源**：2026-04-20 实际调试验证，hook server 从未收到任何事件，换 command 类型后立即触发

---

## [PTY启动] `--output-format stream-json` 禁止用于交互式 PTY session

- **内容**：`claude --output-format stream-json` 是为**程序化 pipe 调用**设计的，在 PTY 交互模式下使用会导致 claude 进入"等待 JSON stdin 输入"的 headless 模式，**SessionStart hook 不触发、JSONL 文件不写入**，直到用户手动输入第一条消息。
- **症状**：点击"启动 Session"后实时面板一直空白，5 分钟无任何 hook 或 JSONL 事件。
- **正确做法**：PTY 交互式 session 不传此参数；`dontAsk` 权限模式（`permissionModeToArgs`）才单独添加它。
- **已修复位置**：`src/main/lib/pty/PtyManager.ts` 的 `startSession` 和 `resumeSession` 方法，移除了顶层 `--output-format stream-json`。
- **来源**：2026-04-20 实际调试验证，PTY 启动后 claude UI 出现但 hook/JSONL 均无响应

---

## [React渲染] AgentBlock key 必须用 claudeId（稳定 UUID），不能用 ptyId（会重复）

- **内容**：LeftPanel 的 `AgentBlock` 列表 key 若用 `sess.id`（ptyId），在 `/branch` 后 resume 的短暂期间，branch entry 和主线 entry 的 `sess.id` 都是旧的分支 PTY UUID（如 `25f79b0c`），导致两个 `AgentBlock` 的 key 相同。React 遇到 key 冲突时先卸载后挂载，PTY_BIND 到达后 key 更新，但 DOM 残留旧节点，形成第 3 个**"幽灵框"**——有视觉但无 PTY 绑定（输入无效）。
- **根本原因**：resume 后 `handleSessionStart` 只更新 `status=Running`，不改 `id` 字段；此时两个 entry 的 `id` 都还是旧分支 PTY，直到 `autoWatchTranscript` 触发的 `PTY_BIND` 才更新主线 `id` 为新 ptyId。
- **修复方法**：`key={sess.claudeId ?? sess.id}`，claudeId 是跨 resume 永不改变的稳定标识，绝不会重复。
- **通用原则**：凡是 React 列表 key，必须用**业务语义稳定的唯一标识**（如 claudeId），而非会随生命周期变化的运行时 ID（如 ptyId）。
- **来源**：2026-04-20 /branch → resume 后 LeftPanel 出现 3 个框的问题排查

---

## [Canvas布局] Cluster-aware 布局：父框+branch子框作为整体单元，并行agent排外侧

- **内容**：历史进程面板的布局策略是 Cluster-aware：每个非 branch 子框的 session 是一个 Cluster 的父框，该 Cluster 包含父框及其左右两侧所有 branch 子框。并行 agent（独立 session）作为独立 Cluster 排在外侧，绝不会被插入到父框和 branch 子框之间。
- **关键计算**：Cluster 左侧宽度 = `max(lineLength + FRAME_WIDTH)` over all left-side branches；右侧同理；父框的 X 坐标 = `cursorX + leftSideWidth`，所有 Cluster 整体水平居中。
- **若不用此策略**：新增并行 agent 会被顺序插入列表，导致其位置落在父框和 branch 子框之间，branch 连线（BranchEdge）sourceHandle 和 targetHandle 不再对齐，连线断裂。
- **实现位置**：`src/renderer/src/hooks/useSessionFrameLayout.ts`
- **来源**：2026-04-20 并行 agent 与 branch 子框重叠问题排查

---

## [branchRegistry] FRAME_WIDTH 必须与 useSessionFrameLayout 保持同步

- **内容**：`branchRegistry.ts` 计算 branch 子框的 `lineLength`（连线长度）时依赖 `FRAME_WIDTH`。若 `branchRegistry.ts` 自定义了 `FRAME_WIDTH = 320`（旧值），而布局层使用 `FRAME_WIDTH = 1500`，则 lineLength 按旧值计算约为 128px，远小于实际帧宽，导致 branch 自然位置落在父框内部，触发误碰撞检测，branch 被推到错误位置，连线方向也随之错乱。
- **修复方法**：`branchRegistry.ts` 直接从 `useSessionFrameLayout.ts` import `FRAME_WIDTH` 和 `FRAME_GAP_X`，禁止本地重定义。
- **正确 lineLength 公式**：第 n 个同侧 branch 的 lineLength = `FRAME_GAP_X + (n-1) * (FRAME_WIDTH + FRAME_GAP_X)`（n 从 1 开始），第 1 个 branch 紧贴父框右侧（lineLength = FRAME_GAP_X = 40px）。
- **实现位置**：`src/renderer/src/capabilities/branchRegistry.ts`
- **来源**：2026-04-20 branch 子框位置错误 + 连线断裂排查

---

## [autoWatchTranscript] 必须跳过已被其他 PTY 绑定的 claudeId

- **内容**：新 PTY 启动时，`autoWatchTranscript` 扫描项目目录下的所有 JSONL 文件寻找 claudeId，若发现某 JSONL 文件的 claudeId **已绑定到另一个 PTY**（`claudeToPtyMap.get(claudeUuid) !== undefined && !== sessionId`），必须跳过该文件继续扫描，**不能**将新 PTY 绑定到此 claudeId。
- **症状**：新并行 agent 的 PTY 被错误绑定到 branch session 的 claudeId，导致主线 agent 在 LeftPanel 重复出现，branch 节点消失。
- **根本原因**：branch session 的 JSONL 是项目目录下最近修改的文件，`autoWatchTranscript` 优先找到它，误认为是新 PTY 对应的 session。
- **关键细节**：`done = true` 和 `clearTimeout(cleanup)` 必须在**所有验证通过后**才能设置，不能在发现文件时就提前设置（否则后续验证失败也无法重试）。
- **实现位置**：`src/main/index.ts` → `autoWatchTranscript` → `tryRegister()` 函数
- **来源**：2026-04-20 新并行 agent 被绑定到 branch claudeId 的问题排查

---

## [JSONL路由] autoWatchTranscript branch 路径必须用 claudeUuid 注册 watchFile

- **内容**：`autoWatchTranscript` 在 branch 路径中（`isPtyId=false`）用 `parentPtyId` 绑定了新 `claudeUuid`，但随即调用 `watchFile(filePath, sessionId, ...)` 时 `sessionId` 是**旧的 branch claudeId**，导致 JSONL 记录被路由到父 session 的 ProcessTimeline 而非 branch 框。
- **症状**：有时 branch 后的交互显示在主线框，有时显示在 branch 框（概率性）。概率性原因：renderer 的 `JSONL_WATCH` 请求用正确的新 claudeId 先注册了文件（`alreadyWatched=true` 跳过）时表现正确，`autoWatchTranscript` 先注册时路由错误。
- **修复方法**：引入 `effectiveClaudeId` 变量，branch 路径下赋值为新 `claudeUuid`；`watchFile` 和 `JSONL_BRANCH_SNAPSHOT` 都用 `effectiveClaudeId`，不用外层 `sessionId`（旧 claudeId）。
- **实现位置**：`src/main/index.ts` → `autoWatchTranscript` → `tryRegister()` 函数内 `watchFile` 调用处
- **来源**：2026-04-21 branch 交互概率性显示在主线框问题排查

---

## [Branch检测] 多Agent同cwd场景：SessionEnd 前必须保存 ptyId 再解绑

- **内容**：多 Agent 并行时（两个 PTY 同 cwd），`SessionEnd` hook 处理链路为：先 `unbindPtyFromClaudeSession(claudeId)` 删除 `claudeToPtyMap` 条目，再用 `findSessionByCwd(cwd)` 查父 PTY。但 `findSessionByCwd` 在多 PTY 同 cwd 时返回 Map 遍历第一个找到的（不一定是触发 `/branch` 的那个），导致 `pendingBranchByPtySession.get(wrongPtyId)` = undefined → branch 链路断裂 → 3s Ctrl+C 仍触发 → 杀死新 branch session。
- **修复方法**：在 `SessionEnd` 进入 `unbindPtyFromClaudeSession` **之前**，用 `claudeToPtyMap.get(payload.session_id)` 精确保存 `ptyIdBeforeUnbind`，branch 检测优先使用此值：`const parentPtyId = ptyIdBeforeUnbind ?? ptyManager.findSessionByCwd(cwd)`。
- **核心原因**：`claudeToPtyMap` 在解绑前有精确答案，解绑后信息丢失；`findSessionByCwd` 只适合单 PTY 场景。
- **实现位置**：`src/main/index.ts` → `onHookEvent` → SessionEnd 处理块
- **来源**：2026-04-21 并行 Agent 的 branch 被误判为新 Agent 并杀死 branch session 问题排查

---

## [防重] stdout "Branched conversation" 检测需要 30s 冷却防重复触发

- **内容**：PTY stdout 的 "Branched─conversation" 字符串在 branch 确认后仍会**多次出现**（回显、状态更新等），导致 branch 检测多次触发，创建多个 `SESSION_BRANCH_LINK` 和多余的 Agent Block。
- **解决方案**：在主进程 module 级别维护一个 `confirmedBranchPtyIds = new Set<string>()`，branch 确认后立即 `add(parentPtyId)`，同时 `setTimeout(() => delete(parentPtyId), 30_000)` 自动清理。检测到 stdout 时先检查 `!confirmedBranchPtyIds.has(sid)` 再处理。
- **典型症状**：不加防重时，`/branch` 会在 LeftPanel 显示 2 个 Agent Block；加防重后只显示 1 个。
- **来源**：M4 S3 /branch 功能修复，2026-04-19

---

## [Branch检测] knownBranchSessionIds 封禁父 session 导致第二次 /branch 变 Agent

- **内容**：曾存在的 `knownBranchSessionIds` Set 设计用于防止同一次 branch 事件被 SessionEnd/Notification/Stop 多个 Hook 重复处理，但 `add()` 的 key 是 `payload.session_id`（即 SessionEnd 的**父 session claudeId**）。父 session 再次发出 `/branch` 时 `SessionEnd(父session)` 再次触发，被该 Set 永久拦截，整个 branch 检测流程跳过 → renderer 停留在 PENDING_CONFIRM → 新 branch 被标记为 "Agent"。
- **复现条件**：开完第一个 branch 后**不关闭 branch**，直接回到主线再发第二个 `/branch`——此时主线 session 已被封禁一次。若关闭 branch 再操作，因为 CLAUDE_A 的 Resume 产生新 PTY session，SessionEnd 触发的时机不同，表现不一致。
- **根本原因**：`pendingBranchByPtySession.delete(parentPtyId)` 已经完美承担了"第一个 Hook 消费条目，后续 Hook 查不到条目自然跳过"的防重职责，`knownBranchSessionIds` 是多余且有害的。
- **修复**：完全删除 `knownBranchSessionIds` 的声明和所有使用（共 3 处）。
- **实现位置**：`src/main/index.ts`（已删除）
- **来源**：2026-04-24 实测验证，branch 保持运行时第二次 /branch 变 Agent 问题

---

## [历史加载] projects.json 的 sessionIds 是 ptyId，无法用于查找历史 JSONL

- **内容**：`~/.claude-driver/projects.json` 中 `project.sessionIds` 存储的是 **ptyId**（每次 resume 会变的 UUID），而 JSONL 文件名是 **claudeId**（永久 UUID）。两者完全不同，没有任何重叠——在 Test2 项目（312 个 JSONL 文件，224 条 sessionIds）中验证：0 个匹配。
- **正确做法**：扫描 `~/.claude/projects/<encoded-path>/` 目录，读每个 `.jsonl` **第一条含 `cwd` 字段的行**，按项目 path 过滤，以文件 mtime 排序。路径编码规则：`projectPath.replace(/[/\\:]/g, '-')`。
- **实现位置**：`src/main/index.ts` → `IPC.PROJECT_HISTORY_SCAN` handler
- **来源**：T8 实现，2026-04-21 实测验证

---

## [历史加载] JSONL 的 forkedFrom 字段是恢复历史 branch 关系的唯一来源

- **内容**：branch session 的 JSONL 文件**第一条含 `cwd` 的行**中有 `forkedFrom: { sessionId: string, messageUuid: string }` 字段，其中 `sessionId` 就是父 session 的 claudeId。这是历史加载时重建 `sessionRelationsAtom` 的唯一可靠来源，无需任何其他数据。
- **注意**：普通（非 branch）session 的 JSONL 第一行没有 `forkedFrom` 字段（或值为 null）。
- **实现位置**：`src/renderer/src/hooks/useHistoryLoader.ts` → `loadHistory()` 中的 sessionRelationsAtom 写入段
- **来源**：T8 实现，2026-04-21 实测验证

---

## [历史加载] subagent JSONL 在父 session 子目录下，需随主 JSONL 一并加载

- **内容**：subagent JSONL 路径为 `~/.claude/projects/<encoded>/<parentClaudeId>/subagents/agent-<agentId>.jsonl`。文件内 `sessionId` = 父 session 的 claudeId，`agentId` 字段为 subagent 标识。
- **加载时机**：主进程 `IPC.JSONL_WATCH` handler 在 `readFromStart=true` 历史模式下，主 JSONL 推送完成后**自动扫描同名子目录的 subagents/**，逐条以 `IPC.JSONL_SUBAGENT_RECORD` 推送，复用现有 jsonlHandler 逻辑。
- **目录查找公式**：`path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'), 'subagents')`
- **来源**：T8 实现，2026-04-21

---

## [拉动条] scrubberTarget 用 setTimeout 清零解决相同 nodeId 重复触发问题

- **内容**：`SessionFrameNode` 中 `scrubberTarget` state 控制 `ProcessTimeline` 的 `scrubberTargetNodeId` prop。当用户对同一个节点重复触发跳转时，因 state 值未变，React 不会触发 `useEffect`，导致第二次点击无效。
- **解决方案**：`handleJumpTo` 中在 `setScrubberTarget(nodeId)` 后立即 `setTimeout(() => setScrubberTarget(null), 50)`，50ms 后清零，下次跳转相同节点时 state 从 null 变为 nodeId，保证 effect 触发。
- **来源**：T8 实现，2026-04-21

---

## [插入线持久化] parsedAt 必须用 JSONL 自带 timestamp，不能用 Date.now()

- **内容**：插入线（`LineInsertion.timestamp`）来自 Hook 事件的真实触发时间（`hookEvent.receivedAt = Date.now()`），约为会话运行时间。JSONL 节点的 `parsedAt` 之前用 `Date.now()`（读取文件时刻），重启后重读会得到当前时间（比 Hook 触发时间晚数天）。
- **致命后果**：`ProcessTimeline` 渲染时用时间窗口过滤插入线：`ins.timestamp >= node.parsedAt && ins.timestamp < nextNode.parsedAt`。parsedAt 是未来时间，所有历史插入线的 timestamp 永远小于 parsedAt，**全部被过滤掉**，导致重启后插入线不显示。
- **修复方法**：在 `JsonlParser.ts` 中，优先用 JSONL 记录自带的 `timestamp` 字段（ISO 8601 字符串）做 `Date.parse()` 转为毫秒数作为 `parsedAt`，只有记录无 timestamp 时才回退到 `Date.now()`。
- **验证**：JSONL 记录的顶层 `timestamp` 字段格式为 `"2026-04-20T10:22:07.346Z"`，user/assistant 类型记录都有此字段。
- **实现位置**：`src/main/lib/jsonl/JsonlParser.ts` → `parseJsonlLine()` 最后的 `parsedAt` 赋值处
- **来源**：T9 插入线持久化，2026-04-22 实测验证

---

## [插入线持久化] JSONL 历史回放与 insertions.jsonl 回放双路径去重策略

- **内容**：重启后两条路径同时向 `lineInsertionsBySessionAtom` 写入插入线：
  1. `useHistoryLoader` 从 `<uuid>.insertions.jsonl` 回放所有持久化的插入线（包含工具调用类）
  2. `ProcessTimeline` 触发 `JSONL_WATCH`，`jsonlHandler` 的 `handleBatchRecords` 从 JSONL 重新提取 insight 插入线
- **冲突点**：insight 插入线同时来自两条路径，若 id 不稳定会产生重复；工具调用类插入线只来自 insertions.jsonl。
- **解决方案**：
  1. insight id 改为 `${sessionId}-insight-${record.uuid}`（依赖 JSONL record 的稳定 uuid），每次 JSONL 回放产生相同 id
  2. `appendInsertion` 内部检查 id 是否已存在，重复则跳过（不写入 atom 也不持久化）
- **禁止做的事**：用 `existing.length > 0` 整体跳过 insertions.jsonl 回放——两条路径的执行顺序不确定，先到的会把后到的完全阻断。
- **实现位置**：`src/renderer/src/capabilities/timelineStore.ts` → `appendInsertion()`；`src/renderer/src/business/jsonlHandler.ts` → `buildInsightInsertion()` id 字段
- **来源**：T9 插入线持久化，2026-04-22

---

## [Git操作] 主进程 execFileSync('git') 与 Claude Code PTY 不冲突；错误提取方式

- **内容**：在主进程用 `execFileSync('git', ['-C', cwd, ...])` 执行 git 操作，与 Claude Code 的 PTY 进程（stdin/stdout 通信）完全隔离，不会产生任何冲突。git 只操作 `.git` 目录和文件系统快照，与 PTY 无共享资源。
- **无需临时 PTY**：不需要为 git 操作单独开 PTY——`execFileSync` 更简单可靠，错误处理更直接。
- **错误提取**：`execFileSync` 抛出的异常对象上有 `stderr`/`stdout` 属性（`Buffer | string`），用 `GitManager.extractGitError(err)` 统一提取 git 真正的错误文本。`String(err)` 只有 Node.js 堆栈，不适合展示给用户。
- **所有 git shell 操作集中在 `GitManager.ts`**，IPC handler 只做委托，禁止在 `index.ts` 内部直接写 `execFileSync('git')`。
- **projectPath 来源**：git 操作的工作目录直接用 `session.cwd`（session 对象自带），不需要通过 projectId 查 projectsAtom。
- **来源**：Git 快照功能调试，2026-04-22；Git 重构，2026-04-25

---

## [渲染进程日志] console-message 白名单控制哪些渲染日志转发到命令行

- **内容**：主进程 `createWindow()` 里监听 `webContents.on('console-message')`，用前缀白名单过滤决定哪些渲染进程 `console.log` 输出到命令行。默认只转发 `[BL-x]`、`[Canvas]` 等特定前缀。
- **新增模块前缀时必须同步更新白名单**：否则新模块的日志只能在 DevTools 看到，命令行完全不可见，严重影响生产环境调试效率。
- **白名单位置**：`src/main/index.ts` → `createWindow()` → `RENDERER_LOG_PREFIXES` 数组
- **命令行输出格式**：`[Renderer:LOG] 消息`、`[Renderer:WARN] 消息`、`[Renderer:ERROR] 消息`
- **来源**：T9 插入线持久化调试，2026-04-22

---

## [React渲染] Hooks 必须在所有条件 return 之前调用，否则黑屏

- **内容**：React Rules of Hooks 要求所有 hook 调用（`useState`、`useEffect`、`useMemo`、`useCallback` 等）在每次渲染中**以完全相同的顺序**被调用。若某 hook 放在条件 `return` 语句之后，当条件成立时该 hook 被跳过，导致 React 内部的 hook 链条数量在不同渲染轮次之间不一致，直接抛出错误并渲染**黑屏**（无任何可见错误提示）。
- **典型症状**：点击某个页面/面板后画面全黑，DevTools 控制台显示 "Invalid hook call" 类错误。
- **修复方法**：把所有 hook 调用移到任何 `if (...) return ...` 语句之前——条件早返回只允许在全部 hook 之后出现。
- **实例（T11 修复）**：`ProcessLineCanvas.tsx` 中 `orderedSessionIds` 的 `useMemo` 原位于两个早期 return 之后（行 ~242），移到最后一个 return 之前（行 ~160）后黑屏消失。
- **来源**：T11 实现，2026-04-24 实测验证

---

## [项目识别] resolveProjectId 必须用最长路径匹配，首次匹配会命中父目录项目

- **内容**：`resolveProjectId(cwd, projects)` 用 `cwd.startsWith(project.path + '/')` 遍历 projects Map 时，若用**首次匹配**（找到即返回），当用户同时认领了 `/home/tony` 和 `/home/tony/Test4` 两个项目，`cwd=/home/tony/Test4` 会先命中 `/home/tony`（父目录），导致 plan 解析、Milestone 检测、倒三角指示器全部挂到错误的父项目下。
- **症状**：`loadPlanForProject returned null`（父目录没有 plan 文件），所有 Hook 触发的 plan 更新静默失败。
- **修复方法**：改为**最长路径匹配**——遍历所有匹配项，返回 `project.path.length` 最大的那个：
  ```typescript
  let bestId: string | null = null
  let bestLength = -1
  for (const [id, project] of projects) {
    if (cwd === project.path || cwd.startsWith(project.path + '/')) {
      if (project.path.length > bestLength) { bestId = id; bestLength = project.path.length }
    }
  }
  return bestId
  ```
- **安全性**：`+ '/'` 尾缀保证 `/home/tony/Test4` 不会误匹配 `/home/tony/Test4Extra`。
- **来源**：T10 Milestone 调试，2026-04-25 实测验证

---

## [Milestone定位] badge Y 坐标应用 frameHeight 而非 nodeIndex × 估算值

- **内容**：Milestone badge 定位到触发时刻的"内容末尾"，正确方法是读取 `sessionFrameHeightsAtom(sessionId)`（ResizeObserver 精确 DOM 高度），减去框头部和底部操作区高度后得到内容底部 Y 坐标。
- **错误方案**：用 `nodeIndex × NODE_HEIGHT_ESTIMATE`（120px/节点）—— `timelineBySessionAtom` 包含所有 tool_use/tool_result 小节点，节点总数远大于可见主节点数，实际高度约 3000px+，badge 溢出到框底部不可见区域。
- **正确公式**：
  ```
  topPx = frameHeight - FRAME_HEADER_HEIGHT(40) - FOOTER_HEIGHT(36) - (totalBadges - idx) × BADGE_HEIGHT(18)
  ```
- **`frameHeight` 来源**：`sessionFrameHeightsAtom` atomFamily，由 `SessionFrameNode` 的 `ResizeObserver` 实时维护，默认值 400px。
- **注意**：`NODE_HEIGHT_ESTIMATE=120` 注释已标注"fallback only，正常路径不再使用"，不应用于 UI 定位计算。
- **来源**：T10 Milestone 调试，2026-04-25 实测验证

---

## [Git架构] Git 操作三层分离：GitManager（shell）→ gitCapability（atom）→ UI

- **内容**：Git 相关代码严格分层，禁止越级调用：
  1. **基础设施层** `main/lib/git/GitManager.ts`：只做 `execFileSync('git', ['-C', cwd, ...])` shell 操作，返回 `{ ok, ... }` 或抛错。**禁止**在此层访问任何 Jotai atom 或 IPC。
  2. **能力层** `renderer/src/capabilities/gitCapability.ts`：接受 `Store` 参数，读写 Jotai atom + 触发 IPC 持久化。函数签名遵循 `function f(store: Store, claudeId: string, ...)` 模式（与 timelineStore.ts 对称）。
  3. **UI 层** `features/project-monitor/ProcessTimeline.tsx`：调用 capability 函数，不直接操作 atom。
- **原因**：将来若切换 git 策略（如恢复 Worktree），只需改 GitManager.ts，capability 和 UI 层不变。
- **来源**：M4 S4 Git 重构，2026-04-25

---

## [Git持久化] git-marks.jsonl：每 session 一个文件，GIT_MARK_DELETE 是重写而非追加

- **内容**：每个 session 的 git 快照记录存储在 `<transcriptDir>/<claudeId>.git-marks.jsonl`（与 `<claudeId>.insertions.jsonl`、`<claudeId>.milestones.jsonl` 同目录、同命名规范）。
- **关键差异**：
  - `GIT_MARK_SAVE`：追加新行（JSONL append 模式）
  - `GIT_MARK_DELETE`：**重写整个文件**（读取→过滤→写入），因为 JSONL 无法原地删除某行
  - 历史加载：`useHistoryLoader.ts` 在 milestones 回放后调用 `GIT_MARKS_LOAD` + `replayGitMarks()` 批量恢复 isGitted 状态
- **`GitMark` 类型**：`{ nodeId, sessionId, commitHash, createdAt }` 定义在 `shared/types/index.ts`
- **SessionHistoryMeta**：新增 `gitMarksPath: string | null` 字段，`PROJECT_HISTORY_SCAN` handler 扫描时同步查找此文件
- **来源**：M4 S4 Git 重构，2026-04-25

---

## [Git操作] git commit hash 必须用 rev-parse --short HEAD，不能解析 commit 输出文字

- **内容**：`git commit` 的 stdout 输出格式（如 `[main abc1234] message`）因 locale、git 版本、bare/non-bare 等差异可能变化，正则解析极不可靠。
- **正确做法**：commit 成功后立即执行 `git rev-parse --short HEAD`，这个命令输出**纯 hash 字符串**，永远可靠。
- **具体实现**（`GitManager.commit()`）：
  ```typescript
  execFileSync('git', ['-C', cwd, 'commit', '-m', msg], ...)
  const hash = execFileSync('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim()
  return { ok: true, commitHash: hash }
  ```
- **ProcessTimeline 渲染侧**：用 `if (result.ok)` 判断成功（不能用 `result.ok && result.commitHash`——空字符串 hash 是 falsy，会误判失败）
- **来源**：M4 S4 git snapshot 未知错误排查，2026-04-25

---

## [键盘导航] filter 结合解构 `[, r]` 丢弃 key 导致 self-inclusion silent no-op

- **内容**：在遍历 `Map.entries()` 时若用 `filter(([, r]) => ...)` 省略 key，**过滤条件中无法排除当前自身**（currentId），导致"查找邻居"的逻辑把自身也包含进结果集。返回自身后调用 `focusSession(sameId)` 不改变任何 atom 状态，表现为按键完全无反应（silent no-op）——是最难调试的一类 bug。
- **复现场景**：`useGlobalKeyNav.ts` 中 branch 向外侧方向按键时，查找同侧 sibling 的过滤器丢弃了 key，自身被计入 siblings，长度为 1 时返回自身。
- **修复方法**：从 branch 向"向外"方向按键时直接大跳相邻 cluster parent，不做 sibling 查找；或在过滤时显式排除 `id !== currentId`。
- **通用原则**：凡是"从关系 Map 中查找我的邻居"，必须加 `id !== currentId` 排除条件，否则自引用结果会导致 no-op。
- **来源**：T11 键盘导航调试，2026-04-25 实测验证

---

## [权限机制] Claude Code 权限提示是 TUI 选项型交互，非 y/n 字符输入

- **内容**：Claude Code 权限提示不是简单的"输入 y/n + 回车"的字符输入型，而是 TUI 选项型交互（类似 trust folder 对话框）。终端弹出 3 个选项：
  ```
  ❯ 1. Yes
    2. Yes, and don't ask again for ...commands in ...
    3. No
  Esc to cancel · Tab to amend · ctrl+e to explain
  ```
- **默认聚焦**：Yes（第 1 项），❯ 光标初始在 "1. Yes" 旁
- **导航**：方向键上/下切换选项，带 wrap 循环
- **Tab = amend**：切换到附加文字输入模式，可在选定选项后输入文字（对 Claude 的反馈），回车发送
- **按键映射**（用 rawWrite 发送 ANSI 转义序列，不自动追加 \r）：
  - 同意（无附加）：`\r`（直接回车，默认 Yes）
  - 拒绝（无附加）：`\x1bOB\x1bOB\r`（Down×2 到 No + Enter）
  - 同意 + 附加：`\t{msg}\r`（Tab + 文字 + Enter）
  - 拒绝 + 附加：`\x1bOB\x1bOB\t{msg}\r`
- **关键发现**：
  1. **按键时间间隔是核心**：一次性发送所有字节（如 `\x1b[B\x1b[B\r` 整体写入）会导致 TUI 来不及逐个处理，所有按键被忽略，结果全部变成"同意"（停留在默认 Yes）。必须逐个按键发送，每次间隔 ~50ms，TUI 才能正确响应。这是原 bug 的根本原因之一（与 y/n 字母问题并列）。
  2. **转义序列兼容性**：`\x1b[B`（普通模式）和 `\x1bOB`（应用光标模式）在有延时的情况下都能工作。代码使用 `\x1b[B`。
- **禁止发 y/n 字母**：TUI 是选项型交互，字母键被忽略（原 bug 根因）
- **真实时序**（实测验证，单实例环境）：
  1. Claude 欲用工具 -> PreToolUse hook fire
  2. 无 hook 决策 -> Claude 弹 TUI（立刻渲染）
  3. ~2s 后 PermissionRequest hook fire -> 驱动 app 审批面板显示
  4. 面板显示时 TUI 已就绪，用户点同意/拒绝发送按键序列到 PTY stdin
- **单实例约束**：HookServer 端口 39521 唯一。多实例运行时 hook 路由可能到另一实例，本实例的 PermissionRequest 不触发，审批面板不显示。
- **调试方法**：PTY onData 中可用 `stripAnsi(data)` + 关键词 `don't ask again` / `❯` + `Yes|No` 检测权限 TUI；用 `rawWrite` 发送按键（不用 `writeToSession`，后者自动追加 `\r` 会破坏转义序列）
- **来源**：M8 权限响应 bug 修复，2026-07-18 实测验证（`~/.claude-driver/permission-debug.log` 原始 PTY 输出）

