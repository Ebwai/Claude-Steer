// 使用方法：<Modal open={bool} onClose={fn} title="标题">...children...</Modal>
// 编译说明：renderer 进程 browser bundle
// 代码说明：全局遮罩弹窗——backdrop-filter blur(2px) 遮罩 + 居中内容区 + 关闭按钮
//           使用 React Portal 挂载到 document.body，避免 z-index 层叠问题

import { useEffect, type FC, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../i18n'
import './Modal.css'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  /** 弹窗宽度（px），默认 480 */
  width?: number
  children: ReactNode
  /** 是否显示关闭按钮，默认 true */
  showClose?: boolean
}

const Modal: FC<ModalProps> = ({
  open,
  onClose,
  title,
  width = 480,
  children,
  showClose = true
}) => {
  const { t } = useT()
  // ESC 键关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="modal-backdrop"
      onClick={(e) => {
        // 点击遮罩区域关闭（点击内容区不关闭）
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-box" style={{ width }} role="dialog" aria-modal>
        {(title || showClose) && (
          <div className="modal-header">
            {title && <span className="modal-title">{title}</span>}
            {showClose && (
              <button className="modal-close" onClick={onClose} aria-label={t('common.closeAriaLabel')}>
                ✕
              </button>
            )}
          </div>
        )}
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body
  )
}

export default Modal
