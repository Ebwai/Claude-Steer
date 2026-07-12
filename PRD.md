# Claude Driver — 产品需求文档 (PRD)

> **版本：** v0.2.0-draft  
> **状态：** 已初审  
> **目标读者：** 架构师、前端/后端开发者  
> **最后更新：** 2026-04-15

---

## 1. 产品概述

### 1.1 产品定位

Claude Driver 是 **Claude Code 的本地可视化仪表盘**，不是重造一个新的 Claude Code。它将 Claude Code 底层能力（Hooks、statusLine、JSONL、PTY、Git Worktree 等）封装为直观的 GUI 交互入口，让用户几乎零学习成本地用上 Claude Code 的全部特性。

### 1.2 核心设计哲学

- **第一性原理设计**：每个功能处理它最擅长的事情——CLAUDE.md 处理始终开启的上下文，Skills 处理按需知识，MCP 处理外部连接，Subagents 处理隔离执行，Hooks 处理自动化
- **渐进式信息披露**：每个场景下只显示当前所需的必要信息，详情放入子页面
- **完全兼容官方**：遵循 Claude Code 官网最佳实践，官方更新后 7 天内同步适配
- **跨平台**：Windows / macOS / Ubuntu

### 1.3 与同类项目差异

| 项目 | 定位 | 交互方式 |
|------|------|---------|
| **cc-connect** | 社交软件 ↔ Claude Code 桥接 | 飞书/钉钉/Telegram 等 IM 消息 |
| **Claude Driver** | 本地 Claude Code 最佳仪表盘 | 桌面 GUI 应用，可视化监控 + 进程管理 |

---

## 2. 整体架构

### 2.1 技术选型

