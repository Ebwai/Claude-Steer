// 使用方法：由 GlobalMonitorPage.tsx 在 wizardOpen===true 时渲染，替代 RightPanel
// 编译说明：renderer 进程 browser bundle
// 代码说明：新建项目三步向导——Step1 项目设置 / Step2 放入资产 / Step3 制定计划
//           完成后调用 PROJECT_CREATE → SESSION_START → SESSION_INPUT("创建计划")

import React, { useState, useCallback } from 'react'
import { useStore } from 'jotai'
import { IPC } from '@shared/events/ipc-channels'
import type { Project } from '@shared/types/index'
import { projectsAtom } from '../../atoms/projects.atom'
import './CreateProjectWizard.css'
import { useT } from '../../i18n'

// ── 步骤定义 ──────────────────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3

// ── 权限模式选项 ──────────────────────────────────────────────────────────────

const PERMISSION_OPTIONS = [
  { value: 'acceptEdits',  key: 'wizard.permission.acceptEdits' },
  { value: 'default',      key: 'wizard.permission.default' },
  { value: 'plan',         key: 'wizard.permission.plan' },
  { value: 'auto',         key: 'wizard.permission.auto' },
]

// ── Props ──────────────────────────────────────────────────────────────────────

interface CreateProjectWizardProps {
  onClose: () => void
}

// ── 组件 ──────────────────────────────────────────────────────────────────────

