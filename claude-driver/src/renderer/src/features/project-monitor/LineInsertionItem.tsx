// 使用方法：由 ProcessTimeline.tsx 在每个节点之间渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：十类插入元素渲染组件——从时间轴向左/右延伸的插入线 + badge
//
// 右向(tool/mcp/cli)：  [轴]──────[badge]    line 从轴向右，badge 在右端
// 左向(其余7类)：       [badge]──────[轴]    badge 在左，line 右端贴轴
//
// subagent 类型特殊处理：badge 固定 320px 宽，超 50 字可展开全文
// tool/mcp/cli 类型：紧凑态显示工具名+操作目标，点击展开显示完整详情

import React, { useState } from 'react'
import type { LineInsertion } from '@shared/types/lineInsertion'
import { useT, type TFunction } from '../../i18n'
import './LineInsertionItem.css'

interface LineInsertionItemProps {
  insertion: LineInsertion
}

// 约 50 个字（9px 字体，每字约 9px）= 450px，badge 宽 320px 内容区约容纳 50 字
const AGENT_MAX_CHARS = 50
// Insight badge：前 20 字可见，点击展开全文
const INSIGHT_MAX_CHARS = 20
// 工具紧凑态截断长度
const COMPACT_MAX = 15

// ── 辅助函数 ──

function basename(path: string): string {
  if (!path) return ''
  const seg = path.split(/[/\\]/).pop()
  return seg ?? path
}

function extractHostname(url: string): string {
  if (!url) return ''
  try { return new URL(url).hostname }
  catch { return url }
}

function trunc(s: string, max: number): string {
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + '…' : s
}