| 维度 | 选择 | 理由 |
|------|------|------|
| **GUI 框架** | **Electron**（Node.js + Chromium） | `node-pty` 支持最成熟；React/Vue 生态直接可用 |
| **无限画板** | **@xyflow/react**（React Flow） | Canvas/SVG 混合渲染，内置虚拟化和视口管理 |
| **项目记录单** | JSON 文件（`~/.claude-driver/projects.json`） | 单用户场景够用，导出/导入零成本 |
| **实时数据** | Hooks + statusLine + JSONL 三通道融合 | 实时性 + 可靠性兜底 |
| **进程管控** | **node-pty**（PTY 伪终端） | 双向 stdin/stdout 控制，跨平台 |
| **Windows 路径** | `%USERPROFILE%\.claude\` | 与 Claude Code 官方一致 |

### 2.2 数据存储

| 数据类型 | 存储位置 | 格式 |
|---------|---------|------|
| 项目记录单 | `~/.claude-driver/projects.json` | JSON |
| Agent 配置 | `~/.claude/agents/`（用户级）+ 项目级 `.claude/agents/` | JSON |
| 全局配置 | `~/.claude-driver/config.json` | JSON（支持导出/导入） |
| Plugin 状态 | 读取 `~/.claude/settings.json` 的 `enabledPlugins` 字段 | JSON |
| Plan 状态缓存 | `~/.claude/projects/<project>/plan_state.json` | JSON |
| Claude Code 转录 | `~/.claude/projects/<encoded-path>/<session-uuid>.jsonl`（主进程）；Subagent：`<session-uuid>/subagents/<subagent-uuid>.jsonl` | JSONL（只读）；路径编码规则：项目绝对路径中所有非字母数字字符替换为 `-`，如 `/home/tony/proj` → `-home-tony-proj` |

### 2.3 全局布局框架

```
┌─────────────────────────────────────┐  ← 顶部标题栏 38px
│  [●●●]  Claude Driver  今日↑tok · 费用 · ●N运行中  │
├────────────────────┬────────────────┤
│                    │   右半：配置面板  │
│  左半：内容区       │   (flex列布局)   │
│  (50%)             │                │
│                    │                │
├────────────────────┴────────────────┤  ← 底部标签栏 38px
│ [全局监控] [项目监控] [消息通知 3]  ···  [⚙全局设置] │
└─────────────────────────────────────┘
```

**底部标签栏（38px）：**
- 左侧：`● 全局监控`（绿色运行指示）/ `📋 项目监控` / `💬 消息通知 [N]`
- 右侧：本月 Ntok · 项目 N · Agents N · `[● N 待处理请求]`（红色胶囊）/ 语言切换 / `⚙ 全局设置`

---

## 3. 页面详述

### 3.1 全局监控页面
> 设计可以参考UI设计demo文件夹下的global-monitor-page.html

#### 3.1.1 左半：项目画板（50%宽，@xyflow/react 无限画板）


**视觉层：**
- 点阵背景网格（radial-gradient 圆点，opacity≈0.3）
- 左上角：用户节点（头像 + 用户名，可编辑自定义名称，默认显示"我"）

**项目卡片分类：**

| 区域 | 显示项目 | 默认展开级别 | 卡片内容 |
|------|---------|------------|---------|
| **进行中** | 正在工作的项目 | 展开至 M 级 plan 列表（最多 4 条） | 绿点 + 项目名 + 执行状态 + Agent 编号 + 当前 M 任务 + 倒三角执行指示器 |
| **其他项目** | 不在工作的项目 | 不展开 | 项目名 + 灰色状态点 |

**项目卡片交互：**
- 单击展开/折叠下一级详细信息
- 双击 → 底部标签切换到「项目监控」+ 自动打开该项目标签页
- 卡片右上角"双击→监控"提示徽章（悬停时 orange 高亮）

**倒三角执行指示器（进行中项目独有）：**
- **触发条件**：基于 `PostToolUse` Hook + 文件变动监听，检测到 plan 文件有变动
- **显示规则**：在对应 plan 条目上显示倒三角"当前正在执行"
- **销毁条件**：
  1. overallplan 中对应 M 任务全部完成，且 3min 内无新 plan 文件变动 → 自动销毁
  2. M 任务未完成但 5min 内无 plan 变动 → 自动退出（展示为"可能暂停"状态）
- **多 plan 并行**：可同时显示多个倒三角

**左下角浮动按钮组：**
- `＋ 新建项目`
- `💬 闲聊`（点击弹出 **Claude 终端子窗口**，基于 xterm.js + node-pty 的独立 BrowserWindow，启动独立 Claude 终端；用户可直接在窗口中输入，程序持有 PTY stdin 管道可注入指令；不作为项目处理和显示）
- `🧩 Plugins`（位于闲聊按钮旁边）

#### 3.1.2 右半：配置面板（flex 列布局，4 个区块）

**① 全局统计（flex-shrink:0，三等分网格卡片）：**

| 卡片 | 主数字 | 副信息 | 交互 |
|------|--------|--------|------|
| 常用模型 | 模型名（如 Sonnet 4.6） | 本月占比 % | — |
| 本月 Token | 总用量（如 2.1M） | 环比上月 ↑/↓% | — |
| 累计费用 | 金额（如 $4.72） | 本月·N 个项目 | 点击弹出浮层，按项目显示分摊明细 |

**Token 数据来源：**
- **来源 A**：statusLine stdin（实时，`context_window.current_usage`，~300ms 刷新）
- **来源 B**：JSONL 转录文件（历史统计，解析 `~/.claude/projects/<hash>/*.jsonl`）
- **来源 C**：内置 `/status` 命令（stdout 解析）
- **统计归属**：全局总计 = 所有项目之和 + "未分类"（闲聊按钮对话归入未分类）

**② Agent + 经验（flex-shrink:0，1fr:2fr 两列网格）：**

- **左列（Agent 面板）**：
  - 面板头：`Agent` · 数量角标 · `全部 ›` · `＋ 添加▾`
  - 条目：`✦ 名称` 右侧模型名（继承/Haiku/Sonnet）
  - 内置 Agent 默认显示 5 个（Explore / Plan / General-purpose / statusline-setup / Claude Code Guide）

- **右列（经验面板：Skills + 工作流并排）**：
  - Skills 条目：`✦ skill 名`
  - 工作流条目：`[HookType]` + 工作流名称

**③ 工具（flex-shrink:0，独占全宽，三等分列）：**
- 列：Tools · MCP · CLI
- 每列头：列名 · 数量角标 · `全部 ›` · `＋ 添加▾`
- Tools 显示内置工具名（前 2 条 + `···`）
- MCP 显示已安装的 MCP server 名（≤3 条全显示）
- CLI 显示自定义命令行工具（无则显示"暂未配置"）

**④ 功能入口（flex-shrink:0，三等分网格按钮）：**
- `⏰ 定时触发` · `📡 远程交互` · `💫 灵魂交流`
- `🧩 Plugins` 按钮位于闲聊按钮旁边（见 3.1.1 左下角浮动按钮组）

**通用面板条目规范（所有列表面板统一适用）：**

1. **列表截断规则**：条目 ≤3 全显示；>3 显示前 2 条 + 第 3 行固定 `···`（可点击）
2. **条目样式**：前缀 `✦`（7px 灰色）+ 主名称（10px）；hover 显示 ✎ 编辑按钮
3. **添加按钮**：`＋ 添加` 带细边框，点击展开下拉：① ✏ 自己创建 ② ⬇ 下载精选（第一阶段为空/社区链接）
4. **展开覆盖浮层**：点击 `···` 或 `全部 ›` → 绝对定位覆盖右侧面板，内含完整列表 + 编辑按钮，右上角 ✕ 关闭

#### 3.1.3 Plugins 面板

**入口位置**：全局监控左半画板左下角浮动按钮组中的 `🧩 Plugins` 按钮

**交互流程**：
1. 点击 `🧩 Plugins` → 全局监控右半面板**替换**为 Plugins 界面
2. 右上角显示关闭按钮（✕），点击退出 Plugin 界面，恢复原配置面板

**Plugins 界面内容**：

| 区域 | 内容 | 说明 |
|------|------|------|
| **已安装列表** | 每个 Plugin 卡片 + 删除按钮 | 通过读取 `~/.claude/settings.json` 的 `enabledPlugins` 字段获取 |
| **添加 Plugin** | 按钮（第一阶段） | 点击后显示"还在开发中"提示（未来替换为一键安装脚本） |
| **精品推荐** | 预留区域（第一阶段为空） | 未来填充精选 Plugin 选择 |

**Plugin 详情展示**：
- 点击某个 Plugin → 显示其应用场景、作用、以及所包含的 MCP / Skills / Hooks

#### 3.1.4 创建项目 SOP

点击 `＋ 新建项目` → 右半配置面板覆盖为创建流程，三步骤：

**Step 1 — 项目设置：**
- 项目名称（加入项目记录单）
- 选择可调用的 Skills / MCP / Tools / Agent / Plugins（以按钮形式展示，点击选择）
- 权限设置：6 选 1（default / acceptEdits / plan / auto / dontAsk / bypassPermissions），hover 显示详细说明
- 系统提示词配置界面（可展开）：
  - 输入框：`{{PROJECT_NAME}}`、`{{PROJECT_DESCRIPTION}}`、`{{ENVIRONMENT}}`、`{{HARDWARE_LIST}}`
  - 关键命令：构建 `{{BUILD_COMMAND}}`、测试 `{{TEST_COMMAND}}`、运行 `{{RUN_COMMAND}}`
  - 提示用户可自行修改文件，附官网教程链接

**Step 2 — 放入资产：**
- 提示文字："如果你有资产可以放入（调研报告、demo 代码等），可放入资料文件夹下"
- 「已放好」按钮，鼠标悬停显示提示

**Step 3 — 制定计划：**
- 点击「已放好」后自动跳转到项目监控页面
- 自动在项目文件夹打开新 Claude Session（权限设为 **acceptEdits**）：弹出 **Claude 终端子窗口**（独立 BrowserWindow + xterm.js），用户可在终端中实时看到 Claude 工作过程
- 自动发送"创建计划"四字指令（通过程序持有的 PTY stdin 注入）

#### 3.1.5 初始化 SOP（首次打开软件）

1. 选择存在所有项目的文件夹
2. 读取全部含 `claude.md` 的文件夹 → 项目记录单标记
3. 向用户发送**项目认领清单**
4. 用户选择认领状态：
   - `1` = 确认是项目，加载到仪表盘
   - `0` = 确认不是项目，从视图隐藏
   - `-1` = 稍后决定（默认值），全局面板常驻"待确认项目"角标
5. 以后每次打开软件：加载所有标记为 1 的项目；检测到新文件夹且未标记 → 发送确认清单

**项目去重合并规则**：路径前缀匹配——同一项目根路径下所有子路径归属同一项目（如 `/home/Tony/Test` 和 `/home/Tony/Test/plan` 属于同一项目）

**重新扫描触发时机**：① 启动时 ② 检测到新文件夹 ③ 用户手动点击"重新扫描"

### 3.2 项目监控页面
> 设计参考：`UI设计 demo/project_monitor_scene1.html`（单主线程）、`project_monitor_scene2.html`（/branch 继承记忆）、`project_monitor_scene3.html`（同项目多 Session 并行）

#### 3.2.0 项目顶栏

**第一行 — 项目切换标签（仿浏览器标签栏，height: 34px）：**
- 每个标签：绿色状态点 + 项目名称 + ✕ 关闭按钮（点击关闭该项目的监控 tab，不终止进程；Claude 终端子窗口继续运行，可从"所有项目"列表重新打开监控 tab）
- 仅显示正在运行的项目（当前激活 tab 有高亮背景 + 深色边框）
- 末端「所有项目 ▾」按钮展开全部项目列表（含未运行项目）供选择，选择某个项目后切换到所选择的那个项目监控页面

**第二行 — 项目设置栏（height: 30px，与全局设置完全独立，仅影响当前项目）：**
- 每项：`设置名称` + 当前值（紫色）+ 下拉箭头，点击展开下拉选择列表
- 项目：`权限` · `模型` · `工具（Tools,MCP,CLI）` · `经验（Skills,工作流）` · `Plugins`（五项依次排列，以竖线分隔，其中工具和经验又包含子内容，所以总共有八项排列在项目设置栏上）
- **最右端固定按钮**：`↑ 同步到 GitHub`（绿色文字 + 绿色边框圆角按钮，常驻最右侧）
  - 点击触发当前主线版本推送流程（与进程线底部"输入到 git 主线"效果一致，区别在于本按钮全局触发，不针对单节点）
  - 若 git 远程未配置或权限不足 → 弹出子窗口说明操作步骤

---

#### 3.2.1 历史工作进程线画布（右半，50%）

**布局**：右半 50% 为可滚动无限画布，承载所有主线 Session 的历史进程线。最右侧常驻 16px 宽的**历史进度拉动条**（竖向轨道 + 拇指块）。

**数据读取三通道：**
- **通道 1**：Claude Code Hooks（主事件流）— `SessionStart` / `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `SubagentStart` / `SubagentStop` / `Notification` / `Stop` / `SessionEnd`
- **通道 2**：statusLine stdin（~300ms 刷新，实时 token / model / context_window）
- **通道 3**：JSONL 转录文件（历史回看 + 兜底补偿）

**进程控制**：通过 `node-pty` 以父进程方式启动 Claude CLI，持有 stdin 管道，可双向注入指令

---

##### 3.2.1.1 Agent 进程线框（每个 Session 一个框）

每个主线 Session 渲染在一个**虚线边框圆角矩形框**中（`border: 1px dashed`），
每个主进程代理可以看作是一个框中（大小要合理），每个框的大小是可以变化的（因为展开一些细节的时候可能会边宽等等），这样多个主进程代理中一个因为展开操作导致变大时，基于相连的碰撞会传到，从而实现动态变大小，当展开时（可见范围聚焦在这个展开的主代理上），缩回的话会自动回归在可见范围能看到全部主代理的无限大面板的缩放视角下
框内从上到下分三部分，并且每个框的最左侧有任务里程碑标记（Milestone），当某一个最低级的plan状态标注为完成后就会插入一个圆点标记完成的那个子任务，比如M1-S1-T1：

**① 框头部（thread header）：**

| 元素 | 规格 |
|------|------|
| 状态点 | 8px 圆点，运行中=绿色+光晕；被notification中断=橙色；不在运行中=灰色 |
| Session 名称 | `Agent1` / `Agent2` 等，粗体，font-size:12px |
| token 用量 | 右侧绿色，显示的是每个session的token用量。如「↑ 34.2K」 |
| 运行时长 | 每个session的运行时长，最右，灰色，如「21min」 |

**② 时间线主体（tl-body）：**

左侧 2px 竖线（时间轴），节点通过 `position: relative; left: -23px` 悬挂在轴上。

**「项目启动」锚点标记**
- 每个项目的历史工作进程无限大面板最上面起点都是这个


**时间节点**
- 最重要的元素：时间线上每个CLAUDE的回复作为一个节点【指的是过程中的对话，因为这些是claude实际执行的最小单位】,节点需要显示出字，但是大小不能太大，字数显示有规定，假如自动超过的话，那么只显示在自作范围内的前面的信息，鼠标悬浮在上面会显示出完整的信息。节点与节点节点之间会根据实际触发情况显示以下**十类元素**（用细线插入再触发时插入到时间线上，有可能会出现同时触发多个的情况，那就按照下面的顺序一个一个来显示，每个类别中同时弹出顺序没有要求，比如同时触发调用3个tools，那么显示顺序无所谓，只要插入3条线都显示出来就行）：
- 显示：内容行：文本截断（white-space: nowrap），hover 展开全文

- 关于插入线：有3种颜色，3种长短（短-中-长，其中以短为一个的单位长度，那么中是短的两倍，长是短的3倍，单位长度大小根据页面实际的设计来定）
- 关于内容badge：插入线一端连接时间线，一端连接内容badge，badge中显示十种触发中的全部需要显示的内容
- 关于状态：正在执行的条目：琥珀色闪烁动效 + ⟳ 后缀
- 关于十类插入元素见下面
**A. Tools调用**
- 触发识别：目前的方案是目前的方案基于hook， 从 JSONL `tool_use.input` 字段，具体见。UserPromptSubmit + 正则匹配（最接近）用户输入"/branch“
- 插入线
  - 颜色： #e6430d
  - 方向：时间线右侧插入
  - 长短：短
- 内容badge：
  - 使用了什么tool
  - 干了什么（简要描述）


  PS：**工具调用文本提取规则：**

  │                 │ PreToolUse  │                       │   建议 Hook     │
  │      工具       │     /       │ tool_input 可提取字段 │    显示格式     │
  │                 │ PostToolUse │                       │                 │
  ├─────────────────┼─────────────┼───────────────────────┼─────────────────┤
  │                 │             │ description, prompt,  │                 │
  │ Agent ★         │     ✅      │ subagent_type, model, │ Agent →         │
  │                 │             │  run_in_background,   │ {description}   │
  │                 │             │ isolation             │                 │
  ├─────────────────┼─────────────┼───────────────────────┼─────────────────┤
  │ AskUserQuestion │             │                       │ AskUserQuestion │
  │  ★              │     ✅      │ questions（数组）     │  →              │
  │                 │             │                       │ {questions[0]}  │
  ├─────────────────┼─────────────┼───────────────────────┼─────────────────┤
  │ Bash ★          │     ✅      │ command, description, │ Bash →          │
  │                 │             │  timeout              │ {description}   │
  ├─────────────────┼─────────────┼───────────────────────┼─────────────────┤
  │                 │             │ schedule（cron        │ CronCreate →    │
  │ CronCreate      │     ✅      │ 表达式）, prompt,     │ {name} @        │
  │                 │             │ name                  │ {schedule}      │
  ├─────────────────┼─────────────┼───────────────────────┼─────────────────┤
  │ CronDelete      │     ✅      │ id                    │ CronDelete →    │
  │                 │             │                       │ {id}            │
  ├─────────────────┼─────────────┼───────────────────────┼─────────────────┤
  │ CronList        │     ✅      │ (无参数)              │ CronList        │
  ├─────────────────┼─────────────┼───────────────────────┼─────────────────┤
  │                 │             │ file_path,            │                 │
  │ Edit ★          │     ✅      │ old_string,           │ Edit →          │
  │                 │             │ new_string,           │ {file_path}     │
  │                 │             │ replace_all           │                 │
  ├─────────────────┼─────────────┼───────────────────────┼─────────────────┤
  │ EnterPlanMode ★ │     ✅      │ (无参数)              │ EnterPlanMode   │
  ├─────────────────┼─────────────┼───────────────────────┼─────────────────┤
  tool_input 可提取字段: file_path, old_string, new_string, replace_all      
  建议 Hook 显示格式: Edit → {file_path}                                     
  ────────────────────────────────────────                                   
  工具: EnterPlanMode ★                                                      
  PreToolUse / PostToolUse: ✅                                               
  tool_input 可提取字段: (无参数)                                            
  建议 Hook 显示格式: EnterPlanMode                                          
  ────────────────────────────────────────                                   
  工具: EnterWorktree                                                           
  PreToolUse / PostToolUse: ✅                                               
  tool_input 可提取字段: description, branch（推断）                            
  建议 Hook 显示格式: EnterWorktree → {branch}                                
  ────────────────────────────────────────                                      
  工具: ExitPlanMode ★                                                          
  PreToolUse / PostToolUse: ✅                                                
  tool_input 可提取字段: plan（完整计划文本）, planFilePath, allowedPrompts     
  建议 Hook 显示格式: ExitPlanMode → {planFilePath}                           
  ────────────────────────────────────────                                    
  工具: ExitWorktree                                                            
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: (无参数)                                               
  建议 Hook 显示格式: ExitWorktree                                            
  ────────────────────────────────────────                                    
  工具: Glob ★
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: pattern, path
  建议 Hook 显示格式: Glob → {pattern}
  ────────────────────────────────────────
  工具: Grep ★
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: pattern, path, glob, output_mode, head_limit, type, -i,

    -C
  建议 Hook 显示格式: Grep → {pattern}
  ────────────────────────────────────────
  工具: ListMcpResourcesTool
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: server_name（可选）
  建议 Hook 显示格式: ListMcpResources → {server_name}
  ────────────────────────────────────────
  工具: LSP                                                                     
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: command（goto_definition等）, file_path, line, column  
  建议 Hook 显示格式: LSP → {command}:{file_path}:{line}                      
  ────────────────────────────────────────                                    
  工具: Monitor                                                                 
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: command, description, timeout                          
  建议 Hook 显示格式: Monitor → {description}                                 
  ────────────────────────────────────────                                    
  工具: NotebookEdit                                                            
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: notebook_path, cell_type, source（或 content）,        
    cell_id/index                                                             
  建议 Hook 显示格式: NotebookEdit → {notebook_path}                          
  ────────────────────────────────────────
  工具: NotebookRead                                                            
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: notebook_path                                          
  建议 Hook 显示格式: NotebookRead → {notebook_path}                          
  ────────────────────────────────────────                                    
  工具: PowerShell                                                              
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: command, description, timeout                          
  建议 Hook 显示格式: PowerShell → {description}                              
  ────────────────────────────────────────                                    
  工具: Read ★                                                                  
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: file_path, offset, limit                               
  建议 Hook 显示格式: Read → {file_path}                                      
  ────────────────────────────────────────                                    
  工具: ReadMcpResourceTool                                                     
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: uri                                                    
  建议 Hook 显示格式: ReadMcpResource → {uri}                                 
  ────────────────────────────────────────                                    
  工具: SendMessage                                                             
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: to, message（或 content）                              
  建议 Hook 显示格式: SendMessage → {to}                                      
  ────────────────────────────────────────                                    
  工具: Skill ★                                                                 
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: skill, args                                            
  建议 Hook 显示格式: Skill → {skill} {args}                                  
  ────────────────────────────────────────                                    
  工具: TaskCreate ★                                                            
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: subject, description, activeForm                       
  建议 Hook 显示格式: TaskCreate → {subject}                                  
  ────────────────────────────────────────                                    
  工具: TaskGet                                                                 
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: task_id（或 id）                                       
  建议 Hook 显示格式: TaskGet → {task_id}                                     
  ────────────────────────────────────────                                    
  工具: TaskList ★                                                              
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: (无参数)                                               
  建议 Hook 显示格式: TaskList                                                
  ────────────────────────────────────────                                    
  工具: TaskOutput ★                                                            
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: task_id, block, timeout                                
  建议 Hook 显示格式: TaskOutput → {task_id}                                  
  ────────────────────────────────────────                                    
  工具: TaskStop                                                                
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: task_id                                                
  建议 Hook 显示格式: TaskStop → {task_id}                                    
  ────────────────────────────────────────                                    
  工具: TaskUpdate ★                                                            
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: taskId, status                                         
  建议 Hook 显示格式: TaskUpdate → {taskId}: {status}                         
  ────────────────────────────────────────                                    
  工具: TeamCreate                                                              
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: name, members（队友列表）                              
  建议 Hook 显示格式: TeamCreate → {name}                                     
  ────────────────────────────────────────                                    
  工具: TeamDelete                                                              
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: team_id                                                
  建议 Hook 显示格式: TeamDelete → {team_id}                                  
  ────────────────────────────────────────                                    
  工具: TodoWrite                                                               
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: todos（数组，含 id/content/status/priority）           
  建议 Hook 显示格式: TodoWrite → {todos.length} items                        
  ────────────────────────────────────────                                    
  工具: ToolSearch ★                                                            
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: query, max_results                                     
  建议 Hook 显示格式: ToolSearch → {query}                                    
  ────────────────────────────────────────                                    
  工具: WebFetch ★                                                              
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: url, prompt                                            
  建议 Hook 显示格式: WebFetch → {url}                                        
  ────────────────────────────────────────                                    
  工具: WebSearch                                                               
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: query                                                  
  建议 Hook 显示格式: WebSearch → {query}                                     
  ────────────────────────────────────────                                    
  工具: Write ★                                                                 
  PreToolUse / PostToolUse: ✅
  tool_input 可提取字段: file_path, content                                     
  建议 Hook 显示格式: Write → {file_path

**B. MCPs调用**
- 触发识别：目前的方案是目前的方案基于hook， 从 JSONL `tool_use.input` 字段
- 插入线
  - 颜色： #e6430d
  - 方向：时间线右侧插入
  - 长短：中
- 内容badge：
  - 使用了什么MCP
  - 干了什么（简要描述，应该可以从hooks中提取）
PS：
MCP 工具（PreToolUse / PostToolUse 可捕获）

  命名格式：mcp__{server}__{action}，tool_input 字段随 MCP server 定义而异：

  ┌───────────────────────────────────┬──────────────────────┬─────────────┐
  │             工具示例              │   tool_input 字段    │ 建议显示格  │
  │                                   │                      │     式      │
  ├───────────────────────────────────┼──────────────────────┼─────────────┤
  │ mcp__playwright__browser_navigate │ url                  │ MCP:playwri │
  │                                   │                      │ ght → {url} │
  ├───────────────────────────────────┼──────────────────────┼─────────────┤
  │ mcp__playwright__browser_take_scr │                      │ MCP:playwri │
  │ eenshot                           │ (无参数)             │ ght →       │
  │                                   │                      │ screenshot  │
  ├───────────────────────────────────┼──────────────────────┼─────────────┤
  │                                   │                      │ MCP:github  │
  │ mcp__github__get_file_contents    │ owner, repo, path    │ → {repo}/{p │
  │                                   │                      │ ath}        │
  ├───────────────────────────────────┼──────────────────────┼─────────────┤
  │                                   │                      │ MCP:github  │
  │ mcp__github__search_code          │ q, per_page          │ →           │
  │                                   │                      │ search:{q}  │
  ├───────────────────────────────────┼──────────────────────┼─────────────┤
  │                                   │ 取 tool_name.split(" │ MCP:{server │
  │ 任意 MCP 工具                     │ __")[2] + tool_input │ } →         │
  │                                   │                      │ {action}    │
  └───────────────────────────────────┴──────────────────────┴─────────────┘


**C. CLI调用**
- 触发识别：目前的方案是目前的方案基于hook， CLI调用实际是调用了某个CLI的Skill包，所以对于CLI类别的Skill，比如飞书CLI（在用户的.claude/skills下识别所有带cli字的skill为CLI，不要放入skill里了，在其他有关skill识别的流程中也需要注意这个），不要识别到使用Skill，而是识别为CLI，属于CLI触发
- 插入线
  - 颜色： #e6430d
  - 方向：时间线右侧插入
  - 长短：长
- 内容badge：
  - 使用了什么CLI
  - 干了什么（简要描述，应该可以从hooks中提取）

**D. Skills调用**
- 触发识别：目前的方案是目前的方案基于hook， 从 JSONL `tool_use.input` 字段，具体见。UserPromptSubmit + 正则匹配（最接近）用户输入"/branch“
- 插入线
  - 颜色： #DA7756
  - 方向：时间线左侧插入
  - 长短：短
- 内容badge：
  - 使用了什么skills
  - 用skill干了什么（应该可以从hooks中提取）

**E. 工作流调用**（本质上目前是hooks调用的识别）
- 触发识别：每当 hook 触发，Claude Code 会向你的脚本/HTTP端点 发送一个 JSON payload
- 插入线
  - 颜色： #DA7756
  - 方向：时间线左侧插入
  - 长短：中
- 内容badge：
  - 什么情况下触发了hooks
  - 干了什么（简要描述，应该可以从hooks中提取）

**F. insight产生**
- 触发识别：实现的方案暂时是通过提取claude回复文本中的insight部分来实现（具体的方法可以再调研并通过实践反馈最终确认）
- 插入线
  - 颜色： #DA7756
  - 方向：时间线左侧插入
  - 长短：长
- 内容badge：
  - insight的内容：只显示前20个字，有一个展开按钮，点击展开可以显示全部
  

**G. subagent调用**
- 触发识别：目前的方案基于hook， 从 JSONL `tool_use.input` 字段，Agent（派发 subagent） | `description` | `Dispatched: {description}` |
- 插入线
  - 颜色： #DA7756
  - 方向：时间线左侧插入
  - 长短：长
  - 注意subagent也会返回信息：subagent再经历自己的时间线返回的时候也要返回一条线连到对应的主时间线上
  - 线上的内容：
    - 主agent分配任务时：显示“分配任务”
    - subagent完成任务返回主agent时：显示“返回任务结果”
- 内容badge：
  - 显示subagent的名称
  - 显示给subagent的信息（subagent完成任务返回时也要返回信息）

**H. 开启/branch**
- 触发识别：目前的方案是UserPromptSubmit + 正则匹配（最接近）用户输入"/branch“
- 插入线
  - 颜色： #DA7756
  - 方向：时间线左侧插入
  - 长短：长
  - 插入线上有文字：继承记忆
- 内容badge：
  - “branch：来自于Agentxx的分支探索”
**I. 开启/btw**
- 触发识别：目前的方案是UserPromptSubmit + 正则匹配（最接近）用户输入"/btw“，接收信息可能需要捕获notification hooks?(需要探索或根据历史经验确认一下)
- 插入线
  - 颜色： #DA7756
  - 方向：时间线左侧插入
  - 长短：长
  - 插入线上有文字：临时提问
- 内容badge：
  - “用户/btw输入的内容”，只显示前20个字，有一个展开按钮，点击展开可以显示全部

**J. 用户输入**
- 触发识别：基于hooks在用户（Submit）时触发
- 插入线
  - 颜色： #DA7756
  - 方向：时间线左侧插入
  - 长短：长
  - 插入线上有文字：继承记忆
- 内容badge：
  - 用户输入的内容，只显示前20个字，有一个展开按钮，点击展开可以显示全部



**每个框的最左侧：任务里程碑标记（Milestone）**
- 格式：`[M1-S1-T1]` 紫色 badge 
- **永远显示**，作为时间轴的语义锚点
- 插入时间：当某一个最低级的plan状态标注为完成后就会插入一个badge标记完成的那个子任务，比如M1-S1-T1
- 鼠标悬浮在上面可以查看这个最底级别任务的目标描述

---

##### 3.2.1.2 进程线特殊元素详细说明

**G. Subagent Mini 进程线**
- 仅当 `SubagentStart` hook 触发时，在对应节点之后插入
- 结构与主线完全相同，但整体视觉缩小一档（字号、圆点、间距均缩小）
- 内部结构：
  1. **传入标签** + 传入内容摘要（紫色，斜体）
  2. **Mini 节点**（可多轮）：8px 圆点 + 规则和② 时间线主体（tl-body）中的一样
  3. **返回标签** + 返回内容摘要（绿色，斜体）
- 时间位置：插入在主线派发节点（`Agent → ...` tool_use）之后，视觉高度对应实际工作时间段
- **折叠/展开**：默认折叠，仅显示 [Subagent 名称] + 传入摘要 + 返回摘要；点击展开显示完整 mini 进程线（含所有中间节点和工具/经验调用详情）
- **注意**：子 agent 内部工具调用归属于子 agent 的SubagentStop 中的 agent session_id，主 session 的 hooks行为看不到；需在子 agent 的 hook 事件中用agent_id 区分


---

##### 3.2.1.3 三种并行情形

| 情形 | 显示方式 | 连线规格 |
|------|---------|---------|
| **情形1 — 单主线程** | 单框居中显示，单条竖向进程线 | 无 |
| **情形2 — /branch 继承记忆** | 两框并排，branch 框 `margin-top` 与原 Session 中 `/branch` 触发点对齐 | 两框之间水平连线（渐变紫色，2px），连线上方「继承记忆」紫色小标签 |
| **情形3 — 同项目多 Session 并行** | 两框并排，顶部对齐 | 两框之间 2px 竖向细分隔线（无标注，两侧完全独立） |

并行情形下，多框使用不同颜色系统以便区分：
- Agent1 / Session A：绿色系（状态点、节点圆点、里程碑 badge）
- Agent2 / Session B：蓝色系（天蓝色系）
- /branch Session：紫色系

---

##### 3.2.1.4 进程线框底部操作区

每个 Session 进程线框末尾固定显示三个操作按钮（`border-top` 分隔）：

| 按钮 | 样式 | 操作 |
|------|------|------|
| `⬛ 打断对话` | 红色边框 + 红色文字 | 向该 Session 的 stdin 发送 Ctrl+C 信号 |
| `回到对话` | 默认样式 | 通过 `claude --resume <session_id>` 恢复该会话 |
| `输入到 git 主线` | 绿色边框 + 绿色文字 | 将当前 worktree 分支 merge 到 main，询问确认后执行 |

---

##### 3.2.1.5 节点点击菜单（点击 Claude 回复节点 → 弹出 4 选项）

```
┌─────────────────────┐
│ ☁ Git 当前版本       │
│ ↩ 回退到当前版本      │
│ 🗑 删除              │
│ ⊕ 创建多 Agent  ▸   │
└─────────────────────┘
```

**① Git 当前版本（快照）**
- 对当前 worktree 执行 `git add -A && git commit -m "<自动消息>"`
- 每个主线 Session 一个独立分支（worktree）
- git 过的节点用**特定颜色**（非绿色，具体颜色由设计确定，每条主线一个颜色）标记
- 合并到 main 后节点改为**浅绿色**

**② 回退到当前版本**
- 仅限已 git 过的节点（有对应 commit hash）才可点击；未 git 的节点显示灰色、不可交互
- 执行 `git reset --hard <commit_hash>`

**③ 删除**
- **仅**点击「用户输入标记」节点时有效；点击 Claude 节点时此项显示灰色、不可交互
- 删除区间 = 该次用户输入到下一次用户输入之间的全部 log
- 若区间内存在 git commit，同步执行 `git rebase --onto` 删除对应 commit 历史（注意：使用非交互式 rebase，禁止 `git rebase -i`）
- 已 git 的节点也可删除（不保护），删除后 git 历史同步清除

**④ 创建多 Agent（仅最后一个节点可交互，其他节点此项显示灰色）**

点击后展开三个子选项：

**a. 开新的分支 Agent（/branch）**
- 调用 Claude Code `/branch` 命令创建继承记忆的新 Session
- 新 Session 在画布上按「情形2」规则，与原 Session 并排显示，起始高度与 /branch 触发点对齐
- 连线上标注「继承记忆」

**b. 指派某个 Agent 工作**
- 弹出该项目已开启的 Agent 列表浮层（overlay）
- **Agent 列表 UI 规格**：
  - 每个 agent 条目右侧有 ✕ 按钮（点击从该项目移除此 agent）
  - 列表末尾有 ＋ 按钮（从全局 agent 库中选择添加）
  - 列表内**分类显示**（各用独立框区分）：自定义 Agent · Plugin 自带 Subagents
  - hover 某条目 → 简要显示该 agent 的作用描述
  - 点击某条目 → 弹出输入框，允许用户输入任务描述（支持 `{{agent}}` 变量指代所选 agent）；输入后点击发送，向 Claude 会话注入「使用 {{agent}} 来...」指令

**c. btw**
- 直接调用 Claude Code `/btw` 功能（在不消耗大量 token 的情况下基于缓存单次交流）
- 按钮上 hover 时显示使用场景说明：「对上一次回复有疑问/需要明确，可高性价比地进行单次询问」

---

##### 3.2.1.6 Git Worktree 绑定技术方案

- 仪表盘维护本地映射数据库（存储于项目配置文件中）：`session_id → worktree_path → branch_name`
- 仪表盘创建 Session 时自动执行 `git worktree add -b <branch> <path>`
- Session 结束时触发合并询问弹窗（「是否将此分支合并到 main？」）
- Claude Code 自身的 `isolation=worktree` 机制在 subagent 层自动处理；主线 Session 由仪表盘管理

---

##### 3.2.1.7 历史进度拉动条

位于画布**最右侧 16px 竖向轨道**：

- **区间划分**：以每次用户输入为边界，将整个进程历史划分为若干区间
- **时间点粒度**：每次触发（② 时间线主体（tl-body）中的十个触发）调用 = 一个时间点（最小单位）
- **交互**：
  - 点击某个用户输入对应的标记点 → 拉动条自动跳转到该区间开头
  - 鼠标拖动滑块 → 连续移动
  - 键盘 ↓ 键 → 精确移动一个时间点
  - 拉动条移动时，左侧面板的「执行计划折叠区」的 plan 指针同步更新
- **动态更新**：在项目运行时，无限视图始终缩放拉取到视图框的合适位置，使得在能显示的范围内占满可以看见的窗口
---

#### 3.2.2 当前工作情况面板（左半，50%）

整体为 flex 纵向四层布局，overflow: hidden，无外部滚动条。

---

##### 层①：执行计划折叠区（顶部，flex-shrink:0）

**折叠态（高度 30px）：**
- 内容：展开箭头（`▸`）+ 「执行计划」大写标签 + 右侧当前 plan 节点 badge（如「M1-S2 · Doing」，紫色背景）
- 点击标题行触发展开（无需额外按钮）

**展开态（最大高度 200px）：**
- 内部左右两列（`border-top` 分隔）：
  - **左列（固定 160px，plan 树）**：
    - 按层级缩进显示全部 M/S/T 节点
    - 每行：展开箭头 + 节点名称 + 状态色块（Done=绿/Doing=琥珀/Todo=灰）
    - 点击某节点 → 高亮选中（蓝紫色背景），右列同步显示该节点详情
    - M 级节点名称使用紫色加粗，S 级缩进 12px，T 级缩进 22px
  - **右列（阅读窗格，剩余宽度）**：
    - 标题：选中节点编号 + 名称（badge 样式）
    - 内容：当前节点的完整描述 + 子任务列表（每项前有状态圆点：Done=绿/Doing=琥珀/Todo=灰边框）

---

##### 层②：当前工作情况区（中部，flex:1，overflow-y:auto，虚线分隔每个 Agent block）

**为无限画板**
每个活跃 Agent/Session 各一个 **Agent Block**，block 结构如下：

**Block 头部行：**
- 状态圆点（绿色 + 光晕）+ Agent 名称（粗体）+ 可选身份 badge（「主线程」蓝色 / 「branch」紫色 / Session 标签）
- 右侧：旋转 `⟳` + 实时工作状态文字（如「Writing · Edit ⟳」，详见 Claude Code 工作状态词规范）

**工具大框 + 经验大框（flex 并排）：**
- 规格与右半画布节点中的完全相同（工具框 T/M/C 三列，经验框 S/W 两列）
- 正在执行的条目：琥珀色闪烁 + ⟳ 后缀实时动效
- 这是当前时间点（两个原子对话节点之间）的实时快照，与历史画布中该节点的静态记录共享相同布局规范

**活跃 Subagent 状态块（可选，仅有 subagent 运行时显示）：**
- 紫色边框小卡片：「Subagent」badge + subagent 名称 + 运行状态
- 卡片内：传入摘要 + 「等待返回...」

**活跃 Insight 块（可选，仅有 insight 时显示）：**
- 金色背景小卡片：◆ 图标 + insight 文本

**Agent 专属消息输入行：**
- 每个 Agent block 内各自一个输入框（多 Agent 并行时各自独立）
- 左侧显示 Agent 标识色（Agent1=紫色 / Agent2=蓝色 / S-A=绿色 / S-B=天蓝色）+ Agent 名称
- 功能：**消息队列机制**——随时可输入，Claude 完成当前响应后（监听 `Stop` hook）自动弹出队列最老的消息注入会话，不打断心流
- 右侧：`↑` 发送按钮

**打断按钮（每个 Agent block 底部）：**
- 红色边框按钮「⬛ 打断对话」，点击向该 Session 发送 Ctrl+C

---

##### 层③：Agent 请求审批框（flex-shrink:0，权限请求出现时显示）

当某个 Agent 发出权限请求（`PermissionRequest` hook），在此区域显示审批控件：

- 请求来源：「[Agent名称] 请求执行：{操作描述}」
- **同意** 按钮（绿色）+ **拒绝** 按钮（红色）
- 点击任一后弹出可选输入框（可附加额外信息，也可为空），再点击「发送」回应
- 底层实现：找到对应 CLI 窗口的 stdin 管道，注入对应的 y/n + 附加文字
- 多个 Agent 同时有请求时，该区域可堆叠显示多条（FIFO 顺序）

---

##### 层④：上下文面板（最底部，flex-shrink:0，max-height: 100px，overflow-y:auto）

**标题栏：**
- 「上下文面板」+ 右侧 Agent 切换按钮（多 Agent 时显示，如 `[Agent1] [Agent2]`，当前选中高亮）

**内容列表（每行一项）：**
- 格式：`- 组件类型 · 文件名/描述`
- 网页链接：以超链接形式显示（标题文字可点击跳转，不显示裸 URL）
- 组件类型：System · CLAUDE.md · Memory · Skills · MCP · Rules · User Input · 读取文件 · WebFetch 等

**写入时机：**
- 任何 Read / WebFetch / Glob / Grep 等读取操作 → 立即追加到列表
- 用户输入 → 以「User Input」类别追加
- 记忆压缩（`PostCompact` hook）后 → 清除旧内容，保留 System/CLAUDE.md 等持久组件

**Token 估算（标注于标题行末尾）：**
- 使用 tiktoken 本地估算各类型 token 占比，标注「≈」表示估算值
- 参考各组件分布：System / CLAUDE.md / Memory / Skills / MCP / Rules / Files / Output 等

---

##### 底部状态栏（全局，height: ~20px，位于四层布局之外的最底部）

```
> [工作状态词]  —  「[当前任务描述]」 ⟳
```

- 左侧 `>` + 高亮颜色的工作状态词（如「Writing: Beaming」「Subagent: pending」）
- 右侧：Claude 实时输出的任务描述摘要（搞怪风格，取最新一条中间对话输出）
- 多 Agent 并行时：显示「N Agents 并行」+ 最活跃的那个状态

### 3.3 消息通知页面

**布局**：左右分栏
- **左侧**：Agent 请求列表（发送了待处理请求的 Agent）
  - 层级显示：项目 → Agent → {任务层级}（如 M1-S2-T1）
  - 多 Agent 并发通知：所有请求同时显示，FIFO 时间顺序
  - 无超时处理（Agent 一直等待）
- **右侧**：消息详细展示窗口
  - 同意 / 不同意 + 输入框（可选）+ 发送按钮

**系统通知**：桌面通知 / 任务栏角标提醒有待处理请求

### 3.4 全局设置页面

**打开方式**：点击底部标签栏 `⚙ 全局设置` 按钮 → 弹出**居中 Modal 浮窗**

**Modal 规格**：
- 宽约 640px，高约 80vh
- 内部单列滚动 + 顶部锚点导航
- 锚点：API · 模型 · 语言 · 权限 · 费用 · 通知 · 偏好 · 记忆 · 存储 · 关于
- 背景：半透明黑色遮罩 + backdrop-filter: blur(2px)
- 右上角 ✕ 关闭按钮，点击遮罩背景也可关闭

**设置项详表：**

#### 🔑 API 与认证
| 设置项 | UI | 底层字段 |
|--------|----|---------|
| API Key | 遮罩输入框 + 「测试连通性」按钮 | — |
| API Key 获取方式 | 切换：直接输入 / 运行命令获取 | `apiKeyHelper` |

#### 🤖 模型与推理
| 设置项 | UI | 底层字段 |
|--------|----|---------|
| 默认模型 | 下拉选择，标注速度/成本 | `model` |
| 思考力度 | 低/中（默认）/高，hover 显示 token 影响 | `effortLevel` |
| Fast Mode | 开关 | `fastMode` |
| 轻量操作模型 | 下拉选择 | `smallFastModel` |

#### 🌐 语言
| 设置项 | UI | 底层字段 |
|--------|----|---------|
| Claude 回复语言 | 下拉选择 | `language` |
| 界面语言 | 与底栏语言切换联动，同一个值 | — |

#### 🔒 权限
| 设置项 | UI | 底层字段 |
|--------|----|---------|
| 默认权限模式 | 6 选 1，hover 显示详细说明 | `permissions.defaultMode` |
| 全局允许目录 | 列表 + 添加按钮 | `permissions.additionalDirectories` |
| 常用命令白名单 | 预设勾选项：`Bash(git:*)` / `Bash(npm:*)` / `Bash(npx:*)` / `Read` / `Write`，可增删 | `permissions.allow` |
| 全局忽略文件 | glob 列表，默认预填 `node_modules/**`、`dist/**`、`*.env` | `ignorePatterns` |

#### 💰 Token 与费用
| 设置项 | UI | 底层字段 |
|--------|----|---------|
| Input token 单价 | 手动输入（$/百万 token） | — |
| Output token 单价 | 手动输入 | — |
| 月度预算提醒 | 超过阈值时顶部显示警告 | — |

#### 🔔 通知
| 设置项 | UI | 底层字段 |
|--------|----|---------|
| 桌面通知 | 总开关（系统通知权限） | — |

#### 🎨 应用偏好
| 设置项 | 默认值 | UI | 底层字段 |
|--------|--------|----|---------|
| 主题 | 深色 | 深色/浅色切换 | — |
| 输出样式 | `explanatory` | 下拉选择，⚠️ 提示不建议修改 | `outputStyle` |
| 代码高亮 | 开 | 开关 | `syntaxHighlightingDisabled` |
| 显示思考摘要 | 开 | 开关 | `showThinkingSummaries` |
| Claude Code in Chrome | 关 | 开关 | — |
| Spinner 小贴士 | 开 | 开关 | `spinnerTipsEnabled` |

#### 🧠 自动记忆
| 设置项 | UI | 底层字段 |
|--------|----|---------|
| 自动记忆 | 开关 | `autoMemoryEnabled` |
| 记忆存储目录 | 路径输入框，空 = 默认 | `autoMemoryDirectory` |

#### 🗄️ 数据与存储
| 设置项 | UI | 底层字段 |
|--------|----|---------|
| 会话历史保留天数 | 数字输入（默认 30） | `cleanupPeriodDays` |
| 导出配置 | 一键导出 `~/.claude-driver/config.json` | — |
| 导入配置 | 选择文件导入 | — |

#### ℹ️ 关于
| 设置项 | UI |
|--------|----|
| 当前版本 | 显示版本号 |
| 检查更新 | 按钮，跳转 GitHub Releases |
| 开源地址 | GitHub 链接 |

### 3.5 灵魂交流 Modal

**触发**：点击全局监控右半「功能入口」区块的 `💫 灵魂交流` 按钮

**Modal 规格**：
- 半透明黑色遮罩 + backdrop-filter: blur(2px)
- 内容区：圆角卡片，宽约 360px，居中显示
- 头部：`💫 灵魂交流` 标题 + 右上角 ✕ 关闭按钮
- 副标题说明文字
- 两个功能选项卡片（垂直排列）：

| 卡片 | 说明 | 触发操作 |
|------|------|---------|
| `✧ Auto-Dream` | Claude Code 内置后台记忆整合引擎（`services/autoDream/`），会话结束后自动提炼工作习惯与项目约定写入持久记忆。当前版本通过 feature flag 禁用，尚未全面开放 | 点击后显示弹窗：「此功能 Claude Code 暂时未全面开放，敬请期待」，不写入任何配置项 |
| `💡 /insight 使用洞见` | 分析 token 用量、项目进展、使用习惯，生成可视化 HTML 报告 | 调用 `/insights` 功能（注意：正确命令为复数形式），等待转圈 → 生成 `~/.claude/usage-data/report.html` → 在转圈位置出现打开按钮 → **Electron 内嵌 WebView 打开** |

- 鼠标悬停卡片时轻微边框高亮
- 点击遮罩背景 / ✕ 按钮关闭

### 3.6 定时触发

**触发**：点击全局监控右半「功能入口」区块的 `⏰ 定时触发` 按钮 → 展开子界面

**三种调度方式：**

| 方式 | 跨重启持久 | 需要开放会话 | 访问本地文件 | 推荐度 |
|------|-----------|------------|------------|--------|
| Cloud（云端） | 是 | 否 | 否（新鲜 clone） | — |
| **Desktop /loop** | **是** | **否** | **是** | **⭐ 推荐** |
| 会话内 /loop | 否 | 是（必须保持会话） | 是 | — |

**子界面内容：**
- 选择调度方式（默认 Desktop /loop）
- 触发时间/间隔输入（支持 cron 表达式或直观间隔选择器）
- 触发时执行的 prompt 输入框
- 是否重复的开关
- 已创建的定时任务列表（ID / 调度 / prompt，支持删除）

**底层工具**：`CronCreate` / `CronDelete` / `CronList`
**限制**：每会话最多 50 个调度任务；周期性任务 7 天后自动过期；最小粒度 1 分钟

### 3.7 远程交互

**触发**：点击全局监控右半「功能入口」区块的 `📡 远程交互` 按钮 → 展开子界面

**当前支持平台**：cc-connect 方式（飞书）
**未来兼容**：WhatsApp 等平台

**配置流程**（基于 cc-connect）：
1. 选择平台（当前仅飞书）
2. 引导用户完成飞书自建应用创建（App ID / App Secret / 机器人能力 / 权限 / 事件订阅 / 发布）
3. 输入配置项：
   - `work_dir`：Claude Code 工作目录
   - `app_id` / `app_secret`：飞书应用凭证
   - `admin_from`：管理员用户 open_id
   - `allowed_senders`：白名单用户列表
   - `enable_feishu_card`：是否启用卡片消息
4. 保存配置，启动 cc-connect 服务

---

## 4. 通用设计规范

### 4.1 状态标识

| 状态 | 视觉 | 含义 |
|------|------|------|
| 进行中 | 绿色转圈（灵动效果） | 正在执行 |
| 已完成 | 纯绿色不转圈 | 已完成 |
| 未开始 | 灰色圈不动 | 待执行 |
| 已中断 | 橙色标识 | 进程崩溃/被 kill |
| 可能暂停 | 灰色 + 文字提示 | 5min 内无 plan 变动 |
| 出问题（未来评估） | 红色圈 | 执行异常 |

### 4.2 通用层级关系

```
项目 → 一级 plan → 二级 plan → ...（可无限拓展，默认 M → S → T 三级）
```

- 每一级通过 plan 文件夹嵌套结构读取
- Plan 文件格式：`- [STATUS] 描述`，STATUS 枚举：`TODO` / `DOING` / `DONE`
- Plan 文件路径：相对于项目根目录，统一命名为 `plan/`

### 4.3 Plan 状态同步架构

| 链路 | 方式 | 频率 |
|------|------|------|
| **主链路** | Hooks 驱动（`PostToolUse` 检测 plan 文件夹写入） | 实时 |
| **兜底链路** | 独立线程全量读取所有 plan 文件 | 每 30s |

- 状态缓存文件：`~/.claude/projects/<project>/plan_state.json`
- Plan 文件损坏或格式不符 → 直接不显示该条目，不报错崩溃

### 4.4 对话生命周期管理

- 所有由仪表盘管理的 Claude session **必须通过仪表盘启动**：
  - 启动时弹出 **Claude 终端子窗口**（独立的 Electron `BrowserWindow`，嵌入 xterm.js 终端）
  - 子窗口内 xterm.js 接管 PTY 的 stdout 渲染，用户可直接在终端中输入
  - 仪表盘主进程同时持有该 PTY 的 stdin 管道，可程序化注入指令（不影响用户交互）
  - 子窗口可被用户独立关闭，关闭子窗口不终止 PTY 进程（仅取消 xterm 输出渲染）；重新打开窗口可恢复 PTY 输出流接入
- 用户手动启动的 Claude 进程：仪表盘可扫描 JSONL 转录文件**只读显示**，无法注入指令
- 终端子窗口 30min 无新交互 → 自动关闭（资源释放），同时发出提醒通知
- 进程存活心跳检测：每 10s 探测一次，进程消失 → 标记为"已中断"（橙色）

### 4.5 无限大画板渲染架构

- **方案**：Canvas-based 虚拟化画布（@xyflow/react）
- **只渲染可视视口 + 一个视口大小的缓冲区**
- **缩放级别**：最小 0.3x（节点文字最小 10px）/ 默认自动 / 最大 4x
- **活跃 Agent 聚合**：自动将活跃主进程线移到视图中心

### 4.6 设计风格

- 遵循 Anthropic Claude 风格
- 参考 UI 设计 demo 文件夹下的 HTML 文件（美术风格可参考，但需求不完全满足）
- 深色主题为主

---

## 5. Agent 配置规范

### 5.1 内置 Agent（默认显示）

| Agent 名称 | 模型 | 工具限制 | 触发场景 |
|-----------|------|---------|---------|
| Explore | Haiku | 只读（拒绝 Write/Edit） | 文件发现、代码搜索 |
| Plan | 继承主对话 | 只读（拒绝 Write/Edit） | Plan Mode 期间研究 |
| General-purpose | 继承主对话 | 全部工具 | 复杂研究 + 代码修改 |
| statusline-setup | Sonnet | — | 运行 /statusline 时触发 |
| Claude Code Guide | Haiku | — | 回答 Claude Code 功能问题 |

### 5.2 Subagent 完整配置字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 唯一标识符（小写字母和连字符） |
| `description` | 是 | Claude 何时委托的判断依据 |
| `model` | 否 | `sonnet`/`opus`/`haiku`/完整 ModelID/`inherit` |
| `tools` | 否 | 允许使用的工具列表（省略则继承全部） |
| `disallowedTools` | 否 | 明确拒绝的工具列表 |
| `permissionMode` | 否 | 6 种权限模式之一 |
| `maxTurns` | 否 | 最大代理轮数上限 |
| `skills` | 否 | 启动时预注入的 Skills |
| `mcpServers` | 否 | 此 subagent 可用的 MCP 服务器列表 |
| `hooks` | 否 | 生命周期 hooks |
| `memory` | 否 | 持久内存作用域：`user`/`project`/`local`/`None` |
| `effort` | 否 | `low`/`medium`（默认）/`high`/`max` |
| `isolation` | 否 | `worktree` 表示在临时 git worktree 中隔离运行 |
| `color` | 否 | 显示颜色 |
| `background` | 否 | 是否始终作为后台任务运行 |
| `initialPrompt` | 否 | 作为主会话 agent 运行时自动提交的第一个 prompt |

**作用域优先级**：托管设置 > `--agents` CLI 标志 > `.claude/agents/` > `~/.claude/agents/` > Plugin 的 `agents/` 目录

### 5.3 Plugin 自带 Subagents

- Plugin 安装时自带 subagents
- 激活 agent 时将这些 subagents 加入列表
- 来自已安装 plugins 的 subagents 与自定义 subagents 一起出现在 /agents 中

---

## 6. 工具列表

### 6.1 内置工具完整列表

| 工具名 | 描述 | 需要权限 |
|--------|------|----------|
| Agent | 生成具有独立 context window 的 subagent | 否 |
| AskUserQuestion | 提出多选题收集需求或澄清歧义 | 否 |
| Bash | 执行 shell 命令 | 是 |
| CronCreate | 调度周期性或一次性 prompt | 否 |
| CronDelete | 通过 ID 取消已调度任务 | 否 |
| CronList | 列出所有已调度任务 | 否 |
| Edit | 精确字符串替换编辑 | 是 |
| EnterPlanMode | 切换到 plan mode | 否 |
| EnterWorktree | 创建隔离的 git worktree | 否 |
| ExitPlanMode | 呈现计划供审批，退出 plan mode | 是 |
| ExitWorktree | 退出 worktree 会话 | 否 |
| Glob | glob 模式匹配查找文件 | 否 |
| Grep | 正则搜索文件内容 | 否 |
| ListMcpResourcesTool | 列出 MCP 服务器暴露的资源 | 否 |
| LSP | 语言服务器协议 | 否 |
| Monitor | 后台运行命令并反馈输出 | 是 |
| NotebookEdit | 修改 Jupyter notebook | 是 |
| NotebookRead | 读取 Jupyter notebook | 否 |
| PowerShell | Windows PowerShell 命令（预览版） | 是 |
| Read | 读取文件内容 | 否 |
| ReadMcpResourceTool | 通过 URI 读取 MCP 资源 | 否 |
| SendMessage | 向 agent team 队友发消息 | 否 |
| Skill | 执行一个 skill | 是 |
| TaskCreate | 创建新任务 | 否 |
| TaskGet | 获取特定任务详情 | 否 |
| TaskList | 列出所有任务及状态 | 否 |
| TaskStop | 终止运行中的后台任务 | 否 |
| TaskUpdate | 更新任务状态或删除任务 | 否 |
| TeamCreate | 创建 agent team（实验性） | 否 |
| TeamDelete | 解散 agent team（实验性） | 否 |
| TodoWrite | 管理会话任务清单 | 否 |
| ToolSearch | 搜索和加载延迟加载的工具 | 否 |
| WebFetch | 从 URL 抓取内容 | 是 |
| WebSearch | 执行网络搜索 | 是 |
| Write | 创建或覆写文件 | 是 |

### 6.2 Agent 可用工具列表（运行时）

| 工具 | 描述 | 使用费率 |
|------|------|---------|
| Agent | 在隔离工作目录中运行 subagent | 以 subagent 费率计 |
| AnswerQuestion | 不退出 Plan Mode 回答问题 | 无 |
| Bash | 执行 bash 命令 | 适用 |
| ComputerTool | 控制鼠标和键盘（部分平台） | 适用 |
| CritiqueCode | Plan Mode 代码评审 | 以 subagent 费率计 |
| Edit | 精确字符串替换 | 适用 |
| EnterPlanMode | 进入 Plan Mode | 无 |
| ExitPlanMode | 退出 Plan Mode | 无 |
| Glob | glob 查找文件 | 适用 |
| Grep | 正则搜索 | 适用 |
| NotebookEdit | 编辑 Notebook | 适用 |
| NotebookRead | 读取 Notebook | 适用 |
| Read | 读取文件 | 适用 |
| Task | 创建和管理任务 | 适用 |
| TodoRead | 读取任务列表 | 无 |
| TodoWrite | 创建/更新任务列表 | 适用 |
| WebFetch | 获取 URL 内容 | 适用 |
| WebSearch | 网络搜索 | 适用 |
| Write | 写入/创建文件 | 适用 |

---

## 7. 权限模式详表

| 模式 | 说明 | 适用场景 |
|------|------|---------|
| **default**（默认） | 每次文件编辑/运行命令都暂停请求确认 | 需要逐步把控的工作 |
| **acceptEdits**（自动接受编辑） | 可直接编辑文件和执行常用命令，无需确认 | 快速迭代代码 |
| **plan**（计划模式） | 只读分析，生成变更计划供用户审查 | 复杂重构前的规划 |
| **auto**（自动模式）⚠️ | 全自动执行，后台分类器过滤危险操作 | 仅限 Team/Enterprise/API 用户 |
| **dontAsk**（禁止提示） | 不提示，直接拒绝未允许的操作 | CI/CD 管道等自动化场景 |
| **bypassPermissions**（绕过权限）⚠️ 危险 | 禁用所有权限检查 | 仅限隔离容器/虚拟机 |

---

## 8. 上下文窗口

### 8.1 组件加载时机

| 组件 | 何时加载 | /compact 后是否保留 |
|------|---------|-------------------|
| System（系统提示） | 始终 | 是 |
| CLAUDE.md（项目根） | 会话开始时 | 是（从磁盘重新注入） |
| Memory（auto memory） | 会话开始时 | 是（从磁盘重新注入） |
| Skills（描述部分） | 会话开始时 | 描述保留；完整内容重新注入 |
| MCP（工具名称） | 会话开始时 | 是 |
| Rules（路径限定规则） | 匹配文件被读取时才加载 | 否 |
| 嵌套子目录 CLAUDE.md | 读取该子目录文件时懒加载 | 否 |
| Hooks | 作为代码运行，不占用上下文 | N/A |

### 8.2 上下文各组件加载规则

| 功能 | 何时加载 | 加载内容 | 上下文成本 |
|------|---------|---------|-----------|
| CLAUDE.md | 会话开始 | 完整内容 | 每个请求 |
| Skills | 会话开始 + 使用时 | 启动时描述，使用时完整内容 | 低（描述）* |
| MCP 服务器 | 会话开始 | 所有工具定义和 JSON 架构 | 每个请求 |
| Subagents | 生成时 | 具有指定 skills 的新鲜上下文 | 与主会话隔离 |
| Hooks | 触发时 | 无（外部运行） | 零 |

---

## 9. 版本规划

### Phase 1（MVP）

- [x] 全局监控页面（项目画板 + 配置面板 + 统计）
- [x] 项目监控页面（进程线 + 实时面板）
- [x] 创建项目 SOP
- [x] 初始化 SOP（项目认领）
- [x] 全局设置 Modal
- [x] 灵魂交流 Modal（Auto-Dream 开关 + /insight 调用）
- [x] 定时触发子界面
- [x] 远程交互子界面（cc-connect 飞书配置）
- [x] Plugins 面板（已安装列表 + 添加链接/命令 + 详情展示 + 删除）
- [x] 消息通知页面
- [x] Agent 列表 + 基础配置
- [x] 工具/MCP/CLI/Skills/工作流展示
- [x] 语言切换（中文/英文）
- [x] 上下文面板
- [x] 历史进度拉动条
- [x] Git Worktree 集成

### Phase 2（未来）

- [ ] 导入历史项目 + AI 自动分解需求
- [ ] 进度条（基于底层任务完成度统计）
- [ ] 画板导航（项目很多时列表导航到对应位置）
- [ ] Agent 工牌（黑白像素画风头像）
- [ ] Plugin 一键安装脚本
- [ ] Plugin 精品推荐市场
- [ ] 下载精选 Agent / MCP / Skills
- [ ] n8n 工作流对接
- [ ] 多用户/团队协作（数据模型已预留 `user_id` 字段）
- [ ] 企业考核机制（Harness Agent 数据）
- [ ] WhatsApp 远程交互
- [ ] 版本标记（手动标记发布版本对应哪些 plan）

---

## 10. 已确认事项

> 以下事项已根据产品决策确认：

1. **Plugin 安装**：第一阶段点击「添加 Plugin」显示"还在开发中"提示；未来实现时通过扫描 Plugin 安装文件夹发现已安装插件，暂不关注安装命令细节。
2. **Auto-Dream**：Auto-Dream 是 Claude Code 内部已实现但尚未全面开放的功能（`services/autoDream/`，通过 `AUTO_DREAM_ENABLED` feature flag 控制）。MVP 阶段点击卡片显示「此功能 Claude Code 暂时未全面开放，敬请期待」弹窗，不写入任何 settings.json 字段，待官方正式发布后替换为真实功能。
3. **/insight 报告打开方式**：使用 **Electron 内嵌 WebView** 打开生成的 HTML 报告。
4. **闲聊按钮**：点击后**弹出 Claude 终端子窗口**（独立 Electron BrowserWindow + xterm.js，不调用系统终端）。用户可直接在终端中输入，仪表盘持有 PTY stdin 可注入指令。
5. **消息通知页面的"联系人"**：定义为 **Agent**（项目中发送待处理请求的 Agent），而非远程交互平台发来请求的人。

