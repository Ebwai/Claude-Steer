// 使用方法：由 ProjectMonitorPage.tsx 渲染在标签栏下方（height: 30px）
// 编译说明：renderer 进程 browser bundle
// 代码说明：项目设置栏——8 项竖线分隔设置（权限/模型/Tools/MCP/CLI/Skills/工作流/Plugins）
//           + 最右端「↑ 同步到 GitHub」按钮。读写项目级 .claude/settings.json。

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useAtomValue, useStore } from 'jotai'
import { IPC } from '@shared/events/ipc-channels'
import { pathMatches } from '@renderer/utils/pathUtils'
import {
  activeProjectIdAtom,
  projectByIdAtom,
  projectSettingsAtom,
  type ProjectSettings,
  defaultProjectSettings,
} from '../../atoms/projects.atom'
import { activeSessionsAtom } from '../../atoms/session-core.atom'
import type { Session, PermissionMode } from '@shared/types/index'
import { pendingPtyStartsAtom } from '../../atoms/pending-starts.atom'
import SettingsDropdown, { type RadioOption, type CheckboxOption, type CheckboxGroup } from './SettingsDropdown'
import { useT, type TFunction } from '../../i18n'
import './ProjectSettingsBar.css'

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 将 allSkills 按来源转换为分组列表（项目 / 个人 / 各 plugin 分组） */
function buildSkillGroups(
  skills: Array<{ name: string; source: 'project' | 'user' | 'plugin'; pluginLabel?: string; description?: string }>,
  filterFn: (name: string) => boolean,
  t: TFunction,
): CheckboxGroup[] {
  const filtered = skills.filter(s => filterFn(s.name))
  const groups: CheckboxGroup[] = []

  const project = filtered.filter(s => s.source === 'project').map(s => ({ value: s.name, label: s.name, description: s.description }))
  if (project.length > 0) groups.push({ label: t('projectMonitor.settingsBar.groupProject'), items: project })

  const user = filtered.filter(s => s.source === 'user').map(s => ({ value: s.name, label: s.name, description: s.description }))
  if (user.length > 0) groups.push({ label: t('projectMonitor.settingsBar.groupUser'), items: user })

  // 按 pluginLabel 聚合各 plugin 分组
  const pluginMap = new Map<string, CheckboxOption[]>()
  for (const s of filtered.filter(s => s.source === 'plugin')) {
    const label = s.pluginLabel ?? 'Plugin'
    if (!pluginMap.has(label)) pluginMap.set(label, [])
    pluginMap.get(label)!.push({ value: s.name, label: s.name, description: s.description })
  }
  for (const [label, items] of pluginMap) {
    groups.push({ label, items })
  }

  return groups
}

// ── 常量 ──────────────────────────────────────────────────────────────────────

const BUILTIN_TOOLS: CheckboxOption[] = [
  'Agent', 'AskUserQuestion', 'Bash', 'Edit', 'Glob', 'Grep',
  'Read', 'Skill', 'Task', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write',
].map((name) => ({ value: name, label: name }))

// ── 类型 ──────────────────────────────────────────────────────────────────────

type DropdownKey = 'permission' | 'model' | 'tools' | 'mcp' | 'cli' | 'skills' | 'workflows' | 'plugins' | null

// ── 主组件 ────────────────────────────────────────────────────────────────────

