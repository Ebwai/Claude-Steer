// 使用方法：由 GlobalMonitorPage.tsx 渲染在右半区域
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局监控右半配置面板——全局统计、Agent、经验（Skills/工作流）、工具（Tools/MCP/CLI）、功能入口
//           配置数据按来源分组展示：内置 / 个人 / 插件，支持折叠截断 + 展开浮层

import React, { useState, useEffect, useCallback } from 'react'
import { useAtomValue, useAtom, useStore } from 'jotai'
import { IPC } from '@shared/events/ipc-channels'
import { tokenStatsAtom, todayCostUsdAtom } from '../../atoms/stats.atom'
import { insightStateAtom, insightReportPathAtom, insightErrorAtom } from '../../atoms/insight.atom'
import { notificationQueueAtom } from '../../atoms/notification.atom'
import { schedulerTasksAtom } from '../../atoms/scheduler.atom'
import Modal from '../../components/Modal/Modal'
import SchedulerModal from '../scheduler/SchedulerModal'
import RemoteModal from '../remote/RemoteModal'
import RecommendModal from '../author-recommend/RecommendModal'
import { useT } from '../../i18n'
import './RightPanel.css'

// ── 镜像 SettingsManager 分组类型（与 IPC CONFIG_READ 响应保持一致）──────────

interface ItemGroup<T> {
  label: string
  source: 'builtin' | 'user' | 'plugin'
  pluginId?: string
  items: T[]
}

interface AgentItem { name: string; model: string }
interface SkillItem { name: string; description?: string; dirName?: string }
interface HookItem  { event: string; name: string }
interface ToolItem  { name: string }
interface McpItem   { name: string }

interface AllConfigGroups {
  agentGroups: ItemGroup<AgentItem>[]
  skillGroups: ItemGroup<SkillItem>[]
  hookGroups:  ItemGroup<HookItem>[]
  toolGroups:  ItemGroup<ToolItem>[]
  mcpGroups:   ItemGroup<McpItem>[]
}

// ── 展开浮层数据类型 ──────────────────────────────────────────────────────────

interface ExpandGroup { label: string; items: string[] }
interface ExpandState { title: string; groups: ExpandGroup[]; category?: string }

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function totalCount<T>(groups: ItemGroup<T>[]): number {
  return groups.reduce((acc, g) => acc + g.items.length, 0)
}

/** 判断是否有多个非空分组（决定是否显示分组标题） */
function hasMultipleNonEmpty<T>(groups: ItemGroup<T>[]): boolean {
  return groups.filter(g => g.items.length > 0).length > 1
}

// ── GroupSection 组件 ─────────────────────────────────────────────────────────
// 渲染一个来源分组的列表，支持截断（≤3全显/＞3前2+···）

interface GroupSectionProps {
  label: string
  count: number
  renderedItems: React.ReactNode[]
  showHeader: boolean
  onExpandAll: () => void
}

function GroupSection({
  label, count, renderedItems, showHeader, onExpandAll,
}: GroupSectionProps): React.JSX.Element | null {
  if (count === 0) return null
  return (
    <div className="rp-gsec">
      {showHeader && (
        <div className="rp-gsh">
          <span className="rp-gsh-label">{label}</span>
          <span className="rp-gsh-count">{count}</span>
        </div>
      )}
      {count <= 3
        ? renderedItems
        : (
          <>
            {renderedItems.slice(0, 2)}
            <div className="rp-elrow" onClick={onExpandAll}>···</div>
          </>
        )
      }
    </div>
  )
}

// ── CostOverlay（费用明细浮层）────────────────────────────────────────────────

interface CostOverlayProps {
  totalCost: number
  costByProject: Record<string, number>
  onClose: () => void
}

