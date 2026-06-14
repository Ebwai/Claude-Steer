// 使用方法：<NotificationSection driverConfig={...} onChange={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局设置通知分区（读写 driverConfig）

import type { FC } from 'react'
import type { DriverConfig } from '@shared/types/index'
import { useT } from '../../../i18n'

interface Props {
  driverConfig: DriverConfig
  onChange: (scope: 'claude' | 'driver', key: string, value: unknown) => void
}

const NotificationSection: FC<Props> = ({ driverConfig, onChange }) => {
  const { t } = useT()
  return (
    <div className="gsm-field">
      <div className="gsm-toggle-row">
        <div>
          <div className="gsm-toggle-label">{t('settings.notificationSection.desktop')}</div>
          <div className="gsm-toggle-sub">{t('settings.notificationSection.desktopSub')}</div>
        </div>
        <label className="gsm-toggle">
          <input
            type="checkbox"
            checked={driverConfig.desktopNotificationsEnabled}
            onChange={(e) => onChange('driver', 'desktopNotificationsEnabled', e.target.checked)}
          />
          <span className="gsm-toggle-track" />
        </label>
      </div>
    </div>
  )
}

export default NotificationSection
