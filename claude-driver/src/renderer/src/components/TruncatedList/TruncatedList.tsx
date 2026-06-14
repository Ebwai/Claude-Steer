// 使用方法：<TruncatedList items={arr} renderItem={fn} maxVisible={3} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：截断列表——≤maxVisible 全部显示；>maxVisible 显示前(maxVisible-1)条 + "···N 更多"
//           点击"···更多"展开覆盖浮层（PRD §3.2.1 截断规则）

import { useState, useRef, useEffect, type FC, type ReactNode } from 'react'
import { useT } from '../../i18n'
import './TruncatedList.css'

interface TruncatedListProps<T> {
  items: T[]
  renderItem: (item: T, index: number) => ReactNode
  /** 超过此数量时截断，默认 3 */
  maxVisible?: number
  /** 浮层标题（可选） */
  overlayTitle?: string
  className?: string
}

function TruncatedList<T>({
  items,
  renderItem,
  maxVisible = 3,
  overlayTitle,
  className = ''
}: TruncatedListProps<T>): React.JSX.Element {
  const { t } = useT()
  const [expanded, setExpanded] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭浮层
  useEffect(() => {
    if (!expanded) return
    const handler = (e: MouseEvent): void => {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) {
        setExpanded(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [expanded])

  const needsTruncation = items.length > maxVisible
  const visibleItems = needsTruncation ? items.slice(0, maxVisible - 1) : items
  const hiddenCount = items.length - visibleItems.length

  return (
    <div className={`trunc-list ${className}`}>
      {visibleItems.map((item, i) => (
        <div key={i} className="trunc-list__item">
          {renderItem(item, i)}
        </div>
      ))}

      {needsTruncation && (
        <div className="trunc-list__more-wrap" ref={overlayRef}>
          <button
            className="trunc-list__more-btn"
            onClick={() => setExpanded(v => !v)}
          >
            ··· {hiddenCount} {t('common.more')}
          </button>

          {expanded && (
            <div className="trunc-list__overlay">
              {overlayTitle && (
                <div className="trunc-list__overlay-title">{overlayTitle}</div>
              )}
              {items.map((item, i) => (
                <div key={i} className="trunc-list__item">
                  {renderItem(item, i)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default TruncatedList as FC<TruncatedListProps<unknown>>
