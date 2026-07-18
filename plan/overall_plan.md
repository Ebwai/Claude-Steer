# Claude Driver — 总体计划 (overall_plan.md)

> **版本**：v0.2.0-MVP  
> **目标**：实现 PRD Phase 1 全部功能  
> **兼容**：Claude Code ≥ 2.1.104  
> **更新日期**：2026-04-15（依据 PRD v0.2.0 + 架构 v0.1.0 更新）

---

## 架构选型理由

### 构建工具：electron-vite ✅（已确认）

| 对比项 | electron-vite | Electron Forge |
|--------|--------------|----------------|
| 主/渲染/Preload 独立 HMR | ✅ 三目标各自热更新 | ❌ 需要重启 |
| native module 支持 | ✅ externalize 配置清晰 | ⚠️ 需要额外插件 |
| React + TS 模板 | ✅ 官方模板开箱即用 | ⚠️ 需要手动配置 |
| 跨平台打包 | ✅ 配合 electron-builder | ✅ 内置打包 |

**选择理由**：开发体验更优（HMR 快），native module 处理更清晰，社区模板丰富。

### 状态管理：Jotai ✅（已确认）

| 对比项 | Jotai | Zustand |
|--------|-------|---------|
| 原子化订阅 | ✅ 精准 re-render | ❌ 整个 store 粒度 |
| 实时数据流适配 | ✅ atomFamily 天然匹配多 session | ⚠️ 需要手动 slice |
| IPC 桥接 | ✅ Vanilla Store API (`store.set`) | ✅ 同样支持 |
| 学习成本 | ⚠️ 偏底层 | ✅ 更直观 |

**选择理由**：项目有大量并发实时数据流（多个 session 的 Hook/statusLine/JSONL），Jotai 原子化订阅可精准控制 re-render 范围，避免进程线整体重绘。

### 进程线渲染：@xyflow/react 外壳 + CSS 滚动布局内容（混合方案）✅（已确认）

- **外壳（Session 框管理）**：`@xyflow/react`，每个 Session 是一个 `SessionFrameNode`（自定义 Node），支持并行框布局、动态高度、碰撞传导、zoom/pan 三态管理（全览/聚焦/跟随）
- **框内时间线内容**：CSS flex + overflow-y scroll（T1-T5 已用此方案验证），时间节点与十类插入元素作为子 DOM 元素渲染，不作为独立 @xyflow Node（避免节点数量爆炸）
- **全局监控左半画板**：独立的 `@xyflow/react` 实例，渲染项目卡片节点，与进程线画布完全隔离
- **原因**：进程线内容不需要画板缩放，但框之间的并行排布和动态高度碰撞需要 @xyflow 的程序化布局能力

---

## 计划状态说明

| 状态 | 标记 | 说明 |
|------|------|------|
| 待实现 | `[ ]` | 初始状态 |
| 已实现 | `[x]` | 已完成并验证 |
| 遇到问题 | `[!]` | 执行中遇到阻塞 |

---

## M1 — 项目脚手架与基础架构层 [ ]

> **交付物**：Electron 窗口启动，IPC 通信可用，顶/底栏骨架可见，CSS Design Token 就绪
> **验收标准**：`npm run dev` 后窗口出现，点击底部标签无报错，主题变量在 DevTools 可见

### S1 — electron-vite 项目初始化 [x]

- [x] T1 — 初始化 electron-vite + React + TypeScript 项目（官方模板 `electron-vite/react`）
- [x] T2 — 配置 native module 支持（node-pty electron-rebuild + postinstall 脚本）
- [x] T3 — 建立共享类型层（`src/shared/types/`、`src/shared/events/ipc-channels.ts`）
- [x] T4 — 配置 Electron ContextBridge IPC 框架（preload 暴露 `window.ipcRenderer`）

### S2 — UI 基础层 [x]

- [x] T1 — CSS Design Token 系统（`src/styles/tokens.css`，完整 `--bg/--or/--gr/--tx` 变量体系）
- [x] T2 — 顶部标题栏骨架（38px，红黄绿按钮 + Logo + 标题 + 运行状态）
- [x] T3 — 底部标签栏骨架（38px，全局监控/项目监控/消息通知 + 右侧统计信息）
- [x] T4 — 通用组件库：Modal（遮罩+关闭）/ StatusDot（5 种状态）/ TruncatedList（截断规则）/ TreeView（可展开树）

