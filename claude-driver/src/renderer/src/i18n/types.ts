// 使用方法：import type { UILanguage } from '@renderer/i18n/types'
// 编译说明：renderer 进程 browser bundle
// 代码说明：UI 语言标识符联合类型

export type UILanguage = 'zh-CN' | 'en'

export const SUPPORTED_LANGUAGES: { id: UILanguage; label: string }[] = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'en',    label: 'English' },
]

export const FALLBACK_LANGUAGE: UILanguage = 'zh-CN'
