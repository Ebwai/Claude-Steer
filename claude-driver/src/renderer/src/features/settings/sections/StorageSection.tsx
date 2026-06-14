// 使用方法：<StorageSection claudeSettings={...} driverConfig={...} onChange={fn} onCheckUpdate={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局设置存储分区——检查更新委托给父组件触发

import type { FC } from 'react'
import type { DriverConfig } from '@shared/types/index'
import { useT } from '../../../i18n'

interface Props {
  cleanupPeriodDays: number
  driverConfig: DriverConfig
  onChange: (scope: 'claude' | 'driver', key: string, value: unknown) => void
  onCheckUpdate: () => void
}

const StorageSection: FC<Props> = ({ cleanupPeriodDays, onChange, onCheckUpdate }) => {
  const { t } = useT()
  const handleCheckUpdate = (): void => {
    console.log('[StorageSection] Triggering update check...')
    onCheckUpdate()
  }

  return (
    <>
      <div className="gsm-field">
        <label className="gsm-label">{t('settings.storage.cleanupDays')}</label>
        <div className="gsm-number-row">
          <input
            className="gsm-input"
            type="number"
            min={1}
            max={365}
            step={1}
            value={cleanupPeriodDays}
            onChange={(e) => onChange('claude', 'cleanupPeriodDays', parseInt(e.target.value) || 30)}
          />
          <span className="gsm-number-unit">{t('settings.storage.days')}</span>
        </div>
      </div>

      <div className="gsm-field">
        <label className="gsm-label">{t('settings.storage.update')}</label>
        <div>
          <button className="gsm-btn" onClick={handleCheckUpdate}>
            {t('settings.storage.checkUpdate')}
          </button>
        </div>
      </div>
    </>
  )
}

export default StorageSection
