// 使用方法：import { createToolActivityHandler } from '@renderer/business/toolActivityHandler'
// 编译说明：renderer 进程 browser bundle
// 代码说明：BL-4 工具活动处理——PreToolUse / PostToolUse / PostToolUseFailure Hook 事件

import { IPC } from '@shared/events/ipc-channels'
import type { HookEvent } from '@shared/types/index'
import {
  toolStart, toolDone, toolFailed, showSubagent, hideSubagent,
  registerSubagentId, incrementAgentCount,
  allocateSubagentSlot, releaseSubagentSlot,
} from '@renderer/capabilities/agentActivity'
import { appendInsertion, updateInsertionStatus, patchInsertion, appendSubagentInsertion, updateSubagentInsertionStatus, patchSubagentInsertion } from '@renderer/capabilities/timelineStore'
import { lineInsertionsBySessionAtom } from '@renderer/atoms/timeline.atom'
import type { LineInsertion, LineInsertionType, LineInsertionLength } from '@shared/types/lineInsertion'
import type { TestStore } from '../../../__tests__/helpers/createTestStore'

type Store = Pick<TestStore, 'get' | 'set'>

/** 工具名 → 工作状态词 */
function toolNameToWorkStatus(toolName: string): string {
  const map: Record<string, string> = {
    Read: '读取文件', Write: '写入文件', Edit: '编辑文件', MultiEdit: '编辑文件',
    Bash: '执行命令', Glob: '扫描文件', Grep: '搜索内容', WebFetch: '获取网页',
    WebSearch: '搜索网络', Agent: '调用 Agent', Task: '执行任务',
  }
  return map[toolName] ?? toolName
}

/** 工具名 → 分类（仅用于非 Skill 工具） */
function categorizeToolName(toolName: string): 'tool' | 'mcp' {
  if (toolName.startsWith('mcp__')) return 'mcp'
  return 'tool'
}

/**
 * 从 tool_input 提取各工具专属字段存入 badgeContent
 * 所有值为字符串（badgeContent 是 Record<string, string>）
 * 内容全文存储，不截断（截断在渲染层处理）
 */
function extractToolBadgeFields(
  toolName: string,
  toolInput: Record<string, unknown>
): Record<string, string> {
  const f: Record<string, string> = {}

  switch (toolName) {
    case 'Read': {
      f.filePath = String(toolInput['file_path'] ?? '')
      if (toolInput['offset'] !== undefined) {
        const offset = Number(toolInput['offset'])
        const limit = toolInput['limit'] !== undefined ? Number(toolInput['limit']) : undefined
        f.rangeLabel = limit !== undefined
          ? `L${offset}-${offset + limit - 1}`
          : `from L${offset}`
      }
      break
    }
    case 'Write': {
      f.filePath = String(toolInput['file_path'] ?? '')
      if (typeof toolInput['content'] === 'string') {
        f.contentFull = toolInput['content'] as string
      }
      break
    }
    case 'Edit': {
      f.filePath = String(toolInput['file_path'] ?? '')
      if (typeof toolInput['old_string'] === 'string') f.oldFull = toolInput['old_string'] as string
      if (typeof toolInput['new_string'] === 'string') f.newFull = toolInput['new_string'] as string
      if (toolInput['replace_all']) f.replaceAll = 'true'
      break
    }
    case 'MultiEdit': {
      f.filePath = String(toolInput['file_path'] ?? '')
      if (Array.isArray(toolInput['edits'])) {
        f.editCount = String((toolInput['edits'] as Array<unknown>).length)
        f.editsJson = JSON.stringify(toolInput['edits'])
      }
      break
    }
    case 'Bash': {
      f.command = String(toolInput['command'] ?? '')
      f.description = String(toolInput['description'] ?? '')
      if (toolInput['dangerouslyDisableSandbox']) f.isSandboxDisabled = 'true'
      break
    }
    case 'Grep': {
      f.pattern = String(toolInput['pattern'] ?? '')
      f.searchPath = String(toolInput['path'] ?? '')
      f.include = String(toolInput['include'] ?? '')
      break
    }
    case 'Glob': {
      f.pattern = String(toolInput['pattern'] ?? toolInput['path'] ?? '')
      break
    }
    case 'WebFetch': {
      f.url = String(toolInput['url'] ?? '')
      if (typeof toolInput['prompt'] === 'string') f.prompt = toolInput['prompt'] as string
      break
    }
    case 'WebSearch': {
      f.query = String(toolInput['query'] ?? '')
      if (toolInput['allowed_domains']) f.allowedDomains = String(toolInput['allowed_domains'])
      break
    }
    case 'ToolSearch': {
      f.query = String(toolInput['query'] ?? '')
      break
    }
    case 'AskUserQuestion': {
      if (Array.isArray(toolInput['questions']) && toolInput['questions'].length > 0) {
        const qs = toolInput['questions'] as Array<Record<string, unknown>>
        f.questionCount = String(qs.length)
        f.questionsJson = JSON.stringify(qs)
      }
      break
    }
    case 'EnterPlanMode':
      break
    case 'ExitPlanMode': {
      if (typeof toolInput['plan'] === 'string') f.planContent = toolInput['plan'] as string
      break
    }
    default: {
      // mcp__* 工具
      if (toolName.startsWith('mcp__')) {
        f.displayName = toolName.replace(/^mcp__/, '').replace(/__/g, '/')
        f.description = String(toolInput['description'] ?? '')
      }
      break
    }
  }

  return f
}

