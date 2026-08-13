// 实时 Agent 消息输入：正文发送、图片/文件选择、剪贴板资源导入与发送前预览

import React, { useState, useCallback, useRef } from 'react'
import { useT } from '../../i18n'
import { IPC } from '@shared/events/ipc-channels'
import type {
  ResourceDraft,
  ResourceImportResult,
  ResourceSendResult
} from '@shared/types/resources'
import './MessageInputBar.css'

interface MessageInputBarProps {
  sessionId: string | null
  projectPath?: string
  isRunning: boolean
  agentLabel?: string
  agentColor?: string
  onSent?: () => void
}

function MessageInputBar({
  sessionId,
  projectPath = '',
  isRunning,
  agentLabel,
  agentColor,
  onSent
}: MessageInputBarProps): React.JSX.Element {
  const { t } = useT()
  const [text, setText] = useState('')
  const [resources, setResources] = useState<ResourceDraft[]>([])
  const [sending, setSending] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<ResourceDraft | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const canAttach = !!sessionId && !!projectPath && isRunning && !sending && !importing
  const canSend =
    !!sessionId &&
    isRunning &&
    (text.trim().length > 0 || resources.length > 0) &&
    !sending &&
    !importing

  const appendImportResult = useCallback((result: ResourceImportResult): void => {
    if (result.resources.length) {
      setResources((current) => [
        ...current,
        ...result.resources.map((resource, index) => ({
          ...resource,
          order: current.length + index
        }))
      ])
    }
    setError(
      result.failures
        .map((failure) => `${failure.displayName ?? failure.path ?? '资源'}：${failure.error}`)
        .join('；')
    )
  }, [])

  const handlePick = useCallback(async () => {
    if (!canAttach) return
    setImporting(true)
    setError('')
    try {
      const result = (await window.api.invoke(IPC.RESOURCE_PICK, {
        projectPath
      })) as ResourceImportResult
      appendImportResult(result)
    } catch (err) {
      setError(String(err))
      console.error('[MessageInputBar] resource pick failed:', err)
    } finally {
      setImporting(false)
    }
  }, [appendImportResult, canAttach, projectPath])

  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const directFiles = Array.from(event.clipboardData.files)
      const files = directFiles.length
        ? directFiles
        : Array.from(event.clipboardData.items)
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null)
      if (!files.length || !canAttach) return
      event.preventDefault()
      setImporting(true)
      setError('')
      try {
        for (const file of files) {
          const originalPath = window.resourceApi?.getPathForFile(file) ?? ''
          let result: ResourceImportResult
          if (originalPath) {
            result = (await window.api.invoke(IPC.RESOURCE_IMPORT_PATHS, {
              projectPath,
              paths: [originalPath]
            })) as ResourceImportResult
          } else if (file.type.startsWith('image/')) {
            result = (await window.api.invoke(IPC.RESOURCE_IMPORT_IMAGE, {
              projectPath,
              bytes: new Uint8Array(await file.arrayBuffer()),
              displayName: file.name || '粘贴图片.png',
              mimeType: file.type || 'image/png'
            })) as ResourceImportResult
          } else {
            setError(t('projectMonitor.inputBar.clipboardNoPath'))
            console.warn(
              `[MessageInputBar] pasted document has no original path: name=${file.name} type=${file.type}`
            )
            continue
          }
          appendImportResult(result)
        }
      } catch (err) {
        setError(String(err))
        console.error('[MessageInputBar] paste import failed:', err)
      } finally {
        setImporting(false)
      }
    },
    [appendImportResult, canAttach, projectPath, t]
  )

  const handleSend = useCallback(async () => {
    if (!canSend || !sessionId) return
    setSending(true)
    setError('')
    try {
      if (resources.length) {
        const result = (await window.api.invoke(IPC.RESOURCE_SEND, {
          sessionId,
          projectPath,
          text: text.trim(),
          resources: resources.map(({ previewDataUrl: _previewDataUrl, ...resource }) => resource)
        })) as ResourceSendResult
        if (!result.ok) throw new Error(result.error)
      } else {
        const result = (await window.api.invoke(IPC.SESSION_INPUT, {
          sessionId,
          text: text.trim()
        })) as { ok: boolean; error?: string }
        if (!result.ok) throw new Error(result.error ?? '发送失败')
      }
      setText('')
      setResources([])
      textareaRef.current?.focus()
      onSent?.()
    } catch (err) {
      setError(String(err))
      console.error('[MessageInputBar] send failed:', err)
    } finally {
      setSending(false)
    }
  }, [canSend, onSent, projectPath, resources, sessionId, text])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        void handleSend()
      }
    },
    [handleSend]
  )

  const handleInterrupt = useCallback(async () => {
    if (!sessionId) return
    try {
      await window.api.invoke(IPC.SESSION_STOP, { sessionId })
    } catch (err) {
      console.error('[MessageInputBar] interrupt failed:', err)
    }
  }, [sessionId])

  return (
    <div className="msgbar">
      {agentLabel && (
        <div className="msgbar-agent-row">
          <span className="msgbar-agent-dot" style={{ backgroundColor: agentColor }} />
          <span className="msgbar-agent-name" style={{ color: agentColor }}>
            {agentLabel}
          </span>
        </div>
      )}
      <textarea
        ref={textareaRef}
        className="msgbar-textarea"
        rows={3}
        placeholder={
          !sessionId
            ? t('projectMonitor.inputBar.noActiveSession')
            : !isRunning
              ? t('projectMonitor.inputBar.sessionEnded')
              : t('projectMonitor.inputBar.placeholder')
        }
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={(event) => void handlePaste(event)}
        disabled={!sessionId || !isRunning}
      />
      {resources.length > 0 && (
        <div
          className="msgbar-resources"
          aria-label={t('projectMonitor.inputBar.attachedResources')}
        >
          {resources.map((resource) => (
            <div className="msgbar-resource" key={resource.id} title={resource.path}>
              {resource.kind === 'image' ? (
                <button className="msgbar-resource-preview" onClick={() => setPreview(resource)}>
                  {resource.previewDataUrl ? (
                    <img src={resource.previewDataUrl} alt={resource.displayName} />
                  ) : (
                    '图'
                  )}
                </button>
              ) : (
                <span className="msgbar-resource-type">{resource.kind.toUpperCase()}</span>
              )}
              <span className="msgbar-resource-name">{resource.displayName}</span>
              <button
                className="msgbar-resource-remove"
                aria-label={`${t('projectMonitor.inputBar.remove')} ${resource.displayName}`}
                onClick={() =>
                  setResources((current) =>
                    current
                      .filter((item) => item.id !== resource.id)
                      .map((item, order) => ({ ...item, order }))
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="msgbar-error" role="alert">
          {error}
        </div>
      )}
      <button className="msgbar-attach" onClick={() => void handlePick()} disabled={!canAttach}>
        🖼{' '}
        {importing
          ? t('projectMonitor.inputBar.importing')
          : t('projectMonitor.inputBar.addResources')}
      </button>
      <div className="msgbar-footer">
        <span className="msgbar-hint">
          {canSend ? t('projectMonitor.inputBar.ctrlEnterToSend') : ''}
        </span>
        <div className="msgbar-btns">
          {sessionId && isRunning && (
            <button className="msgbar-btn-interrupt" onClick={handleInterrupt}>
              ⏹ {t('projectMonitor.inputBar.interrupt')}
            </button>
          )}
          <button className="msgbar-btn-send" onClick={() => void handleSend()} disabled={!canSend}>
            {sending ? t('projectMonitor.inputBar.sending') : t('projectMonitor.inputBar.send')}
          </button>
        </div>
      </div>
      {preview?.previewDataUrl && (
        <div
          className="msgbar-image-modal"
          role="dialog"
          aria-modal="true"
          onClick={() => setPreview(null)}
        >
          <button
            className="msgbar-image-close"
            aria-label={t('projectMonitor.inputBar.closePreview')}
          >
            ×
          </button>
          <img
            src={preview.previewDataUrl}
            alt={preview.displayName}
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}

export default MessageInputBar
