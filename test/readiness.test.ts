import { describe, expect, it } from 'vitest'
import type { OperationalTask } from '../src/domain'
import { summarizeReadiness } from '../src/readiness'

function task(id: string, priority: OperationalTask['priority'], status: OperationalTask['status']): OperationalTask {
  return {
    id,
    title: id,
    owner: 'RO',
    status,
    dueLabel: '予告まで',
    priority,
  }
}

describe('start readiness', () => {
  it('does not call a race ready when required tasks are not configured', () => {
    expect(summarizeReadiness([])).toMatchObject({ state: 'unconfigured', completion: 0, remainingRequired: 0 })
    expect(summarizeReadiness([task('参考', 'reference', 'done')])).toMatchObject({ state: 'unconfigured', completion: 0 })
  })

  it('calculates readiness from required tasks only', () => {
    const summary = summarizeReadiness([
      task('必須1', 'required', 'done'),
      task('必須2', 'required', 'waiting'),
      task('参考1', 'reference', 'done'),
    ])
    expect(summary).toMatchObject({ state: 'incomplete', completion: 50, requiredDone: 1, referenceDone: 1, remainingRequired: 1 })
  })

  it('treats only a required blocker as a readiness blocker', () => {
    expect(summarizeReadiness([
      task('必須', 'required', 'done'),
      task('参考', 'reference', 'blocked'),
    ])).toMatchObject({ state: 'ready', completion: 100, blockers: [] })
    expect(summarizeReadiness([task('必須', 'required', 'blocked')])).toMatchObject({ state: 'blocked', blockers: [expect.objectContaining({ id: '必須' })] })
  })
})