---

## 附录 A：cc-connect 飞书配置项速查

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `work_dir` | Claude Code 工作目录 | `/Users/tony/projects/myapp` |
| `app_id` | 飞书 App ID | `cli_xxxxxxxxxxxxxxxx` |
| `app_secret` | 飞书 App Secret | — |
| `admin_from` | 管理员用户 open_id | `ou_your_feishu_open_id` |
| `allowed_senders` | 白名单用户 | `["ou_xxx", "ou_yyy"]` |
| `enable_feishu_card` | 启用卡片消息 | `true` |
| `progress_style` | 进度样式 | `card` / `compact` / `legacy` |
| `reset_on_idle_mins` | 空闲重置会话 | 默认不重置 |

## 附录 B：hooks 事件类型速查

| 分类 | 事件名 | 触发时机 |
|------|--------|---------|
| 会话级 | `SessionStart` / `SessionEnd` / `Setup` | 会话开始/结束/初始化 |
| 工具调用 | `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | 工具调用前/后/失败 |
| 权限 | `PermissionRequest` / `PermissionDenied` | 权限请求/拒绝 |
| 用户交互 | `UserPromptSubmit` / `Notification` | 用户提交/通知 |
| 停止/继续 | `Stop` / `StopFailure` / `SubagentStart` / `SubagentStop` | 响应完成/失败/子代理启停 |
| 上下文 | `PreCompact` / `PostCompact` | 压缩前/后 |
| 其他 | `TaskCreated` / `TaskCompleted` / `ConfigChange` / `FileChanged` / `CwdChanged` / `WorktreeCreate` / `WorktreeRemove` / `InstructionsLoaded` | 各类状态变更 |

## 附录 C：settings.json 关键字段速查

| 字段 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `model` | string | 默认模型 | `claude-opus-4-6` |
| `language` | string | 响应语言 | `english` |
| `effortLevel` | string | 思考力度 | `medium` |
| `fastMode` | boolean | Fast Mode | `false` |
| `smallFastModel` | string | 轻量快速模型 | 未指定 |
| `autoMemoryEnabled` | boolean | 自动记忆 | `true` |
| `autoDreamEnabled` | boolean | Auto-Dream（Claude Code 内部 feature flag，当前生产版本已通过编译时裁剪禁用；Claude Driver MVP 不读写此字段） | `false` |
| `outputStyle` | string | 输出样式 | `default` |
| `showThinkingSummaries` | boolean | 思考摘要 | `false` |
| `syntaxHighlightingDisabled` | boolean | 禁用代码高亮 | `false` |
| `spinnerTipsEnabled` | boolean | Spinner 小贴士 | `true` |
| `cleanupPeriodDays` | integer | 会话保留天数 | `30` |
| `permissions.defaultMode` | string | 默认权限模式 | `default` |
| `permissions.allow` | string[] | 工具白名单 | `[]` |
| `permissions.additionalDirectories` | string[] | 额外目录 | `[]` |
| `ignorePatterns` | string[] | 忽略文件模式 | `[]` |
| `enabledPlugins` | object | 插件状态 | `{}` |

## 附录 D：关于默认plan方案：M-S-T层级的一些额外要求（提醒用户也可以自己修改plan制定方案）
### 如何制定计划

1. 你是一名资深的 {{DOMAIN_EXPERTISE}} 架构师，精通 {{TECH_STACK}}
2. **优先站在巨人肩膀上**：计划自己编写代码之前，先本地 + 联网调研，确认需要实现的功能是否已有现成实现（尤其是本地官方 demo 和用户成功运行的代码）；如有可直接复用的已实现部分，优先基于此实现，不重复造轮子
3. **充分考虑项目特殊性**：阅读相关 UserGuide，查看开发流程图，关注与通识认知不同的特殊地方（流程、机制、参数配置、硬件特性等）
4. **宏观架构先选型**：制定计划时，在架构设计和功能模块实现框架图上列出多个方案，分析解耦性、复用性、拓展性，**等待用户确认后**才写入 plan
5. 架构和代码设计必须考虑：**解耦性、复用性、拓展性**
6. **每个目标本质是检查点**：计划必须包含具体的测试通过考核内容与标准
7. **充分确认约束**：尤其是硬件参数，禁止瞎编假设值，必须向用户询问
8. **说明技术原理**：overall_plan 里说明架构选型理由，每个 T 文件说明所采用技术的特性、原理和选择理由

---

### 文件结构

```
plan/
├── overall_plan.md              # 母目标 + 子目标 + 任务（含架构选型分析）
├── M1_<母目标名>/
│   ├── 使用指南.md              # M 目标完成时创建，记录运行使用方法
│   └── S1_<子目标名>/
│       └── T1_<任务名>.md       # 细分执行计划，直到原子目标级别
└── M2_<母目标名>/
    └── ...
