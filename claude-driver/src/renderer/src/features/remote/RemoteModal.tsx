// 使用方法：<RemoteModal onClose={fn} />，由 RightPanel.tsx 在 showRemote=true 时渲染
// 编译说明：renderer 进程 browser bundle
// 代码说明：远程交互 Modal 外壳，包裹 RemotePanel

import React from 'react'
import Modal from '../../components/Modal/Modal'
import RemotePanel from './RemotePanel'
import { useT } from '../../i18n'

interface Props {
  onClose: () => void
}

export default function RemoteModal({ onClose }: Props): React.JSX.Element {
  const { t } = useT()
  return (
    <Modal open title={<><span>📡</span> {t('remote.modalTitle')}</>} onClose={onClose} width={520}>
      <RemotePanel />
    </Modal>
  )
}
