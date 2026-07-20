import {
  CLASS_PERFORMANCE_PROFILES,
  type ClassPerformanceProfile as SharedClassPerformanceProfile,
  type SupportedSailingClass,
} from '../shared/classPerformance.js'

export type LngLat = readonly [longitude: number, latitude: number]

export type MarkStatus = 'planned' | 'en-route' | 'deployed' | 'confirmed' | 'recovered'

export interface CourseMark {
  id: string
  label: string
  shortLabel: string
  target: LngLat
  actual?: LngLat
  verificationPosition?: LngLat
  recoveryPosition?: LngLat
  status: MarkStatus
  lastUpdatedAt?: string
  assignedBoatId?: string
  isGate?: boolean
  gateSide?: 'S' | 'P'
  note?: string
}

export interface CommitteeBoat {
  id: string
  name: string
  assignment: string
  position: LngLat
  speedKnots: number
  courseDegrees?: number
  accuracyMetres?: number
  freshnessSeconds: number
  isSelf?: boolean
  status: 'moving' | 'stationed' | 'offline'
}

export interface WindObservation {
  directionDegrees: number
  speedKnots: number
  gustKnots: number
  observedAt: string
  source: string
  trend: 'left' | 'steady' | 'right'
  confidence?: 'low' | 'medium' | 'high'
  position?: LngLat
  raceId?: string
  committeeBoatId?: string
  /** Mark selected when the observation was recorded. Keeps readings stable after boat reassignments. */
  markId?: string
}

export interface CurrentObservation {
  /** True bearing the water is flowing toward (set), not where it comes from. */
  directionDegrees: number
  speedKnots: number
  observedAt: string
  source: string
  confidence: 'low' | 'medium' | 'high'
  position?: LngLat
}

export interface RaceDefinition {
  id: string
  raceAreaId?: string
  raceAreaName?: string
  number: string
  className: SailingClass
  courseCode: string
  status: 'planning' | 'setup' | 'start-sequence' | 'racing' | 'provisional' | 'finalized'
  warningAt: string
  targetMinutes: number
  finalizedRevision?: number
  finalizedAt?: string
  marks: CourseMark[]
  latestSignal?: RaceSignalEvent
}

export type RaceSignalAction =
  | 'warning'
  | 'preparatory'
  | 'one-minute'
  | 'start'
  | 'postpone'
  | 'postpone-h'
  | 'postpone-a'
  | 'resume'
  | 'individual-recall'
  | 'individual-recall-clear'
  | 'general-recall'
  | 'general-recall-clear'
  | 'shorten'
  | 'course-change'
  | 'mark-missing'
  | 'search-rescue'
  | 'abandon'
  | 'abandon-h'
  | 'abandon-a'
  | 'abandon-clear'

export interface RaceSignalEvent {
  id: string
  action: RaceSignalAction
  label: string
  flag: string
  sound: string
  soundCount: number
  executedAt: string
  scheduledAt?: string
  visualExecutedAt: string
  soundExecutedAt?: string
  soundStatus: 'played' | 'pending' | 'not-required' | 'failed' | 'cancelled' | 'legacy'
  officialAudioDeviceId?: string
  warningAt?: string
  reason?: string
  targetSailNumbers?: string
  finishAt?: string
  changeFromMarkId?: string
  changeFromMarkLabel?: string
  targetMarkId?: string
  targetMarkLabel?: string
  newBearing?: number
  directionChange?: 'port' | 'starboard'
  lengthChange?: 'increase' | 'decrease'
  replacementObject?: string
  communicationChannel?: string
  safetyInstructions?: string
  actor?: string
}

export type SailingClass = SupportedSailingClass

export type BoardDetail = 'overview' | 'standard' | 'detail'

export interface OperationalTask {
  id: string
  raceId?: string
  title: string
  owner: string
  status: 'blocked' | 'waiting' | 'doing' | 'done'
  dueLabel: string
  dueAt?: string
  lastUpdatedAt?: string
  markId?: string
  priority: 'required' | 'reference'
}

export interface OperationalMessage {
  id: string
  raceId?: string
  sender: string
  channel: string
  text: string
  sentAt: string
  priority: 'normal' | 'confirm' | 'urgent'
  acknowledgement?: 'pending' | 'acknowledged' | 'done'
  senderMemberId?: string
  target?: {
    type: 'event' | 'area' | 'race' | 'boat' | 'mark' | 'role' | 'member'
    id?: string
    label: string
  }
  receipts?: {
    targetCount: number
    deliveredCount: number
    readCount: number
    acknowledgedCount: number
  }
  ownReceipt?: 'unread' | 'read' | 'acknowledged'
}