```
### 目标层级

```
M 母目标（关键节点交付目标）
└── S 子目标（功能模块级）
    └── T 任务（实现步骤级）[每个T文件说明技术原理和选择理由]
        └── 原子目标（最小执行单元，细化到具体命令行/代码行级别）
```

`overall_plan.md` 包含 M、S、T 三层（含架构选型理由）。
T 级别的 `.md` 文件包含更细分的任务，直到原子目标，还有「待优化项」章节记录性能瓶颈等。
---

## 附录 D：原子底层功能清单

> **设计原则：** 以下每个原子功能点都是最小可复用单元，上层需求均由这些原子功能的组合实现。  
> **架构师参考：** 每个功能点的输入/输出/依赖明确，可直接映射到代码模块。  
> **开发者参考：** 实现时按模块分组开发，确保单一职责、可独立测试。

---

### D.1 进程管理模块（Process Manager）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| P1 | **PTY 启动 Claude 进程** | 项目路径、权限模式、模型、agent 参数 | PTY 句柄（stdin/stdout/stderr）+ 终端子窗口 | 使用 `node-pty` 创建伪终端，以父进程方式启动 Claude CLI；同时弹出独立 BrowserWindow（嵌入 xterm.js），xterm.js 接管 PTY stdout 渲染，用户可直接在终端中输入；仪表盘持有 PTY stdin 可程序化注入指令 | 创建项目 SOP、项目监控、闲聊按钮 |
| P2 | **向进程 stdin 写入指令** | PTY 句柄、指令字符串 | 无 | 向 Claude 进程发送用户输入或自动指令（如"创建计划"） | 消息输入行、创建项目 SOP、定时触发 |
| P3 | **从进程 stdout 读取输出** | PTY 句柄 | 文本流（逐行） | 实时读取 Claude 的文本输出，用于实时显示 | 当前工作情况、实时状态显示 |
| P4 | **进程存活心跳检测** | PTY 句柄 | 布尔值（存活/死亡） | 每 10s 探测一次，进程消失时标记为"已中断"（橙色） | 对话生命周期管理、状态标识 |
| P5 | **进程超时自动关闭** | PTY 句柄、超时阈值（默认 30min） | 无 | 30min 无新交互则自动关闭进程，释放资源 | 对话生命周期管理 |
| P6 | **进程终止** | PTY 句柄 | 无 | 发送 SIGTERM/SIGKILL 终止 Claude 进程 | 打断对话、资源释放 |
| P7 | **进程恢复** | session_id（从 JSONL 路径提取） | PTY 句柄 | 通过 `claude --resume` 恢复之前的会话 | 回到对话按钮 |
| P8 | **弹出 Claude 终端子窗口** | 工作目录、sessionId、PTY 句柄 | BrowserWindow 实例 | 创建独立 Electron BrowserWindow，渲染进程加载 xterm.js；通过 IPC 将 PTY stdout 实时推送给 xterm.js 渲染；xterm.js 的用户输入通过 IPC 转发给 PTY stdin；支持窗口关闭后重新打开（PTY 仍持有，恢复输出流接入）；支持程序化调用写入指令和关闭窗口 | 闲聊按钮、所有 Session 启动 |

---

### D.2 数据读取模块（Data Reader）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| D1 | **JSONL 转录文件解析** | JSONL 文件路径（主进程或 subagent） | 结构化消息数组（含 sessionId/type/role/content/tool_use/tool_result/cwd） | 逐行解析 JSONL；路径规则：`~/.claude/projects/<encoded-path>/<session-uuid>.jsonl`，subagent 路径：`<session-uuid>/subagents/<subagent-uuid>.jsonl`；需同时监听主进程和 subagent 文件；采用 tail 追加模式（fs.watch + 定时轮询兜底），避免重复读取已处理内容 | 历史进程线、工具调用详情、Subagent 展示 |
| D2 | **statusLine 数据接收与解析** | Claude Code 每次状态刷新（约 300ms，事件驱动）写入桥接脚本 stdin 的 JSON | 结构化对象（model/context_window/used_percentage/rate_limits/transcript_path/cwd） | 仪表盘安装时在 `~/.claude/settings.json` 的 `statusLine` 字段注册**桥接脚本**路径；Claude Code 周期性调用该脚本并向其 stdin 写入状态 JSON；桥接脚本将数据 HTTP POST 至仪表盘固定端口 39521；仪表盘解析后更新统计数据。关键字段：`context_window.current_usage`（首次 API 调用前为 null）、`transcript_path`（当前会话 JSONL 路径权威来源） | 全局统计、Token 进度条、模型显示 |
| D3 | **Hook 事件接收与解析** | Claude Code 通过 HTTP type hook 发出的 POST 请求（body 含 hook_event_name/session_id/tool_name/tool_input/tool_response/cwd 等字段） | 结构化事件对象（含 event_type/session_id/tool_name/payload） | 仪表盘在 Main Process 启动**固定端口 39521** 的本地 HTTP Server；在 `~/.claude/settings.json` 中注册 `type: "http", url: "http://localhost:39521/hooks"` 的 Hook 配置；Claude Code 直接 POST 至该地址，无需中间脚本。端口被占用时启动弹窗提示用户在全局设置中修改端口号 | Plan 状态同步、实时工具调用、Subagent 启停 |
| D4 | **文件变动监听** | 目录路径、文件模式（如 `plan/**/*.md`） | 文件变动事件流（created/modified/deleted） | 使用 `chokidar`（Node.js）监听；同时配置定时轮询兜底（macOS 下 `fs.watch` 对长时间运行的 watcher 可能静默停止触发） | 倒三角执行指示器、Plan 状态同步 |
| D5 | **Plan 文件读取与解析** | Plan 文件路径 | Plan 层级树（M/S/T 结构，含状态标记） | 解析 `- [STATUS] 描述` 格式，构建层级树 | 执行计划折叠区、项目画板 plan 列表 |
| D6 | **settings.json 读取/写入** | 文件路径（全局/项目级） | JSON 对象 / 无 | 读取或写入 `~/.claude/settings.json` 或 `.claude/settings.json` | 全局设置、Plugin 状态读取、权限配置 |
| D7 | **CLAUDE.md 读取** | 项目路径 | 文本内容 | 读取项目根目录或子目录的 CLAUDE.md | 上下文面板、项目识别 |
| D8 | **Agent 配置文件读取** | Agent 目录路径（`~/.claude/agents/` 或 `.claude/agents/`） | Agent 配置数组 | 读取所有 `.json` 或 `.md` 格式的 Agent 定义 | Agent 面板、指派 Agent 工作 |
| D9 | **Plugin 元数据加载** | Plugin 目录路径或 enabledPlugins 字段 | Plugin 详情对象（名称/描述/MCP 列表/Skills 列表/Hooks 列表） | 从 Plugin 文件夹或 `enabledPlugins` 字段加载元数据 | Plugins 面板、Plugin 详情展示 |
| D10 | **MCP 服务器列表加载** | `~/.mcp.json` 或 settings.json 的 `mcpServers` 字段 | MCP 服务器数组（名称/命令/参数/env） | 解析 MCP 配置，提取服务器名和连接信息 | 工具面板（MCP 列） |
| D11 | **Skills 列表加载** | Skills 目录路径（`~/.claude/skills/` 或 `.claude/skills/`） | Skills 数组（名称/描述/触发条件） | 读取 Skill 定义文件 | 经验面板（Skills 列） |
| D12 | **工作流列表加载** | Hooks 配置（settings.json 的 `hooks` 字段） | 工作流数组（HookType/名称/触发条件） | 解析 Hooks 配置，提取工作流信息 | 经验面板（工作流列） |
| D13 | **工具调用详情提取** | JSONL 中的 `tool_use` 条目 | 结构化对象（工具名/操作描述/时间戳） | 按工具类型提取对应字段（Bash→description, Read→file_path 等） | 历史进程线工具框、实时工具框 |

---

### D.3 存储管理模块（Storage Manager）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| S1 | **JSON 配置文件读写** | 文件路径、数据对象 | 无 / 数据对象 | 原子性读写 JSON 文件，支持锁机制防止并发冲突 | 项目记录单、全局配置、Plan 状态缓存 |
| S2 | **项目记录单 CRUD** | 项目路径、认领状态 | 更新后的项目记录单 | 增删改查 `~/.claude-driver/projects.json` 中的项目条目 | 初始化 SOP、项目识别、项目画板 |
| S3 | **Plan 状态缓存读写** | 项目路径、Plan 状态对象 | 无 / 状态对象 | 读写 `~/.claude/projects/<project>/plan_state.json` | Plan 状态同步、倒三角指示器 |
| S4 | **配置导出** | 源配置路径 | 导出的 JSON 文件 | 将 `~/.claude-driver/config.json` 复制到用户指定位置 | 全局设置（导出配置） |
| S5 | **配置导入** | 导入文件路径 | 更新后的配置 | 将用户选择的 JSON 文件导入为全局配置 | 全局设置（导入配置） |
| S6 | **Git Worktree 映射数据库** | session_id、worktree_path、branch_name | 映射记录 | 维护本地映射数据库，记录 session 与 worktree 的对应关系 | Git Worktree 绑定、回退到当前版本 |

---

### D.4 Git 操作模块（Git Manager）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| G1 | **创建 Git Worktree** | 项目路径、分支名、worktree 路径 | 无（或错误信息） | 执行 `git worktree add -b <branch> <path>` | 创建项目 SOP、Git Worktree 绑定 |
| G2 | **删除 Git Worktree** | worktree 路径 | 无 | 执行 `git worktree remove <path>` | Session 结束后清理 |
| G3 | **Git Commit（快照）** | worktree 路径、commit 消息 | commit hash | 在当前 worktree 执行 `git add -A && git commit -m "<msg>"` | Git 当前版本按钮 |
| G4 | **Git Merge（合并到主线）** | 主线分支名、特性分支名 | 无（或冲突信息） | 执行 `git merge` 将特性分支合并到主线 | 输入到 git 主线按钮、同步到 GitHub 按钮 |
| G5 | **Git Push（推送到 GitHub）** | 远程仓库 URL、分支名 | 无（或错误信息） | 执行 `git push origin <branch>` | 同步到 GitHub 按钮 |
| G6 | **Git Rebase（删除 commit）** | base commit hash、起始 commit hash、目标分支 | 无（或冲突信息） | 执行 `git rebase --onto <base> <start> <end>` 自动删除指定 commit 区间（全程无需用户交互，可在后台静默执行）；注意：`git rebase -i` 为交互模式，不可在程序中自动化，禁止使用 | 删除节点（同步删除 git 历史） |
| G7 | **Git Reset（回退到版本）** | commit hash | 无 | 执行 `git reset --hard <hash>` 回退到指定版本 | 回退到当前版本按钮 |
| G8 | **Git 状态查询** | 项目路径 | 对象（当前分支/未提交更改/是否 git 过） | 执行 `git status` 和 `git log` 查询 | 节点交互（判断是否可回退） |
| G9 | **Git 节点标记** | 节点 ID、commit hash | 更新后的节点对象 | 在节点数据中标记该节点已 git，记录 commit hash 和颜色 | 历史进程线（git 过的节点颜色标记） |

---

### D.5 事件系统模块（Event System）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| E1 | **Hook 事件注册** | 事件类型列表、目标 URL（`http://localhost:39521/hooks`） | 无 | 在 `~/.claude/settings.json` 中以 `type: "http"` 格式注册 Hook 配置；仪表盘首次启动时自动注入，合并到已有 hooks 配置（不覆盖用户其他 hooks）；注册事件：`SessionStart / PreToolUse / PostToolUse / PostToolUseFailure / SubagentStart / SubagentStop / Notification / Stop / SessionEnd` | 项目创建、Plan 状态同步 |
| E2 | **内部事件总线** | 事件对象（类型/数据/时间戳） | 无 | 统一的事件分发中心，将 Hook/statusLine/JSONL 事件路由到对应 UI 组件 | 所有实时数据更新 |
| E3 | **UI 事件分发** | 事件类型、目标组件 ID | 无 | 将内部事件分发到对应的 UI 组件进行更新 | 进程线实时更新、状态指示器更新 |
| E4 | **权限请求事件处理** | 权限请求对象（工具名/参数/session_id） | 用户响应（同意/拒绝 + 附加信息） | 接收 Claude 的权限请求，展示给用户并收集响应 | 请求交互框、消息通知页面 |

