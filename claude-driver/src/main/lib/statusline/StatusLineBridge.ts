// 使用方法：import { setupStatusLineBridge } from './lib/statusline/StatusLineBridge'
//           setupStatusLineBridge(39521) // 生成脚本 + 注入 settings.json
// 编译说明：主进程 Node.js 模块
// 代码说明：statusLine 桥接脚本生成器——生成 ~/.claude-driver/statusline-bridge.sh（或 .ps1）
//           Claude Code 每 ~300ms fork 一次该脚本，将状态 JSON 写入其 stdin；脚本用 curl 转发给仪表盘
//           重要：脚本是被动调用的极短命进程（read + curl），不能有任何持久状态

import fs from 'fs'
import path from 'path'
import os from 'os'
import { injectStatusLineConfig, readClaudeSettings, writeClaudeSettings } from '../config/SettingsManager'
import {
  DRIVER_CONFIG_DIRNAME,
  STATUS_LINE_SCRIPT_NAME,
  STATUS_LINE_ENDPOINT
} from '../../../shared/constants/index'

const DRIVER_CONFIG_DIR = path.join(os.homedir(), DRIVER_CONFIG_DIRNAME)

/** 生成 Unix shell 桥接脚本内容 */
function generateUnixScript(port: number): string {
  return `#!/bin/sh
# 使用方法：由 Claude Code 自动调用（每 ~300ms 一次），不要手动运行
# 代码说明：statusLine 桥接脚本——读取 Claude Code 写入 stdin 的状态 JSON，POST 到仪表盘
# 注意：本脚本是被动调用的极短命进程，不能有任何持久状态或后台进程

read -r STATUS_JSON
curl -s -X POST http://127.0.0.1:${port}${STATUS_LINE_ENDPOINT} \\
  -H "Content-Type: application/json" \\
  -d "$STATUS_JSON" > /dev/null 2>&1
`
}

/** 生成 Windows PowerShell 桥接脚本内容 */
function generateWindowsScript(port: number): string {
  return `# 使用方法：由 Claude Code 自动调用（每 ~300ms 一次），不要手动运行
# 代码说明：statusLine 桥接脚本（Windows PowerShell 版）
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$statusJson = [Console]::In.ReadLine()
try {
  Invoke-WebRequest -Uri "http://127.0.0.1:${port}${STATUS_LINE_ENDPOINT}" \`
    -Method POST \`
    -ContentType "application/json; charset=utf-8" \`
    -Body ([System.Text.Encoding]::UTF8.GetBytes($statusJson)) \`
    -UseBasicParsing | Out-Null
} catch {}
`
}

/**
 * 生成桥接脚本并注入 settings.json
 * - Unix（macOS/Linux）：生成 .sh 脚本，chmod +x，注册到 settings.json
 * - Windows：生成 .ps1 脚本，注册 `powershell -File <path>` 命令
 */
export function setupStatusLineBridge(port: number): void {
  // 确保 ~/.claude-driver/ 目录存在
  fs.mkdirSync(DRIVER_CONFIG_DIR, { recursive: true })

  if (process.platform === 'win32') {
    setupWindowsBridge(port)
  } else {
    setupUnixBridge(port)
  }
}

function setupUnixBridge(port: number): void {
  const scriptPath = path.join(DRIVER_CONFIG_DIR, STATUS_LINE_SCRIPT_NAME)
  const content = generateUnixScript(port)

  fs.writeFileSync(scriptPath, content, { encoding: 'utf-8', mode: 0o755 })
  console.log(`[StatusLineBridge] Script written: ${scriptPath}`)

  // 注入 settings.json 的 statusLine 字段
  injectStatusLineConfig(scriptPath)
}

function setupWindowsBridge(port: number): void {
  const scriptName = STATUS_LINE_SCRIPT_NAME.replace('.sh', '.ps1')
  const scriptPath = path.join(DRIVER_CONFIG_DIR, scriptName)
  const content = generateWindowsScript(port)

  fs.writeFileSync(scriptPath, content, { encoding: 'utf-8' })
  console.log(`[StatusLineBridge] PS1 script written: ${scriptPath}`)

  // Windows 下 settings.json 注册为 powershell 命令
  injectStatusLineConfig(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`)
}

/** 移除 statusLine 配置（应用退出时可选调用） */
export function removeStatusLineBridge(): void {
  try {
    const settings = readClaudeSettings()
    delete settings.statusLine
    writeClaudeSettings(settings)
    console.log('[StatusLineBridge] Removed statusLine config from settings.json')
  } catch (err) {
    console.error('[StatusLineBridge] Failed to remove config:', err)
  }
}