---

## M2 — 数据管道层（三通道融合）[ ]

> **交付物**：三通道均可接收数据，控制台可打印真实 Hook 事件和 statusLine JSON
> **验收标准**：在真实 Claude Code 进程中执行一次工具调用，仪表盘控制台同时打印 PostToolUse 事件 + statusLine token 数据

### S1 — HTTP Hook Server [x]

- [x] T1 — 主进程 39521 端口 HTTP Server（含端口冲突检测 + 弹窗提示）
- [x] T2 — settings.json 幂等合并注入 Hook 配置（读取现有 hooks 后 merge，原子写入防并发冲突）
- [x] T3 — Hook 事件解析（9 种事件类型）+ 内部 EventBus + IPC 推送到渲染进程

### S2 — node-pty 进程管理 [x]

- [x] T1 — PTY 启动 Claude CLI（P1）/ 停止（P6）/ 心跳检测每 10s（P4）
- [x] T2 — stdout 流 ANSI 控制码过滤（区分 Claude 正文输出 vs 终端转义序列）
- [x] T3 — stdin 消息队列（Q1-Q3）：入队/FIFO 出队/Stop Hook 触发自动注入
- [x] T4 — 进程超时 30min 自动关闭（P5）
- [x] T5 — 进程恢复 `claude --resume <session-id>`（P7，支持"回到对话"功能）
- [x] T6 — Claude 终端子窗口（P8）：xterm.js + 独立 BrowserWindow，用户可在前台命令行交互，程序可注入指令和关闭窗口

### S3 — JSONL 转录解析 [x]

- [x] T1 — JSONL 路径发现策略（优先 `statusLine.transcript_path`，降级到 cwd 路径匹配最新 JSONL）
- [x] T2 — chokidar 监听（depth:3 覆盖 subagents 目录树）+ tail 追加读取（避免重复处理）
- [x] T3 — 结构化消息解析（role/content/tool_use/tool_result/cwd）+ 工具调用详情提取（D13 字段规则）

### S4 — statusLine 桥接 [x]

- [x] T1 — 桥接脚本生成：Unix `~/.claude-driver/statusline-bridge.sh`（read + curl）；Windows `statusline-bridge.ps1`（Invoke-WebRequest）；写入后 chmod +x
- [x] T2 — settings.json 注册 `statusLine` 字段 + 39521/statusline 端点解析（model/context_window/transcript_path）

---

## M3 — 全局监控页面 [x]

> **交付物**：全局监控页完整可用，可新建项目，项目卡片显示正确，配置面板展示实际配置
> **验收标准**：新建一个项目后画板出现项目卡片，plan 列表可显示，配置面板 Agent/Skills/工具条目正确

### S1 — 左半：项目画板（@xyflow/react）[x]

- [x] T1 — 无限画板底板（radial-gradient dot grid 背景 + 用户节点 "我" + 缩放 0.3x~4x）
- [x] T2 — 进行中项目卡片（绿点 + 项目名 + plan 列表 + 双击跳转 + 动态节点高度计算）
- [x] T3 — 其他项目折叠卡片 + 待确认项目角标（橙色 ⚠️）
- [x] T4 — 倒三角执行指示器（PostToolUse plan 文件变动触发 → 5min 无变动销毁 / M任务完成3min销毁）
- [x] T5 — 左下角浮动按钮组（＋新建项目 / 💬 闲聊弹出 Claude 终端子窗口 / Plugins）

### S2 — 右半：配置面板 [x]

- [x] T1 — 全局统计卡片（常用模型 / 本月 Token / 累计费用 + 项目费用分摊浮层）
- [x] T2 — Agent 面板 + 经验面板（Skills / 工作流）：截断规则（≤3全显/＞3前2+···）+ 展开覆盖浮层 + 添加下拉
- [x] T3 — 工具面板（Tools / MCP / CLI 三列，读取 settings.json + agents/ 目录）
- [x] T4 — 功能入口按钮组（⏰定时触发 / 📡远程交互 / 💫灵魂交流）