function CostOverlay({ totalCost, costByProject, onClose }: CostOverlayProps): React.JSX.Element {
  const { t } = useT()
  const entries = Object.entries(costByProject).sort(([, a], [, b]) => b - a)
  const colors = ['#D97858', '#8C74E8', '#5B9CF6', '#35C98A', '#E85858']
  return (
    <div className="rp-cost-overlay">
      <div className="rp-co-header">
        <span className="rp-co-title">{t('globalMonitor.stats.costDetailTitle')}</span>
        <button className="rp-co-close" onClick={onClose}>✕</button>
      </div>
      {entries.length === 0 ? (
        <div className="rp-co-empty">{t('globalMonitor.stats.noCostData')}</div>
      ) : (
        entries.map(([projectId, cost], i) => {
          const ratio = totalCost > 0 ? (cost / totalCost) * 100 : 0
          return (
            <div key={projectId} className="rp-co-row">
              <div className="rp-co-dot" style={{ background: colors[i % colors.length] }} />
              <span className="rp-co-nm">{projectId}</span>
              <div className="rp-co-bar-wrap">
                <div
                  className="rp-co-bar"
                  style={{ width: `${ratio}%`, background: colors[i % colors.length], opacity: 0.65 }}
                />
              </div>
              <span className="rp-co-val">${cost.toFixed(2)}</span>
            </div>
          )
        })
      )}
      <div className="rp-co-sep" />
      <div className="rp-co-total">
        <span>{t('globalMonitor.stats.total')}</span>
        <span style={{ color: 'var(--or)' }}>${totalCost.toFixed(2)}</span>
      </div>
    </div>
  )
}

// ── ExpandOverlay（展开浮层，支持多分组显示）─────────────────────────────────

interface ExpandOverlayProps {
  title: string
  groups: ExpandGroup[]
  onClose: () => void
  onRecommend?: () => void
}

