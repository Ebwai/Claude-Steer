// 使用方法：import RemoteBridgeService from './services/RemoteBridgeService'
//           在 index.ts registerIpcHandlers 中实例化并注册 CC_CONNECT_* IPC handler
// 编译说明：主进程 Node.js 模块
// 代码说明：cc-connect 安装检测 + ~/.cc-connect/config.toml 细粒度管理
//           读取-修改-写入策略：只操作对应 [[projects]] 段，保留其他配置不动

import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import * as TOML from 'smol-toml'
import type { FeishuBotConfig } from '../../shared/types/index'
import { upsertProject, readProjects } from '../lib/projects/ProjectStore'

const CC_DIR = path.join(os.homedir(), '.cc-connect')
const CONFIG_PATH = path.join(CC_DIR, 'config.toml')

export class RemoteBridgeService {

  // ── 安装检测 ────────────────────────────────────────────────────────────────

  checkInstall(): Promise<{ installed: boolean; version?: string }> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which'
      execFile(cmd, ['cc-connect'], (err) => {
        if (err) {
          console.log('[remote] cc-connect not found')
          resolve({ installed: false })
          return
        }
        execFile('cc-connect', ['--version'], (verErr, stdout) => {
          const version = verErr ? undefined : stdout.trim().split('\n')[0]
          console.log(`[remote] cc-connect found, version: ${version ?? 'unknown'}`)
          resolve({ installed: true, version })
        })
      })
    })
  }

  // ── config.toml 细粒度管理 ────────────────────────────────────────────────

  /**
   * 读取 config.toml，返回解析后的对象（文件不存在返回空对象）
   */
  private readToml(): Record<string, unknown> {
    try {
      if (!fs.existsSync(CONFIG_PATH)) {
        console.log('[remote] config.toml not found, starting fresh')
        return {}
      }
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
      return TOML.parse(raw) as Record<string, unknown>
    } catch (err) {
      console.error('[remote] failed to parse config.toml:', err)
      return {}
    }
  }

  /**
   * 将对象序列化为 TOML 并写入 config.toml
   */
  private writeToml(data: Record<string, unknown>): void {
    try {
      fs.mkdirSync(CC_DIR, { recursive: true })
      const content = TOML.stringify(data as TOML.TomlPrimitive)
      fs.writeFileSync(CONFIG_PATH, content, 'utf-8')
      console.log('[remote] config.toml written successfully')
    } catch (err) {
      console.error('[remote] failed to write config.toml:', err)
      throw err
    }
  }

  /**
   * 保存项目 bot 配置 — 读取-修改-写入策略
   * 只操作 name 匹配的 [[projects]] 段，其他配置保持不动
   */
  saveProjectBot(projectId: string, bot: FeishuBotConfig): void {
    // 1. 更新项目存储中的 feishuBot
    const projects = readProjects()
    const project = projects.find((p) => p.id === projectId)
    if (!project) {
      console.error(`[remote] saveProjectBot: project ${projectId} not found`)
      return
    }
    upsertProject({ ...project, feishuBot: bot })
    console.log(`[remote] saved feishuBot config for project ${project.name}`)

    // 2. 读取现有 config.toml
    const config = this.readToml()

    // 3. 查找或创建对应 [[projects]] 段
    const projectsList = (config.projects ?? []) as Record<string, unknown>[]
    let existing = projectsList.find(
      (p) => (p.name as string) === project.name
    ) as Record<string, unknown> | undefined

    if (!existing) {
      existing = { name: project.name }
      projectsList.push(existing)
    }

    // 4. 更新 [[projects]] 顶层字段
    existing.admin_from = bot.adminFrom || ''

    // 5. 更新 [projects.agent] 段
    const agent = (existing.agent ?? {}) as Record<string, unknown>
    agent.type = 'claudecode'
    existing.agent = agent

    // 6. 更新 [projects.agent.options] 段
    const agentOptions = (agent.options ?? {}) as Record<string, unknown>
    agentOptions.work_dir = project.path
    if (bot.agentMode) agentOptions.mode = bot.agentMode
    else delete agentOptions.mode
    if (bot.model) agentOptions.model = bot.model
    else delete agentOptions.model
    if (bot.provider) agentOptions.provider = bot.provider
    else delete agentOptions.provider
    agent.options = agentOptions

    // 7. 更新 [[projects.platforms]] 中 type=feishu 的段
    const platforms = (existing.platforms ?? []) as Record<string, unknown>[]
    let feishuPlatform = platforms.find(
      (p) => (p.type as string) === 'feishu'
    ) as Record<string, unknown> | undefined

    if (!feishuPlatform) {
      feishuPlatform = { type: 'feishu' }
      platforms.push(feishuPlatform)
    }

    // feishu 平台选项必须嵌套在 [projects.platforms.options] 子表内
    const feishuOptions = (feishuPlatform.options ?? {}) as Record<string, unknown>
    feishuOptions.app_id = bot.appId
    feishuOptions.app_secret = bot.appSecret
    feishuOptions.enable_feishu_card = bot.enableFeishuCard
    feishuOptions.progress_style = bot.progressStyle
    feishuOptions.allow_from = bot.allowFrom || '*'
    feishuPlatform.options = feishuOptions

    existing.platforms = platforms

    // 8. 写回 config.toml
    config.projects = projectsList
    this.writeToml(config)
  }

  /**
   * 从 config.toml 中读取指定项目的配置
   */
  readProjectConfig(projectName: string): FeishuBotConfig | null {
    const config = this.readToml()
    const projectsList = (config.projects ?? []) as Record<string, unknown>[]
    const existing = projectsList.find(
      (p) => (p.name as string) === projectName
    ) as Record<string, unknown> | undefined
    if (!existing) return null

    const platforms = (existing.platforms ?? []) as Record<string, unknown>[]
    const feishu = platforms.find(
      (p) => (p.type as string) === 'feishu'
    ) as Record<string, unknown> | undefined
    const feishuOptions = (feishu?.options ?? {}) as Record<string, unknown>

    const agent = (existing.agent ?? {}) as Record<string, unknown>
    const agentOptions = (agent.options ?? {}) as Record<string, unknown>

    return {
      appId: (feishuOptions.app_id as string) ?? '',
      appSecret: (feishuOptions.app_secret as string) ?? '',
      adminFrom: (existing.admin_from as string) ?? '',
      allowFrom: (feishuOptions.allow_from as string) ?? '*',
      enableFeishuCard: (feishuOptions.enable_feishu_card as boolean) ?? true,
      progressStyle: ((feishuOptions.progress_style as string) ?? 'card') as FeishuBotConfig['progressStyle'],
      agentMode: (agentOptions.mode as string) ?? 'default',
      model: (agentOptions.model as string) ?? '',
      provider: (agentOptions.provider as string) ?? '',
    }
  }

  /**
   * 确保配置文件存在（启动服务前调用，但不覆盖已有配置）
   */
  ensureConfig(): void {
    if (fs.existsSync(CONFIG_PATH)) return
    console.log('[remote] config.toml not found, creating empty file')
    fs.mkdirSync(CC_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_PATH, '', 'utf-8')
  }
}

export default RemoteBridgeService
