// 使用方法：<MemorySection autoMemoryEnabled={bool} memoryDir={str} onChange={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局设置记忆分区

import type { FC } from 'react'
import { useT } from '../../../i18n'

interface Props {
  autoMemoryEnabled: boolean
  memoryDir: string
  onChange: (scope: 'claude' | 'driver', key: string, value: unknown) => void
}

const MemorySection: FC<Props> = ({ autoMemoryEnabled, memoryDir, onChange }) => {
  const { t } = useT()
  return (
    <>
      <div className="gsm-field">
        <div className="gsm-toggle-row">
          <div>
            <div className="gsm-toggle-label">{t('settings.memory.autoMemory')}</div>
            <div className="gsm-toggle-sub">{t('settings.memory.autoMemorySub')}</div>
          </div>
          <label className="gsm-toggle">
            <input
              type="checkbox"
              checked={autoMemoryEnabled}
              onChange={(e) => onChange('claude', 'autoMemoryEnabled', e.target.checked)}
            />
            <span className="gsm-toggle-track" />
          </label>
        </div>
      </div>

      <div className="gsm-field">
        <label className="gsm-label">
          {t('settings.memory.memoryDir')}
          <span className="gsm-label-hint">{t('settings.memory.memoryDirHint')}</span>
        </label>
        <input
          className="gsm-input"
          type="text"
          value={memoryDir}
          placeholder={t('settings.memory.memoryDirPlaceholder')}
          onChange={(e) => onChange('claude', 'memoryDir', e.target.value)}
        />
      </div>
    </>
  )
}

export default MemorySection
