import { describe, expect, it } from 'vitest'
import {
  budgetStage,
  estimateRegattaFreeTierUsage,
  STANDARD_REGATTA_LOAD,
} from '../shared/freeTierBudget'

describe('Cloudflare free tier budget model', () => {
  it('keeps the standard 50-boat regatta below the 70 percent design target', () => {
    const estimate = estimateRegattaFreeTierUsage(STANDARD_REGATTA_LOAD)
    expect(estimate.positionMessages).toBe(720_000)
    expect(estimate.maxPercent).toBeLessThan(70)
    expect(estimate.limitingMetric.key).toBe('do-rows-written')
  })

  it('detects that persisting every two-second position frame exceeds the free row-write limit', () => {
    const estimate = estimateRegattaFreeTierUsage({
      ...STANDARD_REGATTA_LOAD,
      durableObjectSnapshotSeconds: 2,
    })
    const writes = estimate.metrics.find((metric) => metric.key === 'do-rows-written')
    expect(writes?.percent).toBeGreaterThan(700)
    expect(estimate.stage).toBe('critical')
  })

  it('uses the documented degradation thresholds', () => {
    expect(budgetStage(49.9)).toBe('normal')
    expect(budgetStage(50)).toBe('observe')
    expect(budgetStage(70)).toBe('warning')
    expect(budgetStage(85)).toBe('protect')
    expect(budgetStage(95)).toBe('critical')
  })
})