/**
 * 判断是否为 subagent 调度工具（Agent 或 Task，两者是同一工具的重命名）
 * Task → Agent 重命名发生于 Claude Code v2.1.63，Task 作为向后兼容别名保留
 */
function isAgentTool(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task'
}

/** 构建普通工具/MCP 插入线（右向）
 *  PRD §3.2.1.1: tool=short, mcp=medium
 */
function buildToolInsertion(
  toolName: string,
  displayText: string,
  entryId: string,
  sessionId: string,
  timestamp: number,
  extraFields?: Record<string, string>,
): LineInsertion | null {
  const category = categorizeToolName(toolName)
  const type: LineInsertionType = category === 'mcp' ? 'mcp' : 'tool'
  const length: LineInsertionLength = category === 'mcp' ? 'medium' : 'short'

  return {
    id: entryId,
    type,
    direction: 'right',
    color: '#e6430d',
    length,
    sessionId,
    timestamp,
    badgeContent: { toolName, displayText, ...extraFields },
    status: 'running',
    isAnimating: true,
  }
}

/**
 * 构建 Skill / CLI 插入线
 * PRD §3.2.1.1 C/D: skill 名含 cli → CLI（右向，长）；否则 Skill（左向，短）
 * badgeContent.toolName 保持 'Skill' 以确保 updateInsertionStatus 按工具名能匹配
 */
function buildSkillInsertion(
  skillName: string,
  entryId: string,
  sessionId: string,
  timestamp: number,
  args?: string,
): LineInsertion {
  const isCli = skillName.toLowerCase().includes('cli')
  const bc: Record<string, string> = {
    toolName: 'Skill',
    displayText: skillName,
    skillName,
  }
  if (args) bc.args = args

  return {
    id: entryId,
    type: isCli ? 'cli' : 'skill',
    direction: isCli ? 'right' : 'left',
    color: isCli ? '#e6430d' : '#DA7756',
    length: isCli ? 'long' : 'short',
    sessionId,
    timestamp,
    badgeContent: bc,
    status: 'running',
    isAnimating: true,
  }
}

/** 每个槽位的基础线宽（px） */
const SLOT_WIDTH = 144

/**
 * 构建 subagent 分配任务插入线（左向）
 * slot：当前活跃 subagent 槽号（1/2/3…），决定线宽
 */
function buildDispatchInsertion(
  agentLabel: string,
  desc: string,
  entryId: string,
  agentId: string,
  sessionId: string,
  timestamp: number,
  toolUseId: string | undefined,
  slot: number,
): LineInsertion {
  const customWidth = slot * SLOT_WIDTH
  return {
    id: entryId,
    type: 'subagent',
    direction: 'left',
    color: '#DA7756',
    length: 'long',
    customWidth,
    sessionId,
    timestamp,
    badgeContent: {
      toolName: agentLabel,
      displayText: desc ? `${agentLabel} ${desc}` : agentLabel,
      description: desc,
      agentN: String(slot),
    },
    status: 'running',
    isAnimating: true,
    lineLabel: '分配任务',
    agentId,
    toolUseId,
  }
}

/**
 * 构建 subagent 返回任务结果插入线（左向，与分配线对称）
 * dispatchWidth 相同 → 线左端精确贴 SubagentBlock 右边缘，badge 出现在其旁边
 */
