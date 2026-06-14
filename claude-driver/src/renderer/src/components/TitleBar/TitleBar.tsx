// 使用方法：<TitleBar runningCount={n} todayTokens={n} todayCostUsd={n} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：顶部标题栏（38px）——macOS 红黄绿 + Logo + 标题 + 右侧运行状态元信息
//           样式像素级还原 global-monitor-page.html 中的 .tb 结构

import type { FC } from 'react'
import { useT } from '../../i18n'
import './TitleBar.css'

interface TitleBarProps {
  /** 当前正在运行的 session 数量 */
  runningCount: number
  /** 今日消耗 token 数 */
  todayTokens: number
  /** 今日估算费用（USD） */
  todayCostUsd: number
}

const TitleBar: FC<TitleBarProps> = ({ runningCount, todayTokens, todayCostUsd }) => {
  const { t } = useT()

  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`
    return String(n)
  }

  return (
    <div className="titlebar">
      {/* macOS 红黄绿窗口控制按钮（仅装饰，Electron 使用系统原生按钮） */}
      <div className="titlebar-wc">
        <span className="wc-btn wc-red" />
        <span className="wc-btn wc-yellow" />
        <span className="wc-btn wc-green" />
      </div>

      {/* Logo */}
      <div className="titlebar-logo" aria-hidden="true">✦</div>

      {/* 标题 */}
      <span className="titlebar-title">Claude Steer</span>

      {/* 弹性空白 */}
      <div className="titlebar-spacer" />

      {/* 右侧元信息 */}
      <div className="titlebar-meta">
        {todayTokens > 0 && (
          <span>
            {t('titlebar.today')} <strong className="titlebar-val">↑ {formatTokens(todayTokens)}</strong> tok
          </span>
        )}
        {todayCostUsd > 0 && (
          <span>
            {t('titlebar.cost')} <strong className="titlebar-val">${todayCostUsd.toFixed(2)}</strong>
          </span>
        )}
        {runningCount > 0 && (
          <div className="titlebar-running">
            <span className="running-dot" />
            <strong className="titlebar-val">{runningCount}</strong> {t('titlebar.running')}
          </div>
        )}
      </div>
    </div>
  )
}

export default TitleBar