export interface LeadingPassageObservation {
  id: string
  passedAt: string
  recordedBy: string
  syncQuality: 'good' | 'fair' | 'poor' | 'offline' | 'unknown'
  wasOffline: boolean
  sailNumber?: string
  note?: string
  status: 'active' | 'cancelled' | 'corrected'
}

export interface LeadingPassageVisit {
  raceId: string
  markId: string
  lapNumber: number
  observations: LeadingPassageObservation[]
  adoptedObservationId?: string
  adoptedAt?: string
  spreadMilliseconds: number
  hasConflict: boolean
}

export interface FinishObservation {
  id: string
  finishPosition: number
  finishedAt: string
  recordedBy: string
  syncQuality: 'good' | 'fair' | 'poor' | 'offline' | 'unknown'
  wasOffline: boolean
  sailNumber?: string
  note?: string
  status: 'active' | 'cancelled' | 'corrected'
}

export interface FinishRecord {
  raceId: string
  finishPosition: number
  observations: FinishObservation[]
  adoptedObservationId?: string
  adoptedAt?: string
  spreadMilliseconds: number
  hasConflict: boolean
}

export type ClassPerformanceProfile = SharedClassPerformanceProfile

export const CLASS_PROFILES: readonly ClassPerformanceProfile[] = CLASS_PERFORMANCE_PROFILES

const warningAt = new Date(Date.now() + 4.5 * 60_000).toISOString()

export const DEMO_RACES: readonly RaceDefinition[] = [
  {
    id: 'race-1',
    number: '1R',
    className: '470',
    courseCode: 'O2 / 下ゲートあり',
    status: 'setup',
    warningAt,
    targetMinutes: 50,
    marks: [
      {
        id: 'mark-1',
        label: '1マーク',
        shortLabel: '1',
        target: [131.5189437, 33.2940818],
        actual: [131.51916, 33.29388],
        status: 'confirmed',
        assignedBoatId: 'mark-a',
      },
      {
        id: 'mark-2',
        label: '2マーク',
        shortLabel: '2',
        target: [131.5307348, 33.2904938],
        status: 'en-route',
        assignedBoatId: 'mark-b',
      },
      {
        id: 'mark-3s',
        label: '下ゲート 3S',
        shortLabel: '3S',
        target: [131.5330923, 33.2759495],
        actual: [131.53296, 33.27602],
        status: 'confirmed',
        assignedBoatId: 'mark-c',
        isGate: true,
        gateSide: 'S',
      },
      {
        id: 'mark-3p',
        label: '下ゲート 3P',
        shortLabel: '3P',
        target: [131.5344695, 33.2761525],
        actual: [131.53455, 33.27607],
        status: 'confirmed',
        assignedBoatId: 'mark-c',
        isGate: true,
        gateSide: 'P',
      },
      {
        id: 'start-pin',
        label: 'スタート・ピン',
        shortLabel: 'PIN',
        target: [131.5190178, 33.2781963],
        actual: [131.5191, 33.27823],
        status: 'confirmed',
        assignedBoatId: 'signal',
      },
      {
        id: 'start-rc',
        label: 'シグナルボート',
        shortLabel: 'RC',
        target: [131.5253741, 33.2791333],
        actual: [131.52531, 33.27916],
        status: 'confirmed',
        assignedBoatId: 'signal',
      },
    ],
  },
  {
    id: 'race-2',
    number: '2R',
    className: 'ILCA 6',
    courseCode: 'I2 / 下ゲートあり',
    status: 'planning',
    warningAt: new Date(Date.now() + 68 * 60_000).toISOString(),
    targetMinutes: 50,
    marks: [],
  },
  {
    id: 'race-3',
    number: '3R',
    className: 'スナイプ',
    courseCode: 'W2 / 下ゲートあり',
    status: 'planning',
    warningAt: new Date(Date.now() + 140 * 60_000).toISOString(),
    targetMinutes: 60,
    marks: [],
  },
] as const

