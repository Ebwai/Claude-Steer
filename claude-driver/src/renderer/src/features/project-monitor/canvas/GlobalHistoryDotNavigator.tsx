// 使用方法：在 ProcessLineCanvas.tsx 中绝对定位于历史画布最右侧
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局主线 Agent 点导航——每个主线框一个等距点，点击复用固定相机聚焦

import React, { useMemo } from 'react'
import { useT } from '../../../i18n'
import { buildHistoryDotItems } from './historyDotNavigation'
import './GlobalHistoryDotNavigator.css'

interface GlobalHistoryDotNavigatorProps {
  orderedMainSessionIds: readonly string[]
  focusedSessionId: string | null
  onSessionFocus: (sessionId: string) => void
}

export default function GlobalHistoryDotNavigator({
  orderedMainSessionIds,
  focusedSessionId,
  onSessionFocus
}: GlobalHistoryDotNavigatorProps): React.JSX.Element | null {
  const { t } = useT()
  const items = useMemo(
    () => buildHistoryDotItems(orderedMainSessionIds, focusedSessionId),
    [orderedMainSessionIds, focusedSessionId]
  )

  if (items.length === 0) return null

  return (
    <nav
      className="ghdn-track nodrag nopan"
      aria-label={t('projectMonitor.canvas.historyDotNavigatorAria')}
      data-testid="history-dot-navigator"
    >
      <div className="ghdn-rail">
        {items.map((item) => {
          const label = t('projectMonitor.canvas.historyDotAria', {
            index: item.index + 1,
            total: items.length
          })
          const hitHeightPct = item.hitEndPct - item.hitStartPct
          const positionWithinHitPct =
            hitHeightPct <= 0 ? 50 : ((item.positionPct - item.hitStartPct) / hitHeightPct) * 100

          return (
            <button
              key={item.sessionId}
              type="button"
              className={`ghdn-hit-target nodrag nopan${item.isFocused ? ' ghdn-hit-target-active' : ''}`}
              style={{
                top: `${item.hitStartPct}%`,
                height: `${hitHeightPct}%`
              }}
              aria-label={label}
              aria-current={item.isFocused ? 'true' : undefined}
              title={label}
              data-session-id={item.sessionId}
              data-position-pct={item.positionPct}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                console.info(
                  `[HistoryDotNavigator] focus main session=${item.sessionId.slice(0, 8)} point=${item.index + 1}/${items.length}`
                )
                onSessionFocus(item.sessionId)
              }}
            >
              <span
                className="ghdn-dot"
                style={{ top: `${positionWithinHitPct}%` }}
                aria-hidden="true"
              />
            </button>
          )
        })}
      </div>
    </nav>
  )
}
