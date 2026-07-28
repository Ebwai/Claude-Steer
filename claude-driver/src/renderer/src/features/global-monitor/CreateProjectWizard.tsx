// 使用方法：由 GlobalMonitorPage.tsx 在 wizardOpen===true 时渲染，替代 RightPanel
// 编译说明：renderer 进程 browser bundle
// 代码说明：新建项目三步向导——Step1 准备目录 / Step2 放入资产 / Step3 初始化项目并可选启动首个 Session

import React, { useState, useCallback } from 'react'
import { useStore } from 'jotai'
import { IPC } from '@shared/events/ipc-channels'
import type { Project } from '@shared/types/index'
import { projectsAtom } from '../../atoms/projects.atom'
import Modal from '../../components/Modal/Modal'
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
  onComplete: (projectId: string) => void
}

type FinishMode = 'start-now' | 'skip'

// ── 组件 ──────────────────────────────────────────────────────────────────────

function CreateProjectWizard({ onClose, onComplete }: CreateProjectWizardProps): React.JSX.Element {
  const store = useStore()

  const [step, setStep] = useState<WizardStep>(1)
  const [projectName, setProjectName] = useState('')
  /** 父目录（存储位置），由“浏览”按钮选择或手动填写 */
  const [parentDir, setParentDir] = useState('')
  const [description, setDescription] = useState('')
  const [permission, setPermission] = useState<string>('acceptEdits')
  const [planPrompt, setPlanPrompt] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [existingDirConfirmOpen, setExistingDirConfirmOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  const handleBrowsePath = useCallback(async () => {
    const dir = await window.api.invoke(IPC.DIALOG_OPEN_DIR) as string | null
    if (dir) setParentDir(dir)
  }, [])

  const handleOpenFolder = useCallback(() => {
    if (!computedPath) return
    window.api.invoke(IPC.SHELL_OPEN_PATH, computedPath).catch((err: unknown) => {
      console.error(`[CreateWizard] open folder failed: path=${computedPath}`, err)
      setError(String(err))
    })
  }, [computedPath])

  const canProceedStep1 = projectName.trim() !== '' && parentDir.trim() !== ''
  const canProceedStep2 = true

  const handleNextFromStep1 = useCallback(async () => {
    if (!computedPath || !canProceedStep1) {
      setError(t('wizard.errorPathIncomplete'))
      return
    }

    setPreparing(true)
    setError(null)
    console.log(`[CreateWizard] Step 1 prepare directory: ${computedPath}`)

    try {
      const result = await window.api.invoke(IPC.PROJECT_PREPARE_DIR, {
        path: computedPath,
      }) as { ok: boolean; status?: 'created' | 'exists'; error?: string }

      if (!result.ok || !result.status) {
        throw new Error(result.error ?? t('wizard.errorPrepareFailed'))
      }

      console.log(`[CreateWizard] Step 1 directory result: ${result.status} path=${computedPath}`)
      if (result.status === 'exists') {
        setExistingDirConfirmOpen(true)
      } else {
        setStep(2)
      }
    } catch (err) {
      console.error(`[CreateWizard] Step 1 directory prepare failed: path=${computedPath}`, err)
      setError(String(err))
    } finally {
      setPreparing(false)
    }
  }, [canProceedStep1, computedPath, t])

  const handleExistingDirContinue = useCallback(() => {
    console.warn(`[CreateWizard] User confirmed existing directory overwrite scope: ${computedPath}`)
    setExistingDirConfirmOpen(false)
    setStep(2)
  }, [computedPath])

  const createProject = useCallback(async (): Promise<Project> => {
    if (!computedPath) {
      throw new Error(t('wizard.errorPathIncomplete'))
    }

    console.log(`[CreateWizard] Finalizing project: ${computedPath}`)
    const createResult = await window.api.invoke(IPC.PROJECT_CREATE, {
      name: projectName.trim(),
      path: computedPath,
      description: description.trim(),
    }) as { ok: boolean; project?: Project; error?: string }

    if (!createResult.ok || !createResult.project) {
      throw new Error(createResult.error ?? t('wizard.errorCreateFailed'))
    }

    const allProjects = await window.api.invoke(IPC.PROJECT_LIST) as Project[]
    store.set(projectsAtom, new Map(allProjects.map((project) => [project.id, project])))
    return createResult.project
  }, [computedPath, description, projectName, store, t])

  const handleFinish = useCallback(async (mode: FinishMode) => {
    if (mode === 'start-now' && !planPrompt.trim()) {
      setError(t('wizard.errorNoGoal'))
      return
    }

    setSubmitting(true)
    setError(null)
    console.log(`[CreateWizard] Step 3 finish mode=${mode} path=${computedPath}`)

    try {
      const project = await createProject()

      if (mode === 'start-now') {
        try {
          const startResult = await window.api.invoke(IPC.SESSION_START, {
            projectId: project.id,
            projectPath: project.path,
            permissionMode: permission,
          }) as { ok: boolean; sessionId?: string; error?: string }

          if (!startResult.ok || !startResult.sessionId) {
            console.warn('[CreateWizard] SESSION_START failed; project will still open:', startResult.error)
          } else {
            await new Promise((resolve) => setTimeout(resolve, 300))
            const wrappedInstruction = t('wizard.instruction', { goal: planPrompt.trim() })
            const inputResult = await window.api.invoke(IPC.SESSION_INPUT, {
              sessionId: startResult.sessionId,
              text: wrappedInstruction,
            }) as { ok: boolean; error?: string }
            if (!inputResult.ok) {
              console.warn('[CreateWizard] SESSION_INPUT failed; project will still open:', inputResult.error)
            }
          }
        } catch (sessionError) {
          console.warn('[CreateWizard] Session initialization failed; project will still open:', sessionError)
        }
      }

      console.log(`[CreateWizard] Project complete; navigating: projectId=${project.id} mode=${mode}`)
      onComplete(project.id)
    } catch (err) {
      console.error(`[CreateWizard] Project finalization failed: path=${computedPath} mode=${mode}`, err)
      setError(String(err))
      setSubmitting(false)
    }
  }, [computedPath, createProject, onComplete, permission, planPrompt, t])

  const StepNav = (): React.JSX.Element => (
    <div className="wiz-stepnav">
      {([1, 2, 3] as WizardStep[]).map((currentStep) => (
        <React.Fragment key={currentStep}>
          <div
            className={`wiz-step-dot ${step === currentStep ? 'wiz-step-active' : step > currentStep ? 'wiz-step-done' : 'wiz-step-todo'}`}
          >
            {step > currentStep ? '✓' : currentStep}
          </div>
          <div className="wiz-step-label">{STEP_LABELS[currentStep]}</div>
          {currentStep < 3 && <div className="wiz-step-line" />}
        </React.Fragment>
      ))}
    </div>
  )

  return (
    <>
      <div className="wiz-panel">
        <div className="wiz-header">
          <div className="wiz-title">
            <span className="wiz-title-icon">◈</span>
            {t('wizard.title')}
          </div>
          <button className="wiz-close" onClick={onClose}>✕</button>
        </div>

        <StepNav />

        <div className="wiz-body">
          {step === 1 && (
            <div className="wiz-step-content">
              <div className="wiz-field">
                <label className="wiz-label">{t('wizard.projectName')} <span className="wiz-req">*</span></label>
                <input
                  className="wiz-input"
                  type="text"
                  placeholder={t('wizard.projectNamePlaceholder')}
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
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
                    onChange={(event) => setParentDir(event.target.value)}
                  />
                  <button className="wiz-btn-browse" onClick={handleBrowsePath}>
                    {t('wizard.browse')}
                  </button>
                </div>
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
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>

              <div className="wiz-field">
                <label className="wiz-label">{t('wizard.permissionMode')}</label>
                <select
                  className="wiz-select"
                  value={permission}
                  onChange={(event) => setPermission(event.target.value)}
                >
                  {PERMISSION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{t(option.key)}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="wiz-step-content">
              <div className="wiz-step2-icon">📁</div>
              <div className="wiz-step2-title">{t('wizard.assetsTitle')}</div>
              <div className="wiz-step2-desc">{t('wizard.assetsDesc')}</div>
              {computedPath && <div className="wiz-step2-path">{computedPath}</div>}
              <button className="wiz-btn-open-folder" onClick={handleOpenFolder} disabled={!computedPath}>
                {t('wizard.openFolder')}
              </button>
              <div className="wiz-step2-hint">{t('wizard.skipHint')}</div>
            </div>
          )}

          {step === 3 && (
            <div className="wiz-step-content">
              <div className="wiz-field">
                <label className="wiz-label">
                  {t('wizard.goalLabel')} <span className="wiz-label-hint">{t('wizard.goalHint')}</span>
                </label>
                <textarea
                  className="wiz-textarea wiz-textarea-lg"
                  rows={7}
                  placeholder={t('wizard.goalPlaceholder')}
                  value={planPrompt}
                  onChange={(event) => setPlanPrompt(event.target.value)}
                  autoFocus
                />
              </div>
              <div className="wiz-step3-hint">{t('wizard.permissionInfo', { mode: permission })}</div>
            </div>
          )}
        </div>

        {error && <div className="wiz-error">{error}</div>}

        <div className="wiz-footer">
          {step > 1 && (
            <button
              className="wiz-btn-back"
              onClick={() => setStep((current) => (current - 1) as WizardStep)}
              disabled={submitting}
            >
              {t('wizard.prevStep')}
            </button>
          )}
          <div style={{ flex: 1 }} />
          {step < 3 ? (
            <button
              className="wiz-btn-next"
              onClick={step === 1 ? () => void handleNextFromStep1() : () => setStep(3)}
              disabled={preparing || (step === 1 ? !canProceedStep1 : !canProceedStep2)}
            >
              {preparing ? t('wizard.preparing') : t('wizard.nextStep')}
            </button>
          ) : (
            <>
              <button
                className="wiz-btn-skip"
                title={t('wizard.skipGoalTooltip')}
                onClick={() => void handleFinish('skip')}
                disabled={submitting}
              >
                {t('wizard.skipGoal')}
              </button>
              <button
                className="wiz-btn-start"
                title={t('wizard.startNowTooltip')}
                onClick={() => void handleFinish('start-now')}
                disabled={submitting || !planPrompt.trim()}
              >
                {submitting ? t('wizard.starting') : t('wizard.startNow')}
              </button>
            </>
          )}
        </div>
      </div>

      <Modal
        open={existingDirConfirmOpen}
        onClose={() => setExistingDirConfirmOpen(false)}
        title={t('wizard.existingDirTitle')}
        width={520}
      >
        <div className="wiz-existing-dir-warning">
          <p>{t('wizard.existingDirWarning')}</p>
          <p>{t('wizard.existingDirScope')}</p>
          <code>{computedPath}</code>
          <div className="wiz-existing-dir-actions">
            <button className="wiz-btn-back" onClick={() => setExistingDirConfirmOpen(false)}>
              {t('wizard.existingDirCancel')}
            </button>
            <button className="wiz-btn-start" onClick={handleExistingDirContinue}>
              {t('wizard.existingDirContinue')}
            </button>
          </div>
        </div>
      </Modal>
    </>
  )
}

export default CreateProjectWizard
