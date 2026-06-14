// 使用方法：<RecommendModal category="skills" onClose={fn} />
// 编译说明：renderer 进程 browser bundle
// 代码说明：作者推荐弹窗——显示某分类的推荐项列表，支持查看详情和安装方法

import { useState, useEffect, useCallback, type FC } from 'react'
import { IPC } from '@shared/events/ipc-channels'
import Modal from '../../components/Modal/Modal'
import { useT } from '../../i18n'
import './RecommendModal.css'

// ── 数据类型 ──────────────────────────────────────────────────────────────────

interface RecommendItem {
  name: string
  description: string
  tags: string[]
  detail: string
  install: {
    commands: string[]
  }
}

type ViewMode = 'list' | 'detail' | 'install'

interface RecommendModalProps {
  category: string
  onClose: () => void
}

// ── 分类显示名映射（i18n key）────────────────────────────────────────────────

const CATEGORY_I18N: Record<string, string> = {
  agents: 'recommend.category.agents',
  skills: 'recommend.category.skills',
  mcps: 'recommend.category.mcps',
  workflows: 'recommend.category.workflows',
  clis: 'recommend.category.clis',
}

// ── RecommendModal 组件 ─────────────────────────────────────────────────────

const RecommendModal: FC<RecommendModalProps> = ({ category, onClose }) => {
  const { t } = useT()
  const [items, setItems] = useState<RecommendItem[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<ViewMode>('list')
  const [selected, setSelected] = useState<RecommendItem | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  // 加载推荐数据
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        setLoading(true)
        const data = await window.api.invoke(IPC.RECOMMEND_GET, { category })
        if (!cancelled) setItems(data as RecommendItem[])
      } catch (err) {
        console.error('[RecommendModal] Failed to load recommendations:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [category])

  const handleDetail = useCallback((item: RecommendItem) => {
    setSelected(item)
    setView('detail')
  }, [])

  const handleInstall = useCallback((item: RecommendItem) => {
    setSelected(item)
    setView('install')
    setCopiedIdx(null)
  }, [])

  const handleBack = useCallback(() => {
    setView('list')
    setSelected(null)
    setCopiedIdx(null)
  }, [])

  const handleCopy = useCallback(async (text: string, idx: number) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIdx(idx)
      setTimeout(() => setCopiedIdx(null), 1500)
    } catch (err) {
      console.error('[RecommendModal] Copy failed:', err)
    }
  }, [])

  const categoryLabel = t(CATEGORY_I18N[category] ?? category)
  const title = (
    <>
      {t('recommend.title', { category: categoryLabel })}
      <span className="ar-title-sub">{t('recommend.subtitle')}</span>
    </>
  )

  return (
    <Modal open={true} onClose={onClose} title={title} width={520}>
      <div className="ar-modal">

        {/* ── 列表视图 ── */}
        {view === 'list' && (
          <div className="ar-list">
            {loading ? (
              <div className="ar-loading">{t('common.loading')}</div>
            ) : items.length === 0 ? (
              <div className="ar-empty">{t('recommend.empty')}</div>
            ) : (
              items.map((item) => (
                <div key={item.name} className="ar-row">
                  <div className="ar-row-info">
                    <div className="ar-row-name">{item.name}</div>
                    <div className="ar-row-desc">{item.description}</div>
                    <div className="ar-row-tags">
                      {item.tags.map((tag) => (
                        <span key={tag} className="ar-tag">{tag}</span>
                      ))}
                    </div>
                  </div>
                  <div className="ar-row-actions">
                    <button className="ar-btn ar-btn-detail" onClick={() => handleDetail(item)}>
                      {t('recommend.detail')}
                    </button>
                    <button className="ar-btn ar-btn-install" onClick={() => handleInstall(item)}>
                      {t('recommend.install')}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ── 详情视图 ── */}
        {view === 'detail' && selected && (
          <div className="ar-detail">
            <button className="ar-back" onClick={handleBack}>{t('recommend.back')}</button>
            <div className="ar-detail-name">{selected.name}</div>
            <div className="ar-detail-content">
              {selected.detail.split('\n').map((line, i) => (
                <div key={i} className="ar-detail-line">{line || ' '}</div>
              ))}
            </div>
          </div>
        )}

        {/* ── 安装视图 ── */}
        {view === 'install' && selected && (
          <div className="ar-install">
            <button className="ar-back" onClick={handleBack}>{t('recommend.back')}</button>
            <div className="ar-install-name">{selected.name}</div>
            <div className="ar-commands">
              {selected.install.commands.map((cmd, i) => {
                const isComment = cmd.startsWith('#')
                const isEmpty = cmd.trim() === ''
                if (isEmpty) return <div key={i} className="ar-cmd-spacer" />
                if (isComment) return <div key={i} className="ar-cmd-comment">{cmd}</div>
                return (
                  <div key={i} className="ar-cmd-row">
                    <code className="ar-cmd-text">{cmd}</code>
                    <button
                      className={`ar-cmd-copy${copiedIdx === i ? ' ar-cmd-copied' : ''}`}
                      onClick={() => handleCopy(cmd, i)}
                    >
                      {copiedIdx === i ? t('recommend.copied') : t('recommend.copy')}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

      </div>
    </Modal>
  )
}

export default RecommendModal
