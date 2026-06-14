// 使用方法：import type { LineInsertion } from '@shared/types/lineInsertion'
// 编译说明：纯类型文件，renderer 与 main 进程均可引用
// 代码说明：进程线十类插入元素的统一数据结构定义

export type LineInsertionType =
  | 'tool'       // A. 内置工具调用（Read/Write/Edit/Bash 等）
  | 'mcp'        // B. MCP 工具调用（工具名含 mcp__ 前缀）
  | 'cli'        // C. CLI Skill 调用（Bash 类 skill）
  | 'skill'      // D. 普通 Skill 调用
  | 'workflow'   // E. 工作流触发
  | 'insight'    // F. Insight 文本产生
  | 'subagent'   // G. Subagent 调用（含分配/返回两种方向）
  | 'branch'     // H. /branch 分支探索
  | 'btw'        // I. /btw 临时提问
  | 'user-input' // J. 普通用户输入

export type LineInsertionDirection = 'left' | 'right'
export type LineInsertionLength = 'short' | 'medium' | 'long'
export type LineInsertionStatus = 'pending' | 'running' | 'done' | 'failed'

export interface LineInsertion {
  /** 全局唯一 ID（来源：sessionId-type-timestamp） */
  id: string
  type: LineInsertionType
  /** 时间轴插入方向：right=工具类，left=经验/交互类 */
  direction: LineInsertionDirection
  /** 线的颜色（工具类 #e6430d，经验/交互类 #DA7756） */
  color: string
  /** 线的长度档位（优先使用 customWidth） */
  length: LineInsertionLength
  /** 自定义线宽（px），覆盖 length 档位。多 subagent 时按序号线性增长使用此字段 */
  customWidth?: number
  sessionId: string
  timestamp: number
  /** badge 内容：工具名、操作描述、subagent 摘要等 */
  badgeContent: Record<string, string>
  status: LineInsertionStatus
  /** true 时显示琥珀色闪烁 + ⟳ 后缀 */
  isAnimating: boolean
  /** 插入线上的文字（G/H/I/J 类有值，如"继承记忆"/"分配任务"） */
  lineLabel?: string
  /** subagent 类型插入线：对应的 agentId（供 ProcessTimeline 渲染 SubagentBlock） */
  agentId?: string
  /**
   * 工具调用唯一 ID（来自 Hook payload tool_use_id）
   * "分配任务"线写入此值，"返回任务结果"线通过相同值精确配对，不依赖顺序
   */
  toolUseId?: string
  /**
   * branch 类型专用：branch 创建瞬间父框高度快照（px）
   * 持久化到 insertions.jsonl，重启后直接用于恢复子框 Y 位置，不需要估算
   */
  triggerYOffset?: number
}