### S3 — 创建项目 SOP [x]

- [x] T1 — 3步向导覆盖右侧面板（Step1 项目设置 / Step2 放入资产 / Step3 制定计划）
- [x] T2 — CLAUDE.md 模板变量替换写入（`{{PROJECT_NAME}}` 等）+ 项目 settings.json 权限配置
- [x] T3 — 自动启动 PTY（acceptEdits 权限）+ 弹出 Claude 终端子窗口（P8）+ 发送"创建计划"四字指令

### S4 — 初始化 SOP（首次启动）[x]

- [x] T1 — 选择根目录 + 递归扫描含 CLAUDE.md 的文件夹 + 路径前缀严格去重
- [x] T2 — 项目认领清单 UI（三态 1/0/-1 选择，-1 为默认，全局角标显示"N 待确认"）
- [x] T3 — 项目记录单持久化（`~/.claude-driver/projects.json`）+ 后续启动重新扫描逻辑

---

## M4 — 项目监控页面 [x]

> **交付物**：进程线实时更新，左侧工作情况面板正确显示当前工具调用，plan 状态同步
> **验收标准**：运行一个真实 Claude Code 任务，进程线追加节点，工具调用可见，plan 状态实时更新，Git 快照可创建
>
> **整体布局**：顶栏（两行：标签栏34px + 设置栏30px）+ 下方主区域左右二分（各 50%）
> - 左半（50%）：当前工作情况面板（flex 纵向四层布局，overflow:hidden，无外部滚动条）
> - 右半（50%）：历史工作进程线画布（可滚动无限画布，最右侧常驻 16px 全局历史导航条）
>   - 全局导航条：单条，覆盖整个画布高度，按 session 分段，支持点击跳框 + 鼠标拖拽
>   - 键盘导航：↑↓ 框内游标移动 + 视口微平移；←→ 框间跳转（cluster 内小跳 / 跨 cluster 大跳）

### S1 — 项目顶栏 [x]

- [x] T1 — 浏览器式项目标签（height:34px，仅显示运行中项目，✕关闭不终止进程）+ 末端「所有项目」展开按钮
- [x] T2 — 项目设置栏（8项设置：权限/模型/Tools/MCP/CLI/Skills/工作流/Plugins，竖线分隔 + 最右端「↑同步到GitHub」绿色按钮）

### S2 — 左半：当前工作情况面板 [x]

- [x] T1 — 执行计划折叠区（30px 折叠态 / 200px 展开态，左列 Plan 树 + 右列阅读窗格）
- [x] T2 — 当前工作情况区（层②：工具大框 Tools/MCP/CLI + 经验框 Skills/工作流 + Subagent 状态块 + 活跃 Insight 金色块 + 每 Agent Block 独立消息输入行）
- [x] T3 — 消息输入行（队列 + Stop Hook 触发 FIFO 自动注入）+ 打断按钮
- [x] T4 — 上下文面板（层④：System/CLAUDE.md/Memory/Skills/读取文件列表，含 token 估算占比）
- [x] T5 — 请求交互框（层③：拦截 PermissionRequest Hook → 同意/拒绝 + 可选附加信息 → PTY stdin 写入）
- [x] T6 — 底部状态栏（height ~20px，工作状态词 + 实时任务摘要；多 Agent 并行时显示"N Agents 并行"）

### S3 — 右半：历史进程线画布（@xyflow SessionFrame 外壳 + CSS 滚动内容）[x]

- [x] T1 — 进程线骨架（项目启动绿色标记 + 垂直左边框时间轴 + 圆形节点指示器）[CSS 内容层已实现]
- [x] T2 — 用户输入标记（蓝色小标签）+ Claude 回复节点（左侧响应文本卡片）
- [x] T3 — 工具/经验双框渲染（每节点右侧：蓝色 Tools 框 + 紫色经验框，某列无调用显示"--"）
  - Bug 修复：JsonlParser 原读取 `obj.content`（错误），实际格式为 `obj.message.content`；修正后工具调用正常渲染
