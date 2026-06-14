// 使用方法：import { HOOK_PORT, DRIVER_CONFIG_DIR } from '@renderer/shared/constants'
// 编译说明：此文件在 renderer 进程（browser 环境）中编译，不能 import Node.js 内置模块
//           main 进程使用路径常量时需自行拼接 os.homedir()
// 代码说明：跨进程共享的常量定义（端口号、相对路径片段、超时时间等）

/** Claude Steer HTTP Hook Server 端口号 */
export const HOOK_PORT = 39521

/** Claude Steer 配置目录名（相对于 HOME 目录） */
export const DRIVER_CONFIG_DIRNAME = '.claude-driver'

/** Claude Code 配置目录名（相对于 HOME 目录） */
export const CLAUDE_CONFIG_DIRNAME = '.claude'

/** statusLine 桥接脚本文件名 */
export const STATUS_LINE_SCRIPT_NAME = 'statusline-bridge.sh'

/** PTY 进程超时时间（毫秒）：30 分钟无响应自动关闭 */
export const PTY_TIMEOUT_MS = 30 * 60 * 1000

/** Hook 心跳检测间隔（毫秒）：10 秒 */
export const HEARTBEAT_INTERVAL_MS = 10 * 1000

/** Plan 倒三角指示器最大存活时间（毫秒）：5 分钟无变化后销毁 */
export const PLAN_INDICATOR_TTL_MS = 5 * 60 * 1000

/** Hook Server 监听路径 */
export const HOOK_ENDPOINT = '/hooks'
export const STATUS_LINE_ENDPOINT = '/statusline'
