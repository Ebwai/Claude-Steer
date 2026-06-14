// 使用方法：由 App.tsx 在 activeTab === 'global' 时渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局监控页面根组件——左半画板 + 右半（配置面板或新建项目向导）
//           wizardOpen 控制右侧区域切换：false=RightPanel / true=CreateProjectWizard

import React, { useState, useCallback } from 'react'
import CanvasPanel from './CanvasPanel'
import RightPanel from './RightPanel'
import CreateProjectWizard from './CreateProjectWizard'
import LanguageSwitcher from './LanguageSwitcher'
import './GlobalMonitorPage.css'

interface GlobalMonitorPageProps {
  /** 双击项目卡片时导航到项目监控页（由 AppInner 注入） */
  onNavigateToProject?: (projectId: string) => void
}

function GlobalMonitorPage({ onNavigateToProject }: GlobalMonitorPageProps): React.JSX.Element {
  const [wizardOpen, setWizardOpen] = useState(false)

  const handleOpenWizard  = useCallback(() => setWizardOpen(true), [])
  const handleCloseWizard = useCallback(() => setWizardOpen(false), [])

  return (
    <div className="gm-page">
      <LanguageSwitcher />
      <CanvasPanel onCreateProject={handleOpenWizard} onNavigateToProject={onNavigateToProject} />
      {wizardOpen
        ? <CreateProjectWizard onClose={handleCloseWizard} />
        : <RightPanel />
      }
    </div>
  )
}

export default GlobalMonitorPage
