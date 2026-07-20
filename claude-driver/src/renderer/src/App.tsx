// 使用方法：由 main.tsx 挂载为 React 根组件
// 编译说明：renderer 进程 browser bundle
// 代码说明：应用根组件——Jotai Provider 根节点、IPC 桥接、三层布局（顶栏/内容/底栏）
//           hash 路由：#/terminal?sessionId=<id> 时渲染独立终端窗口页

import React, { useState, useEffect } from 'react'
import { Provider as JotaiProvider, useAtomValue, useSetAtom, useStore } from 'jotai'
import TitleBar from './components/TitleBar/TitleBar'
import BottomBar from './components/BottomBar/BottomBar'
import GlobalMonitorPage from './features/global-monitor/GlobalMonitorPage'
import ProjectMonitorPage from './features/project-monitor/ProjectMonitorPage'
import NotificationWindowPage from './features/notifications/NotificationWindowPage'
import InitSopModal from './features/global-monitor/InitSopModal'
import GlobalSettingsModal from './features/settings/GlobalSettingsModal'
import TerminalPage from './features/terminal/TerminalPage'
import ChatPage from './features/chat/ChatPage'
import { useIpcBridge } from './hooks/useIpcBridge'
import { usePlanIndicator } from './hooks/usePlanIndicator'
import { runningSessionCountAtom } from './atoms/sessions.atom'
import { todayTokensAtom, todayCostUsdAtom, tokenStatsAtom, projectTotalTokensAtom } from './atoms/stats.atom'
import { setDriverConfig } from './capabilities/tokenCapability'
import { uiLanguageAtom } from './i18n'
import { useT } from './i18n'
import type { UILanguage } from './i18n/types'
import type { DriverConfig } from '@shared/types/index'
import { pendingRequestCountAtom, notificationQueueAtom } from './atoms/notification.atom'
import { claimedProjectsAtom, projectsAtom, activeProjectIdAtom } from './atoms/projects.atom'
import { insightStateAtom, insightReportPathAtom, insightErrorAtom } from './atoms/insight.atom'
import { IPC } from '@shared/events/ipc-channels'
import './App.css'

