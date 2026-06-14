// 使用方法：<RemotePanel />，由 RemoteModal 渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：cc-connect 远程交互主面板
//           安装状态区 + 服务状态栏 + 实时日志 + 项目列表（每个项目可独立配置飞书机器人）

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { claimedProjectsAtom } from '../../atoms/projects.atom'
import { IPC } from '@shared/events/ipc-channels'
import type { FeishuBotConfig } from '@shared/types/index'
import { useT } from '../../i18n'
import FeishuConfigWizard from './FeishuConfigWizard'
import FeishuConfigEditor from './FeishuConfigEditor'
import './remote.css'

type ServiceStatus = 'stopped' | 'starting' | 'running'

interface InstallInfo {
  installed: boolean
  version?: string
}

interface WizardTarget {
  projectId: string
  projectName: string
  initialBot?: FeishuBotConfig
}


export default function RemotePanel(): React.JSX.Element {
  const { t } = useT()
  const projects = useAtomValue(claimedProjectsAtom)

  const [installInfo,   setInstallInfo]   = useState<InstallInfo | null>(null)
  const [serviceStatus, setServiceStatus] = useState<ServiceStatus>('stopped')
  const [logs,          setLogs]          = useState<string[]>([])
  const [wizardTarget,  setWizardTarget]  = useState<WizardTarget | null>(null)
  const [configChoice,  setConfigChoice]  = useState<WizardTarget | null>(null)
  const [projectBots,   setProjectBots]   = useState<Record<string, FeishuBotConfig>>({})
  const [editingTarget, setEditingTarget] = useState<WizardTarget | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  // ── 安装检测 ──────────────────────────────────────────────────────────────

  const checkInstall = useCallback(async () => {
    try {
      const result = await window.api.invoke(IPC.CC_CONNECT_CHECK) as InstallInfo
      setInstallInfo(result)
      console.log('[RemotePanel] cc-connect check:', result)
    } catch (err) {
      console.error('[RemotePanel] CC_CONNECT_CHECK failed:', err)
      setInstallInfo({ installed: false })
    }
  }, [])

  // ── 安装状态轮询（每 8 秒）─────────────────────────────────────────────

  useEffect(() => {
    void checkInstall()
    const timer = setInterval(() => void checkInstall(), 8000)
    return () => clearInterval(timer)
  }, [checkInstall])

  // ── 服务状态轮询 ──────────────────────────────────────────────────────────

  const pollStatus = useCallback(async () => {
    try {
      const { running } = await window.api.invoke(IPC.CC_CONNECT_STATUS) as { running: boolean }
      setServiceStatus((prev) => {
        if (running) return 'running'
        if (prev === 'starting') return 'starting'
        return 'stopped'
      })
    } catch {
      setServiceStatus('stopped')
    }
  }, [])

  // ── 日志监听 ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const unsub = window.api.on(IPC.CC_CONNECT_LOG, (...args: unknown[]) => {
      const payload = args[0] as { log: string }
      setLogs((prev) => {
        const next = [...prev, payload.log]
        return next.length > 50 ? next.slice(-50) : next
      })
    })
    return () => { unsub?.() }
  }, [])

  // 日志自动滚底
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logs])

  // ── 初始化 ────────────────────────────────────────────────────────────────

  useEffect(() => {
    void pollStatus()
    const timer = setInterval(() => void pollStatus(), 5000)
    return () => clearInterval(timer)
  }, [pollStatus])

  // 从 projects atom 同步 feishuBot 配置到本地 state
  useEffect(() => {
    const bots: Record<string, FeishuBotConfig> = {}
    for (const p of projects) {
      if (p.feishuBot) bots[p.id] = p.feishuBot
    }
    setProjectBots(bots)
  }, [projects])

  // ── 启动/停止 ──────────────────────────────────────────────────────────────

  async function handleStart(): Promise<void> {
    setServiceStatus('starting')
    try {
      const result = await window.api.invoke(IPC.CC_CONNECT_START) as { ok: boolean }
      console.log('[RemotePanel] start result:', result)
      if (result.ok) {
        setServiceStatus('running')
      } else {
        setServiceStatus('stopped')
      }
    } catch (err) {
      console.error('[RemotePanel] start failed:', err)
      setServiceStatus('stopped')
    }
  }

  async function handleStop(): Promise<void> {
    try {
      await window.api.invoke(IPC.CC_CONNECT_STOP)
      setServiceStatus('stopped')
      console.log('[RemotePanel] service stopped')
    } catch (err) {
      console.error('[RemotePanel] stop failed:', err)
    }
  }

  // ── 一键安装 ──────────────────────────────────────────────────────────────
  // 主进程通过 CLI 位置参数传入安装提示词，启动 Claude 交互式会话并打开终端窗口

  async function handleInstall(): Promise<void> {
    try {
      const result = await window.api.invoke(IPC.CC_CONNECT_INSTALL) as { ok: boolean }
      if (result.ok) {
        console.log('[RemotePanel] cc-connect install helper started')
      } else {
        console.error('[RemotePanel] CC_CONNECT_INSTALL failed')
      }
    } catch (err) {
      console.error('[RemotePanel] install helper failed:', err)
    }
  }

  // ── 向导回调 ──────────────────────────────────────────────────────────────

  function handleWizardSave(bot: FeishuBotConfig): void {
    if (!wizardTarget) return
    setProjectBots((prev) => ({ ...prev, [wizardTarget.projectId]: bot }))
    setWizardTarget(null)
    console.log('[RemotePanel] bot config saved for', wizardTarget.projectId)
  }

  function handleEditorSave(bot: FeishuBotConfig): void {
    if (!editingTarget) return
    setProjectBots((prev) => ({ ...prev, [editingTarget.projectId]: bot }))
    setEditingTarget(null)
    console.log('[RemotePanel] bot config edited for', editingTarget.projectId)
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────

  // 配置方式选择面板
  if (configChoice) {
    return (
      <div className="rm-body">
        <div className="rm-setup-guide">
          <div className="rm-guide-back" onClick={() => setConfigChoice(null)}>
            ← {t('remote.panel.back')}
          </div>
          <div className="rm-guide-title">{t('remote.panel.configureFeishuBot')}</div>
          <div className="rm-guide-desc">
            {t('remote.panel.configChoiceDescPrefix')}<strong>{configChoice.projectName}</strong>{t('remote.panel.configChoiceDescSuffix')}
          </div>

          {/* 一键配置 */}
          <div className="rm-guide-card">
            <div className="rm-guide-card-title">
              <span className="rm-guide-badge recommended">{t('remote.panel.recommended')}</span>
              {t('remote.panel.oneClickConfigMethod')}
            </div>
            <div className="rm-guide-card-desc">
              {t('remote.panel.oneClickConfigDesc')}
            </div>
            <div className="rm-guide-code">
              cc-connect feishu setup --project {configChoice.projectName}
            </div>
          </div>

          {/* 手动配置 */}
          <div className="rm-guide-card">
            <div className="rm-guide-card-title">{t('remote.panel.manualConfigMethod')}</div>
            <div className="rm-guide-card-desc">
              {t('remote.panel.manualConfigDesc')}
            </div>
            <button
              className="rm-nav-btn next"
              onClick={() => {
                setWizardTarget(configChoice)
                setConfigChoice(null)
              }}
            >
              {t('remote.panel.enterManualWizard')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // 飞书配置编辑器（已配置项目）
  if (editingTarget && editingTarget.initialBot) {
    return (
      <FeishuConfigEditor
        projectId={editingTarget.projectId}
        projectName={editingTarget.projectName}
        bot={editingTarget.initialBot}
        onSave={handleEditorSave}
        onCancel={() => setEditingTarget(null)}
      />
    )
  }

  // 飞书配置向导（新配置项目）
  if (wizardTarget) {
    return (
      <FeishuConfigWizard
        projectId={wizardTarget.projectId}
        projectName={wizardTarget.projectName}
        initialBot={wizardTarget.initialBot}
        onSave={handleWizardSave}
        onCancel={() => setWizardTarget(null)}
      />
    )
  }

  const statusLabel =
    serviceStatus === 'running' ? '🟢 ' + t('remote.panel.statusRunning')
    : serviceStatus === 'starting' ? '🟡 ' + t('remote.panel.statusStarting')
    : '🔴 ' + t('remote.panel.statusStopped')

  return (
    <div className="rm-body">

      {/* ── 安装状态 ──────────────────────────────────────────── */}
      <div className="rm-install">
        <div className="rm-install-icon">🔌</div>
        <div className="rm-install-info">
          <div className="rm-install-title">
            cc-connect
            {installInfo?.installed && installInfo.version && (
              <span style={{ fontSize: 11, color: 'var(--tx-3)', marginLeft: 6, fontWeight: 400 }}>
                {installInfo.version}
              </span>
            )}
          </div>
          <div className="rm-install-sub">
            {installInfo === null
              ? t('remote.panel.checking')
              : installInfo.installed
                ? t('remote.panel.installedReady')
                : t('remote.panel.notInstalled')}
          </div>
          {installInfo?.installed && (
            <div className="rm-install-sub" style={{ fontSize: 11, marginTop: 2 }}>
              {t('remote.panel.poweredByCcConnect')}
              <a
                className="rm-cc-connect-link"
                href="#"
                onClick={(e) => {
                  e.preventDefault()
                  window.api.invoke(IPC.SHELL_OPEN_PATH, 'https://github.com/chenhg5/cc-connect').catch((err) => {
                    console.error('[RemotePanel] Failed to open cc-connect link:', err)
                    window.open('https://github.com/chenhg5/cc-connect', '_blank')
                  })
                }}
              >
                cc-connect
              </a>
            </div>
          )}
        </div>
        {installInfo !== null && !installInfo.installed && (
          <button className="rm-install-btn" onClick={() => void handleInstall()}>
            {t('remote.panel.oneClickInstall')}
          </button>
        )}
        {installInfo !== null && installInfo.installed && (
          <button
            className="rm-install-btn"
            style={{ background: 'var(--bg-3)', color: 'var(--tx-2)' }}
            onClick={() => void checkInstall()}
          >
            {t('remote.panel.recheck')}
          </button>
        )}
      </div>

      {/* ── 服务状态（仅已安装时显示）──────────────────────────── */}
      {installInfo?.installed && (
        <div className="rm-status-bar">
          <div className={`rm-status-dot ${serviceStatus}`} />
          <div className="rm-status-text">{statusLabel}</div>
          {serviceStatus !== 'running' ? (
            <button
              className="rm-status-btn start"
              onClick={handleStart}
              disabled={serviceStatus === 'starting'}
            >
              {t('remote.panel.startService')}
            </button>
          ) : (
            <button className="rm-status-btn stop" onClick={handleStop}>
              {t('remote.panel.stopService')}
            </button>
          )}
        </div>
      )}

      {/* ── 实时日志 ────────────────────────────────────────────── */}
      {installInfo?.installed && (
        <div className="rm-log-area" ref={logRef}>
          {logs.length === 0
            ? <span className="rm-log-empty">{t('remote.panel.noLogs')}</span>
            : logs.join('\n')}
        </div>
      )}

      {/* ── 项目列表 ────────────────────────────────────────────── */}
      {installInfo?.installed && (
        <div>
          <div className="rm-section-title">{t('remote.panel.projectFeishuBot')}</div>
          <div className="rm-project-list">
            {projects.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--tx-3)', padding: '8px 0' }}>
                {t('remote.panel.noClaimedProjects')}
              </div>
            ) : projects.map((project) => {
              const bot = projectBots[project.id]
              return (
                <div key={project.id} className="rm-project-row">
                  <div className="rm-project-name" title={project.path}>
                    {project.name}
                  </div>
                  <span className={`rm-project-badge ${bot ? 'configured' : 'unconfigured'}`}>
                    {bot ? t('remote.panel.configured') : t('remote.panel.unconfigured')}
                  </span>
                  <button
                    className="rm-project-cfg-btn"
                    onClick={() => {
                      if (bot) {
                        setEditingTarget({ projectId: project.id, projectName: project.name, initialBot: bot })
                      } else {
                        setConfigChoice({ projectId: project.id, projectName: project.name })
                      }
                    }}
                  >
                    {bot ? t('remote.panel.editConfig') : t('remote.panel.configure')}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
