// 使用方法：<AboutSection appVersion={str} updaterState={...} onCheckUpdate={fn} onDownloadUpdate={fn} onQuitAndInstall={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局设置关于分区——版本展示 + 更新状态机 UI

import { useState, useEffect, type FC } from 'react'
import { IPC } from '@shared/events/ipc-channels'
import { useT } from '../../../i18n'
import alipaymentImg from '../../../assets/alipayment.jpg'
import './AboutSection.css'

export interface UpdaterState {
  status: 'idle' | 'checking' | 'update-available' | 'downloading' | 'downloaded' | 'no-update' | 'error'
  version?: string
  releaseDate?: string
  releaseNotes?: string | null
  percent?: number
  bytesPerSecond?: number
  error?: string
}

interface Props {
  appVersion: string
  updaterState: UpdaterState
  onCheckUpdate: () => void
  onDownloadUpdate: () => void
  onQuitAndInstall: () => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

const AboutSection: FC<Props> = ({ appVersion, updaterState, onCheckUpdate, onDownloadUpdate, onQuitAndInstall }) => {
  const { t } = useT()
  const { status, version, releaseDate, releaseNotes, percent, bytesPerSecond, error } = updaterState
  const [noUpdateVisible, setNoUpdateVisible] = useState(true)
  const [showAlipay, setShowAlipay] = useState(false)

  // "已是最新版本" 2 秒后自动隐藏
  useEffect(() => {
    if (status !== 'no-update') return
    setNoUpdateVisible(true)
    const timer = setTimeout(() => setNoUpdateVisible(false), 2500)
    return () => clearTimeout(timer)
  }, [status])

  return (
    <>
      <div className="gsm-about-version">Claude Steer v{appVersion}</div>

      {/* idle — 初始状态 */}
      {status === 'idle' && (
        <div className="gsm-updater-actions">
          <button className="gsm-btn" onClick={onCheckUpdate}>
            {t('settings.about.checkUpdate')}
          </button>
        </div>
      )}

      {/* checking — 检查中 */}
      {status === 'checking' && (
        <div className="gsm-updater-actions">
          <span className="gsm-updater-spinner" />
          <span className="gsm-updater-status">{t('settings.about.checking')}</span>
        </div>
      )}

      {/* no-update — 已是最新（2s 后消失回到 idle） */}
      {status === 'no-update' && noUpdateVisible && (
        <div style={{ display: 'flex', gap: 12, marginTop: 8, alignItems: 'center' }}>
          <span className="gsm-updater-status gsm-updater-status--ok">{t('settings.about.upToDate')}</span>
        </div>
      )}

      {/* update-available — 发现新版本 */}
      {status === 'update-available' && (
        <>
          <div className="gsm-updater-status" style={{ marginTop: 8 }}>
            {t('settings.about.newVersion')} <strong>{version ?? '—'}</strong>
            {releaseDate && <> &middot; {t('settings.about.releasedOn')} {releaseDate}</>}
          </div>
          {releaseNotes && (
            <div className="gsm-updater-status" style={{ marginTop: 4 }}>
              {typeof releaseNotes === 'string'
                ? releaseNotes.slice(0, 200)
                : ''}
            </div>
          )}
          <div className="gsm-updater-actions">
            <button className="gsm-btn gsm-btn--primary" onClick={onDownloadUpdate}>
              {t('settings.about.download')} (v{version ?? '—'})
            </button>
          </div>
        </>
      )}

      {/* downloading — 下载中 */}
      {status === 'downloading' && (
        <>
          <div className="gsm-updater-status" style={{ marginTop: 8 }}>
            {t('settings.about.downloading')} v{version ?? '—'}...
            {percent !== undefined && ` ${Math.round(percent)}%`}
          </div>
          {bytesPerSecond !== undefined && (
            <div className="gsm-updater-download-info">
              {formatSpeed(bytesPerSecond)}
            </div>
          )}
          <div className="gsm-updater-progress">
            <div
              className="gsm-updater-progress-bar"
              style={{ width: `${Math.min(percent ?? 0, 100)}%` }}
            />
          </div>
        </>
      )}

      {/* downloaded — 下载完成 */}
      {status === 'downloaded' && (
        <>
          <div className="gsm-updater-status gsm-updater-status--ok" style={{ marginTop: 8 }}>
            v{version ?? '—'} {t('settings.about.downloadReady')}
          </div>
          <div className="gsm-updater-actions">
            <button className="gsm-btn gsm-btn--primary" onClick={onQuitAndInstall}>
              {t('settings.about.restartInstall')}
            </button>
          </div>
        </>
      )}

      {/* error — 错误状态 */}
      {status === 'error' && (
        <>
          <div className="gsm-updater-status gsm-updater-status--err" style={{ marginTop: 8 }}>
            {t('settings.about.checkFailed')}{error ?? t('settings.provider.unknownError')}
          </div>
          <div className="gsm-updater-actions">
            <button className="gsm-btn" onClick={onCheckUpdate}>
              {t('settings.about.retry')}
            </button>
          </div>
        </>
      )}

      {/* GitHub 链接（始终显示） */}
      <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
        <a
          className="gsm-about-link"
          href="#"
          onClick={(e) => {
            e.preventDefault()
            window.api.invoke(IPC.SHELL_OPEN_PATH, 'https://github.com/Ebwai/Claude-Steer').catch((err) => {
              console.error('[AboutSection] Failed to open GitHub link:', err)
              window.open('https://github.com/Ebwai/Claude-Steer', '_blank')
            })
          }}
        >
          GitHub →
        </a>
      </div>

      {/* ── 捐赠支持 ─────────────────────────────────────── */}
      <div className="gsm-donate">
        <div className="gsm-donate-label">{t('settings.about.supportProject')}</div>
        <div className="gsm-donate-row">
          <a
            className="gsm-donate-coffee"
            href="#"
            onClick={(e) => {
              e.preventDefault()
              const url = 'https://www.buymeacoffee.com/tonyleung'
              window.api.invoke(IPC.SHELL_OPEN_PATH, url).catch((err) => {
                console.error('[AboutSection] Failed to open BMC link via IPC:', err)
                window.open(url, '_blank')
              })
            }}
          >
            <img
              src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png"
              alt="Buy Me a Coffee"
              className="gsm-donate-coffee-img"
            />
          </a>
        </div>
        <div className="gsm-donate-row">
          <button className="gsm-btn gsm-donate-alipay-btn" onClick={() => setShowAlipay(true)}>
            {t('settings.about.alipaySupport')}
          </button>
        </div>
      </div>

      {/* 支付宝二维码弹窗 */}
      {showAlipay && (
        <div className="gsm-alipay-overlay" onClick={() => setShowAlipay(false)}>
          <div className="gsm-alipay-modal" onClick={(e) => e.stopPropagation()}>
            <img src={alipaymentImg} alt="Alipay" className="gsm-alipay-img" />
            <button className="gsm-btn gsm-alipay-close" onClick={() => setShowAlipay(false)}>
              {t('settings.about.closeImage')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

export default AboutSection