function ProjectSettingsBar(): React.JSX.Element {
  const { t } = useT()
  const store        = useStore()
  const activeId     = useAtomValue(activeProjectIdAtom)
  const project      = useAtomValue(projectByIdAtom(activeId ?? ''))
  const activeSessions = useAtomValue(activeSessionsAtom)
  const settings     = useAtomValue(projectSettingsAtom(activeId ?? ''))

  // 当前打开的下拉面板
  const [openDropdown, setOpenDropdown] = useState<DropdownKey>(null)
  // GitHub 同步按钮状态
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'success' | 'error'>('idle')
  const [syncError, setSyncError] = useState('')
  const [noRemoteModal, setNoRemoteModal] = useState(false)
  // 添加并行 Agent 主线按钮状态
  const [addingAgent, setAddingAgent] = useState(false)

  // 已翻译的权限选项
  const PERMISSION_OPTIONS: RadioOption[] = [
    { value: 'default',             label: 'default',             description: t('projectMonitor.settingsBar.permissionInteractive') },
    { value: 'acceptEdits',         label: 'acceptEdits',         description: t('projectMonitor.settingsBar.permissionAcceptEdits') },
    { value: 'plan',                label: 'plan',                description: t('projectMonitor.settingsBar.permissionPlan') },
    { value: 'auto',                label: 'auto',                description: t('projectMonitor.settingsBar.permissionAuto') },
    { value: 'dontAsk',             label: 'dontAsk',             description: t('projectMonitor.settingsBar.permissionDontAsk') },
    { value: 'bypassPermissions',   label: 'bypassPermissions',   description: t('projectMonitor.settingsBar.permissionBypass') },
  ]

  // 模型选项
  const MODEL_OPTIONS: RadioOption[] = [
    { value: 'claude-opus-4-6',         label: 'Opus 4.6' },
    { value: 'claude-sonnet-4-6',       label: 'Sonnet 4.6' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ]

  // 每个设置项的锚点 ref（用于浮层定位）
  const anchorRefs = {
    permission: useRef<HTMLDivElement>(null),
    model:      useRef<HTMLDivElement>(null),
    tools:      useRef<HTMLDivElement>(null),
    mcp:        useRef<HTMLDivElement>(null),
    cli:        useRef<HTMLDivElement>(null),
    skills:     useRef<HTMLDivElement>(null),
    workflows:  useRef<HTMLDivElement>(null),
    plugins:    useRef<HTMLDivElement>(null),
  }

  // 反查当前活跃 session（用于显示模型/上下文信息）
  let session: Session | undefined = project?.activeSessionId
    ? activeSessions.get(project.activeSessionId)
    : undefined
  if (!session && project) {
    for (const s of activeSessions.values()) {
      if (s.status === 'Running' &&
          pathMatches(s.cwd, project.path)) {
        session = s; break
      }
    }
  }

  // ── 加载项目级设置（.claude/settings.json + .mcp.json + ~/.claude.json MCP 状态）──
  useEffect(() => {
    if (!project) return
    void window.api.invoke(IPC.PROJECT_SETTINGS_READ, project.path)
      .then((res: unknown) => {
        const r = res as {
          ok: boolean
          settings?: Record<string, unknown>
          mcpJsonServers?: string[]
          globalMcpServers?: string[]
          mcpState?: { enabledMcpjsonServers: string[]; disabledMcpjsonServers: string[] }
          permissionsDeny?: string[]
          localPermissionsDeny?: string[]
          globalSkills?: Array<{ name: string; source: 'user' | 'plugin'; pluginLabel?: string }>
          projectSkills?: Array<{ name: string; source: 'project' }>
        }
        if (!r.ok) return
        const s = r.settings ?? {}

        const projectMcps  = r.mcpJsonServers ?? []
        const globalMcps   = r.globalMcpServers ?? []
        const disabledMcpJson = new Set(r.mcpState?.disabledMcpjsonServers ?? [])
        // 全局 MCP 被 permissions.deny 禁用的判断：包含 "mcp__name" 或 "mcp__name__*"
        const denyRules    = r.permissionsDeny ?? []
        const isGlobalDenied = (name: string) =>
          denyRules.some(rule => rule === `mcp__${name}` || rule === `mcp__${name}__*`)

        // 全局 MCP 去掉与项目 .mcp.json 同名的（避免重复，项目级优先）
        const globalOnly   = globalMcps.filter(name => !projectMcps.includes(name))

        // 全量列表（含来源标记，供 dropdown options 使用）
        const allMcps: ProjectSettings['allMcps'] = [
          ...projectMcps.map(name => ({ name, source: 'mcp.json' as const })),
          ...globalOnly.map(name  => ({ name, source: 'global'   as const })),
        ]

        // 启用列表：.mcp.json server 未在 disabledMcpjsonServers 中，全局 server 未在 permissions.deny 中
        const enabledMcps = allMcps
          .filter(({ name, source }) =>
            source === 'mcp.json' ? !disabledMcpJson.has(name) : !isGlobalDenied(name)
          )
          .map(({ name }) => name)

        // ── Skills 解析 ────────────────────────────────────────────────────
        // 合并全量：项目级优先，去掉与全局同名的重复项，保留 pluginLabel
        const projSkills   = r.projectSkills ?? []
        const globalSkills = r.globalSkills  ?? []
        const projSkillNames = new Set(projSkills.map(s => s.name))
        const allSkills: ProjectSettings['allSkills'] = [
          ...projSkills,
          ...globalSkills.filter(s => !projSkillNames.has(s.name))
            .map(s => ({ ...s, pluginLabel: s.pluginLabel })),
        ]

        // 被禁用的 skill：从 settings.local.json 的 deny 中提取 Skill(xxx) 格式
        const localDeny = r.localPermissionsDeny ?? []
        const disabledSkillSet = new Set(
          localDeny
            .map(rule => { const m = rule.match(/^Skill\((.+)\)$/); return m ? m[1] : null })
            .filter((n): n is string => n !== null)
        )

        // CLI skill：name 中含 'cli'（大小写不敏感）
        const enabledSkillList = allSkills.filter(({ name }) => !disabledSkillSet.has(name))
        const enabledClis   = enabledSkillList.filter(({ name }) => name.toLowerCase().includes('cli')).map(s => s.name)
        const enabledSkills = enabledSkillList.filter(({ name }) => !name.toLowerCase().includes('cli')).map(s => s.name)

        const loaded: ProjectSettings = {
          permissionMode:   (s['permissionMode'] as string)  ?? defaultProjectSettings.permissionMode,
          model:            (s['model'] as string)           ?? defaultProjectSettings.model,
          allowedTools:     (s['allowedTools'] as string[])  ?? [],
          disallowedTools:  (s['disallowedTools'] as string[]) ?? [],
          enabledMcps,
          allMcps,
          enabledClis,
          enabledSkills,
          allSkills,
          enabledWorkflows: (s['enabledWorkflows'] as string[]) ?? [],
          enabledPlugins:   Object.keys((s['enabledPlugins'] as object | undefined) ?? {}),
        }
        store.set(projectSettingsAtom(project.id), loaded)
        console.log(`[ProjectSettingsBar] loaded MCP=${enabledMcps.length} Skills=${enabledSkills.length} CLIs=${enabledClis.length} (disabled=${disabledSkillSet.size})`)
      })
      .catch((err: unknown) => console.error('[ProjectSettingsBar] read failed:', err))
  }, [project?.id, store])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── 写入单字段到项目 settings.json ─────────────────────────────────────────
  const writeSetting = useCallback(async (patch: Record<string, unknown>) => {
    if (!project) return
    try {
      await window.api.invoke(IPC.PROJECT_SETTINGS_WRITE, { projectPath: project.path, patch })
    } catch (err) {
      console.error('[ProjectSettingsBar] write failed:', err)
    }
  }, [project])

  // ── 切换下拉 ────────────────────────────────────────────────────────────────
  const toggleDropdown = (key: DropdownKey) => {
    setOpenDropdown((prev) => (prev === key ? null : key))
  }

  // ── 添加并行 Agent 主线 ─────────────────────────────────────────────────────
  const handleAddAgent = useCallback(async () => {
    console.log(`[PSB] handleAddAgent CLICKED project=${project?.id?.slice(0,8) ?? 'NULL'} addingAgent=${addingAgent}`)
    if (!project || addingAgent) { console.log(`[PSB] handleAddAgent BLOCKED: project=${!!project} addingAgent=${addingAgent}`); return }
    console.log(`[PSB:WIN] handleAddAgent BEFORE: outerW=${window.outerWidth} outerH=${window.outerHeight} innerW=${window.innerWidth} innerH=${window.innerHeight}`)
    setAddingAgent(true)
    try {
      const result = await window.api.invoke(IPC.SESSION_START, {
        projectId: project.id,
        projectPath: project.path,
        permissionMode: settings.permissionMode || 'acceptEdits',
      }) as { ok: boolean; sessionId?: string; error?: string }
      console.log(`[PSB:WIN] handleAddAgent AFTER: outerW=${window.outerWidth} outerH=${window.outerHeight} innerW=${window.innerWidth} innerH=${window.innerHeight}`)

      if (result.ok && result.sessionId) {
        // 只写 pending，等 SessionStart Hook 到达后 sessionLifecycle 以 claudeId 创建正式 entry
        store.set(pendingPtyStartsAtom, (prev) => {
          const m = new Map(prev)
          m.set(project.path, { ptyId: result.sessionId!, projectId: project.id })
          return m
        })
      }
    } catch (err) {
      console.error('[ProjectSettingsBar] add agent failed:', err)
    } finally {
      setAddingAgent(false)
    }
  }, [project, settings.permissionMode, addingAgent, store])

  // ── 同步到 GitHub ──────────────────────────────────────────────────────────
  const handleSync = async () => {
    if (syncState === 'syncing' || !project) return
    setSyncState('syncing')
    setSyncError('')
    try {
      // Step 1：检查 remote 是否配置
      const statusRes = await window.api.invoke(IPC.GIT_GET_STATUS, { projectPath: project.path }) as
        { ok: boolean; hasRemote?: boolean; error?: string }
      if (!statusRes.ok) {
        setSyncState('error')
        setSyncError(statusRes.error?.slice(0, 80) ?? t('projectMonitor.settingsBar.gitStatusFailed'))
        setTimeout(() => setSyncState('idle'), 3000)
        console.warn('[ProjectSettingsBar] git:get-status failed:', statusRes.error)
        return
      }
      if (!statusRes.hasRemote) {
        setSyncState('idle')
        setNoRemoteModal(true)
        console.log('[ProjectSettingsBar] no remote configured, showing guide modal')
        return
      }
      // Step 2：执行推送
      const pushRes = await window.api.invoke(IPC.GIT_PUSH, { projectPath: project.path }) as
        { ok: boolean; error?: string }
      if (pushRes.ok) {
        setSyncState('success')
        setTimeout(() => setSyncState('idle'), 2000)
        console.log('[ProjectSettingsBar] git push ok')
      } else {
        setSyncState('error')
        setSyncError(pushRes.error?.slice(0, 80) ?? t('projectMonitor.settingsBar.pushFailed'))
        setTimeout(() => setSyncState('idle'), 3000)
        console.warn('[ProjectSettingsBar] git push failed:', pushRes.error)
      }
    } catch (err) {
      setSyncState('error')
      setSyncError(String(err).slice(0, 80))
      setTimeout(() => setSyncState('idle'), 3000)
      console.error('[ProjectSettingsBar] handleSync error:', err)
    }
  }

  if (!project) {
    return (
      <div className="pset-bar">
        <span className="pset-empty">{t('projectMonitor.settingsBar.noProjectSelected')}</span>
      </div>
    )
  }

  // 已启用的工具 = 全部默认工具 排除 disallowedTools
  const enabledTools = BUILTIN_TOOLS
    .map((t) => t.value)
    .filter((t) => !settings.disallowedTools.includes(t))

  return (
    <div className="pset-bar">

      {/* 1. 权限 */}
      <div
        ref={anchorRefs.permission}
        className={`pset-item ${openDropdown === 'permission' ? 'pset-item-open' : ''}`}
        onClick={() => toggleDropdown('permission')}
      >
        <span className="pset-label">{t('projectMonitor.settingsBar.permission')}</span>
        <span className="pset-value">{settings.permissionMode || 'default'}</span>
        <span className="pset-arrow">▾</span>
      </div>
      <div className="pset-sep" />

      {/* 2. 模型 */}
      <div
        ref={anchorRefs.model}
        className={`pset-item ${openDropdown === 'model' ? 'pset-item-open' : ''}`}
        onClick={() => toggleDropdown('model')}
      >
        <span className="pset-label">{t('projectMonitor.settingsBar.model')}</span>
        <span className="pset-value">
          {session?.currentModel
            ? session.currentModel.replace('claude-', '').replace(/-\d{8}$/, '')
            : (settings.model ? settings.model.replace('claude-', '').replace(/-\d{8}$/, '') : t('projectMonitor.settingsBar.default'))}
        </span>
        <span className="pset-arrow">▾</span>
      </div>
      <div className="pset-sep" />

      {/* 3-5. 工具组：Tools / MCP / CLI */}
      <div className="pset-group pset-group-tools">
        <div
          ref={anchorRefs.tools}
          className={`pset-item ${openDropdown === 'tools' ? 'pset-item-open' : ''}`}
          onClick={() => toggleDropdown('tools')}
        >
          <span className="pset-label">Tools</span>
          <span className="pset-value">{enabledTools.length}/{BUILTIN_TOOLS.length}</span>
          <span className="pset-arrow">▾</span>
        </div>
        <div className="pset-sep" />
        <div
          ref={anchorRefs.mcp}
          className={`pset-item ${openDropdown === 'mcp' ? 'pset-item-open' : ''}`}
          onClick={() => toggleDropdown('mcp')}
        >
          <span className="pset-label">MCP</span>
          <span className="pset-value">{settings.enabledMcps.length}</span>
          <span className="pset-arrow">▾</span>
        </div>
        <div className="pset-sep" />
        <div
          ref={anchorRefs.cli}
          className={`pset-item ${openDropdown === 'cli' ? 'pset-item-open' : ''}`}
          onClick={() => toggleDropdown('cli')}
        >
          <span className="pset-label">CLI</span>
          <span className="pset-value">{settings.allSkills.filter(({ name }) => name.toLowerCase().includes('cli')).length || t('projectMonitor.settingsBar.none')}</span>
          <span className="pset-arrow">▾</span>
        </div>
      </div>
      <div className="pset-sep" />

      {/* 6-7. 经验组：Skills / 工作流 */}
      <div className="pset-group pset-group-exp">
        <div
          ref={anchorRefs.skills}
          className={`pset-item ${openDropdown === 'skills' ? 'pset-item-open' : ''}`}
          onClick={() => toggleDropdown('skills')}
        >
          <span className="pset-label">Skills</span>
          <span className="pset-value">{settings.allSkills.filter(({ name }) => !name.toLowerCase().includes('cli')).length || t('projectMonitor.settingsBar.none')}</span>
          <span className="pset-arrow">▾</span>
        </div>
        <div className="pset-sep" />
        <div
          ref={anchorRefs.workflows}
          className={`pset-item ${openDropdown === 'workflows' ? 'pset-item-open' : ''}`}
          onClick={() => toggleDropdown('workflows')}
        >
          <span className="pset-label">{t('projectMonitor.settingsBar.workflows')}</span>
          <span className="pset-value">{settings.enabledWorkflows.length || t('projectMonitor.settingsBar.all')}</span>
          <span className="pset-arrow">▾</span>
        </div>
      </div>
      <div className="pset-sep" />

      {/* 8. Plugins */}
      <div
        ref={anchorRefs.plugins}
        className={`pset-item ${openDropdown === 'plugins' ? 'pset-item-open' : ''}`}
        onClick={() => toggleDropdown('plugins')}
      >
        <span className="pset-label">Plugins</span>
        <span className="pset-value">{settings.enabledPlugins.length || t('projectMonitor.settingsBar.all')}</span>
        <span className="pset-arrow">▾</span>
      </div>

      {/* 上下文占比（有 session 时显示） */}
      {session?.tokenUsage.usedPercentage != null && (
        <>
          <div className="pset-sep" />
          <div className="pset-item pset-ctx">
            <div className="pset-ctx-bar">
              <div
                className="pset-ctx-fill"
                style={{ width: `${session.tokenUsage.usedPercentage}%` }}
              />
            </div>
            <span className="pset-value">{Math.round(session.tokenUsage.usedPercentage)}%</span>
          </div>
        </>
      )}

      {/* ＋ 添加并行 Agent 主线 */}
      <button
        className="pset-add-agent-btn"
        onClick={handleAddAgent}
        disabled={addingAgent}
        title={t('projectMonitor.settingsBar.newParallelAgent')}
      >
        {addingAgent ? t('projectMonitor.settingsBar.starting') : t('projectMonitor.settingsBar.addParallelAgent')}
      </button>

      {/* ↑ 同步到 GitHub（固定在右端） */}
      <button
        className={`pset-sync-btn pset-sync-${syncState}`}
        onClick={handleSync}
        disabled={syncState === 'syncing'}
        title={syncState === 'error' && syncError ? syncError : undefined}
      >
        {syncState === 'idle'    && t('projectMonitor.settingsBar.syncToGithub')}
        {syncState === 'syncing' && t('projectMonitor.settingsBar.pushing')}
        {syncState === 'success' && t('projectMonitor.settingsBar.synced')}
        {syncState === 'error'   && t('projectMonitor.settingsBar.pushFailed')}
      </button>

      {/* 无 remote 配置引导 Modal */}
      {noRemoteModal && (
        <div className="pset-modal-overlay" onClick={() => setNoRemoteModal(false)}>
          <div className="pset-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pset-modal-title">{t('projectMonitor.settingsBar.configGithubRemote')}</div>
            <div className="pset-modal-body">
              <p>{t('projectMonitor.settingsBar.noRemoteMessage')}</p>
              <ol>
                <li>{t('projectMonitor.settingsBar.createRepoStep')}</li>
                <li>{t('projectMonitor.settingsBar.runInTerminal')}</li>
                <pre className="pset-modal-code">git remote add origin &lt;{t('projectMonitor.settingsBar.repoUrl')}&gt;</pre>
                <li>{t('projectMonitor.settingsBar.reclickAfterConfig')}</li>
              </ol>
            </div>
            <button className="pset-modal-close" onClick={() => setNoRemoteModal(false)}>{t('projectMonitor.settingsBar.close')}</button>
          </div>
        </div>
      )}

      {/* ── 下拉浮层 ── */}
      {openDropdown === 'permission' && (
        <SettingsDropdown
          mode="radio"
          options={PERMISSION_OPTIONS}
          value={settings.permissionMode || 'default'}
          onChange={async (v) => {
            store.set(projectSettingsAtom(project.id), (prev) => ({ ...prev, permissionMode: v }))
            await writeSetting({ permissionMode: v as PermissionMode })
          }}
          onClose={() => setOpenDropdown(null)}
          anchorRef={anchorRefs.permission}
        />
      )}

      {openDropdown === 'model' && (
        <SettingsDropdown
          mode="radio"
          options={MODEL_OPTIONS}
          value={settings.model || 'claude-opus-4-6'}
          onChange={async (v) => {
            store.set(projectSettingsAtom(project.id), (prev) => ({ ...prev, model: v }))
            await writeSetting({ model: v })
          }}
          onClose={() => setOpenDropdown(null)}
          anchorRef={anchorRefs.model}
        />
      )}

      {openDropdown === 'tools' && (
        <SettingsDropdown
          mode="checkbox"
          options={BUILTIN_TOOLS}
          values={enabledTools}
          onChange={async (selected) => {
            const disabled = BUILTIN_TOOLS.map((t) => t.value).filter((t) => !selected.includes(t))
            store.set(projectSettingsAtom(project.id), (prev) => ({
              ...prev, disallowedTools: disabled,
            }))
            await writeSetting({ disallowedTools: disabled })
          }}
          onClose={() => setOpenDropdown(null)}
          anchorRef={anchorRefs.tools}
        />
      )}

      {openDropdown === 'mcp' && (
        <SettingsDropdown
          mode="checkbox"
          options={settings.allMcps.map(({ name, source }) => ({
            value: name,
            label: name,
            description: source === 'global' ? t('projectMonitor.settingsBar.sourceGlobal') : t('projectMonitor.settingsBar.sourceProject'),
          }))}
          values={settings.enabledMcps}
          onChange={async (selected) => {
            if (!project) return
            const allNames = settings.allMcps.map(m => m.name)
            // 逐个对比变化，按来源走不同禁用路径
            for (const { name, source } of settings.allMcps) {
              const wasEnabled = settings.enabledMcps.includes(name)
              const nowEnabled = selected.includes(name)
              if (wasEnabled === nowEnabled) continue

              if (source === 'mcp.json') {
                // .mcp.json server：写 ~/.claude.json disabledMcpjsonServers
                await window.api.invoke(IPC.MCP_SET_ENABLED, {
                  projectPath: project.path,
                  serverName: name,
                  enabled: nowEnabled,
                  source: 'mcp.json',
                })
              } else {
                // 全局 server：写项目 .claude/settings.json permissions.deny
                await window.api.invoke(IPC.MCP_SET_ENABLED, {
                  projectPath: project.path,
                  serverName: name,
                  enabled: nowEnabled,
                  source: 'global',
                })
              }
            }
            // 更新本地 atom
            store.set(projectSettingsAtom(project.id), (prev) => ({
              ...prev,
              enabledMcps: allNames.filter(n => selected.includes(n)),
            }))
            console.log(`[ProjectSettingsBar] MCP changed → enabled=${selected.length}`)
          }}
          onClose={() => setOpenDropdown(null)}
          anchorRef={anchorRefs.mcp}
        />
      )}

      {openDropdown === 'cli' && (
        <SettingsDropdown
          mode="grouped-checkbox"
          groups={buildSkillGroups(settings.allSkills, name => name.toLowerCase().includes('cli'), t)}
          values={settings.enabledClis}
          onChange={async (selected) => {
            if (!project) return
            const cliSkills = settings.allSkills.filter(({ name }) => name.toLowerCase().includes('cli'))
            for (const { name } of cliSkills) {
              const wasEnabled = settings.enabledClis.includes(name)
              const nowEnabled = selected.includes(name)
              if (wasEnabled === nowEnabled) continue
              await window.api.invoke(IPC.SKILL_SET_ENABLED, { projectPath: project.path, skillName: name, enabled: nowEnabled })
            }
            store.set(projectSettingsAtom(project.id), (prev) => ({
              ...prev,
              enabledClis: cliSkills.map(s => s.name).filter(n => selected.includes(n)),
            }))
          }}
          onClose={() => setOpenDropdown(null)}
          anchorRef={anchorRefs.cli}
        />
      )}

      {openDropdown === 'skills' && (
        <SettingsDropdown
          mode="grouped-checkbox"
          groups={buildSkillGroups(settings.allSkills, name => !name.toLowerCase().includes('cli'), t)}
          values={settings.enabledSkills}
          onChange={async (selected) => {
            if (!project) return
            const nonCliSkills = settings.allSkills.filter(({ name }) => !name.toLowerCase().includes('cli'))
            for (const { name } of nonCliSkills) {
              const wasEnabled = settings.enabledSkills.includes(name)
              const nowEnabled = selected.includes(name)
              if (wasEnabled === nowEnabled) continue
              await window.api.invoke(IPC.SKILL_SET_ENABLED, { projectPath: project.path, skillName: name, enabled: nowEnabled })
            }
            store.set(projectSettingsAtom(project.id), (prev) => ({
              ...prev,
              enabledSkills: nonCliSkills.map(s => s.name).filter(n => selected.includes(n)),
            }))
          }}
          onClose={() => setOpenDropdown(null)}
          anchorRef={anchorRefs.skills}
        />
      )}

      {openDropdown === 'workflows' && (
        <SettingsDropdown
          mode="checkbox"
          options={settings.enabledWorkflows.map((n) => ({ value: n, label: n }))}
          values={settings.enabledWorkflows}
          onChange={() => { /* 工作流管理占位 */ }}
          onClose={() => setOpenDropdown(null)}
          anchorRef={anchorRefs.workflows}
        />
      )}

      {openDropdown === 'plugins' && (
        <SettingsDropdown
          mode="checkbox"
          options={settings.enabledPlugins.map((n) => ({ value: n, label: n }))}
          values={settings.enabledPlugins}
          onChange={() => { /* Plugins 管理在 M6 实现 */ }}
          onClose={() => setOpenDropdown(null)}
          anchorRef={anchorRefs.plugins}
        />
      )}
    </div>
  )
}

export default ProjectSettingsBar
