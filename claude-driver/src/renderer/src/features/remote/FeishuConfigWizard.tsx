// 使用方法：<FeishuConfigWizard projectId={id} projectName={name} initialBot={bot} onSave={fn} onCancel={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：飞书机器人 5步配置向导（针对单个项目）
//           Step1 创建应用 → Step2 配置权限 → Step3 长连接订阅 → Step4 填写凭证 → Step5 发布

import React, { useState } from 'react'
import { IPC } from '@shared/events/ipc-channels'
import type { FeishuBotConfig } from '@shared/types/index'
import { useT } from '../../i18n'
import './remote.css'

const TOTAL_STEPS = 5

const PERMISSIONS = [
  { code: 'im:message',                  descKey: 'remote.wizard.permImMessage' },
  { code: 'im:message.group_msg',        descKey: 'remote.wizard.permImGroupMsg' },
  { code: 'im:message.p2p_msg:readonly', descKey: 'remote.wizard.permImP2pMsg' },
  { code: 'im:message.reactions:read',   descKey: 'remote.wizard.permImReactions' },
  { code: 'im:resource',                 descKey: 'remote.wizard.permImResource' },
  { code: 'im:chat',                     descKey: 'remote.wizard.permImChat' },
  { code: 'contact:user.base:readonly',  descKey: 'remote.wizard.permContactUserBase' },
  { code: 'contact:user.id:readonly',    descKey: 'remote.wizard.permContactUserId' },
]

interface Props {
  projectId: string
  projectName: string
  initialBot?: FeishuBotConfig
  onSave: (bot: FeishuBotConfig) => void
  onCancel: () => void
}

