// 使用方法：<PreferencesSection claudeSettings={...} driverConfig={...} onChange={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局设置偏好分区——主题切换为纯 renderer 操作，不经 IPC

import type { FC } from 'react'
import type { DriverConfig } from '@shared/types/index'
import { useT } from '../../../i18n'

const OUTPUT_STYLE_IDS = ['Explanatory', 'Concise', 'default']

interface ClaudePrefs {
  outputStyle: string
  syntaxHighlightingDisabled: boolean
  showThinkingSummaries: boolean
  spinnerTipsEnabled: boolean
}

interface Props {
  claudePrefs: ClaudePrefs
  driverConfig: DriverConfig
  onChange: (scope: 'claude' | 'driver', key: string, value: unknown) => void
}

const PreferencesSection: FC<Props> = ({ claudePrefs, driverConfig, onChange }) => {
  const { t } = useT()

  const outputStyleLabels: Record<string, string> = {
    Explanatory: t('settings.preferences.outputStyleExplanatory'),
    Concise: t('settings.preferences.outputStyleConcise'),
    default: t('settings.preferences.outputStyleDefault'),
  }

  const handleTheme = (theme: 'dark' | 'light'): void => {
    // 主题切换：直接操作 CSS 变量，不经主进程
    document.documentElement.dataset.theme = theme
    onChange('driver', 'themePreference', theme)
    console.log('[PreferencesSection] theme changed to', theme)
  }

  return (
    <>
      <div className="gsm-field">
        <label className="gsm-label">{t('settings.preferences.theme')}</label>
        <div className="gsm-theme-row">
          <button
            className={`gsm-theme-btn ${driverConfig.themePreference === 'dark' ? 'gsm-theme-btn--active' : ''}`}
            onClick={() => handleTheme('dark')}
          >
            {t('settings.preferences.dark')}
          </button>
          <button
            className={`gsm-theme-btn ${driverConfig.themePreference === 'light' ? 'gsm-theme-btn--active' : ''}`}
            onClick={() => handleTheme('light')}
          >
            {t('settings.preferences.light')}
          </button>
        </div>
      </div>

      <div className="gsm-field">
        <label className="gsm-label">{t('settings.preferences.outputStyle')}</label>
        <select
          className="gsm-select"
          value={claudePrefs.outputStyle}
          onChange={(e) => onChange('claude', 'outputStyle', e.target.value)}
          style={{ width: 240 }}
        >
          {OUTPUT_STYLE_IDS.map((id) => (
            <option key={id} value={id}>{outputStyleLabels[id]}</option>
          ))}
        </select>
        <div className="gsm-warn">{t('settings.preferences.outputStyleWarning')}</div>
      </div>

      <div className="gsm-field">
        <div className="gsm-toggle-row">
          <div>
            <div className="gsm-toggle-label">{t('settings.preferences.syntaxHighlighting')}</div>
            <div className="gsm-toggle-sub">{t('settings.preferences.syntaxHighlightingSub')}</div>
          </div>
          <label className="gsm-toggle">
            {/* 字段是"禁用"，逻辑取反 */}
            <input
              type="checkbox"
              checked={!claudePrefs.syntaxHighlightingDisabled}
              onChange={(e) => onChange('claude', 'syntaxHighlightingDisabled', !e.target.checked)}
            />
            <span className="gsm-toggle-track" />
          </label>
        </div>
      </div>

      <div className="gsm-field">
        <div className="gsm-toggle-row">
          <div>
            <div className="gsm-toggle-label">{t('settings.preferences.showThinking')}</div>
            <div className="gsm-toggle-sub">{t('settings.preferences.showThinkingSub')}</div>
          </div>
          <label className="gsm-toggle">
            <input
              type="checkbox"
              checked={claudePrefs.showThinkingSummaries}
              onChange={(e) => onChange('claude', 'showThinkingSummaries', e.target.checked)}
            />
            <span className="gsm-toggle-track" />
          </label>
        </div>
      </div>

      <div className="gsm-field">
        <div className="gsm-toggle-row">
          <div>
            <div className="gsm-toggle-label">{t('settings.preferences.spinnerTips')}</div>
            <div className="gsm-toggle-sub">{t('settings.preferences.spinnerTipsSub')}</div>
          </div>
          <label className="gsm-toggle">
            <input
              type="checkbox"
              checked={claudePrefs.spinnerTipsEnabled}
              onChange={(e) => onChange('claude', 'spinnerTipsEnabled', e.target.checked)}
            />
            <span className="gsm-toggle-track" />
          </label>
        </div>
      </div>

      <div className="gsm-field">
        <div className="gsm-toggle-row">
          <div>
            <div className="gsm-toggle-label">Claude Code in Chrome</div>
            <div className="gsm-toggle-sub">{t('settings.preferences.chromeSub')}</div>
          </div>
          <label className="gsm-toggle">
            <input type="checkbox" checked={false} disabled onChange={() => {}} />
            <span className="gsm-toggle-track" />
          </label>
        </div>
      </div>
    </>
  )
}

export default PreferencesSection
