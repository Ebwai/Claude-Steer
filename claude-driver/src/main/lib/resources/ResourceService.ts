// 关联资源服务：图片长期受管、文档保留原路径、即时 PTY 发送与 JSONL UUID 绑定

import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { shell } from 'electron'
import type { JsonlRecord } from '../../../shared/types/jsonl'
import { parseJsonlObject } from '../jsonl/JsonlParser'
import type {
  ResourceBoundPayload,
  ResourceDraft,
  ResourceImportImageInput,
  ResourceImportPathsInput,
  ResourceImportResult,
  ResourceItemFailure,
  ResourceKind,
  ResourceMessageSnapshot,
  ResourceOpenResult,
  ResourceReadImageInput,
  ResourceReadImageResult,
  ResourceSendInput,
  ResourceSendResult,
  ResourceSnapshot
} from '../../../shared/types/resources'

const KIND_BY_EXTENSION: Record<string, ResourceKind> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.doc': 'word',
  '.docx': 'word',
  '.pdf': 'pdf',
  '.ppt': 'ppt',
  '.pptx': 'ppt',
  '.md': 'markdown',
  '.markdown': 'markdown'
}
const LABEL_BY_KIND: Record<ResourceKind, string> = {
  image: '图',
  word: 'Word',
  pdf: 'PDF',
  ppt: 'PPT',
  markdown: 'Markdown'
}
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

interface PendingTransaction {
  transactionId: string
  ptyId: string
  claudeId?: string
  transcriptPath?: string
  projectPath: string
  finalText: string
  messageHash: string
  resources: ResourceSnapshot[]
  sentAt: number
}

interface LedgerEvent {
  version: 1
  state: 'preparing' | 'sent' | 'routed' | 'bound' | 'failed'
  recordedAt: number
  transaction: PendingTransaction
  userMessageUuid?: string
  errorCode?: string
}

export interface ResourceServiceDeps {
  writeToSession: (ptyId: string, text: string) => Promise<void>
  resolvePtyId: (sessionId: string) => string
  resolveClaudeId: (ptyId: string) => string | undefined
  onBound: (payload: ResourceBoundPayload) => void
}

export function classifyResourcePath(filePath: string): ResourceKind | null {
  return KIND_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null
}

export function hashMessage(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
}

export function formatResourceMessage(
  text: string,
  resources: ResourceSnapshot[]
): { finalText: string; resources: ResourceSnapshot[] } {
  const counts: Record<ResourceKind, number> = { image: 0, word: 0, pdf: 0, ppt: 0, markdown: 0 }
  const numbered = [...resources]
    .sort((a, b) => a.order - b.order)
    .map((resource, order) => ({ ...resource, order, typeIndex: ++counts[resource.kind] }))
  const prefix = numbered
    .map((resource) => `${LABEL_BY_KIND[resource.kind]}${resource.typeIndex}：${resource.path}`)
    .join('\n')
  const body = text.trim()
  if (!prefix) return { finalText: body, resources: numbered }
  return { finalText: body ? `${prefix}\n\n${body}` : prefix, resources: numbered }
}

function validatePathText(filePath: string): void {
  if (!path.isAbsolute(filePath) || /[\0\r\n]/.test(filePath)) {
    throw Object.assign(new Error('资源路径必须是无换行控制字符的绝对路径'), {
      code: 'RESOURCE_PATH_INVALID'
    })
  }
}

function isPathInside(rootDir: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function toResourceErrorCode(
  error: NodeJS.ErrnoException & { code?: string },
  fallback: ResourceItemFailure['errorCode']
): ResourceItemFailure['errorCode'] {
  if (error.code?.startsWith('RESOURCE_')) return error.code as ResourceItemFailure['errorCode']
  if (error.code === 'ENOENT') return 'RESOURCE_NOT_FOUND'
  return fallback
}

function detectImageExtension(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )
  )
    return '.png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return '.jpg'
  if (
    bytes.length >= 6 &&
    (Buffer.from(bytes.subarray(0, 6)).toString('ascii') === 'GIF87a' ||
      Buffer.from(bytes.subarray(0, 6)).toString('ascii') === 'GIF89a')
  )
    return '.gif'
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
  )
    return '.webp'
  return null
}