/** 解析当前 hash 路由，返回路径和查询参数 */
function parseHash(): { route: string; params: URLSearchParams } {
  const hash = window.location.hash.replace(/^#\/?/, '') // 去掉 # 和可选的 /
  const [routePart, queryPart] = hash.split('?')
  return {
    route: routePart ?? '',
    params: new URLSearchParams(queryPart ?? ''),
  }
}

export type TabId = 'global' | 'project'

// ── 内层组件（在 JotaiProvider 内部，可访问 store）────────────────────────

function AppInner(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('global')
  const store = useStore()
  const { t } = useT()
  const setInsightState    = useSetAtom(insightStateAtom)
  const setInsightReportPath = useSetAtom(insightReportPathAtom)
  const setInsightError    = useSetAtom(insightErrorAtom)
  const insightState       = useAtomValue(insightStateAtom)

  // IPC 桥接：挂载后开始监听 main 进程推送的事件（同时加载项目列表）
  useIpcBridge()
  // 倒三角执行指示器：监听 PostToolUse，检测 plan 文件变动并维护生命周期
  usePlanIndicator()

  // ── 窗口 resize 诊断日志 ────────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => {
      console.log(`[App:WIN] resize: outerW=${window.outerWidth} outerH=${window.outerHeight} innerW=${window.innerWidth} innerH=${window.innerHeight} screenW=${window.screen.width} screenH=${window.screen.height}`)
    }
    window.addEventListener('resize', onResize)
    onResize() // 初始值
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 启动时加载 driverConfig 到 renderer atom，确保费用计算使用正确价格
  // 同时加载已保存的 UI 语言
  useEffect(() => {
    void window.api.invoke(IPC.DRIVER_CONFIG_READ).then((raw: unknown) => {
      if (raw && typeof raw === 'object') {
        const { appVersion: _ver, ...driverFields } = raw as DriverConfig & { appVersion?: string }
        setDriverConfig(store, driverFields as DriverConfig)
        // 加载已保存的 UI 语言
        const cfg = driverFields as DriverConfig
        if (cfg.uiLanguage === 'zh-CN' || cfg.uiLanguage === 'en') {
          store.set(uiLanguageAtom, cfg.uiLanguage as UILanguage)
        }
      }
    }).catch((err: unknown) => {
      console.warn('[App] Failed to load driverConfig for token pricing:', err)
    })
  }, [store])

  // 桌面通知点击时打开独立通知窗口
  useEffect(() => {
    const off = window.api.on(IPC.NOTIFICATION_FOCUS_TAB, () => {
      void window.api.invoke(IPC.NOTIFICATION_WINDOW_OPEN)
    })
    return off
  }, [])

  // 全局 INSIGHT_REPORT_READY 监听——SoulModal 关闭后任务完成也能收到
  useEffect(() => {
    const off = window.api.on(IPC.INSIGHT_REPORT_READY, (...args: unknown[]) => {
      const payload = args[0] as { filePath: string }
      console.log('[App] insight report ready (global):', payload.filePath)
      setInsightReportPath(payload.filePath)
      setInsightState('ready')
      setInsightError(null)
      // push info 通知到队列（SoulModal 也会尝试 push，两者都加了去重 id 逻辑；
      // 全局监听兜底：保证 Modal 关闭后仍能收到通知）
      store.set(notificationQueueAtom, (prev) => {
        const id = `insight-${payload.filePath}`
        if (prev.some((n) => n.id === id)) return prev  // 去重
        return [...prev, {
          id,
          type: 'info' as const,
          title: t('globalMonitor.soul.insightReadyTitle'),
          message: t('globalMonitor.soul.insightReadyMessage'),
          sessionId: '',
          projectId: '',
          requiresAction: false,
          resolved: false,
          createdAt: Date.now(),
          metadata: { reportPath: payload.filePath },
        }]
      })
      // 注：通知 tab 已移至独立窗口，insight 报告就绪通知由 notificationQueueAtom 持有
    })
    return off
  }, [store, setInsightState, setInsightReportPath, setInsightError])

  // 从 Jotai atoms 读取实时数据
  const runningCount       = useAtomValue(runningSessionCountAtom)
  const todayTokens        = useAtomValue(todayTokensAtom)
  const todayCostUsd       = useAtomValue(todayCostUsdAtom)
  const monthlyTokens      = useAtomValue(tokenStatsAtom).monthlyTokens
  const pendingRequests    = useAtomValue(pendingRequestCountAtom)
  const claimedProjects    = useAtomValue(claimedProjectsAtom)
  const allProjects        = useAtomValue(projectsAtom)
  const activeProjectId    = useAtomValue(activeProjectIdAtom)
  const activeProjectTokens = useAtomValue(projectTotalTokensAtom(activeProjectId ?? ''))

  // ── 初始化 SOP 控制 ───────────────────────────────────────────────────────────
  // isFirstLaunch: projects.json 不存在（projects 全部从空开始）且无任何项目记录
  // 注意：useIpcBridge 加载项目后 allProjects 才有数据，用 null 区分"未加载"
  const [initLoaded, setInitLoaded]       = useState(false)
  const [isFirstLaunch, setIsFirstLaunch] = useState(false)
  const [showInitModal, setShowInitModal] = useState(false)
  const [showSettings, setShowSettings]   = useState(false)

  useEffect(() => {
    // 等 IpcBridge 加载项目后（allProjects 长度可能为 0 或 >0）再判断
    if (initLoaded) return

    // 询问主进程是否首次启动（projects.json 是否存在）
    void window.api.invoke(IPC.CONFIG_READ).then(() => {
      // CONFIG_READ 成功意味着 IPC 通道就绪，此时 allProjects 应已被 useIpcBridge 填充
      // 用一个小延迟等待 projectsAtom 更新完成
      setTimeout(() => {
        setInitLoaded(true)
      }, 200)
    })
  }, [initLoaded])

  useEffect(() => {
    if (!initLoaded) return
    // 通过 IPC 检查 projects.json 是否存在（首次启动标志）
    void window.api.invoke(IPC.PROJECT_LIST).then((raw: unknown) => {
      const projects = (raw as import('@shared/types/index').Project[]) ?? []
      const hasAny = projects.length > 0
      const hasPending = projects.some((p) => p.claimStatus === 0)

      if (!hasAny) {
        // 完全首次启动：无任何项目记录
        setIsFirstLaunch(true)
        setShowInitModal(true)
      } else if (hasPending) {
        // 后续启动：有待确认项目
        setIsFirstLaunch(false)
        setShowInitModal(true)
      }
    })
  }, [initLoaded])

  return (
    <div className="app-shell">
      <TitleBar
        runningCount={runningCount}
        todayTokens={todayTokens}
        todayCostUsd={todayCostUsd}
      />

      <main className="app-content">
        {/* 双击项目卡片 → 设置活跃项目 + 切换到项目监控 tab */}
        {activeTab === 'global' && (
          <GlobalMonitorPage
            onNavigateToProject={(projectId) => {
              console.log(`[App:NAV] 导航到项目监控页: projectId=${projectId}`)
              store.set(activeProjectIdAtom, projectId)
              setActiveTab('project')
            }}
          />
        )}
        {activeTab === 'project' && <ProjectMonitorPage />}
      </main>

      <BottomBar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        monthlyTokens={monthlyTokens}
        activeProjectTokens={activeProjectTokens}
        projectCount={claimedProjects.length}
        agentCount={runningCount}
        pendingRequests={pendingRequests}
        onOpenSettings={() => setShowSettings(true)}
      />

      {/* 全局 insight 生成中悬浮 badge（任何 tab 下可见，点击切换到通知页） */}
      {insightState === 'loading' && (
        <div
          className="app-insight-badge"
          title={t('app.insightBadgeTooltip')}
          onClick={() => void window.api.invoke(IPC.NOTIFICATION_WINDOW_OPEN)}
        >
          <span className="app-insight-spinner">⟳</span>
          <span>{t('app.insightBadge')}</span>
        </div>
      )}

      {/* 全局设置 Modal */}
      <GlobalSettingsModal open={showSettings} onClose={() => setShowSettings(false)} />

      {/* 初始化 SOP Modal（首次启动或有待确认项目）*/}
      {showInitModal && (
        <InitSopModal
          isFirstLaunch={isFirstLaunch}
          pendingProjects={
            isFirstLaunch
              ? []
              : Array.from(allProjects.values()).filter((p) => p.claimStatus === 0)
          }
          onClose={() => setShowInitModal(false)}
        />
      )}
    </div>
  )
}

// ── 根组件（包裹 JotaiProvider）─────────────────────────────────────────────

function App(): React.JSX.Element {
  const { route, params } = parseHash()

  // 独立终端窗口：#/terminal?sessionId=<id>
  if (route === 'terminal') {
    const sessionId = params.get('sessionId') ?? ''
    console.log('[App] Terminal route, sessionId:', sessionId)
    return (
      <JotaiProvider>
        <TerminalPage sessionId={sessionId} />
      </JotaiProvider>
    )
  }

  // 闲聊气泡窗口：#/chat?sessionId=<id>
  if (route === 'chat') {
    const sessionId = params.get('sessionId') ?? ''
    console.log('[App] Chat route, sessionId:', sessionId)
    return (
      <JotaiProvider>
        <ChatPage sessionId={sessionId} />
      </JotaiProvider>
    )
  }

  // 独立通知窗口：#/notifications（M10）
  if (route === 'notifications') {
    console.log('[App] Notifications route')
    return (
      <JotaiProvider>
        <NotificationWindowPage />
      </JotaiProvider>
    )
  }

  return (
    <JotaiProvider>
      <AppInner />
    </JotaiProvider>
  )
}

export default App