---

### D.6 统计计算模块（Statistics Engine）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| T1 | **Token 用量统计（实时）** | statusLine 数据流 | 当前 session 的实时 token 用量 | 累加 `context_window.current_usage`，按 session 分组 | 全局统计（本月 Token）、项目监控顶栏 |
| T2 | **Token 用量统计（历史）** | JSONL 文件数组 | 历史 token 用量（按 session/项目/日期分组） | 解析 JSONL 中的 token 估算信息，聚合计算 | 全局统计、费用计算 |
| T3 | **费用计算** | Token 用量、Input/Output 单价 | 费用金额（美元） | 公式：`(input_tokens * input_price + output_tokens * output_price) / 1_000_000` | 全局统计（累计费用）、月度预算提醒 |
| T4 | **模型使用占比计算** | 各模型 token 用量 | 各模型占比百分比 | 计算每个模型的 token 用量占总用量的比例 | 全局统计（常用模型卡片） |
| T5 | **环比计算** | 本期用量、上期用量 | 环比百分比（↑/↓%） | 公式：`(本期 - 上期) / 上期 * 100%` | 全局统计（本月 Token 副信息） |
| T6 | **项目费用分摊计算** | 各项目 token 用量、总费用 | 各项目分摊金额 + 百分比 | 按项目 token 占比分摊总费用 | 累计费用卡片点击弹出的浮层 |
| T7 | **上下文 token 估算** | 各组件内容（System/CLAUDE.md/Memory/Skills/文件等） | 各组件 token 估算值 + 总占比 | 使用 tiktoken 本地估算各部分 token 数 | 上下文面板（token 估算占比） |

