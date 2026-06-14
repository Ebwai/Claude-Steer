// 使用方法：由 App.tsx 在 activeTab==='project' 时渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：项目监控页面容器——顶部标签栏 + 设置栏 + 左半工作情况 + 右半进程线

import React from 'react'
import { useAtomValue } from 'jotai'
import { activeProjectIdAtom } from '../../atoms/projects.atom'
import ProjectTabBar from './ProjectTabBar'
import ProjectSettingsBar from './ProjectSettingsBar'
import LeftPanel from './LeftPanel'
import ProcessLineCanvas from './canvas/ProcessLineCanvas'
import './ProjectMonitorPage.css'

function ProjectMonitorPage(): React.JSX.Element {
  const activeId = useAtomValue(activeProjectIdAtom)

  return (
    <div className="pm-page">
      {/* S1 T1: 浏览器式项目标签 */}
      <ProjectTabBar />

      {/* S1 T2: 项目设置栏 */}
      <ProjectSettingsBar />

      {/* 主体区：左半 + 右半 */}
      <div className="pm-body">
        {/* S2: 左半当前工作情况 */}
        <LeftPanel />

        {/* S3: 右半历史进程线画布（@xyflow SessionFrameNode 外壳） */}
        <ProcessLineCanvas projectId={activeId} />
      </div>
    </div>
  )
}

export default ProjectMonitorPage
