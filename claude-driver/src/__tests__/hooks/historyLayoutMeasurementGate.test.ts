import { describe, expect, it, vi } from 'vitest'
import {
  createHistoryLayoutMeasurementGate,
  setHistoryLayoutMeasurementBlocked,
} from '../../renderer/src/hooks/historyLayoutMeasurementGate'

describe('history layout measurement gate', () => {
  it('keeps one stable object and notifies observers only when an active block is released', () => {
    const gate = createHistoryLayoutMeasurementGate()
    const listener = vi.fn()
    gate.unblockedListeners.add(listener)

    setHistoryLayoutMeasurementBlocked(gate, true)
    expect(gate.blocked).toBe(true)
    expect(listener).not.toHaveBeenCalled()

    setHistoryLayoutMeasurementBlocked(gate, false)
    expect(gate.blocked).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)

    setHistoryLayoutMeasurementBlocked(gate, false)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
