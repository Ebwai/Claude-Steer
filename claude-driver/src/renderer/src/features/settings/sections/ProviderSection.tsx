// 使用方法：<ProviderSection providerId={id} ... onChange={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局设置 Provider 切换分区——供应商选择 + API Key + 模型映射 + 连通性测试

import { useState, type FC } from 'react'
import { IPC } from '@shared/events/ipc-channels'
import { PROVIDER_PRESETS, PROVIDER_PRESET_LIST } from '@shared/constants/providers'
import type { ProviderId } from '@shared/types/index'
import { useT } from '../../../i18n'

interface Props {
  providerId: ProviderId
  apiKey: string
  providerBaseUrl: string
  providerModel: string
  providerLightModel: string
  providerBalancedModel: string
  providerPowerfulModel: string
  providerReasoningModel: string
  providerApiTimeoutMs: number
  providerDisableNonEssential: boolean
  onChange: (scope: 'claude' | 'driver', key: string, value: unknown) => void
}

const ProviderSection: FC<Props> = ({
  providerId, apiKey, providerBaseUrl, providerModel, providerLightModel, providerBalancedModel,
  providerPowerfulModel, providerReasoningModel, providerApiTimeoutMs, providerDisableNonEssential, onChange,
}) => {
  const { t } = useT()
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const preset = PROVIDER_PRESETS[providerId]
  const isCustom = providerId === 'custom'
  const isAnthropic = providerId === 'anthropic'

  // 切换 preset 时自动填充所有字段
  const handlePresetChange = (newId: ProviderId): void => {
    const p = PROVIDER_PRESETS[newId]
    onChange('claude', 'providerId', newId)
    if (p.baseUrl) onChange('claude', 'providerBaseUrl', p.baseUrl)
    onChange('claude', 'providerModel', p.defaultModel)
    onChange('claude', 'providerLightModel', p.defaultLightModel)
    onChange('claude', 'providerBalancedModel', p.defaultBalancedModel)
    onChange('claude', 'providerPowerfulModel', p.defaultPowerfulModel)
    onChange('claude', 'providerReasoningModel', p.reasoningModel)
    // 切换到 Anthropic 时清空 baseUrl；非 Anthropic 时用 preset 的 baseUrl
    if (newId === 'anthropic') {
      onChange('claude', 'providerBaseUrl', '')
    }
  }

  // 连通性测试：向 provider endpoint 发测试请求
  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    const testUrl = isAnthropic ? 'https://api.anthropic.com' : (providerBaseUrl || preset.baseUrl)
    const testModel = providerModel || preset.defaultModel
    console.log(`[ProviderSection] Testing: ${testUrl} model=${testModel}`)
    try {
      const result = await window.api.invoke(IPC.API_TEST_PROVIDER, {
        baseUrl: testUrl,
        apiKey,
        model: testModel,
      }) as { ok: boolean; error?: string }
      if (result.ok) {
        setTestResult({ ok: true, msg: t('settings.provider.connectivityOk') })
      } else {
        setTestResult({ ok: false, msg: result.error ?? t('settings.provider.unknownError') })
      }
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      {/* Provider 下拉选择 */}
      <div className="gsm-field">
        <label className="gsm-label">{t('settings.provider.apiProvider')}</label>
        <select
          className="gsm-select"
          value={providerId}
          onChange={(e) => handlePresetChange(e.target.value as ProviderId)}
          style={{ width: 280 }}
        >
          {PROVIDER_PRESET_LIST.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </div>

      {/* API Key 输入 */}
      <div className="gsm-field">
        <label className="gsm-label">
          {isAnthropic ? 'API Key' : 'Auth Token / API Key'}
        </label>
        <div className="gsm-input-row">
          <input
            className="gsm-input"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            placeholder={isAnthropic ? 'sk-ant-...' : 'sk-...'}
            onChange={(e) => onChange('claude', 'apiKey', e.target.value)}
          />
          <button className="gsm-btn" onClick={() => setShowKey((v) => !v)}>
            {showKey ? t('settings.provider.hide') : t('settings.provider.show')}
          </button>
          <button
            className="gsm-btn"
            onClick={handleTest}
            disabled={testing || !apiKey}
          >
            {testing ? t('settings.provider.testing') : t('settings.provider.testConnectivity')}
          </button>
        </div>
        {testResult && (
          <span className={`gsm-status gsm-status--${testResult.ok ? 'ok' : 'err'}`}>
            {testResult.msg}
          </span>
        )}
      </div>

      {/* Base URL */}
      <div className="gsm-field">
        <label className="gsm-label">
          API Base URL
          {!isCustom && <span className="gsm-label-hint">{t('settings.provider.autoFillHint')}</span>}
        </label>
        <input
          className="gsm-input"
          type="text"
          value={providerBaseUrl || preset.baseUrl}
          placeholder={isAnthropic ? t('settings.provider.defaultApiPlaceholder') : 'https://api.example.com/anthropic'}
          readOnly={!isCustom}
          onChange={(e) => onChange('claude', 'providerBaseUrl', e.target.value)}
        />
        {isAnthropic && (
          <span className="gsm-label-hint" style={{ display: 'block', marginTop: 4 }}>
            {t('settings.provider.noBaseUrlHint')}
          </span>
        )}
      </div>

      {/* 模型选择 */}
      <div className="gsm-field">
        <label className="gsm-label">{t('settings.provider.defaultModel')}</label>
        {isCustom ? (
          <input
            className="gsm-input"
            type="text"
            value={providerModel}
            placeholder={t('settings.provider.modelIdPlaceholder')}
            onChange={(e) => onChange('claude', 'providerModel', e.target.value)}
          />
        ) : (
          <input
            className="gsm-input"
            type="text"
            value={providerModel}
            placeholder={preset.defaultModel}
            onChange={(e) => onChange('claude', 'providerModel', e.target.value)}
          />
        )}
      </div>

      {/* 模型映射：轻量 / 均衡 / 强力 */}
      <div className="gsm-field">
        <label className="gsm-label">{t('settings.provider.modelMapping')}</label>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div className="gsm-field" style={{ flex: 1 }}>
          <label className="gsm-label">
            {t('settings.provider.lightweight')}
            <span className="gsm-label-hint">{t('settings.provider.haikuAlt')}</span>
          </label>
          <input
            className="gsm-input"
            type="text"
            value={providerLightModel}
            placeholder={preset.defaultLightModel}
            onChange={(e) => onChange('claude', 'providerLightModel', e.target.value)}
          />
        </div>
        <div className="gsm-field" style={{ flex: 1 }}>
          <label className="gsm-label">
            {t('settings.provider.balanced')}
            <span className="gsm-label-hint">{t('settings.provider.sonnetAlt')}</span>
          </label>
          <input
            className="gsm-input"
            type="text"
            value={providerBalancedModel}
            placeholder={preset.defaultBalancedModel}
            onChange={(e) => onChange('claude', 'providerBalancedModel', e.target.value)}
          />
        </div>
        <div className="gsm-field" style={{ flex: 1 }}>
          <label className="gsm-label">
            {t('settings.provider.powerful')}
            <span className="gsm-label-hint">{t('settings.provider.opusAlt')}</span>
          </label>
          <input
            className="gsm-input"
            type="text"
            value={providerPowerfulModel}
            placeholder={preset.defaultPowerfulModel}
            onChange={(e) => onChange('claude', 'providerPowerfulModel', e.target.value)}
          />
        </div>
      </div>

      {/* 推理模型（仅非 Anthropic 且 preset 支持 reasoning 时显示） */}
      {preset.reasoningModel !== undefined && (
        <div className="gsm-field">
          <label className="gsm-label">
            {t('settings.provider.reasoningModel')}
            <span className="gsm-label-hint">{t('settings.provider.reasoningHint')}</span>
          </label>
          <input
            className="gsm-input"
            type="text"
            value={providerReasoningModel}
            placeholder={preset.reasoningModel}
            onChange={(e) => onChange('claude', 'providerReasoningModel', e.target.value)}
          />
        </div>
      )}

      {/* API 超时 */}
      <div className="gsm-field">
        <label className="gsm-label">{t('settings.provider.apiTimeout')}</label>
        <div className="gsm-number-row">
          <input
            className="gsm-input"
            type="number"
            min={10000}
            max={600000}
            step={10000}
            value={providerApiTimeoutMs}
            onChange={(e) => onChange('claude', 'providerApiTimeoutMs', parseInt(e.target.value) || 60000)}
          />
          <span className="gsm-number-unit">{t('settings.provider.msRecommend')}</span>
        </div>
      </div>

      {/* 禁用非必要流量 */}
      <div className="gsm-field">
        <div className="gsm-toggle-row">
          <div>
            <div className="gsm-toggle-label">{t('settings.provider.disableNonEssential')}</div>
            <div className="gsm-toggle-sub">{t('settings.provider.disableNonEssentialSub')}</div>
          </div>
          <label className="gsm-toggle">
            <input
              type="checkbox"
              checked={providerDisableNonEssential}
              onChange={(e) => onChange('claude', 'providerDisableNonEssential', e.target.checked)}
            />
            <span className="gsm-toggle-track" />
          </label>
        </div>
      </div>

      {/* 提示 */}
      <div className="gsm-warn">
        {isAnthropic
          ? t('settings.provider.anthropicWarning')
          : t('settings.provider.thirdPartyWarning', { label: preset.label })}
      </div>
    </>
  )
}

export default ProviderSection
