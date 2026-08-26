// 使用方法：import type { EntityShell, DetailRef, EntityLocator } from '@shared/types/detail'
// 编译说明：纯类型文件，renderer 与 main 进程均可引用
// 代码说明：统一渐进式披露契约的跨进程类型定义

// ── 详情状态 ────────────────────────────────────────────────────────────────

/** Renderer detail store 中单个详情的状态 */
export type DetailStatus = 'idle' | 'loading' | 'ready' | 'error' | 'stale'

// ── L1 Entity Shell（轻量驻留层）────────────────────────────────────────────

/** 实体的跨进程标识来源优先级：JSONL uuid > tool_use_id > Permission requestId > insertionId > 确定性 fallback */
export type EntityKind =
  | 'user_input'
  | 'assistant'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'summary'

/**
 * 不透明的详情引用。Renderer 只持有此对象，通过 detailKey 向 Main 请求 L2 详情。
 * 不包含文件路径或 byte range（这些由 Main 持有）。
 */
export interface DetailRef {
  /** Main DetailService 分配的不透明 key */
  detailKey: string
  /** 详情版本号，变化时旧缓存失效 */
  revision: number
  /** 来源世代（source generation），locator 失效时变更 */
  sourceGeneration: string
  /** 预估字节数（用于 Renderer cache 预算），-1 表示未知 */
  estimatedSize: number
}

/**
 * L1 Entity Shell：轻量实体摘要。
 * 折叠时 Renderer 只持有此对象，不含完整正文或重对象。
 */
export interface EntityShell {
  /** 稳定实体 ID（按优先级规则生成，不使用随机 fallback） */
  entityId: string
  /** 实体类型 */
  kind: EntityKind
  /** 在 Session/Cluster 内的顺序（0-based） */
  order: number
  /** 4 行视觉摘要所需的有界摘要文本（不包含完整正文） */
  summary: string
  /** 详情引用（如有重内容需要按需加载） */
  detailRef: DetailRef | null
  /** 详情版本号 */
  revision: number
  /** 预估字节数 */
  estimatedSize: number
}


// ── MCP 双区域详情契约 ───────────────────────────────────────────────────────

/** MCP 请求/返回在时间线 shell 中的关联状态。 */
export type McpRequestStatus = 'missing' | 'available'
export type McpResponseStatus = 'pending' | 'ready' | 'empty' | 'error' | 'missing'

/** MCP 插入线使用的轻量关联 shell，不驻留完整 input/content。 */
export interface McpCallShell {
  callId: string
  toolUseId: string
  toolName: string
  displayName?: string
  requestStatus: McpRequestStatus
  responseStatus: McpResponseStatus
  requestDetailRef?: DetailRef
  responseDetailRef?: DetailRef
}

/** MCP 请求详情：input 保留真实 Claude Code tool_use.input。 */
export interface McpRequestDetail {
  kind: 'mcp-request'
  toolUseId: string
  toolName: string
  input: unknown
}

/** MCP 返回详情：content 可为字符串、数组、对象或 null。 */
export interface McpResponseDetail {
  kind: 'mcp-response'
  toolUseId: string
  content: unknown
  isError: boolean
  errorMessage?: string
}

// ── L2 详情定位（Main 持有）────────────────────────────────────────────────

/**
 * EntityLocator：实体在文件系统中的 byte range 定位。
 * 仅由 Main 持有，不通过 IPC 发送给 Renderer。
 */
export interface EntityLocator {
  /** 源文件路径 */
  filePath: string
  /** 起始 byte 偏移 */
  byteStart: number
  /** 结束 byte 偏移（不含） */
  byteEndExclusive: number
  /** 编码 */
  encoding: 'utf-8'
  /** 行尾符 */
  lineEnding: 'lf' | 'crlf'
}

// ── Detail IPC 契约 ────────────────────────────────────────────────────────

/**
 * Renderer → Main：详情请求。
 * Renderer 只提交 detailKey + revision，不指定路径或 byte range。
 */
export interface DetailRequest {
  detailKey: string
  revision: number
  sourceGeneration: string
}

/**
 * Main → Renderer：详情响应（完整或分块的最后一块）。
 */
export interface DetailResponse {
  detailKey: string
  revision: number
  status: 'ready' | 'error' | 'invalidated'
  /** 详情内容（ready 时存在） */
  data?: string
  /** 错误信息（error 时存在） */
  error?: string
}

/**
 * Main → Renderer：分块详情响应（超大详情的中间块）。
 * 最后一块使用 DetailResponse（status='ready'）。
 */
export interface DetailChunk {
  detailKey: string
  revision: number
  /** 当前块的内容片段 */
  chunk: string
  /** 已发送字节数 */
  bytesSent: number
  /** 总字节数（-1 表示未知） */
  totalBytes: number
}

/**
 * Main → Renderer：详情失效通知。
 * source generation 变更时发送。
 */
export interface DetailInvalidation {
  detailKey: string
  sourceGeneration: string
}

// ── Entity ID 来源 ─────────────────────────────────────────────────────────

/**
 * EntityIdSource 优先级：
 * 1. JSONL `uuid` 字段
 * 2. `tool_use_id`（tool_use/tool_result 类型）
 * 3. Permission `requestId`
 * 4. 持久化 insertion ID
 * 5. 确定性 fallback: sha256(sessionId + byteRange + kind + ordinal)
 * 移除实时随机 fallback，保证 realtime→history 交接稳定性。
 */
export type EntityIdSource =
  | { source: 'uuid'; value: string }
  | { source: 'tool_use_id'; value: string }
  | { source: 'request_id'; value: string }
  | { source: 'insertion_id'; value: string }
  | { source: 'deterministic'; sessionId: string; byteStart: number; byteEndExclusive: number; kind: string; ordinal: number }
