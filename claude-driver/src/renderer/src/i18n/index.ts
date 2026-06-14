// 使用方法：import { useT, uiLanguageAtom } from '@renderer/i18n'
// 编译说明：renderer 进程 browser bundle
// 代码说明：i18n 核心模块——i18next 翻译引擎 + Jotai 状态集成
//           遵循项目原子化模式：Jotai atom 为唯一数据源，i18next 为翻译引擎
//           语言切换自动同步到 DriverConfig 持久化

import { atom, useAtomValue, useSetAtom } from 'jotai'
import i18next from 'i18next'
import { useCallback, useMemo } from 'react'
import { IPC } from '@shared/events/ipc-channels'
import type { UILanguage } from './types'
import { FALLBACK_LANGUAGE } from './types'
import zhCN from './locales/zh-CN'
import en from './locales/en'

// ── i18next 初始化 ─────────────────────────────────────────────────────────────

i18next.init({
  lng: FALLBACK_LANGUAGE,
  fallbackLng: FALLBACK_LANGUAGE,
  resources: {
    'zh-CN': { translation: zhCN },
    'en':    { translation: en },
  },
  interpolation: {
    escapeValue: false, // React 已处理 XSS
  },
  returnObjects: false,
})

// ── Jotai Atom ─────────────────────────────────────────────────────────────────

/** 当前 UI 语言原子状态（默认 zh-CN，由 App 初始化时从 DriverConfig 加载覆盖） */
export const uiLanguageAtom = atom<UILanguage>(FALLBACK_LANGUAGE)

// ── useT() Hook ────────────────────────────────────────────────────────────────

export interface TFunction {
  (key: string, vars?: Record<string, string | number>): string
}

/**
 * 翻译 Hook——订阅 uiLanguageAtom，语言切换时自动触发组件重新渲染
 *
 * 用法：
 *   const { t, language, setLanguage } = useT()
 *   <span>{t('titlebar.today')}</span>
 *   <span>{t('bottombar.pendingRequests', { count: 5 })}</span>
 */
export function useT(): {
  t: TFunction
  language: UILanguage
  setLanguage: (lang: UILanguage) => void
} {
  const language = useAtomValue(uiLanguageAtom)
  const setLanguageAtom = useSetAtom(uiLanguageAtom)

  const setLanguage = useCallback(
    (lang: UILanguage) => {
      i18next.changeLanguage(lang)
      setLanguageAtom(lang)
      // 持久化到 DriverConfig
      window.api.invoke(IPC.CONFIG_WRITE, { scope: 'driver', key: 'uiLanguage', value: lang }).catch(() => {})
    },
    [setLanguageAtom],
  )

  // 确保 i18next 内部语言与 atom 同步（初始化场景）
  if (i18next.language !== language) {
    i18next.changeLanguage(language)
  }

  const t: TFunction = useMemo(
    () => (key: string, vars?: Record<string, string | number>) => i18next.t(key, vars ?? {}),
    [language],
  )

  return { t, language, setLanguage }
}

/**
 * 非组件上下文翻译函数（用于不能使用 hook 的场景）
 * 注意：不会触发 React 重渲染，适合一次性调用
 */
export function tStatic(key: string, vars?: Record<string, string | number>): string {
  return i18next.t(key, vars ?? {})
}

export { i18next }
