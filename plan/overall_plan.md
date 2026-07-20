# Claude Driver — 总体计划 (overall_plan.md)

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

## M1 — 项目脚手架与基础架构层 [x]

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

## M2 — 数据管道层（三通道融合）[x]

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

## M6 — 功能入口 [x]

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

### S5 — 闲聊 PTY [x]
- [x] T1 — 新增 `CHAT_START` IPC 通道 + 主进程 `startBare` handler（chatPtyIds 隔离 Hook 路由）+ CanvasPanel 按钮绑定 + `TERM_WINDOW_OPEN` 弹出终端

### S4 — Plugins 面板 [x]

- [x] T1 — 已安装 Plugin 列表（读取 `~/.claude/settings.json` 的 `enabledPlugins` 字段）+ 删除功能
- [x] T2 — Plugin 详情展示（点击后显示：应用场景/作用/包含的 MCP/Skills/Hooks）
- [x] T3 — 添加 Plugin 按钮（第一阶段：点击显示"还在开发中"提示，不执行任何操作）

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

## M10 - 聚合通知独立窗口化 [ ]

> **背景**：当前聚合通知（权限请求审批）分散在两处：① 主窗口 LeftPanel 的 `RequestApprovalPanel`（实时工作区弹出审批卡片）；② 主窗口 notifications tab 的 `NotificationsPage`（列表+详情双栏）。用户希望将聚合通知独立成一个单独窗口，与实时监控面板解耦，窗口真正独立于主窗口（主窗口最小化不影响它），并按"正在运行的项目"自动分割，每条通知支持展开查看详情（复用历史工作面板触发线的可视化）。
> **需求**（已与用户确认 17 项决策）：
>   1. 独立 `BrowserWindow`，不设 `parent`（仿 `chatWindow`），主窗口最小化不影响它；`alwaysOnTop` 可配置（默认开，全局设置·通知开关）；600×600 正方形默认尺寸（宽参照原 rap-card）
>   2. 单例窗口（非多实例）；顶栏新增"打开独立通知窗口"按钮；移除主窗口 notifications tab 与 LeftPanel 的 `RequestApprovalPanel`
>   3. 三个打开途径：① 用户手动点击顶栏按钮；② 权限请求来时自动打开（可配置默认开，全局设置·通知开关；即使窗口隐藏到托盘）；③ insight 报告完成时自动打开（窗口不存在则创建，已存在则聚焦）
>   4. 关闭按钮 = 隐藏到托盘（窗口存活），新通知来时恢复显示+抢焦点置顶
>   5. 窗口内按"正在运行的项目"纵向分割，每区=项目名头+独立滚动列表；项目停止运行时分割区+通知全部移除（无兜底区）
>   6. 运行中项目判定：镜像 LeftPanel 的 `projectSessions` 逻辑（`ptySessionIds.has` + `Running/Paused` + `pathMatches`），count≥1 即为运行中
>   7. 每条通知 2 行：① Agent框名称（`req.agentName`，主线程/Agent(xxxxxx)）+ 调用名称 + 展开按钮 + 关闭按钮；② 4 交互 Yes/No（同意/同意+消息/拒绝/拒绝+消息，逻辑同 `RequestApprovalPanel`）
>   8. 展开详情复用 `LineInsertionItem.renderToolDetail`，数据源 `PermissionRequest.toolInput` -> `badgeContent`；颜色复用历史面板 type 配色（工具类橙 `#e6430d` / 经验类棕 `#DA7756`）
>   9. 通知范围：权限请求 + insight 报告完成通知（info/warning/error 类通知不在此窗口展示）
>   10. 底层不动：Hook 层、`NotificationService`、`toolInput` 捕获均不变
> **交付物**：
>   1. 新增独立通知窗口能力（main 进程窗口管理 + IPC 路由 + renderer 路由 `#/notifications`）
>   2. 顶栏按钮 + 主窗口 tab/RequestApprovalPanel 移除
>   3. 通知窗口 UI：项目分割 + 2 行通知项 + 展开详情
>   4. 运行中项目检测派生 atom（复用 LeftPanel 逻辑）
>   5. 自动打开/恢复+抢焦点机制（含 insight 报告完成时的自动打开）
>   6. 全局设置·通知新增"窗口始终置顶""权限请求时自动打开"两个开关（读写 `~/.claude-driver/config.json`，默认开）
>   7. 更新 PRD、Architecture、TDD 文档
> **验收标准**：
>   1. 触发权限请求 -> 通知窗口自动打开（置顶）-> 通知项出现在对应项目分割区
>   2. 主窗口最小化 -> 通知窗口依然可见
>   3. 点通知项展开按钮 -> 显示工具调用详情（与历史面板触发线一致的着色与字段）
>   4. 同意/拒绝（±消息）/关闭 四类操作正确驱动 PTY（逻辑同 RequestApprovalPanel）
>   5. 多项目并行 -> 窗口内出现多个纵向分割区，各自独立滚动
>   6. 项目所有 session 结束 -> 对应分割区及通知移除
>   7. 关闭窗口 -> 隐藏到托盘；新通知来 -> 恢复+抢焦点
>   8. 文档已更新（PRD/Architecture/TDD）