- [x] T4 — 十类插入元素 A-J（插入线 + badge，详见架构.md 4.2.2；Subagent G 类含 mini 进程线嵌套块；F-type Insight 已实现：JSONL assistant 文本解析 + 左向长线 + 前20字展开badge）
- [x] T5 — 历史模式 vs 实时增量（打开已有项目：全量读 JSONL 批量渲染；运行中：chokidar tail 逐条追加）
  - Bug 修复（三处）：
    1. JsonlWatcher `add` 事件：预注册文件创建时 `!watchedFiles.has()` 误跳过 → 改为始终调用 `readNewContent`
    2. transcript 路径发现：增加 `autoWatchTranscript()` 主动扫描 `~/.claude/projects/<encoded>/` 目录，不依赖 hooks 触发（仿 agent-flow 方式）
    3. JSONL_WATCH ENOENT：历史读取前增加 `fs.existsSync` 守卫（session 刚启动文件尚未创建时跳过）
  - 已知限制：`--output-format stream-json` 模式下 PTY 进程在两次输入间保持存活，`status` 不自动变为 Completed（属正常行为）
- [x] T6 — @xyflow SessionFrameNode 外壳重构（SessionFrameNode 自定义 Node + 四态视口管理 + 动态高度碰撞传导）
- [x] T7 — 三种并行情形布局（情形1单框/情形2 /branch 继承记忆连线/情形3多 Session 并排）
- [x] T8 — 历史进度拉动条（以用户输入为区间，支持鼠标拖动 + 键盘↓键 + 左侧面板 plan 指针联动）
- [x] T9 — 节点交互菜单（权限分层：普通节点/已git节点/最后节点/用户输入节点，各有不同操作集）
- [x] T10 — 任务里程碑标记（Milestone）：框左侧紫色 badge，Plan 最低级状态变完成时插入
- [x] T11 — 全局历史导航条与键盘导航（单条全局滚动条 + ↑↓游标移动 + ←→框间跳转 + 游标 overlay）

### S4 — Git 集成（单 main 分支策略，已废弃 Worktree 方案）[x]


- [x] T1 — 架构重构：新建 `lib/git/GitManager.ts`（基础设施层）+ `capabilities/gitCapability.ts`（能力层），迁移所有 git shell 操作；`ipc-channels.ts` 新增 6 个 Git IPC 通道
- [x] T2 — Git 快照（`git add -A && git commit` + `rev-parse --short HEAD` 取 hash）+ 节点颜色标记（深蓝绿 `ptl-dot-gitted`）+ `git-marks.jsonl` 持久化（重启后 isGitted 状态恢复）
- [x] T3 — 回退操作（`git reset --hard <hash>`）+ 内联二次确认（`GittedNodeActionBar` 独立组件）
- [x] T4 — 推送到 GitHub（`git push origin main`）+ `GIT_GET_STATUS` 检测 remote + 未配置时弹出引导 Modal（`ProjectSettingsBar.tsx`）
- [x] T5 — 删除 commit（`git rebase --onto <hash>^ <hash>`，非交互式）+ 成功后 `unmarkNodeGitted` 清除 isGitted 标记 + `git-marks.jsonl` 同步删除对应条目
- [x] T6 — 错误边界处理：所有 git 操作错误通过 `extractGitError` 提取 stderr，渲染层按场景显示内联提示文字

---

## M5 — 消息通知 + 全局设置 [x]

> **交付物**：通知页面可显示并处理 Agent 请求，全局设置所有项可保存并即时生效
> **验收标准**：触发一次权限请求，通知页面出现条目 + 桌面通知弹出，全局设置修改模型后新 session 使用新模型

### S1 — 消息通知页面 [x]

- [x] T1 — 消息通知页面骨架 + 左侧请求列表（复用 `permissionRequestsAtom`，按 agentName 分组，FIFO 排序）
- [x] T2 — 右侧详情面板 + 审批操作（同意/同意+附加信息/拒绝 → `IPC.PERMISSION_RESPOND` → `dequeueRequest` 同步清除两处 UI）
- [x] T3 — 桌面通知 + 任务栏角标（主进程 `NotificationService.ts`；Linux/macOS: `app.setBadgeCount`；Windows: `setOverlayIcon` 红点；由 `HookEventBus` 在 PermissionRequest 时触发）

### S2 — 全局设置 Modal [x]

