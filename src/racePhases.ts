import type {
  CourseMark,
  FinishRecord,
  OperationalTask,
  RaceDefinition,
} from './domain'
import type { LatestPassageSummary } from './passages'

export type RacePhaseId =
  | 'planning'
  | 'course-setup'
  | 'position-check'
  | 'start-prep'
  | 'start-sequence'
  | 'racing'
  | 'finish'
  | 'mark-recovery'
  | 'provisional'
  | 'finalized'

export type RacePhaseState = 'not-started' | 'in-progress' | 'waiting' | 'completed' | 'warning' | 'stopped'

export interface RacePhase {
  id: RacePhaseId
  label: string
  state: RacePhaseState
  owner: string
  progress: string
  dueAt?: string
  lastUpdatedAt?: string
  isCurrent: boolean
}

export interface RacePhaseContext {
  race: RaceDefinition
  marks: readonly CourseMark[]
  tasks: readonly OperationalTask[]
  postponed: boolean
  latestPassage?: LatestPassageSummary
  firstFinish?: FinishRecord
}

export interface RaceTimelineEvent {
  id: string
  kind: 'planned' | 'actual'
  label: string
  at: string
}

const phaseDefinitions: ReadonlyArray<Pick<RacePhase, 'id' | 'label' | 'owner'>> = [
  { id: 'planning', label: '計画', owner: 'PRO / RO' },
  { id: 'course-setup', label: 'コース設置', owner: 'コースセッター' },
  { id: 'position-check', label: '位置確認', owner: 'マークボート' },
  { id: 'start-prep', label: 'スタート準備', owner: 'PRO / RO' },
  { id: 'start-sequence', label: 'スタート手順', owner: 'シグナルボート' },
  { id: 'racing', label: 'レース中', owner: 'レース委員会' },
  { id: 'finish', label: 'フィニッシュ', owner: 'シグナルボート' },
  { id: 'mark-recovery', label: 'マーク回収', owner: 'マークボート' },
  { id: 'provisional', label: '暫定完了', owner: 'PRO / RO' },
  { id: 'finalized', label: '確定', owner: '大会管理者' },
]

function validIso(value: string | undefined): string | undefined {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined
}

function offsetIso(base: string | undefined, minutes: number): string | undefined {
  const timestamp = base ? Date.parse(base) : Number.NaN
  return Number.isFinite(timestamp) ? new Date(timestamp + minutes * 60_000).toISOString() : undefined
}

function latestIso(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => Boolean(validIso(value))).sort().at(-1)
}

function latestFinishTime(record: FinishRecord | undefined): string | undefined {
  if (!record) return undefined
  const active = record.observations.filter((observation) => observation.status === 'active')
  const adopted = active.find((observation) => observation.id === record.adoptedObservationId)
  return adopted?.finishedAt ?? latestIso(active.map((observation) => observation.finishedAt))
}

function phaseCurrentId(context: RacePhaseContext, counts: {
  totalMarks: number
  placedMarks: number
  verifiedMarks: number
  recoverableMarks: number
  recoveredMarks: number
  requiredTasks: number
  completedTasks: number
}): RacePhaseId {
  if (context.race.status === 'planning') return 'planning'
  if (context.race.status === 'setup') {
    if (!counts.totalMarks || counts.placedMarks < counts.totalMarks) return 'course-setup'
    if (counts.verifiedMarks < counts.totalMarks) return 'position-check'
    return 'start-prep'
  }
  if (context.race.status === 'start-sequence') return 'start-sequence'
  if (context.race.status === 'racing') {
    return latestFinishTime(context.firstFinish) ? 'finish' : 'racing'
  }
  if (context.race.status === 'provisional') {
    if (counts.recoverableMarks > 0 && counts.recoveredMarks < counts.recoverableMarks) return 'mark-recovery'
    return 'provisional'
  }
  return 'finalized'
}