function CreateProjectWizard({ onClose }: CreateProjectWizardProps): React.JSX.Element {
  const store = useStore()

  const [step, setStep]                 = useState<WizardStep>(1)
  const [projectName, setProjectName]   = useState('')
  /** 父目录（存储位置），由 "浏览" 按钮选择或手动填写 */
  const [parentDir, setParentDir]       = useState('')
  const [description, setDescription]   = useState('')
  const [permission, setPermission]     = useState<string>('acceptEdits')
  const [planPrompt, setPlanPrompt]     = useState('')
  const [submitting, setSubmitting]     = useState(false)
  const [error, setError]               = useState<string | null>(null)

  const { t } = useT()

  const STEP_LABELS: Record<WizardStep, string> = {
    1: t('wizard.step1'),
    2: t('wizard.step2'),
    3: t('wizard.step3'),
  }

  /** 实际项目路径 = 父目录 + 分隔符 + 项目名 */
  const computedPath = parentDir.trim() && projectName.trim()
    ? parentDir.trim().replace(/[\\/]+$/, '') + '/' + projectName.trim()
    : ''

  // ── 父目录选择（浏览按钮选的是父目录，不是项目目录本身）──────────────────────
  const handleBrowsePath = useCallback(async () => {
    const dir = await window.api.invoke(IPC.DIALOG_OPEN_DIR) as string | null
    if (dir) setParentDir(dir)
  }, [])

  // ── 打开文件夹（Step 2 中使用 computedPath）──────────────────────────────────
  const handleOpenFolder = useCallback(() => {
    if (computedPath) {
      window.api.invoke(IPC.SHELL_OPEN_PATH, computedPath).catch(() => {})
    }
  }, [computedPath])

  // ── 步骤验证 ──────────────────────────────────────────────────────────────────
  const canProceedStep1 = projectName.trim() !== '' && parentDir.trim() !== ''
  const canProceedStep2 = true  // 资产放置可选，直接跳过

  // ── Step 3 提交 ──────────────────────────────────────────────────────────────
  const handleStart = useCallback(async () => {
    if (!planPrompt.trim()) {
      setError(t('wizard.errorNoGoal'))
      return
    }
    setSubmitting(true)
    setError(null)

    try {
      if (!computedPath) {
        throw new Error(t('wizard.errorPathIncomplete'))
      }
      // 1. 创建项目（写 CLAUDE.md + settings.json + projects.json）
      const createResult = await window.api.invoke(IPC.PROJECT_CREATE, {
        name: projectName.trim(),
        path: computedPath,
        description: description.trim(),
      }) as { ok: boolean; project?: Project; error?: string }

      if (!createResult.ok || !createResult.project) {
        throw new Error(createResult.error ?? t('wizard.errorCreateFailed'))
      }

      const project = createResult.project

      // 2. 更新 projectsAtom
      const allProjects = await window.api.invoke(IPC.PROJECT_LIST) as Project[]
      store.set(projectsAtom, new Map(allProjects.map((p) => [p.id, p])))

      // 3. 启动 PTY session（acceptEdits 模式）
      const startResult = await window.api.invoke(IPC.SESSION_START, {
        projectId: project.id,
        projectPath: project.path,
        permissionMode: permission,
      }) as { ok: boolean; sessionId?: string; error?: string }

      if (!startResult.ok || !startResult.sessionId) {
        // PTY 启动失败不阻断流程，只记录警告
        console.warn('[CreateWizard] SESSION_START failed:', startResult.error)
      } else {
        // 4. 等待 300ms 后发送初始化计划指令（PTY 启动需要一点初始化时间）
        await new Promise((r) => setTimeout(r, 300))
        const wrappedInstruction = t('wizard.instruction', { goal: planPrompt.trim() })
        await window.api.invoke(IPC.SESSION_INPUT, {
          sessionId: startResult.sessionId,
          text: wrappedInstruction,
        })
      }

      onClose()
    } catch (err) {
      setError(String(err))
      setSubmitting(false)
    }
  }, [
    projectName, parentDir, computedPath, description, permission, planPrompt,
    store, onClose,
  ])

  // ── StepNav 步骤指示器 ────────────────────────────────────────────────────────
  const StepNav = (): React.JSX.Element => (
    <div className="wiz-stepnav">
      {([1, 2, 3] as WizardStep[]).map((s) => (
        <React.Fragment key={s}>
          <div
            className={`wiz-step-dot ${step === s ? 'wiz-step-active' : step > s ? 'wiz-step-done' : 'wiz-step-todo'}`}
          >
            {step > s ? '✓' : s}
          </div>
          <div className="wiz-step-label">{STEP_LABELS[s]}</div>
          {s < 3 && <div className="wiz-step-line" />}
        </React.Fragment>
      ))}
    </div>
  )

  return (
    <div className="wiz-panel">
      {/* 标题行 */}
      <div className="wiz-header">
        <div className="wiz-title">
          <span className="wiz-title-icon">◈</span>
          {t('wizard.title')}
        </div>
        <button className="wiz-close" onClick={onClose}>✕</button>
      </div>

      <StepNav />

      <div className="wiz-body">

        {/* ── Step 1: 项目设置 ── */}
        {step === 1 && (
          <div className="wiz-step-content">
            <div className="wiz-field">
              <label className="wiz-label">{t('wizard.projectName')} <span className="wiz-req">*</span></label>
              <input
                className="wiz-input"
                type="text"
                placeholder={t('wizard.projectNamePlaceholder')}
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
              />
            </div>

            <div className="wiz-field">
              <label className="wiz-label">{t('wizard.storageLocation')} <span className="wiz-req">*</span></label>
              <div className="wiz-path-row">
                <input
                  className="wiz-input wiz-input-path"
                  type="text"
                  placeholder={t('wizard.parentDirPlaceholder')}
                  value={parentDir}
                  onChange={(e) => setParentDir(e.target.value)}
                />
                <button className="wiz-btn-browse" onClick={handleBrowsePath}>
                  {t('wizard.browse')}
                </button>
              </div>
              {/* 预览实际创建路径 */}
              {computedPath && (
                <div className="wiz-path-preview">
                  <span className="wiz-path-preview-lbl">{t('wizard.willCreateAt')}</span>
                  <span className="wiz-path-preview-val">{computedPath}</span>
                </div>
              )}
            </div>

            <div className="wiz-field">
              <label className="wiz-label">{t('wizard.description')} <span className="wiz-opt">{t('wizard.descriptionOptional')}</span></label>
              <textarea
                className="wiz-textarea"
                rows={2}
                placeholder={t('wizard.descriptionPlaceholder')}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <div className="wiz-field">
              <label className="wiz-label">{t('wizard.permissionMode')}</label>
              <select
                className="wiz-select"
                value={permission}
                onChange={(e) => setPermission(e.target.value)}
              >
                {PERMISSION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{t(o.key)}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* ── Step 2: 放入资产 ── */}
        {step === 2 && (
          <div className="wiz-step-content">
            <div className="wiz-step2-icon">📁</div>
            <div className="wiz-step2-title">{t('wizard.assetsTitle')}</div>
            <div className="wiz-step2-desc">
              {t('wizard.assetsDesc')}
            </div>
            {computedPath && (
              <div className="wiz-step2-path">{computedPath}</div>
            )}
            <button className="wiz-btn-open-folder" onClick={handleOpenFolder} disabled={!computedPath}>
              {t('wizard.openFolder')}
            </button>
            <div className="wiz-step2-hint">
              {t('wizard.skipHint')}
            </div>
          </div>
        )}

        {/* ── Step 3: 制定计划 ── */}
        {step === 3 && (
          <div className="wiz-step-content">
            <div className="wiz-field">
              <label className="wiz-label">
                {t('wizard.goalLabel')} <span className="wiz-req">*</span>
                <span className="wiz-label-hint">{t('wizard.goalHint')}</span>
              </label>
              <textarea
                className="wiz-textarea wiz-textarea-lg"
                rows={7}
                placeholder={t('wizard.goalPlaceholder')}
                value={planPrompt}
                onChange={(e) => setPlanPrompt(e.target.value)}
                autoFocus
              />
            </div>
            <div className="wiz-step3-hint">
              {t('wizard.permissionInfo', { mode: permission })}
            </div>
          </div>
        )}

      </div>

      {error && <div className="wiz-error">{error}</div>}

      {/* 底部按钮 */}
      <div className="wiz-footer">
        {step > 1 && (
          <button
            className="wiz-btn-back"
            onClick={() => setStep((s) => (s - 1) as WizardStep)}
            disabled={submitting}
          >
            {t('wizard.prevStep')}
          </button>
        )}
        <div style={{ flex: 1 }} />
        {step < 3 ? (
          <button
            className="wiz-btn-next"
            onClick={() => setStep((s) => (s + 1) as WizardStep)}
            disabled={step === 1 ? !canProceedStep1 : !canProceedStep2}
          >
            {t('wizard.nextStep')}
          </button>
        ) : (
          <button
            className="wiz-btn-start"
            onClick={handleStart}
            disabled={submitting || !planPrompt.trim()}
          >
            {submitting ? t('wizard.starting') : t('wizard.start')}
          </button>
        )}
      </div>
    </div>
  )
}

export default CreateProjectWizard
