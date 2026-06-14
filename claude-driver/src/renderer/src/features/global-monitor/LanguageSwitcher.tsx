// 使用方法：<LanguageSwitcher /> 嵌入 GlobalMonitorPage 右上角
// 编译说明：renderer 进程 browser bundle
// 代码说明：语言切换下拉选择器——使用 Jotai useT() hook 驱动
//           样式遵循项目 tokens 设计系统，与 RightPanel 风格一致

import React from 'react'
import { useT } from '../../i18n'
import { SUPPORTED_LANGUAGES } from '../../i18n/types'
import './LanguageSwitcher.css'

function LanguageSwitcher(): React.JSX.Element {
  const { language, setLanguage } = useT()

  return (
    <div className="ls-container">
      <select
        className="ls-select"
        value={language}
        onChange={(e) => setLanguage(e.target.value as typeof language)}
      >
        {SUPPORTED_LANGUAGES.map((l) => (
          <option key={l.id} value={l.id}>{l.label}</option>
        ))}
      </select>
    </div>
  )
}

export default LanguageSwitcher