- [x] T1 — Modal 骨架（640px 居中，80vh 高度，顶部横向 Tab 锚点导航 10 个分区，复用现有 `Modal` 组件）
- [x] T2 — API / 模型 / 语言 / 权限 分区（读写 `~/.claude/settings.json`，通过 `IPC.CONFIG_WRITE { scope:'claude' }`）
- [x] T3 — Token费用/通知（读写 `~/.claude-driver/config.json`，新增 `DriverConfigStore.ts`）/ 偏好（主题切换纯 renderer，不经主进程）/ 记忆 / 存储
- [x] T4 — 配置导出/导入（新增 `IPC.DIALOG_SAVE_FILE` + `IPC.DIALOG_OPEN_FILE`）+ API 连通性测试（新增 `IPC.API_TEST`）+ 关于分区

---

## M6 — 功能入口 [ ]

> **交付物**：所有功能入口可交互，/insight 可生成并打开报告，定时任务可创建
> **验收标准**：/insight 调用后生成 HTML 报告并在内嵌 WebView 打开；定时任务创建后 CronList 可查到

### S1 — 灵魂交流 Modal [x]

- [x] T1 — Auto-Dream 卡片：点击显示"此功能 Claude Code 暂时未全面开放，敬请期待"弹窗，不写入任何配置
- [x] T2 — /insight 卡片：临时 PTY 在 home 目录裸启 claude → 发 /insights → 等待 report.html → 推送 info 通知 → WebView 打开；全局 loading badge；insight 状态提升为全局 atom

### S2 — 定时触发 [x]

- [x] T1 — 两 Tab Modal（Claude介入 / 脚本触发"开发ing"）+ IPC 通道 + 主进程 handler（startBare PTY / schedulerClaudeIds 按 claudeId 隔离 hook 路由）
- [x] T2 — 任务列表 UI（项目名/间隔/提示词/剩余天数/Toggle ON-OFF/重新创建/删除）+ 3s 轮询刷新 isActive + 持久化 scheduler-sessions.json

### S3 — 远程交互（cc-connect）[x]

- [x] T1 — cc-connect 安装检测（`which cc-connect` / `where cc-connect`）+ 引导安装流程（未安装时复用闲聊 PTY 打开终端预填 npm install 命令）
- [x] T2 — 飞书平台配置向导（5步：应用创建 → 权限配置 → 长连接事件订阅 → 填写凭证 → 发布引导）
- [x] T3 — cc-connect 配置文件生成（`~/.cc-connect/config.toml`，多项目 [[projects]] 嵌套格式）+ 服务启停 + 状态检测

### S5 — 闲聊 PTY [ ]

- [ ] T1 — 新增 `CHAT_START` IPC 通道 + 主进程 `startBare` handler（chatPtyIds 隔离 Hook 路由）+ CanvasPanel 按钮绑定 + `TERM_WINDOW_OPEN` 弹出终端

### S4 — Plugins 面板 [ ]

- [ ] T1 — 已安装 Plugin 列表（读取 `~/.claude/settings.json` 的 `enabledPlugins` 字段）+ 删除功能
- [ ] T2 — Plugin 详情展示（点击后显示：应用场景/作用/包含的 MCP/Skills/Hooks）
- [ ] T3 — 添加 Plugin 按钮（第一阶段：点击显示"还在开发中"提示，不执行任何操作）

---

---

## M7 — Token 统计（能力层重构 + UI 接入）[x]

> **交付物**：每个 session 框底部显示真实 token 消耗；全局监控面板本月 Token / 累计费用 / 常用模型显示真实数值；项目监控面板显示该项目总消耗；价格配置联动费用重算
> **验收标准**：打开有历史的项目，框底部显示非零 token；运行 Claude Code 任务，框 token 实时递增；全局面板月度/累计统计非零；修改价格后费用自动重算

### S1 — tokenCapability 能力层 [x]

- [x] T1 — 新建 `capabilities/tokenCapability.ts`（token 所有写入的唯一入口）+ atom 重构 + 主进程 `TOKEN_SCAN_FILE` IPC 通道 + `JsonlParser` 解析 usage 字段

### S2 — UI 显示接入 [x]

