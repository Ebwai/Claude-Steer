// 使用方法：<TokenCostSection driverConfig={...} onChange={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局设置 Token 费用分区（读写 driverConfig）

import type { FC } from 'react'
import type { DriverConfig } from '@shared/types/index'
import { useT } from '../../../i18n'

interface Props {
  driverConfig: DriverConfig
  onChange: (scope: 'claude' | 'driver', key: string, value: unknown) => void
}

const TokenCostSection: FC<Props> = ({ driverConfig, onChange }) => {
  const { t } = useT()
  return (
    <>
      <div className="gsm-field">
        <label className="gsm-label">{t('settings.tokenCost.inputPrice')}</label>
        <div className="gsm-number-row">
          <input
            className="gsm-input"
            type="number"
            min={0}
            step={0.1}
            value={driverConfig.tokenPriceInputPerM}
            onChange={(e) => onChange('driver', 'tokenPriceInputPerM', parseFloat(e.target.value) || 0)}
          />
          <span className="gsm-number-unit">{t('settings.tokenCost.perMillion')}</span>
        </div>
      </div>

      <div className="gsm-field">
        <label className="gsm-label">{t('settings.tokenCost.outputPrice')}</label>
        <div className="gsm-number-row">
          <input
            className="gsm-input"
            type="number"
            min={0}
            step={0.1}
            value={driverConfig.tokenPriceOutputPerM}
            onChange={(e) => onChange('driver', 'tokenPriceOutputPerM', parseFloat(e.target.value) || 0)}
          />
          <span className="gsm-number-unit">{t('settings.tokenCost.perMillion')}</span>
        </div>
      </div>

      <div className="gsm-field">
        <label className="gsm-label">{t('settings.tokenCost.monthlyBudget')}</label>
        <div className="gsm-number-row">
          <input
            className="gsm-input"
            type="number"
            min={0}
            step={1}
            value={driverConfig.monthlyBudgetAlertUsd}
            onChange={(e) => onChange('driver', 'monthlyBudgetAlertUsd', parseInt(e.target.value) || 0)}
          />
          <span className="gsm-number-unit">{t('settings.tokenCost.perMonth')}</span>
        </div>
      </div>
    </>
  )
}

export default TokenCostSection