> **架构选型**（决策 1-3，用户已确认全部 A 方案）：
>   1. **通知窗口数据流**：通知窗口自建 Jotai store + 复用 handler 工厂（createPermissionHandler / createPtyBindHandler / createSessionLifecycle），HookEventBus 改广播 IPC.HOOK_EVENT/PTY_BIND/SESSION_STATUS 到 mainWindow + 通知窗口。通知窗口独立处理状态，无代码重复。选择理由：工厂函数已是现成的可复用模块（接收 store 参数），广播改动最小（改 HookEventBus.send 为 sendAll），通知窗口自包含不依赖 mainWindow renderer。
>   2. **展开详情复用**：抽取 LineInsertionItem 的 renderToolDetail + buildToolCompact + hasToolDetail 到共享 utility `renderer/src/shared/toolDetailRender.tsx`，LineInsertionItem 和通知窗口都引用（DRY）。选择理由：这些函数已包含 Read/Write/Edit/Bash/Grep 等十类工具的完整详情渲染逻辑，抽取后零代码重复。
>   3. **运行中项目检测**：新增 `runningProjectsAtom` 派生 atom（复用 LeftPanel projectSessions 逻辑：ptySessionIds.has + Running/Paused + pathMatches），放 `renderer/src/atoms/projects.atom.ts`。LeftPanel 现有内联逻辑替换为引用此 atom（统一数据源）。选择理由：派生 atom 自动随依赖 atom 更新，两处（LeftPanel + 通知窗口）各自 store 独立计算，无需 IPC 同步。

### S1 - 修改 PRD 文档 [x]

- [x] T1 - 重写概念三：消息通知界面（独立窗口化 + 项目分割 + 展开详情 + 2 行布局 + 可配置性）
- [x] T2 - 更新机制五：系统通知推送（通知窗口替代 NotificationsPage；自动打开机制；通知窗口设置）
- [x] T3 - 重构骨架 2.0 消息通知界面子节点；移除项目监控下的"Agent 请求审批框"骨架节点
- [x] T4 - 移除 2.2.2 子概念"Agent 请求审批框"（功能迁到独立通知窗口）+ 重编号 2.2.3→2.2.2（上下文面板）、2.2.4→2.2.3（状态栏）
- [x] T5 - 更新痛点映射需求6（移除"Agent 请求审批框"映射）；更新需求2/需求6 对"消息通知界面·独立通知窗口"的引用
- [x] T6 - 更新 3.3 交互流程与 4.2 异常处理（审批框 -> 独立通知窗口）
- [x] T7 - 更新全局设置·通知分区（新增"窗口始终置顶""权限请求时自动打开"两个开关，默认开）

