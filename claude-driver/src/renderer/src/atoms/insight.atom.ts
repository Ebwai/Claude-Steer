// 使用方法：import { insightStateAtom, insightReportPathAtom } from '@renderer/atoms/insight.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：/insight 生成任务全局状态——跨 Modal 生命周期持久，关闭 Modal 后仍可在后台等待完成通知

import { atom } from 'jotai'

export type InsightTaskState = 'idle' | 'loading' | 'ready' | 'error'

/** /insight 当前任务状态 */
export const insightStateAtom = atom<InsightTaskState>('idle')

/** 生成完成后的报告文件路径 */
export const insightReportPathAtom = atom<string | null>(null)

/** 生成失败时的错误信息 */
export const insightErrorAtom = atom<string | null>(null)