function buildReturnInsertion(
  agentLabel: string,
  entryId: string,
  sessionId: string,
  timestamp: number,
  toolUseId: string | undefined,
  dispatchWidth: number,
  status: 'done' | 'failed',
): LineInsertion {
  return {
    id: entryId,
    type: 'subagent',
    direction: 'left',
    color: status === 'done' ? '#35C98A' : '#E85858',
    length: 'long',
    customWidth: dispatchWidth,
    sessionId,
    timestamp,
    badgeContent: {
      toolName: agentLabel,
      displayText: agentLabel,
    },
    status,
    isAnimating: false,
    lineLabel: '返回任务结果',
    toolUseId,
  }
}

export function createToolActivityHandler(store: Store) {
  function handlePreToolUse(hookEvent: HookEvent): void {
    const payload = hookEvent.payload as {
      tool_name?: string
      tool_input?: Record<string, unknown>
      agent_id?: string
      tool_use_id?: string
    }
    const toolName = payload.tool_name ?? 'Unknown'
    const toolInput = payload.tool_input ?? {}
    const isSubagentTool = !!payload.agent_id
    const claudeId = hookEvent.sessionId
    const entryId = `${claudeId}-${toolName}-${hookEvent.receivedAt}`
    const displayText = toolNameToWorkStatus(toolName)
    const category = categorizeToolName(toolName)

    toolStart(store, claudeId, hookEvent.cwd, {
      id: entryId,
      toolName,
      displayText,
      category,
      startedAt: hookEvent.receivedAt,
    })

    if (isAgentTool(toolName)) {
      showSubagent(store, claudeId, {
        subagentId: entryId,
        description: (toolInput['description'] as string) ?? 'Subagent 执行中…',
        startedAt: hookEvent.receivedAt,
      })
    }

    if (!isSubagentTool) {
      if (isAgentTool(toolName)) {
        // subagent 分配任务：左向插入线，宽度 = slot × 144px
        const toolUseId = payload.tool_use_id
        const n = incrementAgentCount(store, claudeId)
        const subagentType = (toolInput['subagent_type'] as string) ?? (toolInput['type'] as string) ?? ''
        const agentLabel = subagentType ? `Agent${n}:${subagentType}` : `Agent${n}`
        const desc = (toolInput['description'] as string) ?? ''
        const slot = toolUseId ? allocateSubagentSlot(store, claudeId, toolUseId) : n
        const insertion = buildDispatchInsertion(
          agentLabel, desc, entryId, '', claudeId,
          hookEvent.receivedAt, toolUseId, slot,
        )
        appendInsertion(store, claudeId, insertion)
        console.log(`[toolActivityHandler] Agent dispatch: label=${agentLabel} slot=${slot} width=${insertion.customWidth}`)
      } else if (toolName === 'Skill') {
        // Skill 工具：按 skill 名含 cli 分流为 CLI（右向长）或 Skill（左向短）
        const skillName = (toolInput['skill'] as string) ?? ''
        const args = typeof toolInput['args'] === 'string' ? toolInput['args'] as string : undefined
        const insertion = buildSkillInsertion(skillName, entryId, claudeId, hookEvent.receivedAt, args)
        appendInsertion(store, claudeId, insertion)
        console.log(`[toolActivityHandler] Skill: name=${skillName} type=${insertion.type} dir=${insertion.direction}`)
      } else {
        // 普通工具 / MCP：右向插入线，携带工具专属字段
        const extraFields = extractToolBadgeFields(toolName, toolInput)
        const insertion = buildToolInsertion(toolName, displayText, entryId, claudeId, hookEvent.receivedAt, extraFields)
        if (insertion) appendInsertion(store, claudeId, insertion)
        console.log(`[toolActivityHandler] Tool: name=${toolName} extraFields=${Object.keys(extraFields).join(',')}`)
      }
    } else {
      // Subagent 内部工具调用：写到 agent_id 的插入线（右向）
      const agentId = payload.agent_id!
      const extraFields = extractToolBadgeFields(toolName, toolInput)
      const insertion = buildToolInsertion(toolName, displayText, entryId, agentId, hookEvent.receivedAt, extraFields)
      if (insertion) appendSubagentInsertion(store, claudeId, agentId, insertion)
      // 注册 agentId 到父 session（第一次注册时才实际写入）
      registerSubagentId(store, claudeId, agentId)
    }
  }

  function handlePostToolUse(hookEvent: HookEvent): void {
    const payload = hookEvent.payload as {
      tool_name?: string
      agent_id?: string
      tool_response?: unknown
      tool_use_id?: string
    }
    const toolName = payload.tool_name ?? ''
    const isSubagentTool = !!payload.agent_id
    const claudeId = hookEvent.sessionId
    console.log(`[toolActivityHandler] PostToolUse: toolName=${toolName} agent_id=${payload.agent_id ?? 'UNDEFINED'} isSubagentTool=${isSubagentTool} sessionId=${claudeId.slice(0,8)}`)

    toolDone(store, claudeId, toolName)
    if (isAgentTool(toolName)) hideSubagent(store, claudeId)

    if (!isSubagentTool) {
      if (isAgentTool(toolName)) {
        // subagent 返回：释放槽位并创建"返回任务结果"右向线
        const toolUseId = payload.tool_use_id
        const dispatchWidth = toolUseId
          ? releaseSubagentSlot(store, claudeId, toolUseId)
          : SLOT_WIDTH
        const entryId = `${claudeId}-Agent-return-${hookEvent.receivedAt}`
        const insertions = store.get(lineInsertionsBySessionAtom(claudeId))
        const dispatchIns = toolUseId ? insertions.find((ins) => ins.toolUseId === toolUseId && ins.lineLabel === '分配任务') : undefined
        const agentLabel = (dispatchIns?.badgeContent.toolName as string | undefined) ?? 'Agent'
        if (toolUseId) updateInsertionStatus(store, claudeId, { toolUseId }, 'done')
        const returnIns = buildReturnInsertion(
          agentLabel, entryId, claudeId,
          hookEvent.receivedAt, toolUseId, dispatchWidth, 'done',
        )
        appendInsertion(store, claudeId, returnIns)
        console.log(`[toolActivityHandler] Agent return: label=${agentLabel} width=${dispatchWidth}`)
      } else {
        updateInsertionStatus(store, claudeId, toolName, 'done')

        // ── 工具专属 PostToolUse 更新 ──
        updatePostToolUseBadge(store, claudeId, toolName, payload.tool_response)
      }
    } else {
      const agentId = payload.agent_id!
      updateSubagentInsertionStatus(store, claudeId, agentId, toolName, 'done')
      updatePostToolUseBadge(store, agentId, toolName, payload.tool_response, claudeId)
    }

    setTimeout(() => {
      toolDone(store, claudeId, toolName)
    }, 3000)
  }

  /**
   * 在 PostToolUse 时回填工具专属 badgeContent 字段
   * （WebSearch 结果、ToolSearch 找到的工具、AskUserQuestion 用户选择）
   */
  function updatePostToolUseBadge(
    store: Store,
    claudeId: string,
    toolName: string,
    toolResponse: unknown,
    parentClaudeId?: string,
  ): void {
    // 找到该 toolName 对应的最新一条 running/done 插入线
    // parentClaudeId 存在时：claudeId 是 subagent 的 agentId，从 agentId 的插入线查找并走 subagent 持久化
    const insertions = store.get(lineInsertionsBySessionAtom(claudeId))
    let targetId: string | null = null
    for (let i = insertions.length - 1; i >= 0; i--) {
      if (insertions[i].badgeContent.toolName === toolName) {
        targetId = insertions[i].id
        break
      }
    }
    if (!targetId) return

    const doPatch = (badgeContent: Record<string, string>) => {
      if (parentClaudeId) {
        patchSubagentInsertion(store, parentClaudeId, claudeId, targetId!, { badgeContent })
      } else {
        patchInsertion(store, claudeId, targetId!, { badgeContent })
      }
    }

    switch (toolName) {
      case 'WebSearch': {
        // WebSearch 返回结构：{ results: [{ tool_use_id, content: [{title, url}, ...] }, ...] }
        // 需要从嵌套的 content 数组中展平真正的搜索结果 {title, url}
        const resp = toolResponse as { results?: Array<Record<string, unknown>> } | undefined
        const rawResults = resp?.results ?? []
        const flat: Array<{ title: string; url: string }> = []
        for (const item of rawResults) {
          // 直接就是 {title, url} → 加入
          if (typeof item.title === 'string' && typeof item.url === 'string') {
            flat.push({ title: item.title, url: item.url })
          }
          // { content: [{title, url}, ...] } → 展平 content 数组
          if (Array.isArray(item.content)) {
            for (const r of item.content as Array<Record<string, unknown>>) {
              if (typeof r.title === 'string' && typeof r.url === 'string') {
                flat.push({ title: r.title, url: r.url })
              }
            }
          }
        }
        if (flat.length > 0) {
          console.log(`[toolActivityHandler] WebSearch flattened: ${flat.length} results from ${rawResults.length} items, top="${flat[0].title}"`)
          doPatch({
            resultCount: String(flat.length),
            topResultTitle: flat[0].title,
            topResultUrl: flat[0].url,
            resultsJson: JSON.stringify(flat.slice(0, 20)),
          })
        }
        break
      }
      case 'ToolSearch': {
        const resp = toolResponse as { tool_reference?: Array<{ tool_name: string }> } | undefined
        const refs = resp?.tool_reference ?? []
        if (refs.length) {
          doPatch({
            toolCount: String(refs.length),
            toolsFound: refs.map((r) => r.tool_name).join(', '),
          })
          console.log(`[toolActivityHandler] ToolSearch: found ${refs.length} tools: ${refs.map(r => r.tool_name).join(', ')}`)
        }
        break
      }
      case 'AskUserQuestion': {
        const resp = toolResponse as Record<string, unknown> | undefined
        if (resp) {
          const answers = resp['answers'] as Record<string, string> | undefined
          const selected = resp['selected'] as string[] | undefined
          const answerText = answers
            ? Object.values(answers).join(', ')
            : selected?.join(', ') ?? ''
          if (answerText) {
            doPatch({ selectedAnswer: answerText })
            console.log(`[toolActivityHandler] AskUserQuestion answer: ${answerText}`)
          }
        }
        break
      }
    }
  }

  function handlePostToolUseFailure(hookEvent: HookEvent): void {
    const payload = hookEvent.payload as { tool_name?: string; agent_id?: string; tool_use_id?: string }
    const toolName = payload.tool_name ?? ''
    const isSubagentTool = !!payload.agent_id
    const claudeId = hookEvent.sessionId

    toolFailed(store, claudeId, toolName)

    if (!isSubagentTool) {
      if (isAgentTool(toolName)) {
        // subagent 失败：同样释放槽位并追加失败返回线
        const toolUseId = payload.tool_use_id
        const dispatchWidth = toolUseId
          ? releaseSubagentSlot(store, claudeId, toolUseId)
          : SLOT_WIDTH
        const entryId = `${claudeId}-Agent-fail-${hookEvent.receivedAt}`
        const insertions = store.get(lineInsertionsBySessionAtom(claudeId))
        const dispatchIns = toolUseId ? insertions.find((ins) => ins.toolUseId === toolUseId && ins.lineLabel === '分配任务') : undefined
        const agentLabel = (dispatchIns?.badgeContent.toolName as string | undefined) ?? 'Agent'
        if (toolUseId) updateInsertionStatus(store, claudeId, { toolUseId }, 'failed')
        const returnIns = buildReturnInsertion(
          agentLabel, entryId, claudeId,
          hookEvent.receivedAt, toolUseId, dispatchWidth, 'failed',
        )
        appendInsertion(store, claudeId, returnIns)
      } else {
        updateInsertionStatus(store, claudeId, toolName, 'failed')
      }
    } else {
      const agentId = payload.agent_id!
      updateSubagentInsertionStatus(store, claudeId, agentId, toolName, 'failed')
    }
  }

  function handleWorkflowHook(hookEvent: HookEvent): void {
    if (!hookEvent.userHooks?.length) return
    const claudeId = hookEvent.sessionId
    hookEvent.userHooks.forEach((cmd, i) => {
      const name = cmd.split(/[/\\]/).pop()?.split(' ')[0] ?? cmd
      const entryId = `${claudeId}-workflow-${hookEvent.receivedAt}-${i}`
      const insertion: LineInsertion = {
        id: entryId,
        type: 'workflow',
        direction: 'left',
        color: '#DA7756',
        length: 'medium',
        sessionId: claudeId,
        timestamp: hookEvent.receivedAt,
        badgeContent: {
          toolName: hookEvent.eventName,
          displayText: name,
        },
        status: 'done',
        isAnimating: false,
      }
      appendInsertion(store, claudeId, insertion)
      console.log(`[toolActivityHandler] Workflow: event=${hookEvent.eventName} cmd=${name}`)
    })
  }

  function register(): Array<() => void> {
    return [
      window.api.on(IPC.HOOK_EVENT, (event: unknown) => {
        const hookEvent = event as HookEvent
        if (hookEvent.eventName === 'PreToolUse') handlePreToolUse(hookEvent)
        if (hookEvent.eventName === 'PostToolUse') handlePostToolUse(hookEvent)
        if (hookEvent.eventName === 'PostToolUseFailure') handlePostToolUseFailure(hookEvent)
        handleWorkflowHook(hookEvent)
      }),
    ]
  }

  return { register, handlePreToolUse, handlePostToolUse, handlePostToolUseFailure }
}
