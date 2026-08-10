// 使用方法：import { tokenInventoryAtom } from '@renderer/atoms/token-inventory.atom'
// 编译说明：renderer 进程 browser bundle
// 代码说明：统计专用 Session Token 库存，历史详情回收不会影响此 Map

import { atom } from 'jotai'
import type { HistoryTokenInventoryEntry } from '@shared/types/history'

export const tokenInventoryAtom = atom<Map<string, HistoryTokenInventoryEntry>>(new Map())