export default function FeishuConfigWizard({ projectId, projectName, initialBot, onSave, onCancel }: Props): React.JSX.Element {
  const { t } = useT()
  const [step, setStep] = useState(1)
  const [saving, setSaving] = useState(false)

  // Step4 表单状态
  const [appId,            setAppId]            = useState(initialBot?.appId ?? '')
  const [appSecret,        setAppSecret]        = useState(initialBot?.appSecret ?? '')
  const [adminFrom,        setAdminFrom]        = useState(initialBot?.adminFrom ?? '')
  const [allowFrom,        setAllowFrom]        = useState(initialBot?.allowFrom ?? '*')
  const [enableCard,       setEnableCard]       = useState(initialBot?.enableFeishuCard ?? true)
  const [progressStyle,    setProgressStyle]    = useState<FeishuBotConfig['progressStyle']>(initialBot?.progressStyle ?? 'card')
  const [agentMode,        setAgentMode]        = useState(initialBot?.agentMode ?? 'default')
  const [model,            setModel]            = useState(initialBot?.model ?? '')
  const [provider,         setProvider]         = useState(initialBot?.provider ?? '')

  function canProceed(): boolean {
    if (step !== 4) return true
    return appId.trim().length > 0 && appSecret.trim().length > 0
  }

  async function handleSave(): Promise<void> {
    setSaving(true)
    const bot: FeishuBotConfig = {
      appId: appId.trim(),
      appSecret: appSecret.trim(),
      adminFrom: adminFrom.trim(),
      allowFrom: allowFrom.trim() || '*',
      enableFeishuCard: enableCard,
      progressStyle,
      agentMode,
      model: model.trim(),
      provider: provider.trim(),
    }
    try {
      await window.api.invoke(IPC.CC_CONNECT_CONFIG_SAVE, { projectId, bot })
      console.log(`[FeishuConfigWizard] saved bot config for project ${projectId}`)
      onSave(bot)
    } catch (err) {
      console.error('[FeishuConfigWizard] save failed:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rm-wizard">
      {/* 步骤进度条 */}
      <div className="rm-wizard-steps">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div
            key={i}
            className={`rm-step-dot ${i + 1 < step ? 'done' : i + 1 === step ? 'active' : ''}`}
          />
        ))}
      </div>

      {/* 项目名提示 */}
      <div style={{ fontSize: 12, color: 'var(--tx-3)', marginBottom: -8 }}>
        {t('remote.wizard.configuringProject')}<span style={{ color: 'var(--tx-2)', fontWeight: 600 }}>{projectName}</span>
      </div>

      {/* Step 1 */}
      {step === 1 && (
        <>
          <div className="rm-wizard-title">{t('remote.wizard.step1Title')}</div>
          <div className="rm-wizard-desc">
            <p>{t('remote.wizard.step1Desc')}</p>
            <ol style={{ paddingLeft: 16, lineHeight: 2 }}>
              <li>{t('remote.wizard.step1Li1Prefix')}<a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">{t('remote.wizard.step1FeishuPlatform')}</a>{t('remote.wizard.step1Li1Suffix')}</li>
              <li>{t('remote.wizard.step1Li2')}</li>
              <li>{t('remote.wizard.step1Li3Prefix')}<em>{projectName} Bot</em>{t('remote.wizard.step1Li3Suffix')}</li>
              <li>{t('remote.wizard.step1Li4Prefix')}<strong>App ID</strong>{t('remote.wizard.step1Li4Mid')}<strong>App Secret</strong></li>
              <li>{t('remote.wizard.step1Li5')}</li>
            </ol>
            <p style={{ marginTop: 8, color: 'var(--tx-3)' }}>
              {t('remote.wizard.step1Tip')}
            </p>
          </div>
        </>
      )}

      {/* Step 2 */}
      {step === 2 && (
        <>
          <div className="rm-wizard-title">{t('remote.wizard.step2Title')}</div>
          <div className="rm-wizard-desc">
            <p>{t('remote.wizard.step2Desc')}</p>
          </div>
          <div className="rm-perm-list">
            {PERMISSIONS.map((p) => (
              <div key={p.code} className="rm-perm-item">
                <span className="rm-perm-code">{p.code}</span>
                <span className="rm-perm-desc">{t(p.descKey)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Step 3 */}
      {step === 3 && (
        <>
          <div className="rm-wizard-title">{t('remote.wizard.step3Title')}</div>
          <div className="rm-wizard-desc">
            <p>{t('remote.wizard.step3DescPrefix')}<strong>{t('remote.wizard.step3WebSocket')}</strong>{t('remote.wizard.step3DescSuffix')}</p>
            <ol style={{ paddingLeft: 16, lineHeight: 2 }}>
              <li>{t('remote.wizard.step3Li1Prefix')}<strong>{t('remote.wizard.step3LongConnection')}</strong>{t('remote.wizard.step3Li1Mid')}<strong style={{ color: 'var(--or)' }}>{t('remote.wizard.step3NoWebhook')}</strong>{t('remote.wizard.step3Li1Suffix')}</li>
              <li>{t('remote.wizard.step3Li2Prefix')}<code>im.message.receive_v1</code>{t('remote.wizard.step3Li2Suffix')}</li>
              <li>{t('remote.wizard.step3Li3Prefix')}<code>card.action.trigger</code>{t('remote.wizard.step3Li3Suffix')}</li>
              <li>{t('remote.wizard.step3Li4')}</li>
            </ol>
            <p style={{ marginTop: 8, color: 'var(--tx-3)' }}>
              {t('remote.wizard.step3Tip')}
            </p>
          </div>
        </>
      )}

      {/* Step 4 */}
      {step === 4 && (
        <>
          <div className="rm-wizard-title">{t('remote.wizard.step4Title')}</div>
          <div className="rm-form">
            <div className="rm-field">
              <label className="rm-label">App ID <span className="rm-label-hint">{t('remote.wizard.cliXxxFormat')}</span></label>
              <input
                className="rm-input"
                placeholder="cli_xxxxxxxxxxxxxxxx"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
              />
            </div>
            <div className="rm-field">
              <label className="rm-label">App Secret</label>
              <input
                className="rm-input"
                type="password"
                placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
              />
            </div>
            <div className="rm-field">
              <label className="rm-label">
                {t('remote.wizard.adminOpenId')}
                <span className="rm-label-hint">{t('remote.wizard.optionalOuXxx')}</span>
              </label>
              <input
                className="rm-input"
                placeholder="ou_xxxxxxxxxxxxxxxxxxxxxxxx"
                value={adminFrom}
                onChange={(e) => setAdminFrom(e.target.value)}
              />
              <div style={{ fontSize: 11, color: 'var(--tx-3)', marginTop: 2 }}>
                {t('remote.wizard.adminOpenIdHintPrefix')} <a href="https://open.feishu.cn/document/faq/trouble-shooting/how-to-obtain-openid" target="_blank" rel="noreferrer" style={{ color: 'var(--or)' }}>{t('remote.wizard.adminOpenIdHintLink')}</a>{t('remote.wizard.adminOpenIdHintSuffix')}
              </div>
            </div>
            <div className="rm-field">
              <label className="rm-label">
                {t('remote.wizard.whitelistUsers')}
                <span className="rm-label-hint">{t('remote.wizard.whitelistHint')}</span>
              </label>
              <input
                className="rm-input"
                placeholder={t('remote.wizard.whitelistPlaceholder')}
                value={allowFrom}
                onChange={(e) => setAllowFrom(e.target.value)}
              />
            </div>
            <div className="rm-field">
              <label className="rm-label">
                {t('remote.wizard.agentMode')}
                <span className="rm-label-hint">{t('remote.wizard.agentModeHint')}</span>
              </label>
              <select
                className="rm-select"
                value={agentMode}
                onChange={(e) => setAgentMode(e.target.value)}
              >
                <option value="default">{t('remote.wizard.agentModeDefault')}</option>
                <option value="acceptEdits">{t('remote.wizard.agentModeAcceptEdits')}</option>
                <option value="plan">{t('remote.wizard.agentModePlan')}</option>
                <option value="auto">{t('remote.wizard.agentModeAuto')}</option>
                <option value="bypassPermissions">{t('remote.wizard.agentModeBypass')}</option>
              </select>
            </div>
            <div className="rm-field">
              <label className="rm-label">
                {t('remote.wizard.model')}
                <span className="rm-label-hint">{t('remote.wizard.modelHint')}</span>
              </label>
              <input
                className="rm-input"
                placeholder={t('remote.wizard.modelPlaceholder')}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
            <div className="rm-field">
              <label className="rm-label">
                Provider
                <span className="rm-label-hint">{t('remote.wizard.providerHint')}</span>
              </label>
              <input
                className="rm-input"
                placeholder={t('remote.wizard.providerPlaceholder')}
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              />
            </div>
            <div className="rm-field">
              <label className="rm-label">{t('remote.wizard.progressStyle')}</label>
              <select
                className="rm-select"
                value={progressStyle}
                onChange={(e) => setProgressStyle(e.target.value as FeishuBotConfig['progressStyle'])}
              >
                <option value="card">{t('remote.wizard.progressStyleCard')}</option>
                <option value="compact">{t('remote.wizard.progressStyleCompact')}</option>
                <option value="legacy">{t('remote.wizard.progressStyleLegacy')}</option>
              </select>
            </div>
            <div className="rm-field">
              <label className="rm-label">{t('remote.wizard.enableFeishuCard')}</label>
              <div className="rm-toggle">
                <label className="rm-toggle-switch">
                  <input
                    type="checkbox"
                    checked={enableCard}
                    onChange={(e) => setEnableCard(e.target.checked)}
                  />
                  <div className="rm-toggle-track" />
                  <div className="rm-toggle-thumb" />
                </label>
                <span style={{ fontSize: 12, color: 'var(--tx-2)' }}>
                  {enableCard ? t('remote.wizard.cardEnabled') : t('remote.wizard.cardDisabled')}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Step 5 */}
      {step === 5 && (
        <>
          <div className="rm-wizard-title">{t('remote.wizard.step5Title')}</div>
          <div className="rm-wizard-desc">
            <ol style={{ paddingLeft: 16, lineHeight: 2 }}>
              <li>{t('remote.wizard.step5Li1')}</li>
              <li>{t('remote.wizard.step5Li2')}</li>
              <li>{t('remote.wizard.step5Li3')}</li>
              <li>{t('remote.wizard.step5Li4')}</li>
            </ol>
            <p style={{ marginTop: 8 }}>
              {t('remote.wizard.step5DescPrefix')}<strong>{projectName}</strong>{t('remote.wizard.step5DescSuffix')}
            </p>
          </div>
        </>
      )}

      {/* 导航按钮 */}
      <div className="rm-wizard-nav">
        <button
          className="rm-nav-btn prev"
          onClick={step === 1 ? onCancel : () => setStep((s) => s - 1)}
        >
          {step === 1 ? t('remote.wizard.cancel') : t('remote.wizard.previous')}
        </button>
        <span className="rm-step-indicator">{step} / {TOTAL_STEPS}</span>
        {step < TOTAL_STEPS ? (
          <button
            className="rm-nav-btn next"
            onClick={() => setStep((s) => s + 1)}
            disabled={!canProceed()}
          >
            {t('remote.wizard.next')}
          </button>
        ) : (
          <button
            className="rm-nav-btn save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? t('remote.wizard.saving') : t('remote.wizard.save')}
          </button>
        )}
      </div>
    </div>
  )
}