---

### D.7 上下文管理模块（Context Tracker）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| C1 | **上下文组件追踪** | 工具调用事件流 | 上下文组件列表（类型/名称/token 估算/加载时机） | 追踪哪些组件已加载到上下文中 | 上下文面板列表 |
| C2 | **上下文更新（读取触发）** | Read/WebFetch 等工具调用事件 | 更新后的上下文组件列表 | 每当有读取操作，将读取的内容加入上下文列表 | 上下文面板实时更新 |
| C3 | **上下文切换** | agent_id（含 subagent） | 该 agent 的上下文组件列表 | 切换到指定 agent 的上下文视图 | 上下文面板（切换 agent） |
| C4 | **上下文清除（记忆压缩后）** | 压缩事件 | 清除后的上下文组件列表 | 记忆压缩后清除旧内容，保留 System/CLAUDE.md 等持久组件 | 上下文面板（记忆压缩后更新） |

---

### D.8 消息队列模块（Message Queue）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| Q1 | **消息入队** | 消息内容（字符串）、session_id | 队列长度 | 将用户输入的消息加入队列尾部 | 消息输入行 |
| Q2 | **消息出队（FIFO）** | session_id、队列状态 | 队首消息（或 null） | 监听 `Stop` Hook 事件（Claude 完成当前响应的信号）；收到 Stop 事件且队列非空时，弹出队首消息准备注入；若队列为空则等待下一次用户输入 | 消息输入行（自动注入） |
| Q3 | **自动注入会话** | 消息内容、PTY 句柄 | 无 | 将出队的消息通过 stdin 写入 Claude 进程 | 消息输入行 |