export function deriveRacePhases(context: RacePhaseContext): RacePhase[] {
  const { race, marks, tasks } = context
  const requiredTasks = tasks.filter((task) => task.priority === 'required')
  const counts = {
    totalMarks: marks.length,
    placedMarks: marks.filter((mark) => Boolean(mark.actual)).length,
    verifiedMarks: marks.filter((mark) => mark.status === 'confirmed' || Boolean(mark.verificationPosition)).length,
    recoverableMarks: marks.filter((mark) => !mark.label.includes('シグナルボート')).length,
    recoveredMarks: marks.filter((mark) => !mark.label.includes('シグナルボート') && mark.status === 'recovered').length,
    requiredTasks: requiredTasks.length,
    completedTasks: requiredTasks.filter((task) => task.status === 'done').length,
  }
  const currentId = phaseCurrentId(context, counts)
  const currentIndex = phaseDefinitions.findIndex((phase) => phase.id === currentId)
  const warningAt = validIso(race.warningAt)
  const startAt = offsetIso(warningAt, 5)
  const estimatedFinishAt = offsetIso(startAt, race.targetMinutes)
  const latestMarkAt = latestIso(marks.map((mark) => mark.lastUpdatedAt))
  const latestTaskAt = latestIso(tasks.map((task) => task.lastUpdatedAt))
  const finishAt = latestFinishTime(context.firstFinish)
  const dueByPhase: Partial<Record<RacePhaseId, string | undefined>> = {
    planning: offsetIso(warningAt, -30),
    'course-setup': offsetIso(warningAt, -20),
    'position-check': offsetIso(warningAt, -10),
    'start-prep': offsetIso(warningAt, -5),
    'start-sequence': warningAt,
    racing: startAt,
    finish: estimatedFinishAt,
    'mark-recovery': offsetIso(estimatedFinishAt, 30),
    provisional: offsetIso(estimatedFinishAt, 45),
  }
  const lastUpdateByPhase: Partial<Record<RacePhaseId, string | undefined>> = {
    'course-setup': latestMarkAt,
    'position-check': latestMarkAt,
    'start-prep': latestTaskAt,
    'start-sequence': race.latestSignal?.executedAt,
    racing: context.latestPassage?.passedAt ?? race.latestSignal?.executedAt,
    finish: finishAt,
    'mark-recovery': latestMarkAt,
    provisional: finishAt,
    finalized: race.finalizedAt,
  }
  const progressByPhase: Record<RacePhaseId, string> = {
    planning: race.courseCode || 'コース未選択',
    'course-setup': `${counts.placedMarks} / ${counts.totalMarks} 設置`,
    'position-check': `${counts.verifiedMarks} / ${counts.totalMarks} 確認`,
    'start-prep': counts.requiredTasks
      ? `${counts.completedTasks} / ${counts.requiredTasks} 必須完了`
      : '必須項目未設定',
    'start-sequence': context.postponed ? '延期・保留中' : race.latestSignal?.label ?? '予告待ち',
    racing: context.latestPassage ? `${context.latestPassage.markLabel} 通過` : '先頭通過待ち',
    finish: finishAt ? '先頭観測あり' : '先頭観測待ち',
    'mark-recovery': `${counts.recoveredMarks} / ${counts.recoverableMarks} 回収`,
    provisional: '記録・競合を確認',
    finalized: race.finalizedRevision ? `確定版 v${race.finalizedRevision}` : '確定版',
  }

  return phaseDefinitions.map((definition, index) => {
    let state: RacePhaseState = index < currentIndex ? 'completed' : index === currentIndex ? 'in-progress' : 'not-started'
    if (definition.id === 'course-setup') {
      if (counts.totalMarks > 0 && counts.placedMarks === counts.totalMarks) state = 'completed'
      else if (index < currentIndex) state = 'warning'
    }
    if (definition.id === 'position-check') {
      if (counts.totalMarks > 0 && counts.verifiedMarks === counts.totalMarks) state = 'completed'
      else if (index < currentIndex) state = 'warning'
      else if (definition.id === currentId && counts.placedMarks < counts.totalMarks) state = 'waiting'
    }
    if (definition.id === 'start-prep') {
      if (counts.requiredTasks > 0 && counts.completedTasks === counts.requiredTasks) state = 'completed'
      else if (definition.id === currentId && counts.requiredTasks === 0) state = 'warning'
      else if (index < currentIndex || requiredTasks.some((task) => task.status === 'blocked') && definition.id === currentId) state = 'warning'
    }
    if (definition.id === 'start-sequence' && definition.id === currentId && context.postponed) state = 'stopped'
    if (definition.id === 'finish' && index < currentIndex && !finishAt) state = 'warning'
    if (definition.id === 'mark-recovery') {
      if (counts.recoverableMarks > 0 && counts.recoveredMarks === counts.recoverableMarks) state = 'completed'
      else if (race.status === 'finalized') state = 'warning'
    }
    if (definition.id === 'finalized' && race.status === 'finalized') state = 'completed'
    return {
      ...definition,
      state,
      progress: progressByPhase[definition.id],
      dueAt: dueByPhase[definition.id],
      lastUpdatedAt: lastUpdateByPhase[definition.id],
      isCurrent: definition.id === currentId,
    }
  })
}

export function buildRaceTimeline(context: RacePhaseContext): RaceTimelineEvent[] {
  const warningAt = validIso(context.race.warningAt)
  const startAt = offsetIso(warningAt, 5)
  const estimatedFinishAt = offsetIso(startAt, context.race.targetMinutes)
  const latestMark = [...context.marks]
    .filter((mark) => validIso(mark.lastUpdatedAt))
    .sort((left, right) => String(right.lastUpdatedAt).localeCompare(String(left.lastUpdatedAt)))[0]
  const finishAt = latestFinishTime(context.firstFinish)
  return [
    warningAt ? { id: 'warning-plan', kind: 'planned' as const, label: '予告信号', at: warningAt } : undefined,
    startAt ? { id: 'start-plan', kind: 'planned' as const, label: 'スタート', at: startAt } : undefined,
    estimatedFinishAt ? { id: 'finish-plan', kind: 'planned' as const, label: '目標フィニッシュ', at: estimatedFinishAt } : undefined,
    latestMark?.lastUpdatedAt ? { id: `mark-${latestMark.id}`, kind: 'actual' as const, label: `${latestMark.label} ${latestMark.status === 'recovered' ? '回収' : latestMark.status === 'confirmed' ? '確認' : '設置'}`, at: latestMark.lastUpdatedAt } : undefined,
    context.race.latestSignal?.executedAt ? { id: `signal-${context.race.latestSignal.id}`, kind: 'actual' as const, label: context.race.latestSignal.label, at: context.race.latestSignal.executedAt } : undefined,
    context.latestPassage?.passedAt ? { id: `passage-${context.latestPassage.markId}`, kind: 'actual' as const, label: `${context.latestPassage.markLabel} 先頭通過`, at: context.latestPassage.passedAt } : undefined,
    finishAt ? { id: 'finish-actual', kind: 'actual' as const, label: '先頭フィニッシュ', at: finishAt } : undefined,
    context.race.finalizedAt ? { id: 'finalized-actual', kind: 'actual' as const, label: 'レース確定', at: context.race.finalizedAt } : undefined,
  ].filter((event): event is RaceTimelineEvent => Boolean(event)).sort((left, right) => left.at.localeCompare(right.at))
}
