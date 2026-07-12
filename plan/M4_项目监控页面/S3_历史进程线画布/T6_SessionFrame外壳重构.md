# T6 — @xyflow SessionFrameNode 外壳重构

## 技术原理

### 当前状态

T1-T5 已用 CSS flex + overflow-y scroll 实现了单 Session 的进程线内容渲染。
本任务将这个内容层**包裹在 @xyflow/react 的自定义 Node（SessionFrameNode）中**，
使多个 Session 可以并排布局、动态改变高度并碰撞传导。

### SessionFrameNode 数据结构

```typescript
interface SessionFrameNode extends Node {
  type: 'sessionFrame'
  data: {
    sessionId: string
    agentColor: 'green' | 'blue' | 'purple'  // Agent1/Agent2/branch 颜色系
    isExpanded: boolean                        // 是否有子节点展开
    estimatedHeight: number                    // 动态计算的框高度
  }
}
```

框内的时间线内容（T1-T5 已实现的 ProcessTimeline 组件）作为子 DOM 渲染，不作为独立 @xyflow Node。

### 三态视口管理状态机

| 状态 | 触发条件 | 视口行为 |
|------|---------|---------|
| **全览模式(overview)** | 默认 / 框折叠完成后 | `fitView({ nodes: allSessionNodes, padding: 0.1 })` |
| **聚焦模式(focus)** | 用户展开某个 Session 框 | `fitView({ nodes: [expandedNode], padding: 0.05 })` |
| **跟随模式(follow)** | 项目运行中有活跃 Session | 新节点插入时 `setViewport` Y 方向跟随，zoom 保持 |
| **锁定模式(locked)** | 用户手动 pan/zoom | 跳过自动调整，双击空白/Esc 恢复 follow |

- `fitView` 调用节流：最多每 500ms 触发一次，避免画面抖动

### 动态框高与碰撞传导

- `SessionFrameNode` 通过 `useResizeObserver` 监听自身 DOM 高度变化，更新 `estimatedHeight`
- 布局重排：手动 `setNodes` 重算所有框的 `position.y`，保证框间距 ≥ 24px（GAP_PX）
- 动画过渡：CSS `transition: transform 0.3s ease`

## 实现步骤

### 原子目标 1 — @xyflow/react 安装与画布容器 [x]
- `npm install @xyflow/react`（已在 S1 全局监控画板安装时完成，确认版本兼容）
- 文件：`src/renderer/src/features/project-monitor/canvas/ProcessLineCanvas.tsx`
  - `<ReactFlow nodes={sessionFrameNodes} edges={branchEdges} nodeTypes={nodeTypes} />`
  - 启用 `panOnScroll`，禁用 `zoomOnScroll`（改为 Ctrl+滚轮）

### 原子目标 2 — SessionFrameNode 自定义 Node [x]
文件：`src/renderer/src/features/project-monitor/canvas/SessionFrameNode.tsx`
- 虚线边框圆角矩形（`border: 1px dashed var(--bd)`，`border-radius: 8px`）
- 大小合理、可动态变化（展开内容时高度增长）

**框头部（thread header）规格**：

| 元素 | 规格 |
|------|------|
| 状态点 | 8px 圆点：运行中=绿色+光晕动效；notification中断=橙色；不在运行中=灰色 |
| Session 名称 | `Agent1` / `Agent2` 等，粗体，font-size: 12px |
| token 用量 | 右侧绿色，每个 session 的 token 用量，如「↑ 34.2K」 |
| 运行时长 | 最右，灰色，如「21min」（从 SessionStart 到当前的累计时间） |

- 框内：左侧里程碑列（20px）+ 中间 `ProcessTimeline` 组件 + 右侧 16px 进度拉动条位置
- 框底部操作区（`border-top` 分隔）：

| 按钮 | 样式 | 操作 |
|------|------|------|
| `⬛ 打断对话` | 红色边框 + 红色文字 | 向该 Session 的 stdin 发送 Ctrl+C 信号 |
| `回到对话` | 默认样式 | 通过 `claude --resume <session_id>` 恢复该会话（已有 P7 实现） |
| `输入到 git 主线` | 绿色边框 + 绿色文字 | 将当前 worktree 分支 merge 到 main，**询问确认后执行** |

- 里程碑标记列：最左侧竖向排列 `[M1-S1-T1]` 紫色 badge（见 T10）
- `useResizeObserver` 监听高度变化 → 更新 `estimatedHeight`

### 原子目标 3 — useProcessLineViewport Hook [x]
文件：`src/renderer/src/hooks/useProcessLineViewport.ts`
- 四态状态机实现（overview / focus / follow / locked）
- 监听 `activeSessionsAtom` 变化决定跟随目标
- `fitView` 调用节流（500ms debounce）
- 用户 pan/zoom 时自动切换到 locked 状态
- 双击空白/Esc 恢复 follow

### 原子目标 4 — useSessionFrameLayout Hook [x]
文件：`src/renderer/src/hooks/useSessionFrameLayout.ts`
- 输入：session 列表 + 各 session 的 estimatedHeight
- 输出：每个 SessionFrameNode 的 `position: {x, y}`
- 规则：
  - 单框：居中（x = 0）
  - 并排多框：固定 x 间距（默认 canvas 宽度 / 框数）
  - y 方向：按框高 + GAP_PX 逐一叠加

### 原子目标 5 — viewportModeAtom 补充 [x]
文件：`src/renderer/src/atoms/viewport.atom.ts`
```typescript
export const viewportModeAtom = atom<'overview' | 'focus' | 'follow' | 'locked'>('overview')
export const focusedSessionIdAtom = atom<string | null>(null)
```

### 原子目标 6 — 迁移 ProcessTimeline 到 SessionFrameNode 内 [x]
- 原有 `ProcessTimeline.tsx` 保持不变（纯内容组件）
- 在 `SessionFrameNode` 内通过 `<ProcessTimeline sessionId={data.sessionId} />` 调用
- 确保滚动独立（框内 `overflow-y: auto`，不影响外部画布）

### 原子目标 7 — 色彩系统应用 [x]
- Agent1（主线）：绿色系（`--gr`）
- Agent2（并行第二个主线）：蓝色系（`--bl`）
- /branch Session：紫色系（`--pu`）
- 颜色影响：框头部状态圆点、节点圆点、里程碑 badge 背景色

## 新增 Atom

```typescript
// src/renderer/src/atoms/sessions.atom.ts 追加
export const sessionFrameHeightsAtom = atomFamily((sessionId: string) =>
  atom<number>(400)   // 初始估算高度
)
```

## 验收标准

- 单 Session：框在画布中居中显示，内容正常渲染
- 展开某个 Session 详细内容时，框变高，相邻框自动向下移动
- 新节点插入时画布自动跟随滚动到最新位置
- 用户手动 pan 后停止自动跟随，Esc 键恢复
