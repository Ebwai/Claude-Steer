// 使用方法：由 App.tsx 在首次启动或有待确认项目时渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：初始化 SOP 模态框——选择根目录、扫描 CLAUDE.md 项目、三态认领清单
//           首次启动（无 projects.json）或有 claimStatus=0 的待确认项目时显示

import React, { useState, useCallback } from 'react'
import { useStore } from 'jotai'
import { IPC } from '@shared/events/ipc-channels'
import type { Project } from '@shared/types/index'
import { projectsAtom } from '../../atoms/projects.atom'
import Modal from '../../components/Modal/Modal'
import './InitSopModal.css'
import { useT } from '../../i18n'

// ── 扫描结果类型（镜像主进程 ScannedProject）──────────────────────────────────

interface ScannedProject {
  path: string
  name: string
  isGitRepo: boolean
}

// ── 认领状态：true = 认领(1), false = 忽略(-1) ────────────────────────────────

type ClaimMap = Map<string, boolean>

// ── Props ──────────────────────────────────────────────────────────────────────

interface InitSopModalProps {
  /** 是否为首次启动（无 projects.json）；false = 有待确认项目的后续启动 */
  isFirstLaunch: boolean
  /** 已有的待确认项目列表（后续启动模式，isFirstLaunch=false 时传入） */
  pendingProjects?: Project[]
  onClose: () => void
}

// ── 组件 ──────────────────────────────────────────────────────────────────────

