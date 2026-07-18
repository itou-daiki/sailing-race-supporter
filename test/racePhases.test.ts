import { describe, expect, it } from 'vitest'
import type { CourseMark, OperationalTask, RaceDefinition } from '../src/domain'
import { buildRaceTimeline, deriveRacePhases } from '../src/racePhases'

const race: RaceDefinition = {
  id: 'race-1', number: '1R', className: '470', courseCode: 'O2', status: 'setup',
  warningAt: '2026-07-18T01:00:00.000Z', targetMinutes: 50, marks: [],
}

const tasks: OperationalTask[] = [{
  id: 'task-1', raceId: 'race-1', title: '全必須マークを確認', owner: 'RO', status: 'blocked',
  dueLabel: '00:50まで', dueAt: '2026-07-18T00:50:00.000Z', lastUpdatedAt: '2026-07-18T00:40:00.000Z', priority: 'required',
}]

const marks: CourseMark[] = [{
  id: 'mark-1', label: '1マーク', shortLabel: '1', target: [139, 35], actual: [139.001, 35.001],
  status: 'deployed', lastUpdatedAt: '2026-07-18T00:45:00.000Z',
}]

describe('race operation phases', () => {
  it('derives the active phase from real mark and task state', () => {
    const phases = deriveRacePhases({ race, marks, tasks, postponed: false })
    expect(phases.find((phase) => phase.id === 'course-setup')).toMatchObject({ state: 'completed', progress: '1 / 1 設置' })
    expect(phases.find((phase) => phase.id === 'position-check')).toMatchObject({ state: 'in-progress', isCurrent: true, progress: '0 / 1 確認' })
    expect(phases.find((phase) => phase.id === 'start-prep')).toMatchObject({ state: 'not-started', progress: '0 / 1 必須完了' })
  })

  it('shows a held start sequence as stopped without losing its planned times', () => {
    const heldRace = { ...race, status: 'start-sequence' as const }
    const phases = deriveRacePhases({ race: heldRace, marks, tasks, postponed: true })
    expect(phases.find((phase) => phase.id === 'start-sequence')).toMatchObject({ state: 'stopped', isCurrent: true })
    expect(buildRaceTimeline({ race: heldRace, marks, tasks, postponed: true })).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'planned', label: '予告信号', at: race.warningAt }),
      expect.objectContaining({ kind: 'actual', label: '1マーク 設置', at: marks[0].lastUpdatedAt }),
    ]))
  })

  it('flags missing recovery evidence even if the race was finalized', () => {
    const finalizedRace = { ...race, status: 'finalized' as const, finalizedAt: '2026-07-18T03:00:00.000Z', finalizedRevision: 1 }
    const phases = deriveRacePhases({ race: finalizedRace, marks, tasks: [{ ...tasks[0], status: 'done' }], postponed: false })
    expect(phases.find((phase) => phase.id === 'mark-recovery')?.state).toBe('warning')
    expect(phases.find((phase) => phase.id === 'finalized')).toMatchObject({ state: 'completed', progress: '確定版 v1' })
  })

  it('warns instead of treating an unconfigured preparation phase as ready', () => {
    const readyMarks = marks.map((mark) => ({ ...mark, status: 'confirmed' as const, verificationPosition: mark.actual }))
    const phases = deriveRacePhases({ race, marks: readyMarks, tasks: [], postponed: false })
    expect(phases.find((phase) => phase.id === 'start-prep')).toMatchObject({
      state: 'warning',
      isCurrent: true,
      progress: '必須項目未設定',
    })
  })
})