- [x] T1 — session 框底部 token 显示 + 全局监控面板数据接通 + 历史加载触发扫描 + driverConfig 价格联动

---

## M8 - 修复聚合通知推送的权限响应策略（y/n -> TUI 按键）[x]

> **背景**：M4 S2 T5（请求交互框）与 M5 S1 T2（消息通知审批）已标记完成，但权限响应策略错误--
> 往 PTY stdin 注入 'y'/'n'，而 Claude Code 权限提示实为 TUI 选项型交互（默认聚焦 Yes，方向键切换 + 回车确认，Tab 进入 amend），字母键被忽略，导致同意/拒绝失效。
> **根因**：设计阶段对 Claude Code 权限交互机制认知错误，误以为是字符输入型（y/n + 回车），实际是 TUI 选项型。错误假设贯穿 PRD/Architecture/TDD/knowledge。
> **真实机制**（实测验证，日志见 `~/.claude-driver/permission-debug.log`）：
>   1. Claude 欲用工具 -> PreToolUse hook fire（hook-bridge 转发到 app）
>   2. 无 hook 决策 -> Claude 弹 TUI：❯ 1. Yes（默认聚焦）/ 2. Yes-and-don't-ask / 3. No；底部 "Esc to cancel · Tab to amend"
>   3. ~2s 后 PermissionRequest hook fire -> 驱动 app 审批面板显示
>   4. 用户在面板点同意/拒绝 -> 应发按键序列（非 y/n）
> **按键映射**（rawWrite 发送，不追加 \r）：同意=`\r`；拒绝=`\x1b[B\x1b[B\r`；同意+附加=`\t{msg}\r`；拒绝+附加=`\x1b[B\x1b[B\t{msg}\r`
> **交付物**：审批面板同意/拒绝（含附加信息）正确驱动 Claude TUI 完成权限响应；全栈文档纠正 y/n 错误描述；Important_Info 记录真实机制。
> **验收标准**：触发权限申请 -> 面板弹出 -> 点同意 Claude 继续 / 点拒绝 Claude 取消 / 带附加信息消息送达 Claude；临时调试代码已移除。

### S1 - 修改 PRD 中权限响应的错误描述 [x]

- [x] T1 - PRD §2.2.2（line 437）「底层：...注入 y/n + 附加文字」-> 改为 TUI 按键机制描述
- [x] T2 - PRD 交互流程（line 770）「用户同意/拒绝（可附加信息）-> 注入 y/n」-> 改为「发 TUI 按键序列」

### S2 - 修改 Architecture 类文档 [x]

- [x] T1 - 修改 `.claude/rules/architecture/src/renderer/features/notifications.md`「IPC.PERMISSION_RESPOND（y/n + 附加 -> PTY stdin）」-> 按键序列
- [x] T2 - 排查其他 Architecture 文档是否有 y/n 描述并修改（另改 `src/main/lib.md` 的"权限审批 y/n"，block-sync 同步至 features.md/main.md，已验证）

### S3 - 修改 TDD 类文档 [x]

- [x] T1 - 修改 `.claude/rules/tdd/src/renderer/features/notifications.md`「IPC.PERMISSION_RESPOND（y/n + 附加 -> PTY stdin）」-> 按键序列 + 记录实测发现（时序/按键映射/单实例约束）
- [x] T2 - 排查其他 TDD 文档（`tdd/src/main/lib.md` 的"权限审批 y/n"已改，block-sync 已验证同步）

### S4 - 修改代码 [x]

- [x] T1 - 修改 `claude-driver/src/main/index.ts` PERMISSION_RESPOND handler：'y'/'n' + writeToSession -> 按键序列 + rawWrite
- [x] T2 - 更新 `claude-driver/knowledge/交互业务层.md` BL-11「writeToSession(ptyId, 'y\r')/'n\r'」-> rawWrite 按键序列
- [x] T3 - 移除全部临时调试代码（capturePermissionPromptDebug + PERMISSION_DEBUG_FILE + onHookEvent 日志 + 捕获窗口 + hook 事件标记，共 5 处，grep 确认无残留）

### S5 - 验收收尾 [x]

