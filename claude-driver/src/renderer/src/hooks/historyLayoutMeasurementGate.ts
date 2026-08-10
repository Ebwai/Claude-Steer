// 使用方法：Canvas 持有单个稳定 gate，SessionFrameNode 只订阅解冻通知，不因相机阶段重建 node.data
// 编译说明：renderer 纯 TypeScript；无 React/DOM 依赖
// 代码说明：相机动画期间冻结框高提交，解冻时只通知持有待提交尺寸的观察者

export interface HistoryLayoutMeasurementGate {
  blocked: boolean
  unblockedListeners: Set<() => void>
}

export function createHistoryLayoutMeasurementGate(): HistoryLayoutMeasurementGate {
  return {
    blocked: false,
    unblockedListeners: new Set(),
  }
}

export function setHistoryLayoutMeasurementBlocked(
  gate: HistoryLayoutMeasurementGate,
  blocked: boolean,
): void {
  if (gate.blocked === blocked) return
  gate.blocked = blocked
  if (blocked) return

  // 使用快照，避免 listener 在通知期间注册/注销导致遍历不稳定。
  for (const listener of [...gate.unblockedListeners]) listener()
}
