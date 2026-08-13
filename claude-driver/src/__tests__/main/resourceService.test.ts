// 使用方法：npm test -- src/__tests__/main/resourceService.test.ts
// 代码说明：资源导入、消息编号、PTY 发送/JSONL 绑定与系统打开错误回归测试

import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { openPath } = vi.hoisted(() => ({ openPath: vi.fn() }))
vi.mock('electron', () => ({ shell: { openPath } }))

import {
  ResourceService,
  formatResourceMessage,
  openPathWithDefaultApp
} from '../../main/lib/resources/ResourceService'
import type { ResourceSnapshot } from '../../shared/types/resources'

describe('ResourceService', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-steer-resources-'))
    openPath.mockReset()
  })

  afterEach(() => {
    if (root.startsWith(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true })
  })

  it('numbers each resource kind while preserving global insertion order', () => {
    const resources: ResourceSnapshot[] = [
      {
        id: 'a',
        kind: 'image',
        origin: 'managed',
        path: 'F:\\p\\a.png',
        displayName: 'a.png',
        order: 0,
        typeIndex: 0
      },
      {
        id: 'b',
        kind: 'pdf',
        origin: 'original',
        path: 'F:\\p\\b.pdf',
        displayName: 'b.pdf',
        order: 1,
        typeIndex: 0
      },
      {
        id: 'c',
        kind: 'image',
        origin: 'managed',
        path: 'F:\\p\\c.png',
        displayName: 'c.png',
        order: 2,
        typeIndex: 0
      }
    ]
    expect(formatResourceMessage('请分析', resources).finalText).toBe(
      '图1：F:\\p\\a.png\nPDF1：F:\\p\\b.pdf\n图2：F:\\p\\c.png\n\n请分析'
    )
    expect(formatResourceMessage('纯文本', []).finalText).toBe('纯文本')
  })

  it('copies images into the managed project directory but retains document original paths', async () => {
    const image = path.join(root, 'source.png')
    const pdf = path.join(root, 'source.pdf')
    fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    fs.writeFileSync(pdf, 'pdf')
    const service = new ResourceService({
      writeToSession: vi.fn(),
      resolvePtyId: (id) => id,
      resolveClaudeId: () => undefined,
      onBound: vi.fn()
    })

    const result = await service.importPaths({ projectPath: root, paths: [image, pdf] })

    expect(result.ok).toBe(true)
    expect(result.resources[0].origin).toBe('managed')
    expect(result.resources[0].path).toContain(path.join('.claude-steer', 'resources', 'images'))
    expect(fs.existsSync(result.resources[0].path)).toBe(true)
    expect(result.resources[1]).toMatchObject({ origin: 'original', path: path.resolve(pdf) })
  })

  it('rejects clipboard bytes whose content does not match the declared image type', async () => {
    const service = new ResourceService({
      writeToSession: vi.fn(),
      resolvePtyId: (id) => id,
      resolveClaudeId: () => undefined,
      onBound: vi.fn()
    })
    const result = await service.importImage({
      projectPath: root,
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png'
    })
    expect(result).toMatchObject({
      ok: false,
      failures: [{ errorCode: 'RESOURCE_IMAGE_DECODE_FAILED' }]
    })
  })

  it('persists resources only after matching the real JSONL user UUID', async () => {
    const writeToSession = vi.fn().mockResolvedValue(undefined)
    const onBound = vi.fn()
    const service = new ResourceService({
      writeToSession,
      resolvePtyId: () => 'pty-1',
      resolveClaudeId: () => 'claude-1',
      onBound
    })
    const pdf = path.join(root, 'spec.pdf')
    fs.writeFileSync(pdf, 'pdf')
    const resource: ResourceSnapshot = {
      id: 'pdf-1',
      kind: 'pdf',
      origin: 'original',
      path: pdf,
      displayName: 'spec.pdf',
      order: 0,
      typeIndex: 0
    }
    const sent = await service.send({
      sessionId: 'claude-1',
      projectPath: root,
      text: '分析',
      resources: [resource]
    })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return

    await service.handleJsonlRecord(
      {
        type: 'user',
        uuid: 'user-uuid',
        text: sent.finalText,
        parsedAt: Date.now(),
        raw: {}
      },
      'claude-1',
      path.join(root, 'claude-1.jsonl')
    )

    const sidecar = fs.readFileSync(path.join(root, 'claude-1.resources.jsonl'), 'utf8')
    expect(JSON.parse(sidecar)).toMatchObject({ userMessageUuid: 'user-uuid' })
    expect(onBound).toHaveBeenCalledWith(expect.objectContaining({ userMessageUuid: 'user-uuid' }))
  })

  it('reports shell.openPath error strings as failures', async () => {
    openPath.mockResolvedValue('No application is associated with the specified file')
    await expect(openPathWithDefaultApp('F:\\docs\\file.pdf')).resolves.toMatchObject({
      ok: false,
      errorCode: 'RESOURCE_OPEN_FAILED'
    })
  })

  it('recovers a sent ledger transaction and binds it after restart', async () => {
    const pdf = path.join(root, 'recover.pdf')
    fs.writeFileSync(pdf, 'pdf')
    const resource: ResourceSnapshot = {
      id: 'recover-1',
      kind: 'pdf',
      origin: 'original',
      path: pdf,
      displayName: 'recover.pdf',
      order: 0,
      typeIndex: 0
    }
    const first = new ResourceService({
      writeToSession: vi.fn().mockResolvedValue(undefined),
      resolvePtyId: () => 'pty-recover',
      resolveClaudeId: () => undefined,
      onBound: vi.fn()
    })
    const sent = await first.send({
      sessionId: 'pty-recover',
      projectPath: root,
      text: '恢复绑定',
      resources: [resource]
    })
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    fs.writeFileSync(
      path.join(root, 'claude-recover.jsonl'),
      `${JSON.stringify({
        type: 'user',
        uuid: 'recovered-user',
        timestamp: new Date().toISOString(),
        message: { content: sent.finalText }
      })}\n`
    )
    const onBound = vi.fn()
    const restarted = new ResourceService({
      writeToSession: vi.fn(),
      resolvePtyId: (id) => id,
      resolveClaudeId: () => undefined,
      onBound
    })

    await restarted.bindPtyToClaude(
      'pty-recover',
      'claude-recover',
      path.join(root, 'claude-recover.jsonl'),
      root
    )

    expect(onBound).toHaveBeenCalledWith(
      expect.objectContaining({ userMessageUuid: 'recovered-user' })
    )
    expect(fs.existsSync(path.join(root, 'claude-recover.resources.jsonl'))).toBe(true)
  })
})
