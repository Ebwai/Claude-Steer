# T9b — 指派 Agent 面板（⊕ 创建多 Agent → 🤖 指派某个 Agent 工作）

> **所属**：M4 项目监控页面 → S3 历史进程线画布 → T9 节点交互菜单（子任务）
> **触发入口**：ProcessTimeline 最后节点操作栏 → ⊕ 创建多 Agent → 🤖 指派某个 Agent 工作

---

## 一、完整需求说明

### 1.1 整体交互流程

点击子菜单「🤖 指派某个 Agent 工作」后，在子菜单下方展开一个**指派面板**。面板由若干**派发行**组成，每行配置一次独立的 Agent 派发。

最终点击「发送」时，将所有行拼接成一段文本，通过 `SESSION_INPUT` IPC 向当前 session 的 PTY stdin 发送。

**发送内容格式**（多行拼接）：
```
派发{N}个{agentName}去做{task}\n派发{N}个{agentName}去做{task}\n...
```

---

### 1.2 派发行结构

每行包含三个交互控件，从左到右：

#### 控件 1：数量输入框（对应 `{N}`）
- 类型：数字输入框
- 默认值：`1`
- 合法范围：1–4（整数）
- 验证规则：输入超过 4 或非正整数时，输入框变红边框，**在输入框正下方显示提示文字**：`"数量超过阈值，不建议，请输入 1–4 中的一个"`
- 宽度固定：36px

#### 控件 2：Agent 名称选择器（对应 `{agentName}`）
- 类型：自定义下拉选择（点击展开选项面板，不用原生 `<select>`）
- 默认显示文字：`agent`
- 选项来源（三组虚线框，按来源分类）：

  **框 A — 全局 & 个人自定义 Agent**（`source: 'builtin' | 'user'`）
  - 来自 `CONFIG_READ` IPC 返回的 `agentGroups`，过滤 `source !== 'plugin'` 的项
  - 框标题：`全局 & 自定义`
  - 每项显示：`{name}` + 小字 `{model}`

  **框 B — 项目级自定义 Agent**（来自项目 `.claude/agents/` 目录）
  - 来自新增 IPC `AGENT_LIST_PROJECT`，传入 `projectPath`，返回 `AgentItem[]`
  - 框标题：`项目级 Agent`
  - 若目录不存在或为空，框显示：`（暂无项目级 Agent）`

  **框 C — 插件 Agent**（`source: 'plugin'`，每个插件占一个子框）
  - 来自 `CONFIG_READ` 的 `agentGroups`，过滤 `source === 'plugin'`
  - 每个插件的框标题：`插件: {pluginId}`
  - 若无任何插件 Agent，此分组不显示

- 用户点击某项后：该行的 agentName 值更新为选中项的 `name`，下拉面板收起

#### 控件 3：任务描述输入框（对应 `{task}`）
- 类型：单行文本输入框
- 默认值：`这件事情`
- 宽度：flex-grow，占满剩余空间
- 支持 Enter 触发发送（同发送按钮行为）

---

### 1.3 面板底部操作行

派发行下方有**两个独立行**：

**加号行**：
- 左侧：`＋ 添加一行` 按钮（点击后追加一个新派发行，初始值同默认值）
- 无右侧内容

**发送行**（最后一行，与加号行分开）：
- 右侧：`发送` 按钮（蓝色，`SESSION_INPUT` 发送所有行拼接文本）
- 发送条件：所有行都通过验证（数量合法、task 非空）
- 发送后：关闭面板，重置所有行为默认状态

---

### 1.4 面板关闭方式

- 点击「发送」后自动关闭
- 点击面板外区域或按 Esc 关闭（重置状态）
- 再次点击「🤖 指派某个 Agent 工作」子菜单项切换关闭

---

## 二、数据层设计

### 2.1 新增 IPC channel

**文件**：`src/shared/events/ipc-channels.ts`

```typescript
/** 读取项目级 .claude/agents/ 目录中的 agent 列表 */
AGENT_LIST_PROJECT: 'agent:list-project',
```

### 2.2 主进程 handler

**文件**：`src/main/index.ts`

