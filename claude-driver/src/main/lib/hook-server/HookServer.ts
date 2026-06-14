// 使用方法：import { startHookServer } from './lib/hook-server/HookServer'
//           startHookServer(39521, onHookEvent, onStatusLine, onPortConflict)
// 编译说明：主进程 Node.js 模块，不可在渲染进程中引用
// 代码说明：轻量 HTTP Server，接收 Claude Code Hook 事件（/hooks）和 statusLine 桥接数据（/statusline）
//           使用原生 http 模块，零依赖，端口冲突时回调通知调用方

import http from 'http'
import type { HookPayload, StatusLineData } from '../../../shared/types/index'

export interface HookServerHandlers {
  onHookEvent: (payload: HookPayload) => void
  onStatusLine: (data: StatusLineData) => void
  onPortConflict: (port: number) => void
  onError: (err: Error) => void
}

/** 解析请求体 JSON（手动拼接 data chunks，避免 body-parser 依赖） */
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('Invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** 发送 JSON 响应 */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

/**
 * 启动 Hook HTTP Server
 * @returns 启动成功后解析为 http.Server 实例（端口冲突时 Promise 不 resolve，通过 onPortConflict 回调通知）
 */
export function startHookServer(
  port: number,
  handlers: HookServerHandlers
): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const { method, url } = req

      // 仅接受 POST 请求
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' })
        return
      }

      let body: unknown
      try {
        body = await readBody(req)
      } catch (err) {
        console.error('[HookServer] Failed to parse request body:', err)
        sendJson(res, 400, { error: 'Bad request' })
        return
      }

      if (url === '/hooks') {
        // Claude Code Hook 事件
        console.log(`[HookServer] Received /hooks request, payload keys: ${Object.keys(body as Record<string, unknown>).join(',')}`)
        try {
          handlers.onHookEvent(body as HookPayload)
          sendJson(res, 200, { ok: true })
        } catch (err) {
          console.error('[HookServer] onHookEvent handler error:', err)
          sendJson(res, 500, { error: 'Internal error' })
        }
      } else if (url === '/statusline') {
        // statusLine 桥接脚本转发的状态数据
        try {
          handlers.onStatusLine(body as StatusLineData)
          sendJson(res, 200, { ok: true })
        } catch (err) {
          console.error('[HookServer] onStatusLine handler error:', err)
          sendJson(res, 500, { error: 'Internal error' })
        }
      } else {
        sendJson(res, 404, { error: 'Not found' })
      }
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // 端口被占用——通知调用方弹窗提示，Server 不启动
        console.error(`[HookServer] Port ${port} already in use`)
        handlers.onPortConflict(port)
      } else {
        console.error('[HookServer] Server error:', err)
        handlers.onError(err)
      }
    })

    server.listen(port, '127.0.0.1', () => {
      console.log(`[HookServer] Listening on http://127.0.0.1:${port}`)
      resolve(server)
    })
  })
}

/** 停止 Hook Server */
export function stopHookServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        console.error('[HookServer] Error stopping server:', err)
        reject(err)
      } else {
        console.log('[HookServer] Server stopped')
        resolve()
      }
    })
  })
}