- [x] T1 - 实测三场景：同意 / 拒绝 / 带附加信息（用户确认全部成功，突破点：按键时间间隔 + 应用光标模式 `\x1bOB`/`\x1b[B`）
- [x] T2 - 同步实测与 Architecture/TDD 文档的差异（Architecture/TDD/交互业务层/Important_Info 均已更新，block-sync 验证通过）
- [x] T3 - 更新 `knowledge/Important_Info.md` 记录 Claude Code 权限 TUI 真实机制与时序（新增「[权限机制]」条目，含时间间隔关键发现）

---

## M9 — 聚合通知支持点击关闭 [x]

> **背景**：用户希望在项目监控界面和消息通知界面的聚合通知中，每个推送支持点击关闭（dismiss），而不必进行审批操作。
> **需求**：在权限请求列表的每个条目上添加"关闭"按钮，允许用户关闭单个通知而不进行审批。关闭后通知从列表消失，但 Agent 继续等待（不会收到审批响应）。
> **交付物**：
>   1. 新增 `IPC.PERMISSION_DISMISS` 通道
>   2. 消息通知界面（NotificationsPage）每个权限请求条目添加"关闭"按钮
>   3. 项目监控界面（RequestApprovalPanel）每个审批卡片添加"关闭"按钮
>   4. 主进程处理关闭操作，更新角标计数
>   5. 更新 PRD、Architecture、TDD 文档
> **验收标准**：
>   1. 触发权限请求后，在消息通知界面和项目监控界面都能看到"关闭"按钮
>   2. 点击"关闭"按钮后，该通知从列表消失
>   3. 角标计数正确更新（-1）
>   4. Agent 继续等待，不会收到任何审批响应
>   5. 文档已更新

### S1 — 修改 PRD 文档 [x]

- [x] T1 - 更新概念三：消息通知界面，添加"关闭"功能的描述
- [x] T2 - 更新机制五：系统通知推送，说明关闭操作也会更新角标

### S2 — 修改 Architecture 类文档 [x]

- [x] T1 - 修改 `.claude/rules/architecture/src/renderer/features/notifications.md`，添加"关闭"操作的描述
- [x] T2 - 修改 `.claude/rules/architecture/src/main/lib/notification.md`，说明关闭操作也会调用 decrementBadge

### S3 — 修改 TDD 类文档 [x]

- [x] T1 - 修改 `.claude/rules/tdd/src/renderer/features/notifications.md`，添加"关闭"操作的流程
- [x] T2 - 修改 `.claude/rules/tdd/src/main/lib/notification.md`，说明关闭操作也会调用 decrementBadge

### S4 — 修改代码 [x]

- [x] T1 - 在 `ipc-channels.ts` 中新增 `IPC.PERMISSION_DISMISS` 通道
- [x] T2 - 在 `main/index.ts` 中添加 `PERMISSION_DISMISS` 的处理逻辑（只更新角标，不发送按键）
- [x] T3 - 修改 `NotificationsPage.tsx`，在权限请求条目上添加"关闭"按钮，调用 `IPC.PERMISSION_DISMISS`
- [x] T4 - 修改 `RequestApprovalPanel.tsx`，在审批卡片上添加"关闭"按钮，调用 `IPC.PERMISSION_DISMISS`
- [x] T5 - 更新 i18n 翻译文件，添加"关闭"按钮的翻译文本

### S5 — 验收收尾 [x]

- [x] T1 - 实测：触发权限请求 -> 点击"关闭" -> 通知消失 -> 角标更新 -> Agent 继续等待
- [x] T2 - 同步实测与 Architecture/TDD 文档的差异
- [x] T3 - 更新 `knowledge/Important_Info.md`（如有需要）- 无需更新，关闭操作是简单的 UI 操作，不涉及特殊技术细节

---

## 依赖链总览

```
M1（环境就绪）
  └─▶ M2（数据管道）
        └─▶ M3（全局监控，第一个可演示页面）
              └─▶ M4（项目监控，核心监控功能）
                    ├─▶ M5（通知+设置，辅助功能）
                    └─▶ M6（功能入口，扩展功能）
                          └─▶ M9（聚合通知关闭功能）
```

**M5 和 M6 可在 M4 完成后并行开发**（彼此无依赖）。M9 依赖 M5 完成。
