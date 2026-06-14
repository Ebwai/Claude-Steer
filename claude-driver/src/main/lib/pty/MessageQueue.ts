// 使用方法：import { MessageQueue } from './lib/pty/MessageQueue'
//           const q = new MessageQueue(sessionId, ptyManager)
//           q.enqueue('你好'); // Hook Stop 事件触发后自动 dequeue + 写入 PTY
// 编译说明：主进程 Node.js 模块
// 代码说明：per-session 消息队列（FIFO）——等待 Stop Hook 信号后自动注入下一条消息
//           对应 PRD Q1（入队）/ Q2（Stop Hook 触发出队）/ Q3（自动注入 PTY stdin）

export interface MessageQueueOptions {
  sessionId: string
  /** 向 PTY stdin 写入文本的函数 */
  writeFn: (sessionId: string, text: string) => void
}

export class MessageQueue {
  private queue: string[] = []
  private sessionId: string
  private writeFn: (sessionId: string, text: string) => void
  /** Claude 是否正在响应中（Stop Hook 未到则为 true） */
  private isProcessing = false

  constructor(opts: MessageQueueOptions) {
    this.sessionId = opts.sessionId
    this.writeFn = opts.writeFn
  }

  /**
   * Q1：入队——将消息加入队列尾部
   * 若 Claude 当前空闲（isProcessing=false）则立即注入
   */
  enqueue(message: string): void {
    if (!this.isProcessing) {
      // Claude 空闲，直接发送
      this.inject(message)
    } else {
      // Claude 忙碌，加入等待队列
      this.queue.push(message)
      console.log(`[MessageQueue:${this.sessionId}] Queued message, queue length: ${this.queue.length}`)
    }
  }

  /**
   * Q2：Stop Hook 触发——Claude 完成响应，从队列取下一条发送
   * 应在收到 Claude Code Stop Hook 事件时调用
   */
  onStop(): void {
    this.isProcessing = false

    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      console.log(`[MessageQueue:${this.sessionId}] Stop received, injecting queued message`)
      this.inject(next)
    }
  }

  /** 获取队列长度 */
  get length(): number {
    return this.queue.length
  }

  /** 清空队列（session 停止时调用） */
  clear(): void {
    this.queue = []
    this.isProcessing = false
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────

  /** Q3：实际写入 PTY stdin */
  private inject(message: string): void {
    this.isProcessing = true
    console.log(`[MessageQueue:${this.sessionId}] Injecting message: ${message.slice(0, 50)}...`)
    this.writeFn(this.sessionId, message)
  }
}