### S2 - 修改 Architecture 类文档 [x]

- [x] T1 - 重写 `architecture/src/renderer/features/notifications.md`（独立窗口 + 项目分割 + 展开详情 + 自建 store + handler 工厂复用 + 共享 toolDetailRender）
- [x] T2 - 修改 `architecture/src/main.md`（新增 notificationWindow 管理 + HookEventBus 广播 + 通信方式 + 关键交互场景）+ 修改 `main/lib/config.md`（新增两个 DriverConfig 字段）
- [x] T3 - 修改 `architecture/src/renderer/atoms.md`（新增 runningProjectsAtom 派生 atom）
- [x] T4 - 修改 `architecture/src/renderer/features/project-monitor.md`（移除 RequestApprovalPanel + 移除 PERMISSION_RESPOND）+ 修改 `renderer/features.md`（notifications 描述更新）+ 修改 `main/lib/notification.md`（自动打开机制）+ 修改 `main/lib/hook-server.md`（广播架构图）
- [x] T5 - block-sync 同步上层文档（已运行，所有 leaf→parent 同步成功）

### S3 - 修改 TDD 类文档 [x]

- [x] T1 - 重写 `tdd/src/renderer/features/notifications.md`（独立窗口 + handler 工厂 + 项目分割 + 展开详情 + 窗口管理）
- [x] T2 - 修改 `tdd/src/main/lib/notification.md`（自动打开+聚焦）+ `tdd/src/main/lib/hook-server.md`（HookEventBus 广播 API）+ `tdd/src/main/lib/config.md`（DriverConfig 新增两个字段）
- [x] T3 - 修改 `tdd/src/renderer/atoms.md`（projects.atom 新增 runningProjectsAtom）
- [x] T4 - block-sync 同步上层文档（已运行，所有 leaf→parent 同步成功）

### S4 - 修改代码 [x]

- [x] T1 - `shared/events/ipc-channels.ts`：新增 `NOTIFICATION_WINDOW_OPEN` 通道
- [x] T2 - `main/index.ts`：openNotificationWindow() helper + IPC handler + HookEventBus 广播 + PTY_BIND/UNBIND 广播到通知窗口 + sessionCwdMap catch-up + 权限请求自动打开 + DriverConfig 读取
- [x] T3 - `renderer/src/App.tsx`：新增 `#/notifications` 路由 + NOTIFICATION_FOCUS_TAB 改为打开通知窗口 + 移除 notifications tab 渲染 + TabId 移除 'notifications'
- [x] T4 - `renderer/src/components/TitleBar`：新增 🔔 按钮（IPC.NOTIFICATION_WINDOW_OPEN）+ CSS
- [x] T5 - `renderer/src/features/notifications/NotificationWindowPage.tsx`：自建 handler 工厂注册 + 项目分割 + 2 行通知项 + 展开详情（toolInput 格式化 + 按工具类型着色）+ 4 交互 Yes/No + CSS
- [x] T6 - `renderer/src/atoms/projects.atom.ts`：新增 `runningProjectsAtom` 派生 atom + `RunningProject` 接口
- [x] T7 - 移除 BottomBar notifications tab + AppInner notifications 渲染 + INSIGHT_REPORT_READY 不再切 tab
- [x] T8 - i18n：zh-CN + en 新增 titlebar.openNotifications / notifications.noRequests / notifications.otherRequests / settings.notificationSection.alwaysOnTop/autoOpen
- [x] T9 - NotificationSection.tsx 新增两个开关 + shared/types DriverConfig 新增 notifWindowAlwaysOnTop / notifWindowAutoOpen

### S5 - 验收收尾 [ ]

- [ ] T1 - 实测全部验收标准（8 项）
- [ ] T2 - 同步实测与 Architecture/TDD 文档差异
- [ ] T3 - 更新 `knowledge/Important_Info.md`（如有需要）

