// 使用方法：import { HistoryService } from './lib/history'
// 编译说明：Electron main / Node.js
// 代码说明：history 模块公开入口

export { HistoryService, type HistoryServiceDeps } from './HistoryService'
export { scanHistoryCatalog, buildHistoryClusters, historyClusterSortKey } from './HistoryCatalog'
export { loadHistoryClusterProjection } from './HistoryDetailLoader'
export { scanHistoryTokenInventory } from './HistoryTokenInventory'
export { deleteHistoryTarget, recoverHistoryDeleteTransactions } from './HistoryDeletion'
export { createDetailService, type DetailService, type DetailServiceDeps } from './DetailService'
export * from './HistoryPaths'