---

### D.9 通知系统模块（Notification Manager）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| N1 | **桌面通知** | 通知标题、内容、图标 | 无 | 调用 Electron `Notification` API 发送系统通知 | 消息通知（系统通知） |
| N2 | **任务栏角标更新** | 待处理请求数量 | 无 | 更新 Electron 窗口任务栏角标（`setBadgeCount`） | 底部标签栏（待处理请求角标） |
| N3 | **通知队列管理** | 通知对象（类型/数据/时间戳/FIFO 顺序） | 通知列表 | 管理所有待处理通知，支持增删查 | 消息通知页面（左侧 Agent 请求列表） |

---

### D.10 定时任务模块（Scheduler）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| H1 | **Cron 任务创建** | session_id、cron 表达式、prompt | 任务 ID | 通过 `CronCreate` 工具或直接向 Claude 发送 `/loop` 命令 | 定时触发子界面 |
| H2 | **Cron 任务删除** | 任务 ID | 无 | 通过 `CronDelete` 工具取消已调度任务 | 定时触发子界面（删除任务） |
| H3 | **Cron 任务列表** | session_id | 任务数组（ID/调度/prompt/状态） | 通过 `CronList` 工具获取已调度任务 | 定时触发子界面（任务列表） |

---

### D.11 远程交互模块（Remote Bridge）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| R1 | **cc-connect 配置管理** | 配置对象（work_dir/app_id/app_secret/admin_from/allowed_senders 等） | 配置文件（`~/.cc-connect/config.toml`） | 生成并写入 cc-connect 配置文件 | 远程交互子界面 |
| R2 | **cc-connect 服务启动/停止** | 配置文件路径 | 进程句柄 / 无 | 启动或停止 cc-connect 后台服务 | 远程交互子界面 |
| R3 | **cc-connect 状态检测** | 无 | 布尔值（运行中/已停止） | 检测 cc-connect 进程是否存活 | 远程交互状态显示 |

---

### D.12 Plugin 管理模块（Plugin Manager）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| PL1 | **Plugin 状态读取** | `~/.claude/settings.json` 的 `enabledPlugins` 字段 | Plugin 启用状态对象 | 读取已启用的 Plugin 列表 | Plugins 面板（已安装列表） |
| PL2 | **Plugin 文件夹扫描** | Plugin 安装目录路径 | Plugin 元数据数组 | 扫描目录，提取每个 Plugin 的名称/版本/描述 | Plugins 面板（未来实现） |
| PL3 | **Plugin 删除** | Plugin ID | 更新后的 settings.json | 从 `enabledPlugins` 中移除该 Plugin | Plugins 面板（删除按钮） |
| PL4 | **Plugin 详情加载** | Plugin ID | Plugin 详情（应用场景/作用/MCP 列表/Skills 列表/Hooks 列表） | 加载 Plugin 的完整元数据 | Plugin 详情展示 |
| PL5 | **Plugin 自带 Subagents 加载** | Plugin ID | Subagent 配置数组 | 从 Plugin 的 `agents/` 目录加载 subagent 定义 | 指派 Agent 工作（Plugin 自带 subagents） |

---

### D.13 Agent 管理模块（Agent Manager）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| A1 | **Agent 配置读取** | Agent 目录路径 | Agent 配置对象数组 | 读取所有 Agent 定义文件（JSON/MD 格式） | Agent 面板、指派 Agent 工作 |
| A2 | **Agent 配置创建** | Agent 配置对象 | 写入的 Agent 文件路径 | 创建新的 Agent 定义文件到指定目录 | 添加 Agent |
| A3 | **Agent 配置编辑** | Agent 文件路径、更新后的配置对象 | 无 | 更新已有 Agent 定义文件 | Agent 编辑 |
| A4 | **Agent 配置删除** | Agent 文件路径 | 无 | 删除 Agent 定义文件 | Agent 删除 |
| A5 | **Agent 激活** | Agent 名称、项目路径 | PTY 句柄 | 通过 `claude --agent <name>` 启动指定 Agent 的会话 | 指派某个 Agent 工作 |
| A6 | **内置 Agent 列表加载** | 无 | 内置 Agent 数组（Explore/Plan/General-purpose/statusline-setup/Claude Code Guide） | 硬编码或从官方文档加载内置 Agent 信息 | Agent 面板（默认显示） |

---

### D.14 项目识别模块（Project Discovery）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| PD1 | **文件夹扫描（含 CLAUDE.md）** | 根目录路径 | 含 CLAUDE.md 的文件夹路径数组 | 递归扫描目录，找出所有包含 CLAUDE.md 的文件夹 | 初始化 SOP、重新扫描 |
| PD2 | **路径前缀匹配去重** | 文件夹路径数组 | 去重后的项目根路径数组 | 同一根路径下所有子路径归属同一项目（如 `/home/Tony/Test` 和 `/home/Tony/Test/plan` → `/home/Tony/Test`） | 初始化 SOP、项目去重合并 |
| PD3 | **项目认领状态管理** | 项目路径、认领状态（1/0/-1） | 更新后的项目记录单 | 更新项目的认领状态 | 初始化 SOP（项目认领清单） |
| PD4 | **新文件夹检测** | 已扫描目录路径 | 新文件夹路径（或无） | 监听目录变化，检测新出现的含 CLAUDE.md 的文件夹 | 重新扫描触发时机② |
| PD5 | **项目加载过滤** | 项目记录单 | 认领状态为 1 的项目数组 | 过滤出已确认的项目 | 每次打开软件加载项目 |

---

