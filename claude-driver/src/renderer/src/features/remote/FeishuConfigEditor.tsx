// 使用方法：<FeishuConfigEditor projectId={id} projectName={name} bot={bot} onSave={fn} onCancel={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：已配置项目的飞书机器人精细化编辑表单（非向导）

import React, { useState } from 'react'
import { IPC } from '@shared/events/ipc-channels'
import type { FeishuBotConfig } from '@shared/types/index'
import { useT } from '../../i18n'
import './remote.css'

interface Props {
  projectId: string
  projectName: string
  bot: FeishuBotConfig
  onSave: (bot: FeishuBotConfig) => void
  onCancel: () => void
}

export default function FeishuConfigEditor({ projectId, projectName, bot, onSave, onCancel }: Props): React.JSX.Element {
  const { t } = useT()
  const [appId,         setAppId]         = useState(bot.appId)
  const [appSecret,     setAppSecret]     = useState(bot.appSecret)
  const [adminFrom,     setAdminFrom]     = useState(bot.adminFrom ?? '')
  const [allowFrom,     setAllowFrom]     = useState(bot.allowFrom ?? '*')
  const [enableCard,    setEnableCard]    = useState(bot.enableFeishuCard ?? true)
  const [progressStyle, setProgressStyle] = useState<FeishuBotConfig['progressStyle']>(bot.progressStyle ?? 'card')
  const [agentMode,     setAgentMode]     = useState(bot.agentMode ?? 'default')
  const [model,         setModel]         = useState(bot.model ?? '')
  const [provider,      setProvider]      = useState(bot.provider ?? '')
  const [saving,        setSaving]        = useState(false)

  const canSave = appId.trim().length > 0 && appSecret.trim().length > 0

  async function handleSave(): Promise<void> {
    if (!canSave) return
    setSaving(true)
    const updated: FeishuBotConfig = {
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
      await window.api.invoke(IPC.CC_CONNECT_CONFIG_SAVE, { projectId, bot: updated })
      console.log(`[FeishuConfigEditor] saved bot config for project ${projectId}`)
      onSave(updated)
    } catch (err) {
      console.error('[FeishuConfigEditor] save failed:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rm-wizard">
      <div className="rm-wizard-title">{t('remote.editor.title')}</div>
      <div style={{ fontSize: 12, color: 'var(--tx-3)', marginTop: -8, marginBottom: -4 }}>
        {t('remote.editor.projectLabel')}<span style={{ color: 'var(--tx-2)', fontWeight: 600 }}>{projectName}</span>
      </div>

      <div className="rm-form">
        <div className="rm-field">
          <label className="rm-label">App ID <span className="rm-label-hint">{t('remote.editor.cliXxxFormat')}</span></label>
          <input className="rm-input" placeholder="cli_xxxxxxxxxxxxxxxx" value={appId} onChange={(e) => setAppId(e.target.value)} />
        </div>
        <div className="rm-field">
          <label className="rm-label">App Secret</label>
          <input className="rm-input" type="password" placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} />
        </div>
        <div className="rm-field">
          <label className="rm-label">
            {t('remote.editor.adminOpenId')}
            <span className="rm-label-hint">{t('remote.editor.optionalOuXxx')}</span>
          </label>
          <input className="rm-input" placeholder="ou_xxxxxxxxxxxxxxxxxxxxxxxx" value={adminFrom} onChange={(e) => setAdminFrom(e.target.value)} />
          <div style={{ fontSize: 11, color: 'var(--tx-3)', marginTop: 2 }}>
            {t('remote.editor.adminOpenIdHintPrefix')} <a href="https://open.feishu.cn/document/faq/trouble-shooting/how-to-obtain-openid" target="_blank" rel="noreferrer" style={{ color: 'var(--or)' }}>{t('remote.editor.adminOpenIdHintLink')}</a>
          </div>
        </div>
        <div className="rm-field">
          <label className="rm-label">
            {t('remote.editor.whitelistUsers')}
            <span className="rm-label-hint">{t('remote.editor.whitelistHint')}</span>
          </label>
          <input className="rm-input" placeholder={t('remote.editor.whitelistPlaceholder')} value={allowFrom} onChange={(e) => setAllowFrom(e.target.value)} />
        </div>
        <div className="rm-field">
          <label className="rm-label">
            {t('remote.editor.agentMode')}
            <span className="rm-label-hint">{t('remote.editor.agentModeHint')}</span>
          </label>
          <select className="rm-select" value={agentMode} onChange={(e) => setAgentMode(e.target.value)}>
            <option value="default">{t('remote.editor.agentModeDefault')}</option>
            <option value="acceptEdits">{t('remote.editor.agentModeAcceptEdits')}</option>
            <option value="plan">{t('remote.editor.agentModePlan')}</option>
            <option value="auto">{t('remote.editor.agentModeAuto')}</option>
            <option value="bypassPermissions">{t('remote.editor.agentModeBypass')}</option>
          </select>
        </div>
        <div className="rm-field">
          <label className="rm-label">
            {t('remote.editor.model')}
            <span className="rm-label-hint">{t('remote.editor.modelHint')}</span>
          </label>
          <input className="rm-input" placeholder={t('remote.editor.modelPlaceholder')} value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        <div className="rm-field">
          <label className="rm-label">
            Provider
            <span className="rm-label-hint">{t('remote.editor.providerHint')}</span>
          </label>
          <input className="rm-input" placeholder={t('remote.editor.providerPlaceholder')} value={provider} onChange={(e) => setProvider(e.target.value)} />
        </div>
        <div className="rm-field">
          <label className="rm-label">{t('remote.editor.progressStyle')}</label>
          <select className="rm-select" value={progressStyle} onChange={(e) => setProgressStyle(e.target.value as FeishuBotConfig['progressStyle'])}>
            <option value="card">{t('remote.editor.progressStyleCard')}</option>
            <option value="compact">{t('remote.editor.progressStyleCompact')}</option>
            <option value="legacy">{t('remote.editor.progressStyleLegacy')}</option>
          </select>
        </div>
        <div className="rm-field">
          <label className="rm-label">{t('remote.editor.enableFeishuCard')}</label>
          <div className="rm-toggle">
            <label className="rm-toggle-switch">
              <input type="checkbox" checked={enableCard} onChange={(e) => setEnableCard(e.target.checked)} />
              <div className="rm-toggle-track" />
              <div className="rm-toggle-thumb" />
            </label>
            <span style={{ fontSize: 12, color: 'var(--tx-2)' }}>
              {enableCard ? t('remote.editor.cardEnabled') : t('remote.editor.cardDisabled')}
            </span>
          </div>
        </div>
      </div>

      <div className="rm-wizard-nav">
        <button className="rm-nav-btn prev" onClick={onCancel}>{t('remote.editor.cancel')}</button>
        <span className="rm-step-indicator" />
        <button className="rm-nav-btn save" onClick={handleSave} disabled={!canSave || saving}>
          {saving ? t('remote.editor.saving') : t('remote.editor.save')}
        </button>
      </div>
    </div>
  )
}
