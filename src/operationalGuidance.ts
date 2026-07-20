import type {
  CourseMark,
  FinishRecord,
  OperationalMessage,
  OperationalTask,
  RaceDefinition,
} from './domain'
import type { OperationMode } from '../shared/operationModes'
import type { LatestPassageSummary } from './passages'
import { deriveRacePhases } from './racePhases'
import { summarizeReadiness } from './readiness'

export type OperationalGuidanceIntent =
  | { kind: 'messages' }
  | { kind: 'course' }
  | { kind: 'mark'; markId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'task-message'; taskId: string }
  | { kind: 'none' }

export interface OperationalGuidance {
  title: string
  reason: string
  actionLabel?: string
  intent: OperationalGuidanceIntent
  tone: 'normal' | 'warning' | 'locked'
}

interface OperationalGuidanceInput {
  race: RaceDefinition
  marks: readonly CourseMark[]
  tasks: readonly OperationalTask[]
  messages: readonly OperationalMessage[]
  postponed: boolean
  locked: boolean
  operationMode: OperationMode
  latestPassage?: LatestPassageSummary
  firstFinish?: FinishRecord
}

const taskStatusLabel: Record<OperationalTask['status'], string> = {
  blocked: '作業を止めて確認が必要',
  waiting: '確認待ち',
  doing: '対応中',
  done: '完了',
}

const phaseStateLabel = {
  'not-started': '未着手',
  'in-progress': '進行中',
  waiting: '確認待ち',
  completed: '完了',
  warning: '要注意',
  stopped: '停止',
} as const

export function deriveOperationalGuidance({
  race,
  marks,
  tasks,
  messages,
  postponed,
  locked,
  operationMode,
  latestPassage,
  firstFinish,
}: OperationalGuidanceInput): OperationalGuidance {
  const unresolvedUrgent = messages.filter((message) => (
    (!message.raceId || message.raceId === race.id)
    && message.priority === 'urgent'
    && (message.ownReceipt === 'unread' || message.acknowledgement === 'pending')
  )).length

  if (postponed) {
    return {
      title: '延期中：本部船の再開決定を待つ',
      reason: '予定時刻ではなく、本部船が共有する信号を基準にしてください。',
      actionLabel: '運営連絡を確認',
      intent: { kind: 'messages' },
      tone: 'warning',
    }
  }

  if (unresolvedUrgent > 0) {
    return {
      title: `緊急連絡 ${unresolvedUrgent}件を確認`,
      reason: '未確認の緊急連絡が最優先です。内容を確認し、了解を返してください。',
      actionLabel: '緊急連絡を開く',
      intent: { kind: 'messages' },
      tone: 'warning',
    }
  }

  if (locked) {
    return {
      title: `${race.number}は確定済み`,
      reason: '通常編集はロック済みです。訂正は大会管理者が修正版として行います。',
      intent: { kind: 'none' },
      tone: 'locked',
    }
  }

  if (race.status === 'planning') {
    return {
      title: `${race.number}のコースとスタートラインを設定`,
      reason: '海面、クラス、コース記号、ゲート有無を確認して推奨位置を保存します。',
      actionLabel: 'コース設定へ',
      intent: { kind: 'course' },
      tone: 'normal',
    }
  }

  const readiness = summarizeReadiness(tasks)
  const primaryTask = readiness.blockers[0] ?? readiness.required.find((task) => task.status !== 'done')
  if (primaryTask) {
    const isSolo = operationMode === 'solo'
    return {
      title: primaryTask.title,
      reason: isSolo
        ? `自分の項目です。現在は「${taskStatusLabel[primaryTask.status]}」、期限は${primaryTask.dueLabel}です。`
        : `${primaryTask.owner}の項目です。現在は「${taskStatusLabel[primaryTask.status]}」、期限は${primaryTask.dueLabel}です。`,
      actionLabel: primaryTask.markId ? '地図で対象を開く' : isSolo ? '状態を進める' : '連絡する',
      intent: primaryTask.markId
        ? { kind: 'mark', markId: primaryTask.markId }
        : isSolo
          ? { kind: 'task', taskId: primaryTask.id }
          : { kind: 'task-message', taskId: primaryTask.id },
      tone: primaryTask.status === 'blocked' ? 'warning' : 'normal',
    }
  }

  const firstUnconfirmedMark = marks.find((mark) => mark.status !== 'confirmed')
  if (firstUnconfirmedMark) {
    return {
      title: `${firstUnconfirmedMark.label}の位置を確認`,
      reason: operationMode === 'solo'
        ? '投下地点を記録し、安全に移動した後でGPS差分を確認します。'
        : '計画位置、投下地点、別艇確認の順で記録すると全員が判断できます。',
      actionLabel: '地図で開く',
      intent: { kind: 'mark', markId: firstUnconfirmedMark.id },
      tone: 'normal',
    }
  }

  const phases = deriveRacePhases({ race, marks, tasks, postponed, latestPassage, firstFinish })
  const currentPhase = phases.find((phase) => phase.isCurrent) ?? phases[0]!
  return {
    title: `${currentPhase.label}を進める`,
    reason: `現在は${phaseStateLabel[currentPhase.state]}です。完了条件：${currentPhase.progress}`,
    intent: { kind: 'none' },
    tone: 'normal',
  }
}
