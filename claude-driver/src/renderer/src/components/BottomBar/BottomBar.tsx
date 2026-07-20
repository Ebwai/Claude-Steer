// 使用方法：<BottomBar activeTab="global" onTabChange={fn} ... />
// 编译说明：renderer 进程 browser bundle
// 代码说明：底部标签栏（38px）——两个导航标签 + 右侧统计信息 + 全局设置按钮
//           样式像素级还原 global-monitor-page.html 中的 .btabs 结构

import type { FC } from 'react'
import type { TabId } from '../../App'
import { useT } from '../../i18n'
import './BottomBar.css'

interface BottomBarProps {
  activeTab: TabId
  onTabChange: (tab: TabId) => void
  /** 本月总 token 数（全局监控 tab 显示） */
  monthlyTokens: number
  /** 当前项目 token 总消耗（项目监控 tab 显示） */
  activeProjectTokens: number
  /** 已认领项目数 */
  projectCount: number
  /** 活跃 Agent 数量 */
  agentCount: number
  /** 待处理权限请求数 */
  pendingRequests: number
  /** 打开全局设置 Modal */
  onOpenSettings: () => void
}

const BottomBar: FC<BottomBarProps> = ({
  activeTab,
  onTabChange,
  monthlyTokens,
  activeProjectTokens,
  projectCount,
  agentCount,
  pendingRequests,
  onOpenSettings,
}) => {
  const { t } = useT()

  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`
    return String(n)
  }

  return (
    <nav className="bottombar">
      {/* 导航标签 */}
      <button
        className={`btab ${activeTab === 'global' ? 'btab--active' : ''}`}
        onClick={() => onTabChange('global')}
      >
        {activeTab === 'global' && <span className="btab-run-dot" />}
        {t('bottombar.globalMonitor')}
      </button>

      <button
        className={`btab ${activeTab === 'project' ? 'btab--active' : ''}`}
        onClick={() => onTabChange('project')}
      >
        {t('bottombar.projectMonitor')}
      </button>

      {/* 弹性空白 */}
      <div className="btab-spacer" />

      {/* 右侧统计信息 */}
      <div className="btab-stats">
        <span className="bstat">
          {activeTab === 'project'
            ? <>{t('bottombar.projectToken')} <strong className="bstat-val">{formatTokens(activeProjectTokens)}</strong> tok</>
            : <>{t('bottombar.monthlyToken')} <strong className="bstat-val">{formatTokens(monthlyTokens)}</strong> tok</>
          }
        </span>
        <span className="bstat-sep" />

        <span className="bstat">
          {t('bottombar.projectCount')} <strong className="bstat-val">{projectCount}</strong>
        </span>
        <span className="bstat-sep" />

        <span className="bstat">
          Agents <strong className="bstat-val">{agentCount}</strong>
        </span>

        {pendingRequests > 0 && (
          <>
            <span className="bstat-sep" />
            <span className="bstat-pending">● {t('bottombar.pendingRequests', { count: pendingRequests })}</span>
          </>
        )}

        <span className="bstat-sep" />

        {/* 全局设置按钮 */}
        <button className="btab-settings" onClick={onOpenSettings}>
          <span className="btab-settings-icon">⚙</span> {t('bottombar.settings')}
        </button>
      </div>
    </nav>
  )
}

export default BottomBar
