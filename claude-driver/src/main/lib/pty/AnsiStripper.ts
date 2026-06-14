// 使用方法：import { stripAnsi } from './lib/pty/AnsiStripper'
//           const clean = stripAnsi(rawPtyOutput)
// 编译说明：主进程 Node.js 模块
// 代码说明：ANSI 控制码过滤——从 PTY stdout 原始数据中提取纯文本
//           过滤范围：ESC 序列（CSI/OSC/SGR）、光标控制码、颜色码

/** ANSI 控制序列正则（覆盖 CSI/OSC/SGR 等常见序列） */
const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g

/** 过滤 ANSI 控制码，返回纯文本 */
export function stripAnsi(raw: string): string {
  return raw.replace(ANSI_REGEX, '')
}

/**
 * 判断一段 PTY 输出是否为 Claude 的正文内容（而非 terminal 转义序列）
 * 简单启发式：去除 ANSI 码后有可打印字符即为正文
 */
export function isPrintableContent(raw: string): boolean {
  const stripped = stripAnsi(raw)
  return /\S/.test(stripped)
}