```typescript
ipcMain.handle(IPC.AGENT_LIST_PROJECT, async (_event, payload: { projectPath: string }) => {
  try {
    const agentsDir = path.join(payload.projectPath, '.claude', 'agents')
    // 直接复用 SettingsManager 的 readAgentsFromDir（已导出）
    const { readAgentsFromDir } = await import('./lib/config/SettingsManager')
    const items = readAgentsFromDir(agentsDir)
    console.log(`[ipc] agent:list-project: ${items.length} agents in ${agentsDir}`)
    return { ok: true, items }
  } catch (err) {
    console.error('[ipc] agent:list-project failed:', err)
    return { ok: false, items: [] }
  }
})
```

> **注意**：`readAgentsFromDir` 是 SettingsManager 的内部函数，目前未导出。需要在 SettingsManager.ts 中将其导出，或在 index.ts 中内联同逻辑（优先导出复用）。

### 2.3 组件内部状态

```typescript
// 单行派发配置
interface AssignRow {
  id: string          // React key 用，本地生成
  count: string       // 数量（字符串，便于输入校验）
  agentName: string   // 选中的 agent 名称
  task: string        // 任务描述
}

// 面板状态
const [assignOpen, setAssignOpen] = useState(false)
const [assignRows, setAssignRows] = useState<AssignRow[]>([defaultRow()])
const [agentOptions, setAgentOptions] = useState<AllConfigGroups | null>(null)
const [projectAgents, setProjectAgents] = useState<AgentItem[]>([])
const [dropdownOpenRowId, setDropdownOpenRowId] = useState<string | null>(null)
```

---

## 三、UI 结构

```
┌ ptl-submenu ──────────────────────────────────────┐
│  🌿 开新的分支 Agent（/branch）                    │
│  🤖 指派某个 Agent 工作          ← 点击后展开以下 │
│  💬 btw（单次轻量询问）                            │
└───────────────────────────────────────────────────┘

↓ 展开后（子菜单仍显示，面板紧随其下）

┌ ptl-assign-panel ─────────────────────────────────┐
│ ┌ ptl-assign-row ──────────────────────────────── ┐│
│ │ [36px 数量] [下拉 Agent 名称 ▾] [任务描述______]││
│ │             [错误提示文字]                       ││
│ └─────────────────────────────────────────────────┘│
│ ＋ 添加一行                                         │
│                                            [发 送] │
└───────────────────────────────────────────────────┘

↓ 下拉 Agent 面板展开时（绝对定位浮层）

┌ ptl-agent-dropdown ──────────────────────────────┐
│ ╔ 全局 & 自定义 ════════════════════════════════╗ │
│ ║  Explore           claude-haiku-4-5           ║ │
│ ║  Plan              inherit                    ║ │
│ ║  General-purpose   inherit                    ║ │
│ ║  …（个人自定义 agents）                        ║ │
│ ╚═══════════════════════════════════════════════╝ │
│ ╔ 项目级 Agent ══════════════════════════════════╗ │
│ ║  my-reviewer       inherit                    ║ │
│ ╚═══════════════════════════════════════════════╝ │
│ ╔ 插件: superpowers@dev ════════════════════════╗ │
│ ║  code-review       claude-sonnet-4-6          ║ │
│ ╚═══════════════════════════════════════════════╝ │
└──────────────────────────────────────────────────┘
```

---

## 四、实现步骤

### 原子目标 1 — 导出 `readAgentsFromDir` [x]

**文件**：`src/main/lib/config/SettingsManager.ts`

将 `readAgentsFromDir` 函数从 `function`（私有）改为 `export function`。

---

### 原子目标 2 — 新增 IPC channel + 主进程 handler [x]

**文件 1**：`src/shared/events/ipc-channels.ts`
- 追加 `AGENT_LIST_PROJECT: 'agent:list-project'`

**文件 2**：`src/main/index.ts`
- 注册 `ipcMain.handle(IPC.AGENT_LIST_PROJECT, ...)` handler，调用 `readAgentsFromDir(path.join(projectPath, '.claude', 'agents'))`

---

### 原子目标 3 — `AssignAgentPanel` 子组件（含下拉 Agent 选择器） [x]

**文件**：新建 `src/renderer/src/features/project-monitor/AssignAgentPanel.tsx`

Props：
```typescript
interface AssignAgentPanelProps {
  sessionId: string
  projectPath: string   // session.cwd
  onClose: () => void
}
```