function ExpandOverlay({ title, groups, onClose, onRecommend }: ExpandOverlayProps): React.JSX.Element {
  const { t } = useT()
  const showGroupLabels = groups.length > 1
  return (
    <Modal open={true} onClose={onClose}>
      <div className="rp-expand-panel">
        <div className="rp-ep-header">
          <span className="rp-ep-title">{title}</span>
          <div className="rp-ep-header-actions">
            {onRecommend && (
              <button className="rp-recommend-btn" onClick={onRecommend} title={t('recommend.plusTooltip')}>{t('recommend.plus')}</button>
            )}
            <button className="rp-ep-close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="rp-ep-body">
          {groups.map((grp, gi) => (
            <div key={gi} className="rp-ep-grp">
              {showGroupLabels && <div className="rp-ep-grp-label">{grp.label}</div>}
              {grp.items.map((item, i) => (
                <div key={i} className="rp-ep-item">
                  <span>{item}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

// ── SoulModal ─────────────────────────────────────────────────────────────────
// 注意：insightState 存储在全局 atom，关闭 Modal 后任务仍在后台运行

function SoulModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useT()
  const store = useStore()
  const [insightState, setInsightState] = useAtom(insightStateAtom)
  const [reportPath, setReportPath]     = useAtom(insightReportPathAtom)
  const [insightError, setInsightError] = useAtom(insightErrorAtom)

  // Auto-Dream 提示弹窗
  const [showAutoDreamNotice, setShowAutoDreamNotice] = useState(false)

  // 注册 INSIGHT_REPORT_READY 事件监听（只要 SoulModal 挂载过一次即生效；
  // 若 Modal 关闭后任务完成，下次打开 Modal 会读到 atom 的 ready 状态）
  useEffect(() => {
    const unlisten = window.api.on(IPC.INSIGHT_REPORT_READY, (...args: unknown[]) => {
      const payload = args[0] as { filePath: string }
      console.log('[SoulModal] insight report ready:', payload.filePath)
      setReportPath(payload.filePath)
      setInsightState('ready')
      // 向通知队列推送一条 info 消息（带 reportPath，通知页面用于渲染"打开报告"按钮）
      store.set(notificationQueueAtom, (prev) => [
        ...prev,
        {
          id: `insight-${Date.now()}`,
          type: 'info' as const,
          title: t('globalMonitor.soul.insightReadyTitle'),
          message: t('globalMonitor.soul.insightReadyMessage'),
          sessionId: '',
          projectId: '',
          requiresAction: false,
          resolved: false,
          createdAt: Date.now(),
          metadata: { reportPath: payload.filePath },
        },
      ])
    })
    return unlisten
  }, [setReportPath, setInsightState, store])

  const handleInsightClick = useCallback(async () => {
    if (insightState === 'ready' && reportPath) {
      console.log('[SoulModal] opening webview for report:', reportPath)
      await window.api.invoke(IPC.OPEN_WEBVIEW, { filePath: reportPath, title: t('globalMonitor.soul.webviewTitle') })
      return
    }
    if (insightState === 'loading') return

    console.log('[SoulModal] requesting insight run via temporary PTY')
    setInsightState('loading')
    setInsightError(null)

    try {
      const result = await window.api.invoke(IPC.INSIGHT_RUN) as { ok: boolean; error?: string }
      if (!result.ok) {
        setInsightState('error')
        setInsightError(result.error ?? t('globalMonitor.soul.launchFailed'))
      }
      // 成功后等待 INSIGHT_REPORT_READY 事件（useEffect 中监听）
    } catch (err) {
      console.error('[SoulModal] insight run failed:', err)
      setInsightState('error')
      setInsightError(String(err))
    }
  }, [insightState, reportPath, setInsightState, setInsightError])

  return (
    <>
      <Modal open={true} onClose={onClose}>
        <div className="rp-soul-modal">
          <div className="rp-sm-header">
            <div className="rp-sm-title">{t('globalMonitor.soul.title')}</div>
            <button className="rp-sm-close" onClick={onClose}>✕</button>
          </div>
          <div className="rp-sm-desc">{t('globalMonitor.soul.desc')}</div>
          <div className="rp-sm-btns">

            {/* Auto-Dream 卡片 */}
            <button className="rp-sm-btn" onClick={() => setShowAutoDreamNotice(true)}>
              <div className="rp-sm-btn-icon">✧</div>
              <div>
                <div className="rp-sm-btn-name">{t('globalMonitor.soul.autoDream')}</div>
                <div className="rp-sm-btn-desc">
                  {t('globalMonitor.soul.autoDreamDesc')}
                </div>
              </div>
            </button>

            {/* /insight 卡片 */}
            <button
              className={`rp-sm-btn${insightState === 'loading' ? ' rp-sm-btn-loading' : ''}${insightState === 'ready' ? ' rp-sm-btn-ready' : ''}`}
              onClick={handleInsightClick}
              disabled={insightState === 'loading'}
            >
              <div className="rp-sm-btn-icon">
                {insightState === 'loading' ? '⟳' : insightState === 'ready' ? '📂' : '💡'}
              </div>
              <div>
                <div className="rp-sm-btn-name">
                  {insightState === 'loading' ? t('globalMonitor.soul.insightGenerating') : insightState === 'ready' ? t('globalMonitor.soul.insightOpen') : t('globalMonitor.soul.insight')}
                </div>
                <div className="rp-sm-btn-desc">
                  {insightState === 'error' && insightError
                    ? insightError
                    : insightState === 'loading'
                      ? t('globalMonitor.soul.insightDescGenerating')
                      : t('globalMonitor.soul.insightDesc')}
                </div>
              </div>
            </button>

          </div>
        </div>
      </Modal>

      {/* Auto-Dream 暂未开放提示 */}
      {showAutoDreamNotice && (
        <Modal open={true} onClose={() => setShowAutoDreamNotice(false)} width={320}>
          <div className="rp-notice-modal">
            <div className="rp-nm-icon">✧</div>
            <div className="rp-nm-text">{t('globalMonitor.soul.autoDreamNotice')}</div>
            <button className="rp-nm-ok" onClick={() => setShowAutoDreamNotice(false)}>{t('globalMonitor.soul.gotIt')}</button>
          </div>
        </Modal>
      )}
    </>
  )
}

// ── 初始空状态 ────────────────────────────────────────────────────────────────

const EMPTY_CONFIG: AllConfigGroups = {
  agentGroups: [],
  skillGroups: [],
  hookGroups:  [],
  toolGroups:  [],
  mcpGroups:   [],
}

// ── RightPanel 主组件 ─────────────────────────────────────────────────────────

function RightPanel(): React.JSX.Element {
  const { t } = useT()
  const tokenStats = useAtomValue(tokenStatsAtom)
  const todayCost  = useAtomValue(todayCostUsdAtom)

  const schedulerTasks = useAtomValue(schedulerTasksAtom)

  const [config, setConfig]       = useState<AllConfigGroups>(EMPTY_CONFIG)
  const [showCost, setShowCost]   = useState(false)
  const [expandState, setExpandState] = useState<ExpandState | null>(null)
  const [showSoul, setShowSoul]   = useState(false)
  const [showScheduler, setShowScheduler] = useState(false)
  const [showRemote, setShowRemote] = useState(false)
  const [showRecommend, setShowRecommend] = useState(false)
  const [recommendCategory, setRecommendCategory] = useState('')

  // CONFIG_READ 直接返回 AllConfigGroups，无需额外转换
  const loadConfig = useCallback(async () => {
    try {
      const raw = await window.api.invoke(IPC.CONFIG_READ)
      if (raw) setConfig(raw as AllConfigGroups)
    } catch (err) {
      console.error('[RightPanel] Failed to load config:', err)
    }
  }, [])

  useEffect(() => { void loadConfig() }, [loadConfig])

  const fmtTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}K`
    return String(n)
  }

  // ── 展开浮层：将分组数据转换为 ExpandGroup[] ──────────────────────────────

  // Skills 按名称含 'cli' 拆分为两套分组（frontmatter name 或目录名任一含 'cli' 即归 CLI）
  const isCli = (s: SkillItem) => s.name.toLowerCase().includes('cli') || (s.dirName?.toLowerCase().includes('cli') ?? false)
  const nonCliSkillGroups = config.skillGroups
    .map(g => ({ ...g, items: g.items.filter(s => !isCli(s)) }))
  const cliSkillGroups = config.skillGroups
    .map(g => ({ ...g, items: g.items.filter(s => isCli(s)) }))
    .filter(g => g.items.length > 0)

  // Tools / MCP / CLI 列扁平化（直接展示前3条）
  const flatTools  = config.toolGroups.flatMap(g => g.items)
  const flatMcp    = config.mcpGroups.flatMap(g => g.items)
  const flatCli    = cliSkillGroups.flatMap(g => g.items)

  // 汇总计数
  const totalAgents = totalCount(config.agentGroups)
  const totalSkills = totalCount(nonCliSkillGroups)
  const totalCli    = flatCli.length
  const totalHooks  = totalCount(config.hookGroups)
  const totalTools  = totalCount(config.toolGroups)
  const totalMcp    = totalCount(config.mcpGroups)

  // 是否需要显示分组标题（多来源时才显示）
  const showAgentGrpHdr = hasMultipleNonEmpty(config.agentGroups)
  const showSkillGrpHdr = hasMultipleNonEmpty(nonCliSkillGroups)
  const showHookGrpHdr  = hasMultipleNonEmpty(config.hookGroups)

  const openAgentExpand = useCallback(() => {
    setExpandState({
      title: t('globalMonitor.agent.listTitle', { count: totalCount(config.agentGroups) }),
      groups: config.agentGroups
        .filter(g => g.items.length > 0)
        .map(g => ({ label: g.label, items: g.items.map(a => `${a.name} · ${a.model}`) })),
      category: 'agents',
    })
  }, [config.agentGroups])

  const openSkillExpand = useCallback(() => {
    setExpandState({
      title: t('globalMonitor.experience.allSkills', { count: totalCount(nonCliSkillGroups) }),
      groups: nonCliSkillGroups
        .filter(g => g.items.length > 0)
        .map(g => ({ label: g.label, items: g.items.map(s => s.name) })),
      category: 'skills',
    })
  }, [nonCliSkillGroups])

  const openCliExpand = useCallback(() => {
    setExpandState({
      title: t('globalMonitor.tools.allCli', { count: cliSkillGroups.reduce((a, g) => a + g.items.length, 0) }),
      groups: cliSkillGroups
        .filter(g => g.items.length > 0)
        .map(g => ({ label: g.label, items: g.items.map(s => s.name) })),
      category: 'clis',
    })
  }, [cliSkillGroups])

  const openHookExpand = useCallback(() => {
    setExpandState({
      title: t('globalMonitor.experience.allWorkflows', { count: totalCount(config.hookGroups) }),
      groups: config.hookGroups
        .filter(g => g.items.length > 0)
        .map(g => ({ label: g.label, items: g.items.map(h => `${h.event} → ${h.name}`) })),
      category: 'workflows',
    })
  }, [config.hookGroups])

  const openToolExpand = useCallback(() => {
    setExpandState({
      title: t('globalMonitor.tools.allTools', { count: totalCount(config.toolGroups) }),
      groups: config.toolGroups
        .filter(g => g.items.length > 0)
        .map(g => ({ label: g.label, items: g.items.map(t => t.name) })),
      category: 'tools',
    })
  }, [config.toolGroups])

  const openMcpExpand = useCallback(() => {
    setExpandState({
      title: t('globalMonitor.tools.allMcp', { count: totalCount(config.mcpGroups) }),
      groups: config.mcpGroups
        .filter(g => g.items.length > 0)
        .map(g => ({ label: g.label, items: g.items.map(m => m.name) })),
      category: 'mcps',
    })
  }, [config.mcpGroups])

  const openRecommend = useCallback((category: string) => {
    setRecommendCategory(category)
    setShowRecommend(true)
  }, [])


  return (
    <div className="rp-panel">

      {/* ── 全局统计 ── */}
      <div className="rp-section">
        <div className="rp-ph"><span className="rp-phi">◈</span> {t('globalMonitor.stats.title')}</div>
        <div className="rp-stats3">
          <div className="rp-sc">
            <div className="rp-sc-lbl">{t('globalMonitor.stats.mostUsedModel')}</div>
            <div className="rp-sc-val rp-sc-val-sm">{tokenStats.mostUsedModel ?? '—'}</div>
            <div className="rp-sc-sub">
              {tokenStats.mostUsedModel ? <span className="rp-sc-badge">{t('globalMonitor.stats.month')}</span> : t('globalMonitor.stats.noData')}
            </div>
          </div>
          <div className="rp-sc">
            <div className="rp-sc-lbl">{t('globalMonitor.stats.monthlyTokens')}</div>
            <div className="rp-sc-val">{fmtTokens(tokenStats.monthlyTokens)}</div>
            <div className="rp-sc-sub">
              <span className="rp-sc-badge">{t('globalMonitor.stats.cumulative')}</span>
              <span>{t('globalMonitor.stats.used')}</span>
            </div>
          </div>
          <div className="rp-sc rp-sc-clickable" onClick={() => setShowCost(s => !s)}>
            <div className="rp-sc-lbl">
              {t('globalMonitor.stats.totalCost')} <span className="rp-sc-lbl-hint">⚙</span>
            </div>
            <div className="rp-sc-val">${tokenStats.totalCostUsd.toFixed(2)}</div>
            <div className="rp-sc-sub">{t('globalMonitor.stats.today')} · ${todayCost.toFixed(2)}</div>
            <div className="rp-sc-expand">{showCost ? t('globalMonitor.stats.collapseDetail') : t('globalMonitor.stats.expandDetail')}</div>
          </div>
        </div>
        {showCost && (
          <CostOverlay
            totalCost={tokenStats.totalCostUsd}
            costByProject={tokenStats.costByProject}
            onClose={() => setShowCost(false)}
          />
        )}
      </div>

      {/* ── 配置行：Agent + 经验（1fr 2fr）── */}
      <div className="rp-cfg-row">

        {/* Agent 面板 */}
        <div className="rp-col">
          <div className="rp-ph"><span className="rp-phi">◈</span> {t('globalMonitor.agent.title')}</div>
          <div className="rp-mpanel">
            <div className="rp-mph">
              <span className="rp-mpt">Agent</span>
              <span className="rp-mpc">{totalAgents}</span>
              <button className="rp-recommend-btn" onClick={() => openRecommend('agents')} title={t('recommend.plusTooltip')}>{t('recommend.plus')}</button>
              <button className="rp-mph-expand" onClick={openAgentExpand}>{t('globalMonitor.agent.expandAll')}</button>
            </div>
            <div className="rp-mpb">
              {config.agentGroups.every(g => g.items.length === 0) ? (
                <div className="rp-empty">{t('globalMonitor.agent.notConfigured')}</div>
              ) : (
                config.agentGroups.map(group => (
                  <GroupSection
                    key={group.label}
                    label={group.label}
                    count={group.items.length}
                    showHeader={showAgentGrpHdr}
                    renderedItems={group.items.map(a => (
                      <div key={a.name} className="rp-aitem">
                        <span className="rp-aname">{a.name}</span>
                        <span className="rp-amod">{a.model}</span>
                      </div>
                    ))}
                    onExpandAll={openAgentExpand}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        {/* 经验面板（Skills + 工作流）*/}
        <div className="rp-col">
          <div className="rp-ph"><span className="rp-phi">◈</span> {t('globalMonitor.experience.title')}</div>
          <div className="rp-exp-row">

            {/* Skills（排除 CLI）*/}
            <div className="rp-emp">
              <div className="rp-emph">
                <span className="rp-empt">{t('globalMonitor.experience.skills')}</span>
                <span className="rp-mpc">{totalSkills}</span>
                <button className="rp-recommend-btn" onClick={() => openRecommend('skills')} title={t('recommend.plusTooltip')}>{t('recommend.plus')}</button>
                <button className="rp-mph-expand" onClick={openSkillExpand}>{t('globalMonitor.agent.expandAll')}</button>
              </div>
              <div className="rp-mpb">
                {nonCliSkillGroups.every(g => g.items.length === 0) ? (
                  <div className="rp-empty">{t('globalMonitor.agent.notConfigured')}</div>
                ) : (
                  nonCliSkillGroups.map(group => (
                    <GroupSection
                      key={group.label}
                      label={group.label}
                      count={group.items.length}
                      showHeader={showSkillGrpHdr}
                      renderedItems={group.items.map(s => (
                        <div key={s.name} className="rp-sitem" title={s.description}>
                          <span className="rp-sitem-name">{s.name}</span>
                        </div>
                      ))}
                      onExpandAll={openSkillExpand}
                    />
                  ))
                )}
              </div>
            </div>

            {/* 工作流（Hooks）*/}
            <div className="rp-emp">
              <div className="rp-emph">
                <span className="rp-empt">{t('globalMonitor.experience.workflows')}</span>
                <span className="rp-mpc">{totalHooks}</span>
                <button className="rp-recommend-btn" onClick={() => openRecommend('workflows')} title={t('recommend.plusTooltip')}>{t('recommend.plus')}</button>
                <button className="rp-mph-expand" onClick={openHookExpand}>{t('globalMonitor.agent.expandAll')}</button>
              </div>
              <div className="rp-mpb">
                {config.hookGroups.every(g => g.items.length === 0) ? (
                  <div className="rp-empty">{t('globalMonitor.agent.notConfigured')}</div>
                ) : (
                  config.hookGroups.map(group => (
                    <GroupSection
                      key={group.label}
                      label={group.label}
                      count={group.items.length}
                      showHeader={showHookGrpHdr}
                      renderedItems={group.items.map(h => (
                        <div key={`${h.event}-${h.name}`} className="rp-witem">
                          <span className="rp-wtag">{h.event}</span>
                          <span className="rp-wname">{h.name}</span>
                        </div>
                      ))}
                      onExpandAll={openHookExpand}
                    />
                  ))
                )}
              </div>
            </div>

          </div>
        </div>
      </div>

      {/* ── 工具（Tools / MCP / CLI 三列）── */}
      <div className="rp-section">
        <div className="rp-ph"><span className="rp-phi">◈</span> {t('globalMonitor.tools.title')}</div>
        <div className="rp-mpanel">
          <div className="rp-t3col">

            {/* Tools */}
            <div className="rp-tcol">
              <div className="rp-tch">
                <span>Tools</span>
                <span className="rp-mpc">{totalTools}</span>
                <span style={{ flex: 1 }} />
                <span className="rp-tch-exp" onClick={openToolExpand}>{t('globalMonitor.agent.expandAll')}</span>
              </div>
              {flatTools.length === 0 ? (
                <div className="rp-tempty">{t('globalMonitor.agent.notConfigured')}</div>
              ) : (
                <>
                  {flatTools.slice(0, 3).map(t => (
                    <div key={t.name} className="rp-titem">{t.name}</div>
                  ))}
                  {flatTools.length > 3 && (
                    <div className="rp-elrow" onClick={openToolExpand}>···</div>
                  )}
                </>
              )}
            </div>

            {/* MCP */}
            <div className="rp-tcol">
              <div className="rp-tch">
                <span>{t('globalMonitor.tools.mcp')}</span>
                <span className="rp-mpc">{totalMcp}</span>
                <span style={{ flex: 1 }} />
                <span className="rp-recommend-btn rp-recommend-btn-sm" onClick={() => openRecommend('mcps')} title={t('recommend.plusTooltip')}>{t('recommend.plus')}</span>
                <span className="rp-tch-exp" onClick={openMcpExpand}>{t('globalMonitor.agent.expandAll')}</span>
              </div>
              {flatMcp.length === 0 ? (
                <div className="rp-tempty">{t('globalMonitor.agent.notConfigured')}</div>
              ) : (
                <>
                  {flatMcp.slice(0, 3).map(m => (
                    <div key={m.name} className="rp-titem">{m.name}</div>
                  ))}
                  {flatMcp.length > 3 && (
                    <div className="rp-elrow" onClick={openMcpExpand}>···</div>
                  )}
                </>
              )}
            </div>

            {/* CLI（名称含 'cli' 的 skill）*/}
            <div className="rp-tcol">
              <div className="rp-tch">
                <span>CLI</span>
                <span className="rp-mpc">{totalCli}</span>
                <span style={{ flex: 1 }} />
                <span className="rp-recommend-btn rp-recommend-btn-sm" onClick={() => openRecommend('clis')} title={t('recommend.plusTooltip')}>{t('recommend.plus')}</span>
                {totalCli > 3 && (
                  <span className="rp-tch-exp" onClick={openCliExpand}>{t('globalMonitor.agent.expandAll')}</span>
                )}
              </div>
              {flatCli.length === 0 ? (
                <div className="rp-tempty">{t('globalMonitor.agent.notConfigured')}</div>
              ) : (
                <>
                  {flatCli.slice(0, 3).map(s => (
                    <div key={s.name} className="rp-titem" title={s.description}>{s.name}</div>
                  ))}
                  {flatCli.length > 3 && (
                    <div className="rp-elrow" onClick={openCliExpand}>···</div>
                  )}
                </>
              )}
            </div>

          </div>
        </div>
      </div>

      {/* ── 功能入口 ── */}
      <div className="rp-section">
        <div className="rp-ph"><span className="rp-phi">◈</span> {t('globalMonitor.features.title')}</div>
        <div className="rp-abrow">
          <div className="rp-abtn" onClick={() => setShowScheduler(true)}>
            <div className="rp-abico">⏰</div>
            <div className="rp-abn">{t('globalMonitor.features.scheduler')}</div>
            <div className="rp-abd">{t('globalMonitor.features.schedulerDesc', { count: schedulerTasks.length })}</div>
          </div>
          <div className="rp-abtn" onClick={() => setShowRemote(true)}>
            <div className="rp-abico">📡</div>
            <div className="rp-abn">{t('globalMonitor.features.remote')}</div>
            <div className="rp-abd">{t('globalMonitor.features.remoteDesc')}</div>
          </div>
          <div className="rp-abtn rp-abtn-soul" onClick={() => setShowSoul(true)}>
            <div className="rp-abico">💫</div>
            <div className="rp-abn">{t('globalMonitor.features.soul')}</div>
            <div className="rp-abd">{t('globalMonitor.features.soulDesc')}</div>
          </div>
        </div>
      </div>

      {/* ── 展开浮层 ── */}
      {expandState && (
        <ExpandOverlay
          title={expandState.title}
          groups={expandState.groups}
          onClose={() => setExpandState(null)}
          onRecommend={expandState.category ? () => openRecommend(expandState.category!) : undefined}
        />
      )}

      {/* ── 灵魂交流 Modal ── */}
      {showSoul && <SoulModal onClose={() => setShowSoul(false)} />}
      {showScheduler && <SchedulerModal onClose={() => setShowScheduler(false)} />}
      {showRemote && <RemoteModal onClose={() => setShowRemote(false)} />}
      {showRecommend && <RecommendModal category={recommendCategory} onClose={() => setShowRecommend(false)} />}

    </div>
  )
}

export default RightPanel
