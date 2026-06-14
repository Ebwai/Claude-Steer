// 使用方法：由 ProjectMonitorPage.tsx 渲染在顶部
// 编译说明：renderer 进程 browser bundle
// 代码说明：浏览器式项目标签栏——运行中项目显示为标签，末端"所有项目"浮层展开全部已认领项目
//           运行中检测：优先用 project.activeSessionId，其次通过 session.cwd 反查（外部启动的 Claude）

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useAtomValue, useAtom } from 'jotai'
import { useT } from '../../i18n'
import { claimedProjectsAtom, activeProjectIdAtom } from '../../atoms/projects.atom'
import { activeSessionsAtom } from '../../atoms/sessions.atom'
import { pathMatches } from '@renderer/utils/pathUtils'
import type { Session } from '@shared/types/index'
import './ProjectTabBar.css'

// ── 通过 activeSessions 反查正在运行该项目的 session ──────────────────────────
function findSessionForProject(
  projectPath: string,
  projectActiveSessionId: string | null,
  activeSessions: Map<string, Session>
): Session | null {
  // 方式 1：直接用 activeSessionId 匹配
  if (projectActiveSessionId) {
    const s = activeSessions.get(projectActiveSessionId)
    if (s) return s
  }
  // 方式 2：通过 cwd 反查（外部启动的 Claude session）
  for (const session of activeSessions.values()) {
    if (
      session.status === 'Running' &&
      pathMatches(session.cwd, projectPath)
    ) {
      return session
    }
  }
  return null
}

function ProjectTabBar(): React.JSX.Element {
  const { t } = useT()
  const claimed        = useAtomValue(claimedProjectsAtom)
  const activeSessions = useAtomValue(activeSessionsAtom)
  const [activeId, setActiveId] = useAtom(activeProjectIdAtom)

  const [allOpen, setAllOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 运行中项目 = session 的 cwd 匹配项目路径，或 activeSessionId 直接命中
  const runningProjects = claimed.filter((p) => {
    const s = findSessionForProject(p.path, p.activeSessionId, activeSessions)
    return s?.status === 'Running'
  })

  // 点击标签之外关闭浮层
  useEffect(() => {
    if (!allOpen) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setAllOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [allOpen])

  // 首次进入时若没有选中项目，自动选中第一个运行中的项目
  useEffect(() => {
    if (!activeId && runningProjects.length > 0) {
      setActiveId(runningProjects[0].id)
    }
  }, [activeId, runningProjects, setActiveId])

  const handleSelect = useCallback((id: string) => {
    setActiveId(id)
    setAllOpen(false)
  }, [setActiveId])

  return (
    <div className="ptab-bar">
      {/* 运行中项目标签 */}
      {runningProjects.map((p) => {
        const session = findSessionForProject(p.path, p.activeSessionId, activeSessions)
        const isActive = p.id === activeId
        return (
          <div
            key={p.id}
            className={`ptab ${isActive ? 'ptab-active' : ''}`}
            onClick={() => handleSelect(p.id)}
          >
            <span
              className="ptab-dot"
              style={{ background: session?.status === 'Running' ? 'var(--gr)' : 'var(--or)' }}
            />
            <span className="ptab-name">{p.name}</span>
          </div>
        )
      })}

      {/* 分隔线 + "所有项目"按钮 */}
      <div className="ptab-sep" />
      <div className="ptab-all-wrap" ref={dropdownRef}>
        <button
          className={`ptab-all-btn ${allOpen ? 'ptab-all-btn-open' : ''}`}
          onClick={() => setAllOpen((v) => !v)}
        >
          {t('projectMonitor.tabBar.allProjects')} {allOpen ? '▴' : '▾'}
        </button>

        {allOpen && (
          <div className="ptab-dropdown">
            {claimed.length === 0 && (
              <div className="ptab-dd-empty">{t('projectMonitor.tabBar.noClaimedProjects')}</div>
            )}
            {claimed.map((p) => {
              const s = findSessionForProject(p.path, p.activeSessionId, activeSessions)
              const isRunning = s?.status === 'Running'
              return (
                <div
                  key={p.id}
                  className={`ptab-dd-item ${p.id === activeId ? 'ptab-dd-item-active' : ''}`}
                  onClick={() => handleSelect(p.id)}
                >
                  <span
                    className="ptab-dot"
                    style={{
                      background: isRunning ? 'var(--gr)' : 'var(--bd2)',
                      flexShrink: 0,
                    }}
                  />
                  <span className="ptab-dd-name">{p.name}</span>
                  {isRunning && <span className="ptab-dd-badge">{t('projectMonitor.tabBar.running')}</span>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export default ProjectTabBar
