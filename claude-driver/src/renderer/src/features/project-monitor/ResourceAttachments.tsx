// 历史/实时用户节点只读资源入口：图片应用内查看，其余资源交给系统默认程序

import React, { useCallback, useState } from 'react'
import { IPC } from '@shared/events/ipc-channels'
import type {
  ResourceReadImageResult,
  ResourceOpenResult,
  ResourceSnapshot
} from '@shared/types/resources'
import { useT } from '../../i18n'

interface ResourceAttachmentsProps {
  resources: ResourceSnapshot[]
  projectPath: string
}

export default function ResourceAttachments({
  resources,
  projectPath
}: ResourceAttachmentsProps): React.JSX.Element {
  const { t } = useT()
  const [expanded, setExpanded] = useState(false)
  const [image, setImage] = useState<{ name: string; dataUrl: string } | null>(null)
  const [error, setError] = useState('')

  const handleOpen = useCallback(
    async (resource: ResourceSnapshot) => {
      setError('')
      if (resource.kind === 'image') {
        const result = (await window.api.invoke(IPC.RESOURCE_READ_IMAGE, {
          projectPath,
          resource
        })) as ResourceReadImageResult
        if (result.ok) setImage({ name: resource.displayName, dataUrl: result.dataUrl })
        else setError(result.error)
        return
      }
      const result = (await window.api.invoke(IPC.RESOURCE_OPEN, {
        resource
      })) as ResourceOpenResult
      if (!result.ok) setError(`${t('projectMonitor.resources.openFailed')}：${result.error}`)
    },
    [projectPath, t]
  )

  return (
    <div className="resource-attachments">
      <button className="resource-toggle" onClick={() => setExpanded((value) => !value)}>
        ◫ {t('projectMonitor.resources.related')} ({resources.length})
      </button>
      {expanded && (
        <div className="resource-list">
          {resources
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((resource) => (
              <button
                key={resource.id}
                className="resource-item"
                title={resource.path}
                onClick={() => void handleOpen(resource)}
              >
                <span className="resource-item-type">
                  {resource.kind === 'image' ? '图' : resource.kind.toUpperCase()}
                </span>
                <span>{resource.displayName}</span>
              </button>
            ))}
        </div>
      )}
      {error && (
        <div className="resource-error" role="alert">
          {error}
        </div>
      )}
      {image && (
        <div
          className="resource-image-modal"
          role="dialog"
          aria-modal="true"
          onClick={() => setImage(null)}
        >
          <button
            className="resource-image-close"
            aria-label={t('projectMonitor.resources.closePreview')}
          >
            ×
          </button>
          <img src={image.dataUrl} alt={image.name} onClick={(event) => event.stopPropagation()} />
        </div>
      )}
    </div>
  )
}
