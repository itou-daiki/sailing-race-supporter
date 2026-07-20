import { describe, expect, it } from 'vitest'
import { DEMO_RACES, type OperationalMessage, type OperationalTask } from '../src/domain'
import { deriveOperationalGuidance } from '../src/operationalGuidance'

const race = { ...DEMO_RACES[0], status: 'setup' as const }
const task: OperationalTask = {
  id: 'task-1',
  raceId: race.id,
  title: 'アンカーを確認',
  owner: '1マーク艇',
  status: 'waiting',
  dueLabel: '予告30分前',
  priority: 'required',
}

const base = {
  race,
  marks: race.marks,
  tasks: [task],
  messages: [] as OperationalMessage[],
  postponed: false,
  locked: false,
  operationMode: 'team' as const,
}

describe('deriveOperationalGuidance', () => {
  it('puts postponement ahead of every normal operation', () => {
    const guidance = deriveOperationalGuidance({ ...base, postponed: true })
    expect(guidance.title).toContain('延期中')
    expect(guidance.intent).toEqual({ kind: 'messages' })
    expect(guidance.tone).toBe('warning')
  })

  it('puts an unread urgent message ahead of tasks', () => {
    const guidance = deriveOperationalGuidance({
      ...base,
      messages: [{
        id: 'urgent-1',
        raceId: race.id,
        sender: '本部船',
        channel: '全体',
        text: '安全確認',
        sentAt: new Date().toISOString(),
        priority: 'urgent',
        acknowledgement: 'pending',
        ownReceipt: 'unread',
      }],
    })
    expect(guidance.title).toBe('緊急連絡 1件を確認')
    expect(guidance.intent).toEqual({ kind: 'messages' })
  })

  it('makes a solo task directly actionable', () => {
    const guidance = deriveOperationalGuidance({ ...base, operationMode: 'solo' })
    expect(guidance.actionLabel).toBe('状態を進める')
    expect(guidance.intent).toEqual({ kind: 'task', taskId: task.id })
  })

  it('routes a team task to a message for its assignee', () => {
    const guidance = deriveOperationalGuidance(base)
    expect(guidance.actionLabel).toBe('連絡する')
    expect(guidance.intent).toEqual({ kind: 'task-message', taskId: task.id })
  })

  it('locks normal actions after finalization', () => {
    const guidance = deriveOperationalGuidance({
      ...base,
      race: { ...race, status: 'finalized' },
      locked: true,
    })
    expect(guidance.intent).toEqual({ kind: 'none' })
    expect(guidance.tone).toBe('locked')
  })
})