### D.15 状态管理模块（State Manager）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| SM1 | **项目状态追踪** | 项目路径、进程状态 | 项目状态对象（进行中/已完成/未开始/已中断/暂停） | 根据进程存活状态和 plan 变动更新项目状态 | 项目画板（绿点/灰点）、状态标识 |
| SM2 | **Session 状态追踪** | session_id、进程状态 | Session 状态对象（运行中/已暂停/已中断/已完成） | 追踪每个 session 的实时状态 | 项目监控页面（Session 状态） |
| SM3 | **Plan 状态同步（Hooks 驱动）** | PostToolUse Hook 事件 | 更新后的 Plan 状态缓存 | Hook 检测到 plan 文件写入时立即更新状态缓存 | Plan 状态同步主链路 |
| SM4 | **Plan 状态同步（轮询兜底）** | 项目路径 | 更新后的 Plan 状态缓存 | 每 30s 全量读取所有 plan 文件，修正 hooks 漏报的差异 | Plan 状态同步兜底链路 |
| SM5 | **倒三角执行指示器管理** | Plan 状态缓存、时间戳 | 倒三角指示器列表（plan 路径/状态/触发时间） | 根据 plan 变动创建/销毁倒三角指示器 | 项目画板（倒三角执行指示器） |
| SM6 | **倒三角销毁条件检测** | 倒三角指示器列表、Plan 状态 | 更新后的倒三角指示器列表 | 检测销毁条件：① M 任务完成且 3min 无变动 ② 5min 无变动 | 倒三角执行指示器 |

---

### D.16 UI 渲染模块（UI Renderer）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| U1 | **无限画板渲染** | 节点数组、连线数组、视口参数 | Canvas/SVG 渲染结果 | 基于 @xyflow/react 渲染无限画板，支持缩放/平移 | 全局监控项目画板、项目监控进程线画布 |
| U2 | **视口管理** | 画板尺寸、节点位置、缩放级别 | 视口参数（x/y/zoom） | 管理可视视口，自动缩放至能同时显示全部活跃主进程 | 无限画板渲染架构 |
| U3 | **虚拟化渲染** | 视口参数、节点数组 | 可视区域内的节点数组 | 只渲染可视视口内及周边一个视口大小的缓冲区域 | 无限大画板渲染架构 |
| U4 | **进程线渲染** | Session 数据（节点/连线/Subagent/工具调用） | 进程线 DOM/Canvas 元素 | 渲染单条或多条并行的进程线，支持折叠/展开 | 项目监控页面（历史工作进程线） |
| U5 | **节点渲染** | 节点数据（类型/内容/时间戳/状态） | 节点 DOM 元素 | 渲染 Claude 回复节点/用户输入标签/Subagent 块/Insight 菱形/打断节点 | 进程线节点 |
| U6 | **连线渲染** | 连线数据（起点/终点/标签/样式） | 连线 DOM/Canvas 元素 | 渲染"继承记忆"连线或其他关联连线 | /branch 继承记忆情形 |
| U7 | **树形结构渲染** | 层级数据（Plan 树/M/S/T 结构） | 树形 DOM 元素 | 渲染可展开/折叠的树形结构，支持层级缩进 | 执行计划折叠区 |
| U8 | **列表渲染（截断/展开）** | 数据数组、截断阈值（默认 3） | 列表 DOM 元素（含 `···` 或完整列表） | 条目 ≤3 全显示；>3 显示前 2 条 + `···` | 通用面板条目规范 |
| U9 | **Modal/浮层渲染** | 内容组件、尺寸规格、关闭回调 | Modal DOM 元素 | 渲染居中 Modal，支持遮罩背景点击关闭、✕ 按钮关闭 | 全局设置 Modal、灵魂交流 Modal、展开覆盖浮层 |
| U10 | **标签页渲染** | 标签数组、当前激活标签 | 标签栏 DOM 元素 | 渲染底部标签栏，支持切换、角标、激活指示 | 底部标签栏 |
| U11 | **状态指示器渲染** | 状态类型（进行中/已完成/未开始/已中断/暂停） | 状态指示器 DOM 元素（绿点/灰点/旋转/橙色） | 渲染不同状态的视觉指示器 | 项目卡片状态、Agent 状态、Plan 状态 |
| U12 | **历史进度拉动条渲染** | 时间点数组、当前位置 | 拉动条 DOM 元素 | 渲染可拖动的拉动条，支持键盘精确移动 | 历史进度拉动条 |
| U13 | **工具/经验框渲染** | 工具调用数据、经验调用数据 | 工具框 + 经验框 DOM 元素 | 渲染固定结构的工具框（Tools/MCP/CLI）和经验框（Skills/工作流） | 历史进程线工具/经验展示、实时工具/经验框 |
| U14 | **WebView 渲染** | HTML 文件路径或 URL | WebView 组件 | 在 Electron 内嵌 WebView 加载 HTML 内容 | /insight 报告打开方式 |
| U15 | **主题切换** | 主题类型（深色/浅色） | CSS 变量更新 | 切换全局主题，更新 CSS 变量 | 全局设置（主题） |

---

### D.17 国际化模块（i18n）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| I1 | **语言切换** | 语言代码（zh/en） | 无 | 切换全局语言设置，更新界面语言 | 底部标签栏语言切换、全局设置（界面语言） |
| I2 | **多语言资源加载** | 语言代码 | 翻译资源对象 | 加载对应语言的翻译资源 | 所有界面文本 |
| I3 | **Claude 回复语言设置** | 语言代码 | 更新后的 settings.json | 写入 `language` 字段到 settings.json | 全局设置（Claude 回复语言） |

---

### D.18 配置管理模块（Config Manager）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| CF1 | **全局配置读写** | 配置键值对 | 无 / 配置值 | 读写 `~/.claude-driver/config.json` 中的配置项 | 全局设置页面所有设置项 |
| CF2 | **项目配置读写** | 项目路径、配置键值对 | 无 / 配置值 | 读写项目级 `.claude/settings.json` 中的配置项 | 项目监控页面（项目设置） |
| CF3 | **配置变更通知** | 变更的配置键 | 无 | 通知所有订阅者配置已变更，触发 UI 更新 | 所有设置项的实时生效 |
| CF4 | **配置验证** | 配置对象 | 验证结果（通过/失败 + 错误信息） | 验证配置是否符合 JSON Schema | 全局设置（保存时验证） |

---

### D.19 命令执行模块（Command Executor）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| X1 | **Shell 命令执行** | 命令字符串、工作目录 | 命令输出（stdout/stderr）+ 退出码 | 执行任意 shell 命令，用于测试连通性等 | API Key 测试连通性、cc-connect 服务管理 |
| X2 | **Claude CLI 命令执行** | session_id、命令（如 `/insights`、`/branch`、`/btw`） | 命令执行结果 | 通过 PTY stdin 向 Claude 发送斜杠命令 | /insight 调用、开新分支 agent、btw |
| X3 | **apiKeyHelper 命令执行** | 命令字符串 | API Key（stdout 输出） | 执行用户配置的命令，将 stdout 作为 API Key | 全局设置（API Key 获取方式） |

---

### D.20 网络模块（Network）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| NW1 | **HTTP Server（接收 Hooks + statusLine）** | 固定端口 39521（默认，可在全局设置中修改）、路由配置 | HTTP Server 实例 | 在 Electron Main Process 启动本地 HTTP Server，监听 `http://127.0.0.1:39521`；接收 Claude Hook 的直接 HTTP POST 请求及 statusLine 桥接脚本的状态数据转发；启动时检测端口占用，若被占用则弹窗提示用户修改端口 | Hook 事件接收、statusLine 数据接收 |
| NW2 | **HTTP 客户端（测试连通性）** | API URL、API Key | 连通性结果（成功/失败 + 错误信息） | 发送测试请求验证 API Key 是否有效 | 全局设置（测试连通性） |
| NW3 | **检查更新** | GitHub Releases API URL | 最新版本信息（版本号/下载链接/更新日志） | 请求 GitHub API 检查是否有新版本 | 全局设置（检查更新） |

---

### D.21 文件系统模块（File System Watcher）

| # | 原子功能 | 输入 | 输出 | 说明 | 支撑的上层需求 |
|---|---------|------|------|------|--------------|
| FS1 | **目录扫描** | 根目录路径、过滤条件 | 符合条件的文件/文件夹路径数组 | 递归扫描目录，按条件过滤 | 项目识别、Plugin 文件夹扫描 |
| FS2 | **文件创建/写入** | 文件路径、内容 | 无 | 创建或覆写文件 | 创建项目（CLAUDE.md/settings.json）、Agent 配置创建 |
| FS3 | **文件监听** | 文件/目录路径 | 文件变动事件流（created/modified/deleted） | 监听文件或目录的变化 | Plan 状态同步、新文件夹检测 |
| FS4 | **路径解析（跨平台）** | 路径字符串（含 `~/` 或 `%USERPROFILE%`） | 绝对路径 | 将用户路径解析为平台相关的绝对路径 | 所有路径相关操作 |

---

### D.22 需求 → 原子功能映射表

> 以下表格展示每个上层需求由哪些原子功能组合实现，帮助架构师理解模块间的依赖关系。

| 上层需求 | 依赖的原子功能编号 |
|---------|------------------|
| **全局监控 — 项目画板** | PD1, PD2, PD5, SM1, SM5, SM6, U1, U2, U3, U11 |
| **全局监控 — 全局统计** | D2, T1, T2, T3, T4, T5, T6, U8 |
| **全局监控 — Agent 面板** | A1, A6, U8 |
| **全局监控 — 经验面板** | D11, D12, U8 |
| **全局监控 — 工具面板** | D10, U8 |
| **全局监控 — Plugins 面板** | PL1, PL3, PL4, U8, U9 |
| **全局监控 — 创建项目 SOP** | P1, P2, FS2, CF2, E1, G1 |
| **全局监控 — 初始化 SOP** | PD1, PD2, PD3, PD4, PD5, U9 |
| **全局监控 — 闲聊按钮** | P8 |
| **全局监控 — 功能入口（定时触发/远程交互/灵魂交流）** | H1, H2, H3, R1, R2, R3, CF1, X2, U9, U14 |
| **项目监控 — 项目顶栏** | CF2, G5, U10 |
| **项目监控 — 历史进程线画布** | D1, D13, U4, U5, U6, U13, G9 |
| **项目监控 — 当前工作情况面板** | D2, D3, D13, C1, C2, C3, C4, Q1, Q2, Q3, U7, U11, U13 |
| **项目监控 — 节点交互（Git/回退/删除/多 agent）** | G3, G4, G6, G7, G8, A5, X2, U5 |
| **项目监控 — 历史进度拉动条** | D1, U12 |
| **项目监控 — Plan 显示界面** | D5, SM3, SM4, U7 |
| **消息通知页面** | E4, N3, U9 |
| **全局设置页面** | CF1, CF3, CF4, I1, I3, X1, X3, U9, U15 |
| **灵魂交流 Modal** | CF1, X2, U9, U14 |
| **定时触发子界面** | H1, H2, H3, U9 |
| **远程交互子界面** | R1, R2, R3, U9 |
| **对话生命周期管理** | P1, P4, P5, P6, P7, SM2 |
| **无限大画板渲染架构** | U1, U2, U3 |
| **Plan 状态同步架构** | D4, D5, E1, SM3, SM4, S3 |
| **上下文面板** | C1, C2, C3, C4, T7, U13 |
| **国际化（语言切换）** | I1, I2, I3 |
| **配置导出/导入** | S4, S5 |
| **检查更新** | NW3 |
| **桌面通知** | N1, N2 |

---

### D.23 模块依赖关系图

```
┌─────────────────────────────────────────────────────────────┐
│                        UI 层 (Electron + React)               │
│  U1-U15 (渲染) · I1-I3 (i18n) · N1-N2 (通知)                  │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                      业务逻辑层                               │
│  SM1-SM6 (状态) · T1-T7 (统计) · C1-C4 (上下文)               │
│  Q1-Q3 (消息队列) · E1-E4 (事件) · PD1-PD5 (项目识别)          │
└──────┬──────────┬──────────┬──────────┬──────────────────────┘
       │          │          │          │
┌──────▼───┐ ┌────▼────┐ ┌──▼───┐ ┌───▼────────────────────┐
│ 进程管理  │ │ 数据读取 │ │ Git  │ │ 集成层                   │
│ P1-P8    │ │ D1-D13  │ │ G1-G9│ │ R1-R3 (远程)             │
│          │ │         │ │      │ │ H1-H3 (定时)             │
│          │ │         │ │      │ │ PL1-PL5 (Plugin)         │
│          │ │         │ │      │ │ A1-A6 (Agent)            │
│          │ │         │ │      │ │ X1-X3 (命令)             │
└──────┬───┘ └────┬────┘ └──┬───┘ └───┬────────────────────┘
       │          │          │          │
┌──────▼──────────▼──────────▼──────────▼────────────────────┐
│                      基础设施层                               │
│  S1-S6 (存储) · CF1-CF4 (配置) · NW1-NW3 (网络) · FS1-F4 (文件) │
│  node-pty · chokidar · Electron API · Git CLI                │
└─────────────────────────────────────────────────────────────┘
```

---

*PRD 结束。本文档覆盖 Claude Driver v0.1.0 全部功能需求 + 23 个模块的原子底层功能清单，供架构师进行技术选型和模块设计，供开发者进行任务拆解和实现参考。*