---

## M11 - 修复实时工作区与上下文面板之间的无效留白 [x]

> **背景**：M10 将聚合通知审批框迁移到独立通知窗口后，项目监控页 `LeftPanel` 已不再渲染 `RequestApprovalPanel`，但审批框与上下文面板之间原有的弹性空白占位仍然保留，导致当前工作情况区的可视范围提前结束。
> **根因**：`LeftPanel.tsx` 在 `.lp-agent-list` 与 `ContextPanel` 之间仍渲染 `<div style={{ flex: 1, minHeight: 0 }} />`；该节点继续占用纵向剩余空间，与已经移除的审批面板生命周期不一致。
> **方案选择**：复用现有 column flex 布局，让 `.lp-agent-list` 成为上下文面板上方唯一的弹性区域，删除失去职责的空白占位。相比新增高度计算或绝对定位，此方案不引入窗口尺寸常量，可随 Windows、macOS、Ubuntu 的可用高度自适应。
> **验收标准**：当前工作情况区的可视框底边与上下文面板顶部分隔线重合；窗口缩放、多 Agent 列表滚动、无活跃 Session 状态均不产生覆盖或额外空白。

### S1 - 阅读并修改 PRD 中的对应内容 [x]

- [x] T1 - 确认实时工作区纵向三层布局的边界约束并向用户说明修改点
- [x] T2 - 用户确认后补充当前工作情况区与上下文面板无间隙衔接规则

### S2 - 查找并修改 Architecture 类文档 [x]

- [x] T1 - 沿 project-monitor 文档链确认 LeftPanel 弹性布局职责
- [x] T2 - 更新对应叶子 Architecture 文档并由 block-sync 级联同步

### S3 - 查找并修改 TDD 类文档 [x]

- [x] T1 - 确认 LeftPanel 当前工作区、上下文面板的 CSS/Flex 实现约束
- [x] T2 - 更新对应叶子 TDD 文档并由 block-sync 级联同步

### S4 - 修改代码 [x]

- [x] T1 - 删除通知审批框迁移后遗留的弹性空白占位
- [x] T2 - 保持 Agent 列表滚动、上下文面板固定和状态栏固定行为

### S5 - 验收收尾 [x]

- [x] T1 - 执行验证：M11 定向 ESLint 0 error；当时发现的 M10 两个类型错误已由 M12 修复，当前全量 typecheck 通过
- [x] T2 - 布局结构断言通过：无遗留 spacer，Agent 列表与 ContextPanel 直接相邻，`flex: 1 + min-height: 0 + overflow-y: auto` 约束完整
- [x] T3 - PRD、Architecture、TDD 已同步，block-sync 已级联到顶层；新增 `Important_Info` 弹性占位避坑记录

---

## M12 - 修复独立通知窗口迁移后的两个 TypeScript 编译错误 [x]

> **背景**：M10 移除 BottomBar 通知 tab、增加独立通知窗口后，全量 typecheck 暴露两个迁移残留：BottomBar 仍接收但不使用 `notificationCount`；NotificationWindowPage 将宽泛 `string` 状态写入 `SessionStatus`。
> **根因**：旧通知 tab 的 prop/atom 订阅未完整清理；通知窗口复制 SESSION_STATUS 监听逻辑时没有复用 shared 层的状态联合类型。
> **方案选择**：删除失去消费者的 BottomBar prop 与 App 订阅；通知窗口在 IPC 解构边界直接使用共享 `SessionStatus` 类型。保持现有运行逻辑不变，不新增重复状态定义。
> **验收标准**：`npm run typecheck` 通过；BottomBar 仍正确显示 tokens、项目数、Agent 数、待处理权限数与设置按钮；通知窗口收到 Completed 状态后正常更新 session。

### S1 - 阅读并修改 PRD 中的对应内容 [x]