async function validateImageFileContent(filePath: string): Promise<void> {
  const file = await fs.promises.open(filePath, 'r')
  try {
    const header = Buffer.alloc(12)
    const { bytesRead } = await file.read(header, 0, header.length, 0)
    const detected = detectImageExtension(header.subarray(0, bytesRead))
    const declared =
      path.extname(filePath).toLowerCase() === '.jpeg'
        ? '.jpg'
        : path.extname(filePath).toLowerCase()
    if (!detected || detected !== declared) {
      throw Object.assign(new Error('图片内容与扩展名不匹配'), {
        code: 'RESOURCE_IMAGE_DECODE_FAILED'
      })
    }
  } finally {
    await file.close()
  }
}

async function atomicCopy(source: string, destination: string): Promise<void> {
  const temp = `${destination}.tmp`
  try {
    await fs.promises.copyFile(source, temp, fs.constants.COPYFILE_EXCL)
    await fs.promises.rename(temp, destination)
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function atomicWriteBytes(bytes: Uint8Array, destination: string): Promise<void> {
  const temp = `${destination}.tmp`
  try {
    await fs.promises.writeFile(temp, bytes, { flag: 'wx' })
    await fs.promises.rename(temp, destination)
  } catch (error) {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function toPreviewDataUrl(filePath: string): Promise<string> {
  const bytes = await fs.promises.readFile(filePath)
  const mime = MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  return `data:${mime};base64,${bytes.toString('base64')}`
}

function createSnapshot(
  filePath: string,
  kind: ResourceKind,
  origin: 'managed' | 'original',
  displayName: string
): ResourceDraft {
  return { id: randomUUID(), kind, origin, path: filePath, displayName, order: 0, typeIndex: 0 }
}

export async function openPathWithDefaultApp(targetPath: string): Promise<ResourceOpenResult> {
  try {
    const error = await shell.openPath(targetPath)
    if (error) return { ok: false, errorCode: 'RESOURCE_OPEN_FAILED', error }
    return { ok: true }
  } catch (error) {
    return { ok: false, errorCode: 'RESOURCE_OPEN_FAILED', error: String(error) }
  }
}

export class ResourceService {
  private pendingByPty = new Map<string, PendingTransaction[]>()
  private pendingByClaude = new Map<string, PendingTransaction[]>()
  private loadedProjectLedgers = new Set<string>()

  constructor(private readonly deps: ResourceServiceDeps) {}

  async importPaths(input: ResourceImportPathsInput): Promise<ResourceImportResult> {
    const resources: ResourceDraft[] = []
    const failures: ResourceItemFailure[] = []
    try {
      validatePathText(input.projectPath)
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { code?: string }
      return {
        ok: false,
        resources,
        failures: [
          {
            path: input.projectPath,
            errorCode: toResourceErrorCode(e, 'RESOURCE_PATH_INVALID'),
            error: e.message
          }
        ],
        error: e.message
      }
    }
    for (const originalPath of input.paths) {
      try {
        validatePathText(originalPath)
        const kind = classifyResourcePath(originalPath)
        if (!kind)
          throw Object.assign(new Error('不支持的资源类型'), { code: 'RESOURCE_UNSUPPORTED_TYPE' })
        const stat = await fs.promises.stat(originalPath)
        if (!stat.isFile())
          throw Object.assign(new Error('资源不是普通文件'), { code: 'RESOURCE_PATH_INVALID' })
        if (kind === 'image') {
          await validateImageFileContent(originalPath)
          const imagesDir = path.join(input.projectPath, '.claude-steer', 'resources', 'images')
          await fs.promises.mkdir(imagesDir, { recursive: true })
          const destination = path.join(
            imagesDir,
            `${randomUUID()}${path.extname(originalPath).toLowerCase()}`
          )
          await atomicCopy(originalPath, destination)
          const draft = createSnapshot(destination, kind, 'managed', path.basename(originalPath))
          draft.previewDataUrl = await toPreviewDataUrl(destination)
          resources.push(draft)
        } else {
          resources.push(
            createSnapshot(
              path.resolve(originalPath),
              kind,
              'original',
              path.basename(originalPath)
            )
          )
        }
      } catch (error) {
        const e = error as NodeJS.ErrnoException & { code?: string }
        failures.push({
          path: originalPath,
          displayName: path.basename(originalPath),
          errorCode: toResourceErrorCode(e, 'RESOURCE_IO_ERROR'),
          error: e.message
        })
        console.warn(
          `[ResourceService] import failed kind=${classifyResourcePath(originalPath) ?? 'unknown'} code=${e.code ?? 'RESOURCE_IO_ERROR'} pathHash=${hashMessage(originalPath).slice(0, 12)}`
        )
      }
    }
    resources.forEach((resource, order) => {
      resource.order = order
    })
    return failures.length && !resources.length
      ? { ok: false, resources, failures, error: '没有可导入的资源' }
      : { ok: true, resources, failures }
  }

  async importImage(input: ResourceImportImageInput): Promise<ResourceImportResult> {
    try {
      validatePathText(input.projectPath)
      if (!input.bytes.length) throw new Error('剪贴板图片为空')
      const imagesDir = path.join(input.projectPath, '.claude-steer', 'resources', 'images')
      await fs.promises.mkdir(imagesDir, { recursive: true })
      const detectedExtension = detectImageExtension(input.bytes)
      const declaredExtension = EXTENSION_BY_MIME[input.mimeType ?? 'image/png']
      if (!detectedExtension || !declaredExtension || detectedExtension !== declaredExtension) {
        throw Object.assign(
          new Error(`剪贴板图片内容与类型不匹配：${input.mimeType ?? 'unknown'}`),
          { code: 'RESOURCE_IMAGE_DECODE_FAILED' }
        )
      }
      const extension = detectedExtension
      const destination = path.join(imagesDir, `${randomUUID()}${extension}`)
      await atomicWriteBytes(input.bytes, destination)
      const draft = createSnapshot(
        destination,
        'image',
        'managed',
        input.displayName || `粘贴图片${extension}`
      )
      draft.previewDataUrl = await toPreviewDataUrl(destination)
      return { ok: true, resources: [draft], failures: [] }
    } catch (error) {
      const item = {
        displayName: input.displayName,
        errorCode: 'RESOURCE_IMAGE_DECODE_FAILED' as const,
        error: String(error)
      }
      return { ok: false, resources: [], failures: [item], error: item.error }
    }
  }

  async send(input: ResourceSendInput): Promise<ResourceSendResult> {
    try {
      await this.ensureProjectLedgerLoaded(input.projectPath)
      const managedImagesDir = path.join(input.projectPath, '.claude-steer', 'resources', 'images')
      for (const resource of input.resources) {
        validatePathText(resource.path)
        if (
          resource.kind === 'image' &&
          (resource.origin !== 'managed' || !isPathInside(managedImagesDir, resource.path))
        ) {
          throw Object.assign(
            new Error(`图片不在当前项目的受管资源目录：${resource.displayName}`),
            { code: 'RESOURCE_PATH_INVALID' }
          )
        }
        const stat = await fs.promises.stat(resource.path)
        if (!stat.isFile())
          throw Object.assign(new Error(`资源不存在：${resource.displayName}`), {
            code: 'RESOURCE_NOT_FOUND'
          })
      }
      const formatted = formatResourceMessage(input.text, input.resources)
      if (!formatted.finalText)
        throw Object.assign(new Error('消息内容为空'), { code: 'RESOURCE_PATH_INVALID' })
      const ptyId = this.deps.resolvePtyId(input.sessionId)
      const transaction: PendingTransaction = {
        transactionId: randomUUID(),
        ptyId,
        claudeId: this.deps.resolveClaudeId(ptyId),
        projectPath: input.projectPath,
        finalText: formatted.finalText,
        messageHash: hashMessage(formatted.finalText),
        resources: formatted.resources,
        sentAt: Date.now()
      }
      this.enqueue(transaction)
      try {
        await this.appendLedger(transaction, 'preparing')
        await this.deps.writeToSession(ptyId, formatted.finalText)
      } catch (error) {
        this.removePending(transaction)
        await this.appendLedger(
          transaction,
          'failed',
          undefined,
          'RESOURCE_PTY_WRITE_FAILED'
        ).catch((ledgerError: unknown) => {
          console.error('[ResourceService] failed to append failure ledger event:', ledgerError)
        })
        throw error
      }
      await this.appendLedger(transaction, 'sent').catch((ledgerError: unknown) => {
        console.error(
          `[ResourceService] sent ledger append failed transaction=${transaction.transactionId}:`,
          ledgerError
        )
      })
      console.info(
        `[ResourceService] sent transaction=${transaction.transactionId} pty=${ptyId.slice(0, 8)} claude=${transaction.claudeId?.slice(0, 8) ?? 'pending'} resources=${transaction.resources.length}`
      )
      return {
        ok: true,
        transactionId: transaction.transactionId,
        finalText: formatted.finalText,
        resources: formatted.resources
      }
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { code?: string }
      return {
        ok: false,
        errorCode: toResourceErrorCode(e, 'RESOURCE_PTY_WRITE_FAILED'),
        error: e.message
      }
    }
  }

  async bindPtyToClaude(
    ptyId: string,
    claudeId: string,
    transcriptPath: string,
    projectPath: string
  ): Promise<void> {
    await this.ensureProjectLedgerLoaded(projectPath)
    const pending = this.pendingByPty.get(ptyId) ?? []
    if (pending.length) {
      this.pendingByPty.delete(ptyId)
      const target = this.pendingByClaude.get(claudeId) ?? []
      for (const item of pending) {
        item.claudeId = claudeId
        item.transcriptPath = transcriptPath
        target.push(item)
        await this.appendLedger(item, 'routed')
      }
      this.pendingByClaude.set(claudeId, target)
      console.info(
        `[ResourceService] route migrated pty=${ptyId.slice(0, 8)} claude=${claudeId.slice(0, 8)} pending=${pending.length}`
      )
    }
    await this.recoverAgainstTranscript(claudeId, transcriptPath)
  }

  async handleJsonlRecord(
    record: JsonlRecord,
    claudeId: string,
    transcriptPath: string
  ): Promise<void> {
    if (record.type !== 'user' || !record.uuid || !record.text) return
    const queue = this.pendingByClaude.get(claudeId)
    if (!queue?.length) return
    const index = queue.findIndex(
      (item) =>
        item.messageHash === hashMessage(record.text!) && record.parsedAt >= item.sentAt - 1000
    )
    if (index < 0) return
    const [transaction] = queue.splice(index, 1)
    if (!queue.length) this.pendingByClaude.delete(claudeId)
    await this.persistBoundTransaction(transaction, claudeId, record.uuid, transcriptPath)
  }

  private async persistBoundTransaction(
    transaction: PendingTransaction,
    claudeId: string,
    userMessageUuid: string,
    transcriptPath: string
  ): Promise<void> {
    const snapshot: ResourceMessageSnapshot = {
      version: 1,
      transactionId: transaction.transactionId,
      claudeId,
      userMessageUuid,
      messageHash: transaction.messageHash,
      resources: transaction.resources,
      boundAt: Date.now()
    }
    const sidecarPath = path.join(path.dirname(transcriptPath), `${claudeId}.resources.jsonl`)
    let alreadyPersisted = false
    try {
      const existing = await fs.promises.readFile(sidecarPath, 'utf8')
      alreadyPersisted = existing.split(/\r?\n/).some((line) => {
        if (!line.trim()) return false
        try {
          return (
            (JSON.parse(line) as ResourceMessageSnapshot).transactionId ===
            transaction.transactionId
          )
        } catch {
          return false
        }
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!alreadyPersisted)
      await fs.promises.appendFile(sidecarPath, `${JSON.stringify(snapshot)}\n`, 'utf8')
    await this.appendLedger(transaction, 'bound', userMessageUuid)
    this.deps.onBound({ sessionId: claudeId, userMessageUuid, resources: transaction.resources })
    console.info(
      `[ResourceService] bound transaction=${transaction.transactionId} claude=${claudeId.slice(0, 8)} user=${userMessageUuid.slice(0, 8)} resources=${transaction.resources.length}`
    )
  }

  async readImage(input: ResourceReadImageInput): Promise<ResourceReadImageResult> {
    const { projectPath, resource } = input
    if (resource.kind !== 'image' || resource.origin !== 'managed')
      return { ok: false, errorCode: 'RESOURCE_PATH_INVALID', error: '不是受管图片资源' }
    const imagesDir = path.join(projectPath, '.claude-steer', 'resources', 'images')
    if (!isPathInside(imagesDir, resource.path))
      return { ok: false, errorCode: 'RESOURCE_PATH_INVALID', error: '图片不在当前项目受管目录' }
    try {
      return { ok: true, dataUrl: await toPreviewDataUrl(resource.path) }
    } catch (error) {
      return { ok: false, errorCode: 'RESOURCE_NOT_FOUND', error: String(error) }
    }
  }

  async open(resource: ResourceSnapshot): Promise<ResourceOpenResult> {
    if (resource.kind === 'image')
      return { ok: false, errorCode: 'RESOURCE_PATH_INVALID', error: '图片应在应用内预览' }
    try {
      validatePathText(resource.path)
      if (classifyResourcePath(resource.path) !== resource.kind)
        throw new Error('资源类型与路径不匹配')
      if (!(await fs.promises.stat(resource.path)).isFile()) throw new Error('资源不是普通文件')
    } catch (error) {
      const code =
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'RESOURCE_NOT_FOUND'
          : 'RESOURCE_PATH_INVALID'
      return { ok: false, errorCode: code, error: String(error) }
    }
    return openPathWithDefaultApp(resource.path)
  }

  private enqueue(transaction: PendingTransaction): void {
    if (transaction.claudeId) {
      const list = this.pendingByClaude.get(transaction.claudeId) ?? []
      list.push(transaction)
      this.pendingByClaude.set(transaction.claudeId, list)
    } else {
      const list = this.pendingByPty.get(transaction.ptyId) ?? []
      list.push(transaction)
      this.pendingByPty.set(transaction.ptyId, list)
    }
  }

  private removePending(transaction: PendingTransaction): void {
    const removeFrom = (map: Map<string, PendingTransaction[]>, key: string | undefined): void => {
      if (!key) return
      const list = map.get(key)
      if (!list) return
      const next = list.filter((item) => item.transactionId !== transaction.transactionId)
      if (next.length) map.set(key, next)
      else map.delete(key)
    }
    removeFrom(this.pendingByPty, transaction.ptyId)
    removeFrom(this.pendingByClaude, transaction.claudeId)
  }

  private ledgerPath(projectPath: string): string {
    return path.join(projectPath, '.claude-steer', 'resources', 'resource-transactions.jsonl')
  }

  private async appendLedger(
    transaction: PendingTransaction,
    state: LedgerEvent['state'],
    userMessageUuid?: string,
    errorCode?: string
  ): Promise<void> {
    const ledgerPath = this.ledgerPath(transaction.projectPath)
    await fs.promises.mkdir(path.dirname(ledgerPath), { recursive: true })
    const event: LedgerEvent = {
      version: 1,
      state,
      recordedAt: Date.now(),
      transaction,
      userMessageUuid,
      errorCode
    }
    await fs.promises.appendFile(ledgerPath, `${JSON.stringify(event)}\n`, 'utf8')
  }

  private async ensureProjectLedgerLoaded(projectPath: string): Promise<void> {
    const key = path.resolve(projectPath)
    if (this.loadedProjectLedgers.has(key)) return
    this.loadedProjectLedgers.add(key)
    let content: string
    try {
      content = await fs.promises.readFile(this.ledgerPath(projectPath), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[ResourceService] ledger read failed:', error)
      return
    }
    const latest = new Map<string, LedgerEvent>()
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line) as LedgerEvent
        if (event.version === 1 && event.transaction?.transactionId)
          latest.set(event.transaction.transactionId, event)
      } catch {
        console.warn(
          `[ResourceService] malformed ledger line project=${path.basename(projectPath)}`
        )
      }
    }
    let recovered = 0
    for (const event of latest.values()) {
      if (event.state !== 'sent' && event.state !== 'routed') continue
      this.enqueue(event.transaction)
      recovered++
    }
    if (recovered)
      console.info(
        `[ResourceService] ledger recovered project=${path.basename(projectPath)} pending=${recovered}`
      )
  }

  private async recoverAgainstTranscript(claudeId: string, transcriptPath: string): Promise<void> {
    const queue = this.pendingByClaude.get(claudeId)
    if (!queue?.length || !transcriptPath) return
    let lines: string[]
    try {
      lines = (await fs.promises.readFile(transcriptPath, 'utf8')).split(/\r?\n/)
    } catch {
      return
    }
    const users: JsonlRecord[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const record = parseJsonlObject(JSON.parse(line) as Record<string, unknown>)
        if (record?.type === 'user' && record.uuid && record.text) users.push(record)
      } catch {
        /* malformed transcript lines are handled by JsonlWatcher */
      }
    }
    for (const transaction of [...queue]) {
      const candidates = users.filter(
        (record) =>
          hashMessage(record.text!) === transaction.messageHash &&
          record.parsedAt >= transaction.sentAt - 1000
      )
      if (candidates.length !== 1) {
        if (candidates.length > 1)
          console.warn(
            `[ResourceService] recovery ambiguous transaction=${transaction.transactionId} candidates=${candidates.length}`
          )
        continue
      }
      this.removePending(transaction)
      await this.persistBoundTransaction(transaction, claudeId, candidates[0].uuid!, transcriptPath)
    }
  }
}