export const DEMO_BOATS: readonly CommitteeBoat[] = [
  {
    id: 'mark-a',
    name: 'マークボートA',
    assignment: '1マーク（自分）',
    position: [131.5193, 33.2935],
    speedKnots: 5.8,
    courseDegrees: 344,
    freshnessSeconds: 2,
    isSelf: true,
    status: 'moving',
  },
  {
    id: 'mark-b',
    name: 'マークボートB',
    assignment: '2マーク',
    position: [131.5286, 33.2878],
    speedKnots: 3.2,
    courseDegrees: 18,
    freshnessSeconds: 6,
    status: 'moving',
  },
  {
    id: 'mark-c',
    name: 'マークボートC',
    assignment: '下ゲート',
    position: [131.5337, 33.2761],
    speedKnots: 0.2,
    freshnessSeconds: 3,
    status: 'stationed',
  },
  {
    id: 'signal',
    name: 'シグナルボート',
    assignment: 'スタート／フィニッシュ',
    position: [131.52531, 33.27916],
    speedKnots: 0,
    freshnessSeconds: 1,
    status: 'stationed',
  },
  {
    id: 'jury-1',
    name: 'ジュリーボート',
    assignment: 'プロテスト',
    position: [131.524, 33.284],
    speedKnots: 4.1,
    courseDegrees: 92,
    freshnessSeconds: 8,
    status: 'moving',
  },
] as const

export const DEMO_TASKS: readonly OperationalTask[] = [
  {
    id: 'task-line',
    raceId: 'race-1',
    title: 'スタートライン方位を再確認',
    owner: 'シグナルボート',
    status: 'blocked',
    dueLabel: '予告3分前',
    priority: 'required',
  },
  {
    id: 'task-mark-2',
    raceId: 'race-1',
    title: '2マークを投下して位置確定',
    owner: 'マークボートB',
    status: 'doing',
    dueLabel: '予告5分前',
    markId: 'mark-2',
    priority: 'required',
  },
  {
    id: 'task-wind',
    raceId: 'race-1',
    title: '5分平均風を更新',
    owner: 'コースセッター',
    status: 'waiting',
    dueLabel: '2分以内',
    priority: 'required',
  },
  {
    id: 'task-audio',
    raceId: 'race-1',
    title: '公式音響端末を準備',
    owner: 'シグナルボート',
    status: 'done',
    dueLabel: '完了 09:52',
    priority: 'required',
  },
] as const

export const DEMO_MESSAGES: readonly OperationalMessage[] = [
  {
    id: 'message-1',
    raceId: 'race-1',
    sender: 'マークボートB',
    channel: '1R・海面A',
    text: '2マークへ移動中。あと約2分です。',
    sentAt: new Date(Date.now() - 75_000).toISOString(),
    priority: 'normal',
    target: { type: 'race', id: 'race-1', label: '1R・全運営' },
    receipts: { targetCount: 18, deliveredCount: 18, readCount: 15, acknowledgedCount: 0 },
    ownReceipt: 'read',
  },
  {
    id: 'message-2',
    raceId: 'race-1',
    sender: 'PRO',
    channel: '1R・全運営',
    text: '風向350°Tで安定。コースO2を継続します。',
    sentAt: new Date(Date.now() - 34_000).toISOString(),
    priority: 'confirm',
    acknowledgement: 'pending',
    target: { type: 'race', id: 'race-1', label: '1R・全運営' },
    receipts: { targetCount: 18, deliveredCount: 18, readCount: 14, acknowledgedCount: 11 },
    ownReceipt: 'unread',
  },
] as const

export const INITIAL_WIND: WindObservation = {
  directionDegrees: 350,
  speedKnots: 8.4,
  gustKnots: 10.1,
  observedAt: new Date(Date.now() - 42_000).toISOString(),
  source: 'コースセッター',
  trend: 'steady',
  confidence: 'medium',
}

export const DEMO_MARK_WINDS: readonly WindObservation[] = [
  {
    directionDegrees: 348,
    speedKnots: 8.7,
    gustKnots: 10.3,
    observedAt: new Date(Date.now() - 48_000).toISOString(),
    source: 'マークボートA',
    trend: 'steady',
    confidence: 'medium',
    position: [131.5193, 33.2935],
    raceId: 'race-1',
    committeeBoatId: 'mark-a',
  },
  {
    directionDegrees: 353,
    speedKnots: 8.1,
    gustKnots: 9.8,
    observedAt: new Date(Date.now() - 82_000).toISOString(),
    source: 'マークボートB',
    trend: 'right',
    confidence: 'medium',
    position: [131.5286, 33.2878],
    raceId: 'race-1',
    committeeBoatId: 'mark-b',
  },
  {
    directionDegrees: 346,
    speedKnots: 7.6,
    gustKnots: 9.1,
    observedAt: new Date(Date.now() - 116_000).toISOString(),
    source: 'マークボートC',
    trend: 'left',
    confidence: 'medium',
    position: [131.5337, 33.2761],
    raceId: 'race-1',
    committeeBoatId: 'mark-c',
  },
] as const

export const INITIAL_CURRENT: CurrentObservation = {
  directionDegrees: 185,
  speedKnots: 0.4,
  observedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  source: 'コースセッター',
  confidence: 'low',
}
