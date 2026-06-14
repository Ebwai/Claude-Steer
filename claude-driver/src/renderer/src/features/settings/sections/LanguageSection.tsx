// 使用方法：<LanguageSection language={str} uiLanguage={str} onChange={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局设置语言分区——Claude 回复语言 + 仪表盘界面语言

import type { FC } from 'react'
import { useT } from '../../../i18n'
import { SUPPORTED_LANGUAGES } from '../../../i18n/types'

const CLAUDE_LANGUAGES = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en',    label: 'English' },
  { id: 'ja',    label: '日本語' },
  { id: 'ko',    label: '한국어' },
  { id: 'fr',    label: 'Français' },
  { id: 'de',    label: 'Deutsch' },
]

interface Props {
  language: string
  onChange: (scope: 'claude' | 'driver', key: string, value: unknown) => void
}

const LanguageSection: FC<Props> = ({ language, onChange }) => {
  const { t, language: uiLang, setLanguage } = useT()

  return (
    <>
      <div className="gsm-field">
        <label className="gsm-label">{t('settings.language.claudeReply')}</label>
        <select
          className="gsm-select"
          value={language}
          onChange={(e) => onChange('claude', 'language', e.target.value)}
          style={{ width: 200 }}
        >
          {CLAUDE_LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
      </div>

      {/* 仪表盘 UI 语言——即时生效，无需保存 */}
      <div className="gsm-field">
        <label className="gsm-label">{t('settings.language.dashboardUI')}</label>
        <select
          className="gsm-select"
          value={uiLang}
          onChange={(e) => setLanguage(e.target.value as typeof uiLang)}
          style={{ width: 200 }}
        >
          {SUPPORTED_LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
        <div className="gsm-hint" style={{ fontSize: 'var(--text-xs)', color: 'var(--tx2)', marginTop: 4 }}>
          {t('settings.language.instantApply')}
        </div>
      </div>
    </>
  )
}

export default LanguageSection