/** React 不能直接渲染普通对象；将任意值转为安全的 React 子节点 */
function safeChild(v: unknown): React.ReactNode {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** 从 resultsJson 展平真实的搜索结果 {title, url}
 *  兼容新格式 [{title, url}] 和旧格式 [{tool_use_id, content: [{title, url}]}] */
function flattenWebSearchResults(resultsJson: string): Array<{ title: string; url: string }> {
  try {
    const raw = JSON.parse(resultsJson)
    const array = Array.isArray(raw) ? raw : [raw]
    const out: Array<{ title: string; url: string }> = []
    for (const item of array) {
      if (typeof item.title === 'string' && typeof item.url === 'string') {
        out.push({ title: item.title, url: item.url })
      }
      if (Array.isArray(item.content)) {
        for (const r of item.content) {
          if (typeof r.title === 'string' && typeof r.url === 'string') {
            out.push({ title: r.title, url: r.url })
          }
        }
      }
    }
    return out
  } catch { return [] }
}

// ── 工具紧凑态文本构建 ──

function buildToolCompact(toolName: string, bc: Record<string, string>, t: TFunction): string {
  switch (toolName) {
    case 'Read': {
      const fn = basename(bc['filePath'] ?? '')
      const range = bc['rangeLabel'] ?? ''
      return range ? `Read  ${fn}  ${range}` : `Read  ${fn}`
    }
    case 'Write':
      return `Write  ${basename(bc['filePath'] ?? '')}`
    case 'Edit':
      return `Edit  ${basename(bc['filePath'] ?? '')}`
    case 'MultiEdit':
      return `MultiEdit  ${basename(bc['filePath'] ?? '')} (${bc['editCount'] ?? '?'} edits)`
    case 'Bash': {
      const text = bc['description'] || bc['command'] || ''
      return `Bash  ${trunc(text, COMPACT_MAX)}`
    }
    case 'Grep': {
      const pat = trunc(bc['pattern'] ?? '', COMPACT_MAX)
      const pth = trunc(bc['searchPath'] ?? '', COMPACT_MAX)
      return pth ? `Grep  "${pat}"  in  ${pth}` : `Grep  "${pat}"`
    }
    case 'Glob':
      return `Glob  ${trunc(bc['pattern'] ?? '', COMPACT_MAX)}`
    case 'WebFetch':
      return `WebFetch  ${trunc(extractHostname(bc['url'] ?? ''), COMPACT_MAX)}`
    case 'WebSearch': {
      const flat = flattenWebSearchResults(bc['resultsJson'] ?? '')
      if (flat.length > 0) {
        return `WebSearch  ${t('projectMonitor.lineInsertion.webSearchResults', { count: flat.length })}  ${trunc(flat[0].title, COMPACT_MAX)}`
      }
      return `WebSearch  ${trunc(bc['query'] ?? '', COMPACT_MAX)}`
    }
    case 'Task':
    case 'Agent':
      return `${toolName}  ${trunc(bc['description'] ?? '', COMPACT_MAX)}`
    case 'ToolSearch':
      return `ToolSearch  ${trunc(bc['query'] ?? '', COMPACT_MAX)}`
    case 'EnterPlanMode':
      return `EnterPlanMode  ${t('projectMonitor.lineInsertion.enterPlanMode')}`
    case 'ExitPlanMode':
      return `ExitPlanMode  ${t('projectMonitor.lineInsertion.exitPlanMode')}`
    default: {
      if (bc['displayName']) {
        return `${bc['displayName']}  ${trunc(bc['description'] ?? '', COMPACT_MAX)}`
      }
      return `${toolName}  ${trunc(bc['displayText'] ?? '', 38)}`
    }
  }
}

// ── 判断是否有额外详情可展开 ──

function hasToolDetail(toolName: string, bc: Record<string, string>): boolean {
  switch (toolName) {
    case 'Read': return !!(bc['filePath'] || bc['rangeLabel'])
    case 'Write': return !!(bc['filePath'] || bc['contentFull'])
    case 'Edit': return !!(bc['filePath'] || bc['oldFull'] || bc['newFull'])
    case 'MultiEdit': return !!(bc['filePath'] || bc['editsJson'])
    case 'Bash': return !!(bc['command'] || bc['description'])
    case 'Grep': return !!(bc['pattern'] || bc['searchPath'])
    case 'Glob': return !!bc['pattern']
    case 'WebFetch': return !!(bc['url'] || bc['prompt'])
    case 'WebSearch': return !!(bc['query'] || bc['resultsJson'])
    case 'ToolSearch': return !!(bc['query'] || bc['toolsFound'])
    case 'AskUserQuestion': return !!(bc['questionsJson'] || bc['selectedAnswer'])
    default: return !!bc['displayName']
  }
}

// ════════════════════════════════════════════════════════════════
// 工具 badge 展开态详情渲染
// ════════════════════════════════════════════════════════════════

function renderToolDetail(toolName: string, bc: Record<string, string>, t: TFunction): React.ReactNode {
  switch (toolName) {
    case 'Read':
      return (
        <>
          {bc['filePath'] && <div className="ins-badge-tool-path">{bc['filePath']}</div>}
          {bc['rangeLabel'] && (
            <div className="ins-badge-tool-detail">{bc['rangeLabel']}</div>
          )}
        </>
      )

    case 'Write':
      return (
        <>
          {bc['filePath'] && <div className="ins-badge-tool-path">{bc['filePath']}</div>}
          {bc['contentFull'] && (
            <div className="ins-badge-tool-code">{bc['contentFull']}</div>
          )}
        </>
      )

    case 'Edit':
      return (
        <>
          {bc['filePath'] && <div className="ins-badge-tool-path">{bc['filePath']}</div>}
          {bc['oldFull'] && <div className="ins-badge-tool-old">− {bc['oldFull']}</div>}
          {bc['newFull'] && <div className="ins-badge-tool-new">+ {bc['newFull']}</div>}
          {bc['replaceAll'] === 'true' && <span className="ins-badge-tool-tag">{t('projectMonitor.lineInsertion.replaceAll')}</span>}
        </>
      )

    case 'MultiEdit':
      return (
        <>
          {bc['filePath'] && <div className="ins-badge-tool-path">{bc['filePath']}</div>}
          {bc['editCount'] && <div className="ins-badge-tool-detail">{t('projectMonitor.lineInsertion.editsCount', { count: parseInt(bc['editCount'], 10) || 0 })}</div>}
          {bc['editsJson'] && (() => {
            try {
              const edits = JSON.parse(bc['editsJson']) as Array<{ old_string: string; new_string: string }>
              return edits.map((e, i) => (
                <div key={i} className="ins-badge-tool-code">
                  <div className="ins-badge-tool-old">− {safeChild(e.old_string)}</div>
                  <div className="ins-badge-tool-new">+ {safeChild(e.new_string)}</div>
                </div>
              ))
            } catch (err) {
              console.error('[LineInsertion] MultiEdit expand ERROR:', err)
              return null
            }
          })()}
        </>
      )

    case 'Bash':
      return (
        <>
          {bc['command'] && <div className="ins-badge-tool-command">$ {bc['command']}</div>}
          {bc['description'] && <div className="ins-badge-tool-detail">{bc['description']}</div>}
          {bc['isSandboxDisabled'] === 'true' && (
            <span className="ins-badge-tool-tag" style={{ color: 'var(--rd)' }}>⚠ sandbox off</span>
          )}
        </>
      )

    case 'Grep':
      return (
        <>
          {bc['pattern'] && <div className="ins-badge-tool-detail">pattern: "{bc['pattern']}"</div>}
          {bc['searchPath'] && <div className="ins-badge-tool-detail">path: {bc['searchPath']}</div>}
          {bc['include'] && <div className="ins-badge-tool-detail">include: {bc['include']}</div>}
        </>
      )

    case 'Glob':
      return bc['pattern'] ? <div className="ins-badge-tool-path">{bc['pattern']}</div> : null

    case 'WebFetch':
      return (
        <>
          {bc['url'] && <div className="ins-badge-tool-path">{bc['url']}</div>}
          {bc['prompt'] && <div className="ins-badge-tool-detail">prompt: {bc['prompt']}</div>}
        </>
      )

    case 'WebSearch': {
      const flatResults = flattenWebSearchResults(bc['resultsJson'] ?? '')
      return (
        <>
          {bc['query'] && <div className="ins-badge-tool-detail-wrap">query: {bc['query']}</div>}
          {bc['allowedDomains'] && <div className="ins-badge-tool-detail-wrap">domains: {bc['allowedDomains']}</div>}
          {flatResults.length > 0 && <div className="ins-badge-tool-detail">{t('projectMonitor.lineInsertion.resultsCount', { count: flatResults.length })}</div>}
          {flatResults.length > 0 && (
            <div className="ins-badge-ws-results">
              {flatResults.map((r, i) => (
                <div key={i} className="ins-badge-ws-result">
                  <span className="ins-badge-ws-result-num">{i + 1}.</span>
                  <div className="ins-badge-ws-result-body">
                    <div className="ins-badge-ws-result-title">{safeChild(r.title)}</div>
                    <div className="ins-badge-ws-result-url">{safeChild(r.url)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )
    }

    case 'ToolSearch':
      return (
        <>
          {bc['query'] && <div className="ins-badge-tool-detail">query: {bc['query']}</div>}
          {bc['toolCount'] && <div className="ins-badge-tool-detail">{t('projectMonitor.lineInsertion.foundTools', { count: parseInt(bc['toolCount'], 10) || 0 })}</div>}
          {bc['toolsFound'] && <div className="ins-badge-tool-path">{bc['toolsFound']}</div>}
        </>
      )

    case 'EnterPlanMode':
      return <div className="ins-badge-tool-detail">{t('projectMonitor.lineInsertion.enterPlanMode')}</div>

    case 'ExitPlanMode':
      return (
        <>
          <div className="ins-badge-tool-detail">{t('projectMonitor.lineInsertion.exitPlanMode')}</div>
          {bc['planContent'] && <div className="ins-badge-tool-code">{bc['planContent']}</div>}
        </>
      )

    default: {
      // mcp__* 工具
      if (bc['displayName']) {
        return (
          <>
            <div className="ins-badge-tool-detail">{bc['displayName']}</div>
            {bc['description'] && <div className="ins-badge-tool-detail">{bc['description']}</div>}
          </>
        )
      }
      return null
    }
  }
}

// ════════════════════════════════════════════════════════════════

function LineInsertionItem({ insertion }: LineInsertionItemProps): React.JSX.Element {
  const { t } = useT()
  const { type, direction, color, length, customWidth, badgeContent, status, isAnimating, lineLabel } = insertion
  const [isExpanded, setIsExpanded] = useState(false)

  const isRight = direction === 'right'
  const isAgent = type === 'subagent'
  const isBtw = type === 'btw'
  const isInsight = type === 'insight'
  const isBranch = type === 'branch'
  const isSkill = type === 'skill'

  const lineClass = `ins-line ins-line-${length}`
  const lineStyle: React.CSSProperties = customWidth != null ? { width: customWidth } : {}

  const toolName = type === 'cli' ? 'CLI' : (badgeContent['toolName'] ?? '')
  const mainText = badgeContent['displayText'] || badgeContent['description'] || badgeContent['toolName'] || ''

  // ── subagent badge ──
  const buildAgentBadge = (): React.ReactNode => {
    const isLong = mainText.length > AGENT_MAX_CHARS
    const displayDesc = isLong && !isExpanded
      ? mainText.slice(0, AGENT_MAX_CHARS) + '…'
      : mainText

    return (
      <div
        className="ins-badge ins-badge-agent"
        style={{ borderColor: color, color, cursor: isLong ? 'pointer' : 'default', whiteSpace: isLong && isExpanded ? 'normal' : 'nowrap' }}
        title={mainText}
        onClick={isLong ? () => setIsExpanded((v) => !v) : undefined}
      >
        <span className="ins-badge-tool">{toolName}</span>
        {displayDesc && displayDesc !== toolName && (
          <span className="ins-badge-desc">{displayDesc.replace(toolName, '').trim()}</span>
        )}
        {isLong && (
          <span className="ins-badge-expand" style={{ color }}>
            {isExpanded ? '▲' : '▼'}
          </span>
        )}
        {isAnimating && <span className="ins-spinner">⟳</span>}
        {status === 'failed' && <span className="ins-fail">✕</span>}
      </div>
    )
  }

  // ── Insight badge ──
  const buildInsightBadge = (): React.ReactNode => {
    const isLong = mainText.length > INSIGHT_MAX_CHARS
    const displayText = isLong && !isExpanded
      ? mainText.slice(0, INSIGHT_MAX_CHARS) + '…'
      : mainText
    return (
      <div
        className="ins-badge ins-badge-insight"
        style={{ borderColor: color, color, cursor: isLong ? 'pointer' : 'default',
                 whiteSpace: isLong && isExpanded ? 'normal' : 'nowrap' }}
        title={mainText}
        onClick={isLong ? () => setIsExpanded((v) => !v) : undefined}
      >
        <span className="ins-badge-tool">{toolName}</span>
        {displayText && <span className="ins-badge-desc">{displayText}</span>}
        {isLong && (
          <span className="ins-badge-expand" style={{ color }}>
            {isExpanded ? '▲' : '▼'}
          </span>
        )}
      </div>
    )
  }

  // ── btw badge ──
  const buildBtwBadge = (): React.ReactNode => {
    const answer = badgeContent['answer'] as string | undefined
    const questionShort = mainText.length > INSIGHT_MAX_CHARS
      ? mainText.slice(0, INSIGHT_MAX_CHARS) + '…'
      : mainText
    return (
      <div
        className="ins-badge ins-badge-btw"
        style={{ borderColor: color, cursor: answer ? 'pointer' : 'default' }}
        onClick={answer ? () => setIsExpanded((v) => !v) : undefined}
      >
        <span className="ins-badge-tool" style={{ color }}>{toolName}</span>
        <span className="ins-badge-desc" style={{ color }}>{questionShort}</span>
        {isAnimating && !answer && <span className="ins-spinner" style={{ color }}>⟳</span>}
        {answer && (
          <span className="ins-badge-expand" style={{ color }}>{isExpanded ? '▲' : '▼'}</span>
        )}
        {answer && isExpanded && (
          <div className="ins-btw-answer">{answer}</div>
        )}
      </div>
    )
  }

  // ── Skill badge ──
  const buildSkillBadge = (): React.ReactNode => {
    const args = badgeContent['args'] as string | undefined
    const hasDetail = !!args
    return (
      <div
        className={`ins-badge ins-badge-skill ${hasDetail ? 'ins-badge-tool has-extra' : ''}`}
        style={{ borderColor: color, color, cursor: hasDetail ? 'pointer' : 'default' }}
        onClick={hasDetail ? () => setIsExpanded((v) => !v) : undefined}
      >
        {isExpanded && hasDetail ? (
          <>
            <div className="ins-badge-tool-header">
              <span className="ins-badge-tool">Skill</span>
              <span className="ins-badge-desc">{badgeContent['skillName'] || mainText}</span>
              <span className="ins-badge-expand" style={{ color }}>▲</span>
              {isAnimating && <span className="ins-spinner">⟳</span>}
              {status === 'failed' && <span className="ins-fail">✕</span>}
            </div>
            <div className="ins-badge-tool-separator" />
            <div className="ins-badge-tool-detail">args: {args}</div>
          </>
        ) : (
          <>
            <span className="ins-badge-tool">Skill</span>
            <span className="ins-badge-desc">{badgeContent['skillName'] || mainText}</span>
            {hasDetail && <span className="ins-badge-expand" style={{ color }}>▼</span>}
            {isAnimating && <span className="ins-spinner">⟳</span>}
            {status === 'failed' && <span className="ins-fail">✕</span>}
          </>
        )}
      </div>
    )
  }

  // ── AskUserQuestion badge ──
  const buildAskUserQuestionBadge = (): React.ReactNode => {
    const hasAnswer = !!badgeContent['selectedAnswer']
    const hasQuestions = !!badgeContent['questionsJson']

    // 紧凑态：固定文字
    if (!isExpanded) {
      return (
        <div
          className="ins-badge ins-badge-aq-compact"
          style={{ borderColor: color, cursor: hasQuestions || hasAnswer ? 'pointer' : 'default' }}
          onClick={(hasQuestions || hasAnswer) ? () => {
            console.log('[LineInsertion] AskUserQuestion expand clicked — hasQuestions:', hasQuestions, 'hasAnswer:', hasAnswer)
            setIsExpanded(true)
          } : undefined}
        >
          <span className="ins-badge-tool" style={{ color }}>AskUserQuestion</span>
          <span className="ins-badge-desc" style={{ color: 'var(--tx3)' }}>
            {hasAnswer ? t('projectMonitor.lineInsertion.answered') : t('projectMonitor.lineInsertion.clickToContinue')}
          </span>
          {isAnimating && <span className="ins-spinner" style={{ color }}>⟳</span>}
          {status === 'failed' && <span className="ins-fail">✕</span>}
          {(hasQuestions || hasAnswer) && (
            <span className="ins-badge-expand" style={{ color }}>▼</span>
          )}
        </div>
      )
    }

    // 展开态：渲染问题 + 选项列表
    return (
      <div
        className="ins-badge ins-badge-aq"
        style={{ borderColor: color }}
        onClick={() => setIsExpanded(false)}
      >
        <div className="ins-badge-aq-header">
          <span className="ins-badge-tool" style={{ color }}>AskUserQuestion</span>
          <span className="ins-badge-aq-status">
            {hasAnswer ? t('projectMonitor.lineInsertion.answeredCheck') : t('projectMonitor.lineInsertion.waitingForAnswer')}
          </span>
          <span className="ins-badge-expand" style={{ color }}>▲</span>
          {isAnimating && !hasAnswer && <span className="ins-spinner" style={{ color }}>⟳</span>}
        </div>

        {hasQuestions && (() => {
          try {
            const questions = JSON.parse(badgeContent['questionsJson']) as Array<{
              question: string; header?: string; options?: Array<{ label: string; description?: string }>;
              multiSelect?: boolean
            }>
            return questions.map((q, qi) => (
              <div key={qi}>
                {q.header && <div className="ins-badge-tool-detail" style={{ fontWeight: 600, marginTop: qi > 0 ? 'var(--space-sm)' : 0 }}>📋 {safeChild(q.header)}</div>}
                <div className="ins-badge-aq-question">{safeChild(q.question)}</div>
                {q.options && q.options.length > 0 && (
                  <div className="ins-badge-aq-options">
                    {q.options.map((opt, oi) => {
                      const isSelected = badgeContent['selectedAnswer']?.includes(String(opt.label ?? ''))
                      return (
                        <div key={oi} className={`ins-badge-aq-option ${isSelected ? 'selected' : 'unselected'}`}>
                          <span className="ins-badge-aq-option-label">
                            {isSelected ? '●' : '○'} {safeChild(opt.label)}
                          </span>
                          {opt.description && (
                            <span className="ins-badge-aq-option-desc">{safeChild(opt.description)}</span>
                          )}
                          {isSelected && <span className="ins-badge-aq-option-desc" style={{ color: 'var(--gr)' }}>{t('projectMonitor.lineInsertion.yourChoice')}</span>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            ))
          } catch (err) {
            console.error('[LineInsertion] AskUserQuestion expand ERROR:', err)
            console.error('[LineInsertion] AskUserQuestion — questionsJson preview:', badgeContent['questionsJson']?.substring(0, 200))
            return null
          }
        })()}

        {hasAnswer && !hasQuestions && (
          <div className="ins-badge-tool-detail">{t('projectMonitor.lineInsertion.selectedAnswer', { answer: badgeContent['selectedAnswer'] })}</div>
        )}
      </div>
    )
  }

  // ── 工具 badge（tool / mcp / cli 类型） ──
  const buildToolBadge = (): React.ReactNode => {
    const actualToolName = badgeContent['toolName'] ?? ''
    const compactText = buildToolCompact(actualToolName, badgeContent, t)
    const hasDetail = hasToolDetail(actualToolName, badgeContent)

    if (!hasDetail) {
      // 无详情 → 回退到旧 default badge
      return buildDefaultBadge()
    }

    if (!isExpanded) {
      // 紧凑态
      return (
        <div
          className="ins-badge ins-badge-tool has-extra"
          style={{ borderColor: color, cursor: 'pointer' }}
          onClick={() => {
            console.log('[LineInsertion] expand clicked — tool:', actualToolName, 'badgeContent keys:', Object.keys(badgeContent).join(','))
            setIsExpanded(true)
          }}
        >
          <span className="ins-badge-tool" style={{ color }}>{actualToolName}</span>
          <span className="ins-badge-desc">{compactText.replace(actualToolName, '').trim()}</span>
          <span className="ins-badge-expand" style={{ color }}>▼</span>
          {isAnimating && <span className="ins-spinner">⟳</span>}
          {status === 'failed' && <span className="ins-fail">✕</span>}
        </div>
      )
    }

    // 展开态
    const detailContent = (() => {
      try {
        return renderToolDetail(actualToolName, badgeContent, t)
      } catch (err) {
        console.error('[LineInsertion] renderToolDetail CRASHED for tool:', actualToolName, 'error:', err)
        return <div className="ins-badge-tool-detail" style={{ color: 'var(--rd)' }}>{t('projectMonitor.lineInsertion.renderDetailFailed', { error: String(err) })}</div>
      }
    })()

    return (
      <div
        className="ins-badge ins-badge-tool expanded"
        style={{ borderColor: color }}
        onClick={() => {
          console.log('[LineInsertion] collapse clicked — tool:', actualToolName)
          setIsExpanded(false)
        }}
      >
        <div className="ins-badge-tool-header">
          <span className="ins-badge-tool" style={{ color }}>{actualToolName}</span>
          <span className="ins-badge-expand" style={{ color }}>▲</span>
          {isAnimating && <span className="ins-spinner">⟳</span>}
          {status === 'failed' && <span className="ins-fail">✕</span>}
        </div>
        <div className="ins-badge-tool-separator" />
        {detailContent}
      </div>
    )
  }

  // ── 普通 badge（兜底 / 向后兼容） ──
  const buildDefaultBadge = (): React.ReactNode => {
    const truncated = mainText.length > 38 ? mainText.slice(0, 38) + '…' : mainText
    const descText = truncated !== toolName ? truncated.replace(toolName, '').trim() : ''

    return (
      <div
        className="ins-badge"
        style={{ borderColor: color, color }}
        title={mainText}
      >
        <span className="ins-badge-tool">{toolName}</span>
        {descText && <span className="ins-badge-desc">{descText}</span>}
        {isAnimating && <span className="ins-spinner">⟳</span>}
        {status === 'failed' && <span className="ins-fail">✕</span>}
      </div>
    )
  }

  // ── 主渲染分发 ──

  const lineEl = (
    <div
      className={lineClass}
      style={{ backgroundColor: color, ...lineStyle }}
    >
      {lineLabel && (
        <span className="ins-line-label" style={{ color }}>{lineLabel}</span>
      )}
    </div>
  )

  // branch 类型：纯线，无 badge
  if (isBranch) {
    return isRight
      ? <div className="ins-right">{lineEl}</div>
      : <div className="ins-left">{lineEl}</div>
  }

  const actualToolName = badgeContent['toolName'] ?? ''

  // 渲染分发：按优先级匹配
  const badgeEl = (() => {
    if (isAgent) return buildAgentBadge()
    if (isBtw) return buildBtwBadge()
    if (isInsight) return buildInsightBadge()
    if (isSkill) return buildSkillBadge()

    // AskUserQuestion：按 toolName 匹配（其 LineInsertion type 是 'tool'）
    if (actualToolName === 'AskUserQuestion') return buildAskUserQuestionBadge()

    // tool / mcp / cli → 工具 badge
    if (type === 'tool' || type === 'mcp' || type === 'cli') return buildToolBadge()

    // workflow + 兜底
    return buildDefaultBadge()
  })()

  if (isRight) {
    return (
      <div className="ins-right">
        {lineEl}
        {badgeEl}
      </div>
    )
  }

  // 左向：badge 在左，line 在右
  return (
    <div className="ins-left">
      {badgeEl}
      {lineEl}
    </div>
  )
}

export default LineInsertionItem