内容：
- 挂载时并行调用 `IPC.CONFIG_READ`（全局）和 `IPC.AGENT_LIST_PROJECT`（项目级）获取 agent 列表
- 管理 `AssignRow[]` 状态列表
- 渲染每一行（数量框 + Agent 下拉 + 任务输入框）
- 下拉 Agent 选择器：三框（全局&自定义、项目级、插件），虚线边框区分，每项可点击
- 「＋ 添加一行」按钮：追加新行
- 「发送」按钮：校验全部行 → 拼接文本 → `SESSION_INPUT` → `onClose()`

**验证逻辑**：
```typescript
function validateCount(v: string): string | null {
  const n = parseInt(v, 10)
  if (isNaN(n) || n < 1 || n > 4 || !Number.isInteger(n))
    return '数量超过阈值，不建议，请输入 1–4 中的一个'
  return null
}
```

**拼接逻辑**：
```typescript
const text = rows
  .map(r => `派发${r.count}个${r.agentName}去做${r.task}`)
  .join('\n') + '\n'
await window.api.invoke(IPC.SESSION_INPUT, { sessionId, text })
```

---

### 原子目标 4 — `AssignAgentPanel.css` [x]

**文件**：新建 `src/renderer/src/features/project-monitor/AssignAgentPanel.css`

关键样式：
- `.aap-panel`：灰白背景，左侧带 8px 蓝色竖线，padding 8px 12px，border-top
- `.aap-row`：flex row，gap 6px，align-items flex-start
- `.aap-count`：width 36px，text-align center，border，border-radius 3px
- `.aap-count-error`：红色边框 + 下方 9px 红色错误提示文字
- `.aap-agent-select`：最小宽 120px，cursor pointer，border 虚线（复用蓝色调），显示选中名称 + ▾
- `.aap-agent-dropdown`：absolute，z-index 200，背景白，shadow，max-height 240px，overflow-y auto
- `.aap-agent-group`：虚线边框，margin 4px，padding 4px 8px
- `.aap-agent-group-title`：8px 字体，颜色 tx3，margin-bottom 3px
- `.aap-agent-item`：hover 背景，cursor pointer，9px 字体
- `.aap-task`：flex-grow 1，border，border-radius 3px，padding 2px 6px
- `.aap-footer`：flex，justify-content space-between，margin-top 6px
- `.aap-add-btn`：文字按钮，蓝色，小字
- `.aap-send-btn`：绿色按钮，disabled 时半透明

---

### 原子目标 5 — 集成到 `AssistantActionBar` [x]

**文件**：`src/renderer/src/features/project-monitor/ProcessTimeline.tsx`

修改：
1. 将「🤖 指派某个 Agent 工作」子菜单项的 `onClick` 改为：`setAssignOpen((v) => !v)`（新增 `assignOpen` state）
2. 在 `{subMenuOpen && <div className="ptl-submenu">...</div>}` 之后追加：
   ```tsx
   {assignOpen && sessionId && (
     <AssignAgentPanel
       sessionId={sessionId}
       projectPath={session?.cwd ?? ''}
       onClose={() => setAssignOpen(false)}
     />
   )}
   ```
3. 关闭子菜单时同步关闭 assignOpen：`setSubMenuOpen(false)` 处追加 `setAssignOpen(false)`

---

## 五、验收标准

- [ ] 点击「🤖 指派某个 Agent 工作」子菜单项，面板展开（子菜单仍可见）
- [ ] 面板默认包含 1 行，数量=1，Agent=agent，任务=这件事情
- [ ] 数量输入 5 → 输入框红边框 + 提示文字「数量超过阈值，不建议，请输入 1–4 中的一个」，发送按钮 disabled
- [ ] 数量输入 0 或负数 → 同上错误提示
- [ ] 点击 Agent 下拉 → 展开三框（全局&自定义 / 项目级 / 插件）
- [ ] 框 A 显示内置 agents（Explore/Plan/General-purpose 等）+ 个人自定义 agents
- [ ] 框 B 显示项目 `.claude/agents/` 下的 agents（不存在则显示暂无提示）
- [ ] 框 C 仅在有插件 agents 时显示
- [ ] 点击 Agent 项 → 下拉收起，该行 Agent 名称更新
- [ ] 点击「＋ 添加一行」→ 追加新行（默认值），可无限添加
- [ ] 所有行合法时「发送」按钮可点击
- [ ] 点击「发送」→ PTY stdin 收到 `派发N个agentName去做task\n`（多行时换行连接）
- [ ] 发送后面板关闭，行重置为默认
- [ ] 任务框按 Enter → 触发发送（同发送按钮）
- [ ] Esc 或点击面板外 → 面板关闭
