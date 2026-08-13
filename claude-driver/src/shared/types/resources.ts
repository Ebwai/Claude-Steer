// 关联资源跨进程契约：草稿、发送快照、图片读取与系统打开结果

export type ResourceKind = 'image' | 'word' | 'pdf' | 'ppt' | 'markdown'
export type ResourceOrigin = 'managed' | 'original'

export type ResourceErrorCode =
  | 'RESOURCE_UNSUPPORTED_TYPE'
  | 'RESOURCE_PATH_INVALID'
  | 'RESOURCE_NOT_FOUND'
  | 'RESOURCE_IMAGE_DECODE_FAILED'
  | 'RESOURCE_PTY_WRITE_FAILED'
  | 'RESOURCE_BIND_AMBIGUOUS'
  | 'RESOURCE_OPEN_FAILED'
  | 'RESOURCE_IO_ERROR'

export interface ResourceSnapshot {
  id: string
  kind: ResourceKind
  origin: ResourceOrigin
  path: string
  displayName: string
  order: number
  typeIndex: number
}

export interface ResourceDraft extends ResourceSnapshot {
  previewDataUrl?: string
}

export interface ResourceItemFailure {
  path?: string
  displayName?: string
  errorCode: ResourceErrorCode
  error: string
}

export interface ResourcePickInput {
  projectPath: string
}
export interface ResourceImportPathsInput {
  projectPath: string
  paths: string[]
}
export interface ResourceImportImageInput {
  projectPath: string
  bytes: Uint8Array
  displayName?: string
  mimeType?: string
}
export type ResourceImportResult =
  | { ok: true; resources: ResourceDraft[]; failures: ResourceItemFailure[] }
  | { ok: false; resources: ResourceDraft[]; failures: ResourceItemFailure[]; error: string }

export interface ResourceSendInput {
  sessionId: string
  projectPath: string
  text: string
  resources: ResourceSnapshot[]
}
export type ResourceSendResult =
  | { ok: true; transactionId: string; finalText: string; resources: ResourceSnapshot[] }
  | { ok: false; errorCode: ResourceErrorCode; error: string }

export interface ResourceMessageSnapshot {
  version: 1
  transactionId: string
  claudeId: string
  userMessageUuid: string
  messageHash: string
  resources: ResourceSnapshot[]
  boundAt: number
}

export interface ResourceBoundPayload {
  sessionId: string
  userMessageUuid: string
  resources: ResourceSnapshot[]
}

export interface ResourceReadImageInput {
  projectPath: string
  resource: ResourceSnapshot
}
export type ResourceReadImageResult =
  | { ok: true; dataUrl: string }
  | { ok: false; errorCode: ResourceErrorCode; error: string }

export interface ResourceOpenInput {
  resource: ResourceSnapshot
}
export type ResourceOpenResult =
  | { ok: true }
  | { ok: false; errorCode: ResourceErrorCode; error: string }