function InitSopModal({ isFirstLaunch, pendingProjects = [], onClose }: InitSopModalProps): React.JSX.Element {
  const store = useStore()

  // ── 首次启动流程状态 ─────────────────────────────────────────────────────────
  const [rootDir, setRootDir]         = useState<string>('')
  const [scanning, setScanning]       = useState(false)
  const [scanned, setScanned]         = useState<ScannedProject[] | null>(null)
  const [claimMap, setClaimMap]       = useState<ClaimMap>(new Map())
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState<string | null>(null)

  const { t } = useT()

  // 待确认模式：将 pendingProjects 转为 claimMap（初始全部 false = 忽略）
  const [pendingClaimMap, setPendingClaimMap] = useState<ClaimMap>(() =>
    new Map(pendingProjects.map((p) => [p.id, false]))
  )

  // ── 目录选择 ──────────────────────────────────────────────────────────────────
  const handleBrowse = useCallback(async () => {
    const dir = await window.api.invoke(IPC.DIALOG_OPEN_DIR) as string | null
    if (dir) setRootDir(dir)
  }, [])

  // ── 扫描 ──────────────────────────────────────────────────────────────────────
  const handleScan = useCallback(async () => {
    if (!rootDir.trim()) return
    setScanning(true)
    setError(null)
    try {
      const results = await window.api.invoke(IPC.PROJECT_SCAN, rootDir) as ScannedProject[]
      setScanned(results)
      // 默认全部 false（忽略）
      setClaimMap(new Map(results.map((p) => [p.path, false])))
    } catch (err) {
      setError(t('initSop.scanFailed') + String(err))
    } finally {
      setScanning(false)
    }
  }, [rootDir])

  // ── 切换认领状态 ──────────────────────────────────────────────────────────────
  const toggleClaim = useCallback((projectPath: string, setter: React.Dispatch<React.SetStateAction<ClaimMap>>) => {
    setter((prev) => {
      const next = new Map(prev)
      next.set(projectPath, !prev.get(projectPath))
      return next
    })
  }, [])

  // ── 确认（首次启动模式）──────────────────────────────────────────────────────
  const handleConfirmFirstLaunch = useCallback(async () => {
    if (!scanned) return
    setSaving(true)
    setError(null)
    try {
      const updates = scanned.map((p) => ({
        projectId: p.path,
        claimStatus: claimMap.get(p.path) ? 1 : -1,
      })) as Array<{ projectId: string; claimStatus: 1 | -1 }>

      await window.api.invoke(IPC.PROJECT_UPDATE, {
        updates,
        initCompleted: true,
        lastRootDir: rootDir,
      })

      // 重新拉取项目列表更新 atom
      const allProjects = await window.api.invoke(IPC.PROJECT_LIST) as Project[]
      store.set(projectsAtom, new Map(allProjects.map((p) => [p.id, p])))
      onClose()
    } catch (err) {
      setError(t('initSop.saveFailed') + String(err))
    } finally {
      setSaving(false)
    }
  }, [scanned, claimMap, rootDir, store, onClose])

  // ── 确认（后续启动待确认模式）────────────────────────────────────────────────
  const handleConfirmPending = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const updates = pendingProjects.map((p) => ({
        projectId: p.id,
        claimStatus: pendingClaimMap.get(p.id) ? 1 : -1,
      })) as Array<{ projectId: string; claimStatus: 1 | -1 }>

      await window.api.invoke(IPC.PROJECT_UPDATE, { updates })

      const allProjects = await window.api.invoke(IPC.PROJECT_LIST) as Project[]
      store.set(projectsAtom, new Map(allProjects.map((p) => [p.id, p])))
      onClose()
    } catch (err) {
      setError(t('initSop.saveFailed') + String(err))
    } finally {
      setSaving(false)
    }
  }, [pendingProjects, pendingClaimMap, store, onClose])

  // ── 渲染项目行 ────────────────────────────────────────────────────────────────
  const renderProjectRow = (
    projectPath: string,
    projectName: string,
    isGit: boolean,
    isClaimed: boolean,
    onToggle: () => void
  ): React.JSX.Element => (
    <div
      key={projectPath}
      className={`init-row ${isClaimed ? 'init-row-claimed' : 'init-row-ignored'}`}
      onClick={onToggle}
    >
      <div className="init-row-toggle">
        {isClaimed ? '✓' : '—'}
      </div>
      <div className="init-row-info">
        <div className="init-row-name">{projectName}</div>
        <div className="init-row-path">{projectPath}</div>
      </div>
      {isGit && <div className="init-row-git">git</div>}
    </div>
  )

  // ── 后续启动模式（待确认项目）────────────────────────────────────────────────
  if (!isFirstLaunch) {
    return (
      <Modal open={true} onClose={onClose}>
        <div className="init-modal">
          <div className="init-header">
            <div className="init-title">
              <span className="init-title-icon">◈</span>
              {t('initSop.titlePending', { count: pendingProjects.length })}
            </div>
            <button className="init-close" onClick={onClose}>✕</button>
          </div>

          <div className="init-desc">
            {t('initSop.descPending')}
          </div>

          <div className="init-list">
            {pendingProjects.map((p) =>
              renderProjectRow(
                p.path, p.name, p.isGitRepo,
                pendingClaimMap.get(p.id) ?? false,
                () => toggleClaim(p.id, setPendingClaimMap)
              )
            )}
          </div>

          {error && <div className="init-error">{error}</div>}

          <div className="init-footer">
            <button className="init-btn-skip" onClick={onClose} disabled={saving}>
              {t('initSop.later')}
            </button>
            <button className="init-btn-confirm" onClick={handleConfirmPending} disabled={saving}>
              {saving ? t('initSop.saving') : t('initSop.confirm')}
            </button>
          </div>
        </div>
      </Modal>
    )
  }

  // ── 首次启动模式 ──────────────────────────────────────────────────────────────
  return (
    <Modal open={true} onClose={onClose}>
      <div className="init-modal">
        <div className="init-header">
          <div className="init-title">
            <span className="init-title-icon">◈</span>
            {t('initSop.titleInit')}
          </div>
          <button className="init-close" onClick={onClose}>✕</button>
        </div>

        <div className="init-desc">
          {t('initSop.descInit')}
        </div>

        {/* 目录选择行 */}
        <div className="init-dir-row">
          <div className="init-dir-path">{rootDir || t('initSop.noDirSelected')}</div>
          <button className="init-btn-browse" onClick={handleBrowse}>
            {t('initSop.browse')}
          </button>
          <button
            className="init-btn-scan"
            onClick={handleScan}
            disabled={!rootDir.trim() || scanning}
          >
            {scanning ? t('initSop.scanning') : t('initSop.scan')}
          </button>
        </div>

        {/* 扫描结果 */}
        {scanned !== null && (
          <>
            <div className="init-scan-header">
              {t('initSop.scanResult', { count: scanned.length })}
              {scanned.length > 0 && (
                <span className="init-scan-hint">{t('initSop.scanHint')}</span>
              )}
            </div>

            {scanned.length === 0 ? (
              <div className="init-scan-empty">{t('initSop.noProjectsFound')}</div>
            ) : (
              <div className="init-list">
                {scanned.map((p) =>
                  renderProjectRow(
                    p.path, p.name, p.isGitRepo,
                    claimMap.get(p.path) ?? false,
                    () => toggleClaim(p.path, setClaimMap)
                  )
                )}
              </div>
            )}
          </>
        )}

        {error && <div className="init-error">{error}</div>}

        <div className="init-footer">
          <button className="init-btn-skip" onClick={onClose} disabled={saving}>
            {t('initSop.skip')}
          </button>
          <button
            className="init-btn-confirm"
            onClick={handleConfirmFirstLaunch}
            disabled={!scanned || saving}
          >
            {saving ? t('initSop.saving') : t('initSop.confirm')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export default InitSopModal
