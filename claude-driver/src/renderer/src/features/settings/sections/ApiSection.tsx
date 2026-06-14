// 使用方法：<ApiSection claudeSettings={...} onChange={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局设置 API/认证分区——API Key 输入 + 连通性测试

import { useState, type FC } from 'react'
import { IPC } from '@shared/events/ipc-channels'
import { useT } from '../../../i18n'

interface Props {
  apiKey: string
  apiKeyHelper: string
  onChange: (scope: 'claude' | 'driver', key: string, value: unknown) => void
}

const ApiSection: FC<Props> = ({ apiKey, apiKeyHelper, onChange }) => {
  const { t } = useT()
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const handleTest = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    console.log('[ApiSection] Testing API connectivity...')
    try {
      const result = await window.api.invoke(IPC.API_TEST, { apiKey }) as
        | { ok: true; model: string }
        | { ok: false; error: string }
      if (result.ok) {
        setTestResult({ ok: true, msg: `${t('settings.api.connectivityOk')} · ${result.model}` })
      } else {
        setTestResult({ ok: false, msg: result.error })
      }
    } catch (err) {
      setTestResult({ ok: false, msg: String(err) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <div className="gsm-field">
        <label className="gsm-label">API Key</label>
        <div className="gsm-input-row">
          <input
            className="gsm-input"
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            placeholder="sk-ant-..."
            onChange={(e) => onChange('claude', 'apiKey', e.target.value)}
          />
          <button className="gsm-btn" onClick={() => setShowKey((v) => !v)}>
            {showKey ? t('settings.api.hide') : t('settings.api.show')}
          </button>
          <button className="gsm-btn" onClick={handleTest} disabled={testing || !apiKey}>
            {testing ? t('settings.api.testing') : t('settings.api.testConnectivity')}
          </button>
        </div>
        {testResult && (
          <span className={`gsm-status gsm-status--${testResult.ok ? 'ok' : 'err'}`}>
            {testResult.msg}
          </span>
        )}
      </div>

      <div className="gsm-field">
        <label className="gsm-label">
          {t('settings.api.keyCommand')}
          <span className="gsm-label-hint">{t('settings.api.keyCommandHint')}</span>
        </label>
        <input
          className="gsm-input"
          type="text"
          value={apiKeyHelper}
          placeholder={t('settings.api.keyCommandPlaceholder')}
          onChange={(e) => onChange('claude', 'apiKeyHelper', e.target.value)}
        />
      </div>
    </>
  )
}

export default ApiSection
