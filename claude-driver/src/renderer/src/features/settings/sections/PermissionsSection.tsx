// 使用方法：<PermissionsSection ... onChange={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局设置权限分区

import type { FC } from 'react'
import { useT } from '../../../i18n'

const PERMISSION_MODE_IDS = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']

interface Props {
  defaultMode: string
  additionalDirectories: string[]
  allowList: string[]
  ignorePatterns: string[]
  onChange: (scope: 'claude' | 'driver', key: string, value: unknown) => void
}

const PermissionsSection: FC<Props> = ({
  defaultMode,
  additionalDirectories,
  allowList,
  ignorePatterns,
  onChange,
}) => {
  const { t } = useT()

  const modeDesc: Record<string, string> = {
    default: t('settings.permissions.modeDefault'),
    acceptEdits: t('settings.permissions.modeAcceptEdits'),
    plan: t('settings.permissions.modePlan'),
    auto: t('settings.permissions.modeAuto'),
    dontAsk: t('settings.permissions.modeDontAsk'),
    bypassPermissions: t('settings.permissions.modeBypass'),
  }
  return (
    <>
      <div className="gsm-field">
        <label className="gsm-label">{t('settings.permissions.defaultMode')}</label>
        {PERMISSION_MODE_IDS.map((id) => (
          <label
            key={id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 0',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name="permissionMode"
              value={id}
              checked={defaultMode === id}
              onChange={() => onChange('claude', 'permissions.defaultMode', id)}
              style={{ accentColor: 'var(--or)' }}
            />
            <span style={{ color: 'var(--tx)', fontSize: 'var(--text-base)' }}>{id}</span>
            <span style={{ color: 'var(--tx2)', fontSize: 'var(--text-sm)' }}>— {modeDesc[id]}</span>
          </label>
        ))}
      </div>

      <div className="gsm-field">
        <label className="gsm-label">
          {t('settings.permissions.allowDirs')}
          <span className="gsm-label-hint">{t('settings.permissions.allowDirsHint')}</span>
        </label>
        <textarea
          className="gsm-input"
          rows={3}
          value={additionalDirectories.join('\n')}
          onChange={(e) =>
            onChange(
              'claude',
              'permissions.additionalDirectories',
              e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)
            )
          }
          style={{ resize: 'vertical', userSelect: 'text' }}
        />
      </div>

      <div className="gsm-field">
        <label className="gsm-label">
          {t('settings.permissions.allowCommands')}
          <span className="gsm-label-hint">{t('settings.permissions.allowCommandsHint')}</span>
        </label>
        <textarea
          className="gsm-input"
          rows={3}
          value={allowList.join('\n')}
          onChange={(e) =>
            onChange(
              'claude',
              'permissions.allow',
              e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)
            )
          }
          style={{ resize: 'vertical', userSelect: 'text' }}
        />
      </div>

      <div className="gsm-field">
        <label className="gsm-label">
          {t('settings.permissions.ignoreFiles')}
          <span className="gsm-label-hint">{t('settings.permissions.ignoreFilesHint')}</span>
        </label>
        <textarea
          className="gsm-input"
          rows={3}
          value={ignorePatterns.join('\n')}
          onChange={(e) =>
            onChange(
              'claude',
              'ignorePatterns',
              e.target.value.split('\n').map((s) => s.trim()).filter(Boolean)
            )
          }
          style={{ resize: 'vertical', userSelect: 'text' }}
        />
      </div>
    </>
  )
}

export default PermissionsSection
