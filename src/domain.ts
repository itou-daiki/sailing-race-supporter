export type LngLat = readonly [longitude: number, latitude: number]

export type MarkStatus = 'planned' | 'en-route' | 'deployed' | 'confirmed'

export interface CourseMark {
  id: string
  label: string
  shortLabel: string
  target: LngLat
  actual?: LngLat
  status: MarkStatus
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
}

export interface RaceDefinition {
  id: string
  number: string
  className: SailingClass
  courseCode: string
  status: 'planning' | 'setup' | 'start-sequence' | 'racing' | 'provisional' | 'finalized'
  warningAt: string
  targetMinutes: number
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
  actor?: string
}

export type SailingClass =
  | 'OP'
  | 'ILCA 4'
  | 'ILCA 6'
  | 'ILCA 7'
  | '420'
  | '470'
  | 'スナイプ'

export type BoardDetail = 'overview' | 'standard' | 'detail'

export interface OperationalTask {
  id: string
  raceId?: string
  title: string
  owner: string
  status: 'blocked' | 'waiting' | 'doing' | 'done'
  dueLabel: string
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
    type: 'event' | 'race' | 'boat' | 'mark' | 'role' | 'member'
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

export interface ClassPerformanceProfile {
  className: SailingClass
  targetMinutes: number
  upwindKnotsAt8: number
  downwindKnotsAt8: number
  reachKnotsAt8: number
}

export const CLASS_PROFILES: readonly ClassPerformanceProfile[] = [
  { className: 'OP', targetMinutes: 50, upwindKnotsAt8: 3.1, downwindKnotsAt8: 3.5, reachKnotsAt8: 4.0 },
  { className: 'ILCA 4', targetMinutes: 50, upwindKnotsAt8: 3.8, downwindKnotsAt8: 4.2, reachKnotsAt8: 4.8 },
  { className: 'ILCA 6', targetMinutes: 50, upwindKnotsAt8: 4.1, downwindKnotsAt8: 4.6, reachKnotsAt8: 5.2 },
  { className: 'ILCA 7', targetMinutes: 50, upwindKnotsAt8: 4.3, downwindKnotsAt8: 4.8, reachKnotsAt8: 5.4 },
  { className: '420', targetMinutes: 45, upwindKnotsAt8: 4.6, downwindKnotsAt8: 5.8, reachKnotsAt8: 6.4 },
  { className: '470', targetMinutes: 50, upwindKnotsAt8: 5.1, downwindKnotsAt8: 6.6, reachKnotsAt8: 7.3 },
  { className: 'スナイプ', targetMinutes: 60, upwindKnotsAt8: 4.3, downwindKnotsAt8: 4.8, reachKnotsAt8: 5.1 },
] as const

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
        target: [139.4661, 35.2948],
        actual: [139.46638, 35.29455],
        status: 'confirmed',
        assignedBoatId: 'mark-a',
      },
      {
        id: 'mark-1a',
        label: 'オフセット 1A',
        shortLabel: '1A',
        target: [139.46915, 35.2945],
        actual: [139.46906, 35.29431],
        status: 'deployed',
        assignedBoatId: 'mark-a',
      },
      {
        id: 'mark-2',
        label: '2マーク',
        shortLabel: '2',
        target: [139.4723, 35.2881],
        status: 'en-route',
        assignedBoatId: 'mark-b',
      },
      {
        id: 'mark-3s',
        label: '下ゲート 3S',
        shortLabel: '3S',
        target: [139.46265, 35.28165],
        actual: [139.46242, 35.28175],
        status: 'confirmed',
        assignedBoatId: 'mark-c',
        isGate: true,
        gateSide: 'S',
      },
      {
        id: 'mark-3p',
        label: '下ゲート 3P',
        shortLabel: '3P',
        target: [139.46485, 35.28165],
        actual: [139.46498, 35.28147],
        status: 'confirmed',
        assignedBoatId: 'mark-c',
        isGate: true,
        gateSide: 'P',
      },
      {
        id: 'start-pin',
        label: 'スタート・ピン',
        shortLabel: 'PIN',
        target: [139.4586, 35.27915],
        actual: [139.45873, 35.27921],
        status: 'confirmed',
        assignedBoatId: 'signal',
      },
      {
        id: 'start-rc',
        label: 'シグナルボート',
        shortLabel: 'RC',
        target: [139.46575, 35.27908],
        actual: [139.46564, 35.27912],
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
    position: [139.4682, 35.2918],
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
    position: [139.4738, 35.2855],
    speedKnots: 3.2,
    courseDegrees: 18,
    freshnessSeconds: 6,
    status: 'moving',
  },
  {
    id: 'mark-c',
    name: 'マークボートC',
    assignment: '下ゲート',
    position: [139.4631, 35.2821],
    speedKnots: 0.2,
    freshnessSeconds: 3,
    status: 'stationed',
  },
  {
    id: 'signal',
    name: 'シグナルボート',
    assignment: 'スタート／フィニッシュ',
    position: [139.46564, 35.27912],
    speedKnots: 0,
    freshnessSeconds: 1,
    status: 'stationed',
  },
  {
    id: 'jury-1',
    name: 'ジュリーボート',
    assignment: 'プロテスト',
    position: [139.4598, 35.2861],
    speedKnots: 4.1,
    courseDegrees: 92,
    freshnessSeconds: 8,
    status: 'moving',
  },
] as const

export const DEMO_TASKS: readonly OperationalTask[] = [
  {
    id: 'task-line',
    title: 'スタートライン方位を再確認',
    owner: 'シグナルボート',
    status: 'blocked',
    dueLabel: '予告3分前',
    priority: 'required',
  },
  {
    id: 'task-mark-2',
    title: '2マークを投下して位置確定',
    owner: 'マークボートB',
    status: 'doing',
    dueLabel: '予告5分前',
    markId: 'mark-2',
    priority: 'required',
  },
  {
    id: 'task-wind',
    title: '5分平均風を更新',
    owner: 'コースセッター',
    status: 'waiting',
    dueLabel: '2分以内',
    priority: 'required',
  },
  {
    id: 'task-audio',
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
    text: '風向350°で安定。コースO2を継続します。',
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
}