- [x] T1 - 核对独立通知窗口与 BottomBar 产品约束
- [x] T2 - 确认两个错误均为实现迁移残留，PRD 无需修改

### S2 - 查找并修改 Architecture 类文档 [x]

- [x] T1 - 更新 BottomBar 组件边界，移除 notifications tab 与 notificationCount
- [x] T2 - 更新 notifications 模块对 shared SessionStatus 的依赖描述

### S3 - 查找并修改 TDD 类文档 [x]

- [x] T1 - 更新 BottomBarProps 输入模型
- [x] T2 - 补充 SESSION_STATUS 共享联合类型约束

### S4 - 修改代码 [x]

- [x] T1 - 删除 App 与 BottomBar 的无效 notificationCount 数据链
- [x] T2 - 将 NotificationWindowPage 的 status 收窄为共享 SessionStatus

### S5 - 验收收尾 [x]

- [x] T1 - 全量 `npm run typecheck` 通过（node + web 均 0 error）
- [x] T2 - BottomBar 与 NotificationWindowPage 定向 ESLint 0 error；残留引用与 diff-check 通过（App 仍有 2 个既有 lint 错误，不属于本目标）
- [x] T3 - Architecture/TDD 叶子已经 block-sync 同步到对应父块；无新增项目特殊知识，无需更新 Important_Info

---

## M13 - 将独立通知窗口默认尺寸调整为 400×400 [!]

> **背景**：独立通知窗口当前以 600×600 创建，用户要求默认调整为 400×400，使窗口更紧凑、减少对主工作区的遮挡。
> **真实约束**：当前 BrowserWindow 已设置 `minWidth: 400`、`minHeight: 400`，与用户确认后的默认尺寸一致，无需修改最小尺寸。
> **方案选择**：仅将默认 width/height 从 600 改为 400，保留最小宽高 400、窗口可自由放大、单例/置顶/托盘隐藏等行为不变。
> **验收标准**：首次创建通知窗口时外框为 400×400；不能缩小到 400 以下但可放大；权限请求、项目分区及滚动行为不变；全量 typecheck 通过。

### S1 - 阅读并修改 PRD 中的对应内容 [x]

- [x] T1 - 定位独立通知窗口默认尺寸产品约束
- [x] T2 - 将“默认正方形尺寸”明确为 400×400，并注明最小尺寸同为 400×400

### S2 - 查找并修改 Architecture 类文档 [!]

- [ ] T1 - 更新独立通知窗口默认与最小尺寸约束
- [ ] T2 - 由 block-sync 级联同步父级文档

### S3 - 查找并修改 TDD 类文档 [ ]

- [ ] T1 - 更新 BrowserWindow 默认宽高参数并保留最小宽高
- [ ] T2 - 补充 400×400 创建与缩放测试

### S4 - 修改代码 [ ]

- [ ] T1 - 将 notificationWindow width/height 从 600 改为 400
- [ ] T2 - 保留 minWidth/minHeight 400，确保不小于紧凑布局下限

### S5 - 验收收尾 [ ]

- [ ] T1 - 运行全量 TypeScript 类型检查
- [ ] T2 - 检查尺寸参数、相关文档与补丁完整性
- [ ] T3 - 判断是否更新 Important_Info

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
                                └─▶ M10（聚合通知独立窗口化）
                                      └─▶ M11（实时工作区纵向空间回收）
                                      └─▶ M12（通知迁移编译错误修复）
                                      └─▶ M13（通知窗口默认尺寸 400×400）
```

**M5 和 M6 可在 M4 完成后并行开发**（彼此无依赖）。M9 依赖 M5 完成。M10 依赖 M9（复用关闭通道）与 M4（移除项目监控审批框）。M11 依赖 M10 已移除主窗口审批面板。M12 修复 M10 独立通知窗口迁移后的编译错误。M13 将 M10 独立通知窗口的默认尺寸调整为 400×400，并保留相同最小尺寸。
