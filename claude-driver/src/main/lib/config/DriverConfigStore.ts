// 使用方法：import { readDriverConfig, writeDriverConfig, patchDriverConfig } from './DriverConfigStore'
// 编译说明：主进程 Node.js 模块
// 代码说明：~/.claude-driver/config.json 原子读写工具（仪表盘自有配置）
//           与 ProjectStore.ts 相同的 write-tmp + rename 原子写入模式

import fs from 'fs'
import path from 'path'
import os from 'os'
import type { DriverConfig } from '../../../shared/types/index'

const DRIVER_DIR = path.join(os.homedir(), '.claude-driver')
const CONFIG_PATH = path.join(DRIVER_DIR, 'config.json')
const CONFIG_TMP_PATH = path.join(DRIVER_DIR, 'config.json.tmp')

const DEFAULTS: DriverConfig = {
  tokenPriceInputPerM: 3.0,
  tokenPriceOutputPerM: 15.0,
  monthlyBudgetAlertUsd: 50,
  desktopNotificationsEnabled: true,
  themePreference: 'dark',
}

export function readDriverConfig(): DriverConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<DriverConfig>) }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[DriverConfigStore] Failed to read config.json:', err)
    }
    return { ...DEFAULTS }
  }
}

export function writeDriverConfig(data: DriverConfig): void {
  try {
    fs.mkdirSync(DRIVER_DIR, { recursive: true })
    fs.writeFileSync(CONFIG_TMP_PATH, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(CONFIG_TMP_PATH, CONFIG_PATH)
    console.log('[DriverConfigStore] config.json saved')
  } catch (err) {
    console.error('[DriverConfigStore] Failed to write config.json:', err)
    throw err
  }
}

export function patchDriverConfig(key: keyof DriverConfig, value: unknown): void {
  const current = readDriverConfig()
  writeDriverConfig({ ...current, [key]: value } as DriverConfig)
}
