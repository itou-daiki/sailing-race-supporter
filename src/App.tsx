import {
  AlertTriangle,
  Anchor,
  BellRing,
  ChevronDown,
  CircleUserRound,
  CloudOff,
  FilePenLine,
  LockKeyhole,
  Menu,
  MessageSquareText,
  RadioTower,
  ScrollText,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Waves,
  X,
} from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { bearingDegrees, distanceMetres, generateCoursePlan, midpoint, recommendedCourseLength, type CourseTemplate } from './course'
import {
  CLASS_PROFILES,
  DEMO_BOATS,
  DEMO_MARK_WINDS,
  DEMO_MESSAGES,
  DEMO_RACES,
  DEMO_TASKS,
  INITIAL_CURRENT,
  INITIAL_WIND,
  type BoardDetail,
  type CommitteeBoat,
  type CourseMark,
  type CurrentObservation,
  type FinishObservation,
  type FinishRecord,
  type LeadingPassageObservation,
  type LeadingPassageVisit,
  type LngLat,
  type MarkStatus,
  type OperationalMessage,
  type OperationalTask,
  type RaceDefinition,
  type RaceSignalEvent,
  type SailingClass,
  type WindObservation,
} from './domain'
import { OperationsBoard } from './components/OperationsBoard'
import { CoursePresetPicker } from './components/CoursePresetPicker'
import { WindEntrySheet, type MarkWindInput, type MarkWindSaveResult } from './components/WindEntrySheet'
import { StartSequence } from './components/StartSequence'
import { RaceTabs } from './components/RaceTabs'
import { OperationalCommandBar } from './components/OperationalCommandBar'
import { MobileCommandDock } from './components/MobileCommandDock'
import { PreEventCoursePlanner } from './components/PreEventCoursePlanner'
import {
  authenticatePasskey,
  authErrorMessage,
  hasRecentPasskeyAuthentication,
  loadSession,
  type SessionState,
} from './authClient'
import {
  createPostFinalizationRevisionDraft,
  discardPostFinalizationRevisionDraft,
  EventApiError,
  loadCourseRevisions,
  loadEventBootstrap,
  publishPostFinalizationRevisionDraft,
  rollbackCourseRevision,
  saveCourseRevision,
} from './eventClient'
import type { CourseRevisionSummary, EventAccessSummary, EventCreationPlan, EventResources, PostFinalizationRevisionDraft } from './eventClient'
import { loadEventSnapshot, saveEventSnapshot } from './offlineStore'
import { RealtimeOperationError, useEventRoom, type SequencedOperation } from './realtime'
import { useOfficialAudioDevice } from './audioDeviceClient'
import { adoptPassageObservation, latestPassageSummary, mergePassageObservation, passageVisitKey } from './passages'
import { adoptFinishObservation, finishRecordKey, mergeFinishObservation } from './finishes'
import { isRaceSignalHeld, makeRaceSignalEvent } from './signals'
import { raceFinalizationPhrase } from '../shared/finalization'
import { estimateRegattaFreeTierUsage, STANDARD_REGATTA_LOAD } from '../shared/freeTierBudget'
import { normalizeBoatMotion } from './boatMotion'
import type { CoordinateEntryMode } from './coordinateEntry'
import { formatTrueBearing } from '../shared/trueBearing'
import { coursePresetForClass, normalizeCoursePresetCode, type CoursePresetCode } from '../shared/coursePresets'
import { assignWindReadingsToMarks, formatWindSpeedDual } from './markWind'
import { canRecordOverallWind, isRaceOfficerRole, operationRoleLabel, roleCan } from '../shared/roles'
import type { OperationMode } from '../shared/operationModes'
import { deriveOperationalGuidance } from './operationalGuidance'
import { shortCourseMarkLabel } from './courseMarkLabels'
import {
  WORLD_SAILING_TRAPEZOID_FINISH_DISTANCE_METRES,
  finishDistanceMode as inferFinishDistanceMode,
  isValidCustomFinishDistanceMetres,
  metresToNauticalMiles,
  nauticalMilesToMetres,
  supportsTrapezoidFinishDistance,
  type FinishDistanceMode,
} from '../shared/finishDistance'
import { FinishDistanceControl } from './components/FinishDistanceControl'

const DETAIL_KEY = 'srs-board-detail-v2'
const SCALE_KEY = 'srs-board-scale'
const SPLIT_KEY = 'srs-map-split'

interface PendingMarkCorrection {
  markId: string
  label: string
  actual: LngLat
  recordedAt: string
  source: 'device-geolocation' | 'handheld-gps-manual'
  entryMode?: CoordinateEntryMode
  accuracyMetres?: number
  note?: string
  committeeBoatId?: string
}

const operationLabels: Record<string, string> = {
  position: '運営ボート位置', wind: '風向風速', current: '潮流', mark: 'マーク操作',
  'leading-passage': '先頭通過', finish: 'フィニッシュ', task: '運用タスク', message: 'メッセージ',
  signal: 'レース信号', 'signal-audio': '公式音響', schedule: '予告予定', finalize: 'レース確定',
  course: 'コース改訂', assignment: '担当変更',
}

interface CachedAppState {
  eventName: string
  operationMode?: OperationMode
  races: readonly RaceDefinition[]
  boats: readonly CommitteeBoat[]
  messages: readonly OperationalMessage[]
  tasks: readonly OperationalTask[]
  leadingPassages: Record<string, LeadingPassageVisit>
  finishes: Record<string, FinishRecord>
  memberCount: number
  wind?: WindObservation
  winds?: readonly WindObservation[]
  current?: CurrentObservation
}

const AuthPanel = lazy(() => import('./components/AuthPanel').then((module) => ({ default: module.AuthPanel })))
const EventManager = lazy(() => import('./components/EventManager').then((module) => ({ default: module.EventManager })))
const JoinRecoveryPanel = lazy(() => import('./components/JoinRecoveryPanel').then((module) => ({ default: module.JoinRecoveryPanel })))
const LogDrawer = lazy(() => import('./components/LogDrawer').then((module) => ({ default: module.LogDrawer })))
const MapView = lazy(() => import('./components/MapView').then((module) => ({ default: module.MapView })))

function storedNumber(key: string, fallback: number): number {
  const value = Number(window.localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function eventSlugFromLocation(): string {
  const match = window.location.pathname.match(/^\/e\/([^/]+)/)
  return match ? decodeURIComponent(match[1]) : 'enoshima-summer-regatta'
}

function hasEventLocation(): boolean {
  return /^\/e\/[^/]+/u.test(window.location.pathname)
}

function localMemberId(): string {
  const key = 'srs-local-member-id'
  const existing = window.localStorage.getItem(key)
  if (existing) return existing
  const created = crypto.randomUUID()
  window.localStorage.setItem(key, created)
  return created
}

function joinContextFromLocation(): { inviteId: string; secret: string } | undefined {
  const match = window.location.pathname.match(/^\/e\/[^/]+\/join\/([^/]+)/)
  if (!match) return undefined
  const secret = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? ''
  return { inviteId: decodeURIComponent(match[1]), secret }
}

function formatClock(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso))
}

function formatDueClock(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

function formatCourseRevisionTime(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

function dateTimeLocalValue(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function applyShiftedTaskTimes(
  current: readonly OperationalTask[],
  shiftedTasks: readonly { taskId: string; dueAt: string }[],
): readonly OperationalTask[] {
  const dueTimes = new Map(shiftedTasks.map((task) => [task.taskId, task.dueAt]))
  if (!dueTimes.size) return current
  return current.map((task) => {
    const dueAt = dueTimes.get(task.id)
    return dueAt ? { ...task, dueAt, dueLabel: `${formatDueClock(dueAt)}まで` } : task
  })
}

function messageTargetPayload(value: string, raceId: string): { targetType: NonNullable<OperationalMessage['target']>['type']; targetId?: string } {
  if (value === 'event') return { targetType: 'event' }
  if (value === 'race') return { targetType: 'race', targetId: raceId }
  const separator = value.indexOf(':')
  const targetType = value.slice(0, separator) as NonNullable<OperationalMessage['target']>['type']
  return { targetType, targetId: value.slice(separator + 1) }
}

function messageReceiptLabel(message: OperationalMessage): string | undefined {
  if (!message.receipts || message.receipts.targetCount === 0) return undefined
  const receipt = message.receipts
  if (message.priority === 'normal') return `既読 ${receipt.readCount}/${receipt.targetCount}`
  return `確認 ${receipt.acknowledgedCount}/${receipt.targetCount}・既読 ${receipt.readCount}`
}

function messageTargetLabel(value: string, raceNumber: string, resources: EventResources): string {
  if (value === 'event') return '大会全体'
  if (value === 'race') return `${raceNumber}・全運営`
  const separator = value.indexOf(':')
  const type = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (type === 'area') return resources.areas.find((area) => area.id === id)?.name ?? 'レースエリア'
  if (type === 'boat') return resources.boats.find((boat) => boat.id === id)?.assignment ?? '運営ボート'
  if (type === 'mark') return resources.marks.find((mark) => mark.id === id)?.label ?? 'マーク'
  if (type === 'role') return `${operationRoleLabel(id)}担当`
  if (type === 'member') {
    const member = resources.members.find((candidate) => candidate.id === id)
    return member ? `${member.displayName}（${member.assignment}）` : '運営メンバー'
  }
  return raceNumber
}

export default function App() {
  const [eventId] = useState(eventSlugFromLocation)
  const [eventRoute] = useState(hasEventLocation)
  const [eventDatabaseId, setEventDatabaseId] = useState<string>()
  const [eventName, setEventName] = useState('2026 別府湾サマーレガッタ')
  const [operationMode, setOperationMode] = useState<OperationMode>('team')
  const [memberId, setMemberId] = useState(localMemberId)
  const [activeRaceId, setActiveRaceId] = useState(DEMO_RACES[0].id)
  const [races, setRaces] = useState<readonly RaceDefinition[]>(DEMO_RACES)
  const [boats, setBoats] = useState<readonly CommitteeBoat[]>(DEMO_BOATS)
  const [selectedMarkId, setSelectedMarkId] = useState<string>()
  const [messages, setMessages] = useState<readonly OperationalMessage[]>(DEMO_MESSAGES)
  const [tasks, setTasks] = useState<readonly OperationalTask[]>(DEMO_TASKS)
  const [memberCount, setMemberCount] = useState(18)
  const [eventRefreshKey, setEventRefreshKey] = useState(0)
  const [operationError, setOperationError] = useState<string>()
  const [messagesOpen, setMessagesOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [windEntryOpen, setWindEntryOpen] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [resumeEventIssuanceAfterAuth, setResumeEventIssuanceAfterAuth] = useState(false)
  const [eventManagerOpen, setEventManagerOpen] = useState(false)
  const [preEventPlan, setPreEventPlan] = useState<EventCreationPlan>()
  const [joinContext, setJoinContext] = useState(joinContextFromLocation)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [session, setSession] = useState<SessionState>({ mode: 'checking' })
  const [eventAccess, setEventAccess] = useState<EventAccessSummary>()
  const [eventResources, setEventResources] = useState<EventResources>({ areas: [], boats: [], marks: [], members: [] })
  const [confirmFinalize, setConfirmFinalize] = useState(false)
  const [finalizeConfirmation, setFinalizeConfirmation] = useState('')
  const [finalizeWorking, setFinalizeWorking] = useState(false)
  const [finalizeReauthWorking, setFinalizeReauthWorking] = useState(false)
  const [finalizeError, setFinalizeError] = useState<string>()
  const [finalizeNeedsReauth, setFinalizeNeedsReauth] = useState(false)
  const [revisionOpen, setRevisionOpen] = useState(false)
  const [revisionCourseCode, setRevisionCourseCode] = useState('')
  const [revisionTargetMinutes, setRevisionTargetMinutes] = useState(50)
  const [revisionReason, setRevisionReason] = useState('確定後に判明した運営記録の訂正')
  const [revisionNote, setRevisionNote] = useState('')
  const [revisionConfirmation, setRevisionConfirmation] = useState('')
  const [pendingMarkCorrection, setPendingMarkCorrection] = useState<PendingMarkCorrection>()
  const [revisionDrafts, setRevisionDrafts] = useState<Record<string, PostFinalizationRevisionDraft>>({})
  const [revisionWorking, setRevisionWorking] = useState(false)
  const [revisionError, setRevisionError] = useState<string>()
  const [boardScale, setBoardScale] = useState(() => storedNumber(SCALE_KEY, 100))
  const [boardDetail, setBoardDetail] = useState<BoardDetail>(() => {
    const stored = window.localStorage.getItem(DETAIL_KEY)
    return stored === 'standard' || stored === 'detail' ? stored : 'overview'
  })
  const [mapSplit, setMapSplit] = useState(() => storedNumber(SPLIT_KEY, 58))
  const [mobileMapPriority, setMobileMapPriority] = useState(true)
  const [courseAdvisorExpanded, setCourseAdvisorExpanded] = useState(false)
  const [selectedClassOverrides, setSelectedClassOverrides] = useState<Partial<Record<string, SailingClass>>>({})
  const [courseWindSpeed, setCourseWindSpeed] = useState(INITIAL_WIND.speedKnots)
  const [courseWindDirection, setCourseWindDirection] = useState(INITIAL_WIND.directionDegrees)
  const [windDetails, setWindDetails] = useState<WindObservation>(INITIAL_WIND)
  const [markWinds, setMarkWinds] = useState<readonly WindObservation[]>(DEMO_MARK_WINDS)
  const [seaCurrent, setSeaCurrent] = useState<CurrentObservation>(INITIAL_CURRENT)
  const [courseTemplate, setCourseTemplate] = useState<CourseTemplate>('O2')
  const [lowerGate, setLowerGate] = useState(true)
  const [finishLineMode, setFinishLineMode] = useState<'separate' | 'shared-rc'>('separate')
  const [finishDistanceSelection, setFinishDistanceSelection] = useState<FinishDistanceMode>('world-sailing-standard')
  const [customFinishDistanceNm, setCustomFinishDistanceNm] = useState('0.15')
  const [upperGate, setUpperGate] = useState(false)
  const [secondGate, setSecondGate] = useState(false)
  const [gateWidthMetres, setGateWidthMetres] = useState(130)
  const [courseSaving, setCourseSaving] = useState(false)
  const [courseSaveError, setCourseSaveError] = useState<string>()
  const [courseHistory, setCourseHistory] = useState<CourseRevisionSummary[]>([])
  const [courseHistoryLoading, setCourseHistoryLoading] = useState(false)
  const [courseRollbackWorking, setCourseRollbackWorking] = useState<number>()
  const [scheduleWarningDrafts, setScheduleWarningDrafts] = useState<Record<string, string>>(() => ({
    [DEMO_RACES[0].id]: dateTimeLocalValue(DEMO_RACES[0].warningAt),
  }))
  const [scheduleReason, setScheduleReason] = useState('大会運営計画の更新')
  const [scheduleWorking, setScheduleWorking] = useState(false)
  const [scheduleError, setScheduleError] = useState<string>()
  const [preparatoryFlag, setPreparatoryFlag] = useState('P旗')
  const [messageDraft, setMessageDraft] = useState('')
  const [messagePriority, setMessagePriority] = useState<OperationalMessage['priority']>('normal')
  const [messageTarget, setMessageTarget] = useState('race')
  const [leadingPassages, setLeadingPassages] = useState<Record<string, LeadingPassageVisit>>({})
  const [finishes, setFinishes] = useState<Record<string, FinishRecord>>({})
  const draggingSplit = useRef(false)
  const memberIdRef = useRef(memberId)
  const messageReadsRequested = useRef(new Set<string>())

  useEffect(() => {
    memberIdRef.current = memberId
  }, [memberId])

  const applyRemoteEvent = useCallback((event: SequencedOperation) => {
    if (event.type === 'position') {
      const payload = event.payload as { committeeBoatId?: string; position?: LngLat; speedKnots?: number | null; courseDegrees?: number | null; accuracyMetres?: number | null }
      if (!payload.committeeBoatId || !payload.position) return
      const motion = normalizeBoatMotion(payload)
      setBoats((current) => current.map((boat) => (
        boat.id === payload.committeeBoatId
          ? {
              ...boat,
              position: payload.position as LngLat,
              speedKnots: motion.speedKnots,
              courseDegrees: motion.courseDegrees,
              accuracyMetres: motion.accuracyMetres,
              freshnessSeconds: 0,
            }
          : boat
      )))
    }

    if (event.type === 'mark') {
      const payload = event.payload as { markId?: string; actual?: LngLat; status?: MarkStatus; recordedAt?: string }
      if (!event.raceId || !payload.markId || !payload.actual) return
      setRaces((current) => current.map((race) => (
        race.id === event.raceId
          ? {
              ...race,
              marks: race.marks.map((mark) => (
                mark.id === payload.markId
                  ? payload.status === 'confirmed'
                    ? { ...mark, verificationPosition: payload.actual, status: 'confirmed', lastUpdatedAt: payload.recordedAt ?? event.serverTime }
                    : payload.status === 'recovered'
                      ? { ...mark, recoveryPosition: payload.actual, status: 'recovered', lastUpdatedAt: payload.recordedAt ?? event.serverTime }
                      : {
                          ...mark,
                          actual: payload.actual,
                          verificationPosition: undefined,
                          recoveryPosition: undefined,
                          status: payload.status ?? 'deployed',
                          lastUpdatedAt: payload.recordedAt ?? event.serverTime,
                        }
                  : mark
              )),
            }
          : race
      )))
    }

    if (event.type === 'leading-passage') {
      const payload = event.payload as {
        action?: 'observe' | 'adopt'; markId?: string; lapNumber?: number
        observation?: LeadingPassageObservation; observationId?: string; adoptedAt?: string
      }
      if (!event.raceId || !payload.markId) return
      const lapNumber = payload.lapNumber ?? 1
      const key = passageVisitKey(event.raceId, payload.markId, lapNumber)
      if (payload.action === 'observe' && payload.observation) {
        setLeadingPassages((current) => ({
          ...current,
          [key]: mergePassageObservation(
            current[key], event.raceId as string, payload.markId as string, lapNumber, payload.observation as LeadingPassageObservation,
          ),
        }))
      }
      if (payload.action === 'adopt' && payload.observationId && payload.adoptedAt) {
        setLeadingPassages((current) => current[key] ? ({
          ...current,
          [key]: adoptPassageObservation(current[key], payload.observationId as string, payload.adoptedAt as string),
        }) : current)
      }
    }

    if (event.type === 'finish') {
      const payload = event.payload as {
        action?: 'observe' | 'adopt'; finishPosition?: number
        observation?: FinishObservation; observationId?: string; adoptedAt?: string
      }
      if (!event.raceId) return
      const finishPosition = payload.finishPosition ?? 1
      const key = finishRecordKey(event.raceId, finishPosition)
      if (payload.action === 'observe' && payload.observation) {
        setFinishes((current) => ({
          ...current,
          [key]: mergeFinishObservation(
            current[key], event.raceId as string, finishPosition, payload.observation as FinishObservation,
          ),
        }))
      }
      if (payload.action === 'adopt' && payload.observationId && payload.adoptedAt) {
        setFinishes((current) => current[key] ? ({
          ...current,
          [key]: adoptFinishObservation(current[key], payload.observationId as string, payload.adoptedAt as string),
        }) : current)
      }
    }

    if (event.type === 'task') {
      const payload = event.payload as { taskId?: string; status?: OperationalTask['status']; changedAt?: string }
      if (!payload.taskId || !payload.status) return
      setTasks((current) => current.map((task) => (
        task.id === payload.taskId
          ? { ...task, status: payload.status as OperationalTask['status'], lastUpdatedAt: payload.changedAt ?? event.serverTime }
          : task
      )))
    }

    if (event.type === 'schedule') {
      const payload = event.payload as {
        warningAt?: string
        shiftedTasks?: Array<{ taskId: string; dueAt: string }>
      }
      if (!event.raceId || !payload.warningAt) return
      setRaces((current) => current.map((race) => (
        race.id === event.raceId ? { ...race, warningAt: payload.warningAt as string } : race
      )))
      setScheduleWarningDrafts((current) => ({ ...current, [event.raceId as string]: dateTimeLocalValue(payload.warningAt as string) }))
      if (payload.shiftedTasks) setTasks((current) => applyShiftedTaskTimes(current, payload.shiftedTasks ?? []))
    }

    if (event.type === 'wind') {
      const payload = event.payload as Partial<WindObservation>
      if (typeof payload.directionDegrees === 'number') setCourseWindDirection(payload.directionDegrees)
      if (typeof payload.speedKnots === 'number') setCourseWindSpeed(payload.speedKnots)
      if (typeof payload.directionDegrees === 'number' && typeof payload.speedKnots === 'number') {
        const nextWind: WindObservation = {
          directionDegrees: payload.directionDegrees,
          speedKnots: payload.speedKnots,
          gustKnots: payload.gustKnots ?? payload.speedKnots,
          observedAt: payload.observedAt ?? event.serverTime,
          source: payload.source ?? '運営メンバー',
          trend: payload.trend ?? 'steady',
          confidence: payload.confidence ?? 'low',
          position: payload.position,
          raceId: event.raceId,
          committeeBoatId: payload.committeeBoatId,
          markId: payload.markId,
        }
        setWindDetails(nextWind)
        if (nextWind.markId || nextWind.committeeBoatId) {
          setMarkWinds((current) => [
            nextWind,
            ...current.filter((observation) => {
              if (observation.raceId !== nextWind.raceId) return true
              if (nextWind.markId) return observation.markId !== nextWind.markId
              return Boolean(observation.markId) || observation.committeeBoatId !== nextWind.committeeBoatId
            }),
          ])
        }
      }
    }

    if (event.type === 'current') {
      const payload = event.payload as Partial<CurrentObservation>
      if (typeof payload.directionDegrees !== 'number' || typeof payload.speedKnots !== 'number') return
      setSeaCurrent({
        directionDegrees: payload.directionDegrees,
        speedKnots: payload.speedKnots,
        observedAt: payload.observedAt ?? event.serverTime,
        source: payload.source ?? '運営メンバー',
        confidence: payload.confidence ?? 'low',
        position: payload.position,
      })
    }

    if (event.type === 'assignment') {
      const payload = event.payload as {
        memberId?: string; assignment?: string; raceAreaId?: string
        committeeBoatId?: string; markId?: string
      }
      if (!payload.memberId || !payload.assignment) return
      setEventResources((current) => ({
        ...current,
        members: current.members.map((member) => member.id === payload.memberId ? {
          ...member,
          assignment: payload.assignment as string,
          raceAreaId: payload.raceAreaId,
          committeeBoatId: payload.committeeBoatId,
          markId: payload.markId,
        } : member),
      }))
      setEventRefreshKey((current) => current + 1)
    }

    if (event.type === 'course') {
      const payload = event.payload as { courseCode?: string }
      if (event.raceId && payload.courseCode) {
        setRaces((current) => current.map((race) => (
          race.id === event.raceId ? { ...race, courseCode: payload.courseCode as string } : race
        )))
      }
      setEventRefreshKey((current) => current + 1)
    }

    if (event.type === 'message') {
      const payload = event.payload as {
        action?: string; messageId?: string; body?: string; sender?: string; channel?: string
        priority?: OperationalMessage['priority']; sentAt?: string; senderMemberId?: string
        memberId?: string; target?: OperationalMessage['target']; receipts?: OperationalMessage['receipts']
        recipientMemberIds?: string[]
      }
      if ((payload.action === 'acknowledge' || payload.action === 'read') && payload.messageId) {
        setMessages((current) => current.map((message) => (
          message.id === payload.messageId ? {
            ...message,
            receipts: payload.receipts ?? message.receipts,
            ownReceipt: payload.memberId === memberIdRef.current
              ? payload.action === 'acknowledge' ? 'acknowledged' as const : 'read' as const
              : message.ownReceipt,
            acknowledgement: payload.memberId === memberIdRef.current && payload.action === 'acknowledge'
              ? 'acknowledged' as const
              : message.acknowledgement,
          } : message
        )))
      } else if (payload.body) {
        const received: OperationalMessage = {
          id: event.id,
          raceId: event.raceId,
          sender: payload.sender ?? '運営メンバー',
          senderMemberId: payload.senderMemberId,
          channel: payload.channel ?? event.raceId ?? 'event',
          text: payload.body as string,
          sentAt: payload.sentAt ?? event.serverTime,
          priority: payload.priority ?? 'normal',
          target: payload.target,
          receipts: payload.receipts,
          ownReceipt: payload.recipientMemberIds?.includes(memberIdRef.current) ? 'unread' : undefined,
          acknowledgement: payload.recipientMemberIds?.includes(memberIdRef.current) && (payload.priority === 'confirm' || payload.priority === 'urgent') ? 'pending' : undefined,
        }
        setMessages((current) => current.some((message) => message.id === event.id)
          ? current.map((message) => message.id === event.id ? { ...message, ...received } : message)
          : [...current, received])
      }
    }

    if (event.type === 'finalize' && event.raceId) {
      setRaces((current) => current.map((race) => (
        race.id === event.raceId ? { ...race, status: 'finalized' as const } : race
      )))
    }

    if (event.type === 'signal') {
      const payload = event.payload as Partial<Omit<RaceSignalEvent, 'id'>> & {
        schedule?: { shiftedTasks?: Array<{ taskId: string; dueAt: string }> }
      }
      if (!event.raceId || !payload.action || !payload.executedAt) return
      const signal = makeRaceSignalEvent(event.id, payload.action, payload.executedAt, payload)
      const startsSequence = ['warning', 'preparatory', 'one-minute', 'resume', 'general-recall-clear', 'abandon-clear'].includes(signal.action)
      const startsRace = ['start', 'individual-recall', 'individual-recall-clear', 'shorten', 'course-change', 'mark-missing'].includes(signal.action)
      const returnsToSetup = ['postpone', 'postpone-h', 'postpone-a', 'general-recall', 'abandon', 'abandon-h', 'abandon-a'].includes(signal.action)
      setRaces((current) => current.map((race) => race.id === event.raceId ? {
        ...race,
        warningAt: signal.warningAt ?? race.warningAt,
        latestSignal: signal,
        status: startsSequence ? 'start-sequence' : startsRace ? 'racing' : returnsToSetup ? 'setup' : race.status,
      } : race))
      if (signal.warningAt) {
        setScheduleWarningDrafts((current) => ({ ...current, [event.raceId as string]: dateTimeLocalValue(signal.warningAt as string) }))
      }
      if (payload.schedule?.shiftedTasks) {
        setTasks((current) => applyShiftedTaskTimes(current, payload.schedule?.shiftedTasks ?? []))
      }
    }

    if (event.type === 'signal-audio') {
      const payload = event.payload as {
        signalId?: string
        soundExecutedAt?: string
        soundStatus?: RaceSignalEvent['soundStatus']
        officialAudioDeviceId?: string
      }
      if (!event.raceId || !payload.signalId || !payload.soundExecutedAt) return
      setRaces((current) => current.map((race) => {
        const latestSignal = race.latestSignal
        if (race.id !== event.raceId || !latestSignal || latestSignal.id !== payload.signalId) return race
        return {
          ...race,
          latestSignal: {
            ...latestSignal,
            soundExecutedAt: payload.soundExecutedAt,
            soundStatus: payload.soundStatus ?? 'played',
            officialAudioDeviceId: payload.officialAudioDeviceId,
          },
        }
      }))
    }
  }, [])

  const sessionUserId = session.mode === 'authenticated' ? session.user.id : ''
  const sessionConnectionKey = session.mode === 'authenticated' ? `${session.user.id}:${session.expiresAt}` : session.mode
  const realtime = useEventRoom({
    eventId,
    memberId,
    connectionKey: sessionConnectionKey,
    enabled: session.mode === 'authenticated' && eventRoute && Boolean(eventAccess),
    onEvent: applyRemoteEvent,
    onOperationError: (error, operation) => {
      setOperationError(`${operation ? operationLabels[operation] ?? operation : '操作'}：${error.message}`)
      if (error.code === 'AUTHENTICATION_REQUIRED' || error.code === 'RECENT_AUTHENTICATION_REQUIRED') setAuthOpen(true)
      setEventRefreshKey((current) => current + 1)
    },
    onResyncRequired: () => setEventRefreshKey((current) => current + 1),
  })
  const sendRealtimeOperation = realtime.send

  const activeRace = races.find((race) => race.id === activeRaceId) ?? races[0]
  const selectedClass = selectedClassOverrides[activeRace.id] ?? activeRace.className
  const setSelectedClass = (className: SailingClass) => {
    setSelectedClassOverrides((current) => ({ ...current, [activeRace.id]: className }))
  }
  const changeSelectedClass = (nextClass: SailingClass) => {
    const crossesSnipeBoundary = (selectedClass === 'スナイプ') !== (nextClass === 'スナイプ')
    const nextCode = crossesSnipeBoundary
      ? nextClass === 'スナイプ' ? 'W2' : 'O2'
      : normalizeCoursePresetCode(nextClass, courseTemplate)
    setSelectedClass(nextClass)
    setCourseTemplate(nextCode)
    setLowerGate(coursePresetForClass(nextClass, nextCode).route.some((point) => point.includes('S/')))
    setSecondGate(false)
  }
  const changeCourseTemplate = (code: CoursePresetCode) => {
    const preset = coursePresetForClass(selectedClass, code)
    setCourseTemplate(code as CourseTemplate)
    setLowerGate(preset.route.some((point) => point.includes('S/')))
    setSecondGate(false)
  }
  const revisionDraft = revisionDrafts[activeRace.id]
  const postponed = isRaceSignalHeld(activeRace.latestSignal)
  const activeCoursePreset = useMemo(
    () => coursePresetForClass(activeRace.className, activeRace.courseCode.split('/')[0].trim()),
    [activeRace.className, activeRace.courseCode],
  )
  const selectedCoursePreset = useMemo(
    () => coursePresetForClass(selectedClass, courseTemplate),
    [courseTemplate, selectedClass],
  )
  const customFinishDistanceMetres = nauticalMilesToMetres(Number(customFinishDistanceNm))
  const finishDistanceInputValid = finishDistanceSelection === 'world-sailing-standard'
    || isValidCustomFinishDistanceMetres(customFinishDistanceMetres)
  const finishDistanceSupported = finishLineMode === 'separate'
    && supportsTrapezoidFinishDistance(selectedCoursePreset.code, selectedClass)
  const configuredFinishDistanceMetres = finishDistanceSupported
    ? finishDistanceSelection === 'custom' && finishDistanceInputValid
      ? customFinishDistanceMetres
      : WORLD_SAILING_TRAPEZOID_FINISH_DISTANCE_METRES
    : undefined
  const raceAreaCenter = useMemo<LngLat | undefined>(() => {
    const area = eventResources.areas.find((candidate) => candidate.id === activeRace.raceAreaId)
    return area?.centerLng !== undefined && area.centerLat !== undefined
      ? [area.centerLng, area.centerLat]
      : undefined
  }, [activeRace.raceAreaId, eventResources.areas])
  const marks = useMemo(() => {
    const sourceMarks: CourseMark[] = activeRace.marks.length ? activeRace.marks : (() => {
      const firstRaceStart = races[0].marks.filter((mark) => mark.shortLabel === 'PIN' || mark.shortLabel === 'RC')
      const fallbackCenter: LngLat = raceAreaCenter
        ?? (firstRaceStart.length === 2 ? midpoint(firstRaceStart[0].target, firstRaceStart[1].target) : races[0].marks[0]?.target)
        ?? [131.5221959, 33.2786648]
      const preview = generateCoursePlan({
        center: fallbackCenter,
        windDirection: courseWindDirection,
        windSpeed: courseWindSpeed,
        totalLengthMetres: recommendedCourseLength(
          activeRace.className,
          courseWindSpeed,
          activeRace.targetMinutes,
          activeCoursePreset.code as CourseTemplate,
          activeRace.finishLineMode ?? 'separate',
          activeRace.finishDistanceMetres,
        ).kilometres * 1_000,
        courseCode: activeCoursePreset.code as CourseTemplate,
        className: activeRace.className,
        lowerGate: activeCoursePreset.route.some((point) => point.includes('S/')),
        upperGate: false,
        finishLineMode: activeRace.finishLineMode ?? 'separate',
        finishDistanceMetres: activeRace.finishDistanceMetres,
      })
      return preview.map((node) => {
        const physical = eventResources.marks.find((mark) => mark.label === node.label)
        return {
          id: physical?.id ?? `${activeRace.id}-${node.key}`,
          label: node.label,
          shortLabel: shortCourseMarkLabel(node.label),
          target: node.target,
          status: 'planned' as const,
          isGate: node.nodeType === 'gate',
          gateSide: node.label.endsWith('S') ? 'S' as const : node.label.endsWith('P') ? 'P' as const : undefined,
        }
      })
    })()
    const usableSourceMarks = activeRace.finishLineMode === 'shared-rc'
      ? sourceMarks.filter((mark) => mark.shortLabel !== 'FIN')
      : sourceMarks
    const requiredFinishLabels = activeRace.finishLineMode === 'shared-rc' ? ['F'] : ['F', 'FIN']
    const marksWithFinish: CourseMark[] = requiredFinishLabels.every((label) => (
      usableSourceMarks.some((mark) => mark.shortLabel === label)
    ))
      ? usableSourceMarks
      : (() => {
          const startPin = usableSourceMarks.find((mark) => mark.shortLabel === 'PIN')
          const startSignal = usableSourceMarks.find((mark) => mark.shortLabel === 'RC')
          const startLine = startPin && startSignal ? {
            pin: startPin.actual ?? startPin.target,
            signal: startSignal.actual ?? startSignal.target,
          } : undefined
          const center = startLine
            ? midpoint(startLine.pin, startLine.signal)
            : raceAreaCenter ?? usableSourceMarks[0]?.target ?? [131.5221959, 33.2786648] as LngLat
          const finishNodes = generateCoursePlan({
            center,
            startLine,
            windDirection: courseWindDirection,
            windSpeed: courseWindSpeed,
            totalLengthMetres: recommendedCourseLength(
              activeRace.className,
              courseWindSpeed,
              activeRace.targetMinutes,
              activeCoursePreset.code as CourseTemplate,
              activeRace.finishLineMode ?? 'separate',
              activeRace.finishDistanceMetres,
            ).kilometres * 1_000,
            courseCode: activeCoursePreset.code as CourseTemplate,
            className: activeRace.className,
            lowerGate: activeCoursePreset.route.some((point) => point.includes('S/')),
            upperGate: false,
            finishLineMode: activeRace.finishLineMode ?? 'separate',
            finishDistanceMetres: activeRace.finishDistanceMetres,
          }).filter((node) => node.nodeType === 'finish' && !usableSourceMarks.some((mark) => (
            mark.shortLabel === shortCourseMarkLabel(node.label)
          )))
          return [...usableSourceMarks, ...finishNodes.map((node) => {
            const physical = eventResources.marks.find((mark) => mark.label === node.label)
            return {
              id: physical?.id ?? `${activeRace.id}-${node.key}`,
              label: node.label,
              shortLabel: shortCourseMarkLabel(node.label),
              target: node.target,
              status: 'planned' as const,
            }
          })]
        })()
    return marksWithFinish.map((mark) => {
      if (mark.assignedBoatId) return mark
      const assignment = eventResources.members.find((member) => member.markId === mark.id && member.committeeBoatId)
      return assignment ? { ...mark, assignedBoatId: assignment.committeeBoatId } : mark
    })
  }, [activeCoursePreset, activeRace, courseWindDirection, courseWindSpeed, eventResources.marks, eventResources.members, raceAreaCenter, races])
  const draftMarkCorrection = revisionDraft?.corrections.markPosition
  const revisionMarkCorrection: PendingMarkCorrection | undefined = pendingMarkCorrection ?? (draftMarkCorrection ? {
    markId: draftMarkCorrection.markId,
    label: draftMarkCorrection.label ?? marks.find((mark) => mark.id === draftMarkCorrection.markId)?.label ?? 'マーク',
    actual: draftMarkCorrection.actual,
    recordedAt: draftMarkCorrection.recordedAt,
    source: draftMarkCorrection.positionSource,
    entryMode: draftMarkCorrection.coordinateEntryMode,
    accuracyMetres: draftMarkCorrection.accuracyMetres,
    note: draftMarkCorrection.note,
    committeeBoatId: draftMarkCorrection.committeeBoatId,
  } : undefined)
  const recommendation = recommendedCourseLength(
    selectedClass,
    courseWindSpeed,
    activeRace.targetMinutes,
    selectedCoursePreset.code as CourseTemplate,
    finishLineMode,
    configuredFinishDistanceMetres,
  )
  const startPinMark = marks.find((mark) => mark.label === 'スタート・ピン')
  const startSignalMark = marks.find((mark) => mark.label === 'シグナルボート')
  const recordedStartEndpoints = Number(Boolean(startPinMark?.actual)) + Number(Boolean(startSignalMark?.actual))
  const useRecordedStartLine = recordedStartEndpoints === 2
  const startPinPosition = startPinMark
    ? useRecordedStartLine ? startPinMark.actual! : startPinMark.target
    : undefined
  const startSignalPosition = startSignalMark
    ? useRecordedStartLine ? startSignalMark.actual! : startSignalMark.target
    : undefined
  const startLineLength = startPinPosition && startSignalPosition
    ? distanceMetres(startPinPosition, startSignalPosition)
    : undefined
  const startLineBearing = startPinPosition && startSignalPosition
    ? bearingDegrees(startPinPosition, startSignalPosition)
    : undefined
  const freeTierBudget = useMemo(() => estimateRegattaFreeTierUsage(STANDARD_REGATTA_LOAD), [])
  const activeTasks = useMemo(
    () => tasks.filter((task) => !task.raceId || task.raceId === activeRace.id),
    [activeRace.id, tasks],
  )
  const locked = activeRace.status === 'finalized'
  const canControlSignals = !locked && (!eventAccess || eventAccess.isOwner || roleCan(eventAccess.role, 'signal'))
  const canChangeCourse = !locked && (!eventAccess || eventAccess.isOwner || roleCan(eventAccess.role, 'course'))
  const canViewCourseHistory = Boolean(eventAccess && (eventAccess.isOwner || roleCan(eventAccess.role, 'course')))
  const canRollbackCourse = Boolean(eventAccess && (
    eventAccess.isOwner || !locked && roleCan(eventAccess.role, 'course')
  ))
  const canShareEnvironment = !locked && (!eventAccess || eventAccess.isOwner || roleCan(eventAccess.role, 'wind'))
  const canManageAllMarks = !eventAccess || eventAccess.isOwner || roleCan(eventAccess.role, 'course')
  const canVerifyMarks = !eventAccess || eventAccess.isOwner || roleCan(eventAccess.role, 'mark')
  const ownMemberResource = eventResources.members.find((member) => member.id === eventAccess?.memberId)
  const selfCommitteeBoat = boats.find((boat) => boat.isSelf)
  const assignedMarkId = ownMemberResource?.markId
    ?? marks.find((mark) => mark.label === eventAccess?.assignment || mark.shortLabel === eventAccess?.assignment)?.id
    ?? marks.find((mark) => mark.assignedBoatId === selfCommitteeBoat?.id)?.id
  const manageableMarkIds = canManageAllMarks
    ? marks.map((mark) => mark.id)
    : assignedMarkId ? [assignedMarkId] : []
  const windObservationMarks = marks.filter((mark) => mark.label !== 'スタート・ピン' && mark.label !== 'シグナルボート')
  const ownWindMarkId = assignedMarkId && windObservationMarks.some((mark) => mark.id === assignedMarkId)
    ? assignedMarkId
    : undefined
  const canChooseWindMark = canManageAllMarks
  const allowOverallWind = canChooseWindMark || !eventAccess || canRecordOverallWind(eventAccess.role)
  const selectedWindCandidate = selectedMarkId && windObservationMarks.some((mark) => mark.id === selectedMarkId)
    ? selectedMarkId
    : undefined
  const defaultWindMarkId = ownWindMarkId
    ?? (canChooseWindMark ? selectedWindCandidate ?? windObservationMarks[0]?.id : undefined)
  const defaultWindMark = windObservationMarks.find((mark) => mark.id === defaultWindMarkId)
  const windTargetLabel = defaultWindMark
    ? `${defaultWindMark.label}${defaultWindMark.id === ownWindMarkId ? '（自分）' : ''}`
    : allowOverallWind ? '本部船・全体風' : '担当未設定'
  const initialWindForEntry = defaultWindMarkId
    ? assignWindReadingsToMarks(marks, markWinds).get(defaultWindMarkId)?.observation ?? windDetails
    : windDetails
  const canScheduleRace = !locked && ['planning', 'setup'].includes(activeRace.status) && Boolean(eventAccess) && (
    Boolean(eventAccess?.isOwner) || roleCan(eventAccess?.role ?? '', 'schedule')
  )
  const scheduleWarningInput = scheduleWarningDrafts[activeRace.id] ?? dateTimeLocalValue(activeRace.warningAt)
  const canAdoptLeadingPassage = !eventAccess || eventAccess.isOwner || roleCan(eventAccess.role, 'finish')
  const canRecordFinish = (!locked || Boolean(eventAccess?.isOwner)) && (
    !eventAccess || eventAccess.isOwner || roleCan(eventAccess.role, 'finish')
  )
  const canAdoptFinish = canRecordFinish
  const canFinalizeRace = !locked && (!eventAccess || eventAccess.isOwner || isRaceOfficerRole(eventAccess.role))
  const finalizePhrase = raceFinalizationPhrase(activeRace.number)
  const recentAuthentication = hasRecentPasskeyAuthentication(session) && !finalizeNeedsReauth
  const firstFinish = finishes[finishRecordKey(activeRace.id, 1)]
  const latestPassage = useMemo(
    () => latestPassageSummary(leadingPassages, marks, activeRace.id),
    [activeRace.id, leadingPassages, marks],
  )
  const guidance = useMemo(() => deriveOperationalGuidance({
    race: activeRace,
    marks,
    tasks: activeTasks,
    messages,
    postponed,
    locked,
    operationMode,
    latestPassage,
    firstFinish,
  }), [activeRace, activeTasks, firstFinish, latestPassage, locked, marks, messages, operationMode, postponed])
  const messageAttentionCount = messages.filter((message) => (
    (!message.raceId || message.raceId === activeRace.id)
    && (message.ownReceipt === 'unread' || message.acknowledgement === 'pending')
  )).length
  const messageRoles = useMemo(
    () => [...new Set(eventResources.members.map((member) => member.role))].sort((left, right) => left.localeCompare(right, 'ja')),
    [eventResources.members],
  )
  const officialAudio = useOfficialAudioDevice({
    eventSlug: eventId,
    raceId: activeRace.id,
    enabled: session.mode === 'authenticated' && Boolean(eventAccess) && canControlSignals,
    serverOffsetMs: realtime.serverOffsetMs,
  })

  useEffect(() => {
    if (!messagesOpen) return
    const unreadMessages = messages
      .filter((message) => message.ownReceipt === 'unread' && !messageReadsRequested.current.has(message.id))
    if (!unreadMessages.length) return
    unreadMessages.forEach((message) => {
      messageReadsRequested.current.add(message.id)
      void sendRealtimeOperation('message', { action: 'read', messageId: message.id }, message.raceId ?? activeRace.id)
    })
  }, [activeRace.id, messages, messagesOpen, sendRealtimeOperation])

  useEffect(() => window.localStorage.setItem(SCALE_KEY, String(boardScale)), [boardScale])
  useEffect(() => window.localStorage.setItem(DETAIL_KEY, boardDetail), [boardDetail])
  useEffect(() => window.localStorage.setItem(SPLIT_KEY, String(mapSplit)), [mapSplit])

  useEffect(() => {
    let active = true
    void loadSession()
      .then((loaded) => { if (active) setSession(loaded) })
      .catch(() => { if (active) setSession({ mode: 'anonymous' }) })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (session.mode !== 'offline-demo' && (session.mode !== 'authenticated' || !sessionUserId)) return
    let active = true
    const applyCachedState = async () => {
      const cached = await loadEventSnapshot<CachedAppState>(eventId)
      if (!active || !cached) return
      setEventName(cached.value.eventName)
      setOperationMode(cached.value.operationMode ?? 'team')
      setRaces(cached.value.races)
      setActiveRaceId((current) => cached.value.races.some((race) => race.id === current) ? current : cached.value.races[0]?.id ?? current)
      setBoats(cached.value.boats)
      setMessages(cached.value.messages)
      setTasks(cached.value.tasks ?? [])
      setLeadingPassages(cached.value.leadingPassages)
      setFinishes(cached.value.finishes ?? {})
      setMemberCount(cached.value.memberCount ?? 0)
      if (cached.value.wind) {
        setCourseWindSpeed(cached.value.wind.speedKnots)
        setCourseWindDirection(cached.value.wind.directionDegrees)
        setWindDetails({ ...INITIAL_WIND, ...cached.value.wind })
      }
      if (cached.value.winds) setMarkWinds(cached.value.winds)
      if (cached.value.current) setSeaCurrent(cached.value.current)
    }
    if (session.mode === 'offline-demo') {
      void applyCachedState()
      return () => { active = false }
    }
    if (!eventRoute) return () => { active = false }
    void loadEventBootstrap(eventId)
      .then((bootstrap) => {
        if (!active) return
        setEventDatabaseId(bootstrap.event.id)
        setEventName(bootstrap.event.name)
        setOperationMode(bootstrap.event.operationMode)
        setEventAccess(bootstrap.access)
        setEventResources(bootstrap.resources)
        setRevisionDrafts(Object.fromEntries(bootstrap.revisionDrafts.map((draft) => [draft.raceId, draft])))
        setMemberId(bootstrap.access.memberId)
        if (bootstrap.races.length) {
          setRaces(bootstrap.races)
          setActiveRaceId((current) => (
            bootstrap.races.some((race) => race.id === current)
              ? current
              : bootstrap.races[0].id
          ))
        }
        setBoats(bootstrap.boats)
        setMessages(bootstrap.messages)
        setTasks(bootstrap.tasks)
        setLeadingPassages(bootstrap.leadingPassages)
        setFinishes(bootstrap.finishes)
        setMemberCount(bootstrap.memberCount)
        if (bootstrap.wind) {
          setCourseWindSpeed(bootstrap.wind.speedKnots)
          setCourseWindDirection(bootstrap.wind.directionDegrees)
          setWindDetails(bootstrap.wind)
        }
        setMarkWinds(bootstrap.winds)
        if (bootstrap.current) setSeaCurrent(bootstrap.current)
      })
      .catch(() => void applyCachedState())
    return () => { active = false }
  }, [eventId, eventRefreshKey, eventRoute, session.mode, sessionUserId])

  useEffect(() => {
    if (!eventRoute) return
    const timeout = window.setTimeout(() => {
      void saveEventSnapshot({
        eventId,
        sequence: realtime.lastSequence,
        savedAt: new Date().toISOString(),
        value: {
          eventName,
          operationMode,
          races,
          boats,
          messages,
          tasks,
          leadingPassages,
          finishes,
          memberCount,
          wind: windDetails,
          winds: markWinds,
          current: seaCurrent,
        },
      })
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [boats, eventId, eventName, eventRoute, finishes, leadingPassages, markWinds, memberCount, messages, operationMode, races, realtime.lastSequence, seaCurrent, tasks, windDetails])

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!draggingSplit.current) return
      const next = (event.clientX / window.innerWidth) * 100
      setMapSplit(Math.min(72, Math.max(40, next)))
    }
    const up = () => { draggingSplit.current = false }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [])

  const updateSelfLocation = (position: LngLat, motion: { speedKnots?: number; courseDegrees?: number; accuracyMetres?: number }) => {
    const selfBoat = boats.find((boat) => boat.isSelf)
    const normalizedMotion = normalizeBoatMotion(motion)
    setBoats((current) => current.map((boat) => (
      boat.isSelf ? {
        ...boat,
        position,
        speedKnots: normalizedMotion.speedKnots,
        courseDegrees: normalizedMotion.courseDegrees,
        accuracyMetres: normalizedMotion.accuracyMetres,
        freshnessSeconds: 0,
        status: 'moving' as const,
      } : boat
    )))
    if (selfBoat) {
      void sendRealtimeOperation('position', {
        committeeBoatId: selfBoat.id,
        position,
        speedKnots: normalizedMotion.speedKnots,
        courseDegrees: normalizedMotion.courseDegrees ?? null,
        accuracyMetres: normalizedMotion.accuracyMetres ?? null,
      }, activeRace.id)
    }
  }

  const acknowledgeMessage = (messageId: string) => {
    const message = messages.find((candidate) => candidate.id === messageId)
    setMessages((current) => current.map((message) => (
      message.id === messageId ? { ...message, acknowledgement: 'acknowledged' as const, ownReceipt: 'acknowledged' as const } : message
    )))
    void sendRealtimeOperation('message', { action: 'acknowledge', messageId }, message?.raceId ?? activeRace.id)
  }

  const advanceTask = (taskId: string) => {
    if (locked && !eventAccess?.isOwner) return
    const task = tasks.find((candidate) => candidate.id === taskId)
    if (!task) return
    const nextStatus: OperationalTask['status'] = task.status === 'done'
      ? 'waiting'
      : task.status === 'doing' ? 'done' : 'doing'
    const changedAt = new Date().toISOString()
    setTasks((current) => current.map((candidate) => (
      candidate.id === taskId ? { ...candidate, status: nextStatus, lastUpdatedAt: changedAt } : candidate
    )))
    void sendRealtimeOperation('task', { taskId, status: nextStatus }, task.raceId ?? activeRace.id)
  }

  const openTaskMessage = (task: OperationalTask) => {
    setMessageDraft(`[${activeRace.number}・${task.title}] `)
    setMessagePriority(task.status === 'blocked' ? 'confirm' : 'normal')
    setMessageTarget('race')
    setMessagesOpen(true)
  }

  const focusMark = (markId: string) => {
    setCourseAdvisorExpanded(false)
    setSelectedMarkId(markId)
    setMobileMapPriority(true)
  }

  const openWindEntry = () => {
    if (!canShareEnvironment) return
    setMessagesOpen(false)
    setLogsOpen(false)
    setSettingsOpen(false)
    setWindEntryOpen(true)
  }

  const activateGuidance = () => {
    const { intent } = guidance
    if (intent.kind === 'messages') {
      setMessagesOpen(true)
      return
    }
    if (intent.kind === 'course') {
      openCourseSettings()
      return
    }
    if (intent.kind === 'mark') {
      focusMark(intent.markId)
      return
    }
    if (intent.kind === 'task') {
      advanceTask(intent.taskId)
      setMobileMapPriority(false)
      return
    }
    if (intent.kind === 'task-message') {
      const task = activeTasks.find((candidate) => candidate.id === intent.taskId)
      if (task) openTaskMessage(task)
    }
  }

  const recordMarkPosition = (
    markId: string,
    actual: LngLat,
    metadata: {
      source: 'device-geolocation' | 'handheld-gps-manual'
      entryMode?: CoordinateEntryMode
      accuracyMetres?: number
      note?: string
      committeeBoatId?: string
    },
    lifecycleStatus?: 'confirmed' | 'recovered',
  ) => {
    const existingMark = marks.find((mark) => mark.id === markId)
    if (!existingMark) return
    if (locked) {
      if (lifecycleStatus) return
      if (!eventAccess?.isOwner) return
      if (revisionDraft) {
        setRevisionError('先に進行中の管理者修正版を再確定または破棄してください')
        setRevisionOpen(true)
        return
      }
      setPendingMarkCorrection({
        markId,
        label: existingMark.label,
        actual,
        recordedAt: new Date().toISOString(),
        source: metadata.source,
        entryMode: metadata.entryMode,
        accuracyMetres: metadata.accuracyMetres,
        note: metadata.note,
        committeeBoatId: metadata.committeeBoatId,
      })
      setRevisionReason(`${existingMark.label}の確定後位置をGPS記録に基づいて訂正`)
      setRevisionNote(metadata.note ?? '')
      setRevisionConfirmation('')
      setRevisionError(undefined)
      setRevisionOpen(true)
      return
    }
    setRaces((current) => current.map((race) => {
      if (race.id !== activeRace.id) return race
      const sourceMarks = race.marks.length ? race.marks : marks
      return {
        ...race,
        marks: sourceMarks.map((mark) => (
          mark.id === markId
            ? lifecycleStatus === 'confirmed'
              ? { ...mark, verificationPosition: actual, status: 'confirmed' as const, lastUpdatedAt: new Date().toISOString() }
              : lifecycleStatus === 'recovered'
                ? { ...mark, recoveryPosition: actual, status: 'recovered' as const, lastUpdatedAt: new Date().toISOString() }
                : {
                    ...mark,
                    actual,
                    verificationPosition: undefined,
                    recoveryPosition: undefined,
                    status: 'deployed' as const,
                    lastUpdatedAt: new Date().toISOString(),
                  }
            : mark
        )),
      }
    }))
    void sendRealtimeOperation('mark', {
      markId,
      actual,
      status: lifecycleStatus ?? (existingMark.actual ? 'moved' : 'deployed'),
      recordedAt: new Date().toISOString(),
      committeeBoatId: metadata.committeeBoatId,
      accuracyMetres: metadata.accuracyMetres,
      positionSource: metadata.source,
      coordinateEntryMode: metadata.entryMode,
      coordinateDatum: 'WGS84',
      note: metadata.note,
    }, activeRace.id)
  }

  const recordMarkDrop = (markId: string) => {
    const selfBoat = boats.find((boat) => boat.isSelf)
    if (!selfBoat) return
    recordMarkPosition(markId, selfBoat.position, {
      source: 'device-geolocation',
      committeeBoatId: selfBoat.id,
      accuracyMetres: selfBoat.accuracyMetres,
    })
  }

  const recordManualMarkPosition = (
    markId: string,
    actual: LngLat,
    metadata: { entryMode: CoordinateEntryMode; accuracyMetres?: number; note?: string },
  ) => {
    const selfBoat = boats.find((boat) => boat.isSelf)
    recordMarkPosition(markId, actual, {
      source: 'handheld-gps-manual',
      committeeBoatId: selfBoat?.id,
      ...metadata,
    })
  }

  const recordMarkConfirmation = (markId: string) => {
    const selfBoat = boats.find((boat) => boat.isSelf)
    if (!selfBoat || locked) return
    recordMarkPosition(markId, selfBoat.position, {
      source: 'device-geolocation',
      committeeBoatId: selfBoat.id,
      accuracyMetres: selfBoat.accuracyMetres,
      note: `${selfBoat.assignment}から位置確認`,
    }, 'confirmed')
  }

  const recordMarkRecovery = (markId: string) => {
    const selfBoat = boats.find((boat) => boat.isSelf)
    if (!selfBoat || locked) return
    recordMarkPosition(markId, selfBoat.position, {
      source: 'device-geolocation',
      committeeBoatId: selfBoat.id,
      accuracyMetres: selfBoat.accuracyMetres,
      note: `${selfBoat.assignment}が回収`,
    }, 'recovered')
  }

  const recordLeadingPassage = (markId: string) => {
    if (locked && !eventAccess?.isOwner) return
    const passedAt = new Date().toISOString()
    const selfBoat = boats.find((boat) => boat.isSelf)
    void sendRealtimeOperation('leading-passage', {
      action: 'observe',
      markId,
      passedAt,
      lapNumber: 1,
      committeeBoatId: selfBoat?.id,
      deviceId: memberId,
      clockOffsetMs: Math.round(realtime.serverOffsetMs),
      syncQuality: realtime.status === 'live' ? 'good' : 'offline',
      wasOffline: realtime.status !== 'live',
    }, activeRace.id).then((observationId) => {
      const observation: LeadingPassageObservation = {
        id: observationId,
        passedAt,
        recordedBy: eventAccess?.displayName ?? 'この端末',
        syncQuality: realtime.status === 'live' ? 'good' : 'offline',
        wasOffline: realtime.status !== 'live',
        status: 'active',
      }
      const key = passageVisitKey(activeRace.id, markId, 1)
      setLeadingPassages((current) => ({
        ...current,
        [key]: mergePassageObservation(current[key], activeRace.id, markId, 1, observation),
      }))
    })
  }

  const adoptLeadingPassage = (markId: string, observationId: string) => {
    if (!canAdoptLeadingPassage || locked && !eventAccess?.isOwner) return
    const adoptedAt = new Date().toISOString()
    const key = passageVisitKey(activeRace.id, markId, 1)
    setLeadingPassages((current) => current[key] ? ({
      ...current,
      [key]: adoptPassageObservation(current[key], observationId, adoptedAt),
    }) : current)
    void sendRealtimeOperation('leading-passage', {
      action: 'adopt',
      observationId,
      reason: locked ? '大会管理者による確定後の追記訂正' : '記録担当者による採用',
    }, activeRace.id)
  }

  const recordFirstFinish = (sailNumber?: string, note?: string) => {
    if (!canRecordFinish) return
    const finishedAt = new Date(Date.now() + realtime.serverOffsetMs).toISOString()
    const selfBoat = boats.find((boat) => boat.isSelf)
    void sendRealtimeOperation('finish', {
      action: 'observe',
      finishPosition: 1,
      finishedAt,
      committeeBoatId: selfBoat?.id,
      deviceId: memberId,
      clockOffsetMs: Math.round(realtime.serverOffsetMs),
      syncQuality: realtime.status === 'live' ? 'good' : 'offline',
      wasOffline: realtime.status !== 'live',
      sailNumber,
      note,
    }, activeRace.id).then((observationId) => {
      const observation: FinishObservation = {
        id: observationId,
        finishPosition: 1,
        finishedAt,
        recordedBy: eventAccess?.displayName ?? 'この端末',
        syncQuality: realtime.status === 'live' ? 'good' : 'offline',
        wasOffline: realtime.status !== 'live',
        sailNumber,
        note,
        status: 'active',
      }
      const key = finishRecordKey(activeRace.id, 1)
      setFinishes((current) => ({
        ...current,
        [key]: mergeFinishObservation(current[key], activeRace.id, 1, observation),
      }))
    })
  }

  const adoptFirstFinish = (observationId: string) => {
    if (!canAdoptFinish) return
    const adoptedAt = new Date(Date.now() + realtime.serverOffsetMs).toISOString()
    const key = finishRecordKey(activeRace.id, 1)
    setFinishes((current) => current[key] ? ({
      ...current,
      [key]: adoptFinishObservation(current[key], observationId, adoptedAt),
    }) : current)
    void sendRealtimeOperation('finish', {
      action: 'adopt',
      observationId,
      reason: locked ? '大会管理者による確定後の追記訂正' : '記録担当者による採用',
    }, activeRace.id)
  }

  const openFinalizeConfirmation = () => {
    setFinalizeConfirmation('')
    setFinalizeError(undefined)
    setConfirmFinalize(true)
  }

  const reauthenticateCriticalOperation = async (scope: 'finalize' | 'revision' = 'finalize') => {
    const currentUserId = session.mode === 'authenticated' ? session.user.id : undefined
    const setOperationError = scope === 'revision' ? setRevisionError : setFinalizeError
    setFinalizeReauthWorking(true)
    setOperationError(undefined)
    try {
      const refreshed = await authenticatePasskey()
      if (currentUserId && refreshed.user.id !== currentUserId) {
        setSession(refreshed)
        setEventAccess(undefined)
        setFinalizeNeedsReauth(true)
        setOperationError('別の利用者として本人確認されました。この大会への権限を再読込しています')
        return
      }
      setSession(refreshed)
      setFinalizeNeedsReauth(false)
    } catch (error) {
      setOperationError(authErrorMessage(error))
    } finally {
      setFinalizeReauthWorking(false)
    }
  }

  const finalizeRace = async () => {
    if (
      finalizeConfirmation !== finalizePhrase ||
      !recentAuthentication ||
      realtime.status !== 'live' ||
      realtime.connectedKey !== sessionConnectionKey ||
      realtime.pendingCount > 0
    ) return
    setFinalizeWorking(true)
    setFinalizeError(undefined)
    try {
      await realtime.sendConfirmed('finalize', {
        reason: '確定権限者によるレース確定',
        confirmationPhrase: finalizeConfirmation,
      }, activeRace.id)
      setConfirmFinalize(false)
      setFinalizeConfirmation('')
    } catch (error) {
      if (error instanceof RealtimeOperationError && error.code === 'RECENT_AUTHENTICATION_REQUIRED') {
        setFinalizeNeedsReauth(true)
      }
      setFinalizeError(error instanceof RealtimeOperationError ? error.message : 'レースを確定できませんでした')
    } finally {
      setFinalizeWorking(false)
    }
  }

  const recordSignal = useCallback((signal: Omit<RaceSignalEvent, 'id'> & { officialAudioDeviceSecret?: string }) => {
    void sendRealtimeOperation('signal', signal, activeRace.id).then((id) => {
      const recorded = makeRaceSignalEvent(id, signal.action, signal.executedAt, signal)
      const startsSequence = ['warning', 'preparatory', 'one-minute', 'resume', 'general-recall-clear', 'abandon-clear'].includes(recorded.action)
      const startsRace = ['start', 'individual-recall', 'individual-recall-clear', 'shorten', 'course-change', 'mark-missing'].includes(recorded.action)
      const returnsToSetup = ['postpone', 'postpone-h', 'postpone-a', 'general-recall', 'abandon', 'abandon-h', 'abandon-a'].includes(recorded.action)
      setRaces((current) => current.map((race) => race.id === activeRace.id ? {
        ...race,
        warningAt: recorded.warningAt ?? race.warningAt,
        latestSignal: recorded,
        status: startsSequence ? 'start-sequence' : startsRace ? 'racing' : returnsToSetup ? 'setup' : race.status,
      } : race))
    })
  }, [activeRace.id, sendRealtimeOperation])

  const recordSignalAudio = useCallback((execution: { raceId: string; signalId: string; soundExecutedAt: string; deviceId: string; deviceSecret: string }) => {
    const { raceId, ...payload } = execution
    void sendRealtimeOperation('signal-audio', payload, raceId)
  }, [sendRealtimeOperation])

  const shareRaceSchedule = async () => {
    if (!canScheduleRace || realtime.status !== 'live') return
    setScheduleWorking(true)
    setScheduleError(undefined)
    try {
      const warningAt = new Date(scheduleWarningInput)
      if (Number.isNaN(warningAt.getTime())) throw new Error('予告時刻を入力してください')
      if (!scheduleReason.trim()) throw new Error('変更理由を入力してください')
      await realtime.sendConfirmed('schedule', {
        warningAt: warningAt.toISOString(),
        reason: scheduleReason.trim(),
        source: 'manual',
      }, activeRace.id)
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : '予告予定を変更できませんでした')
    } finally {
      setScheduleWorking(false)
    }
  }

  const recordMarkWind = async (input: MarkWindInput): Promise<MarkWindSaveResult> => {
    if (!canShareEnvironment) throw new Error('現在の担当では風向・風速を記録できません')
    if (!input.markId && !allowOverallWind) throw new Error('担当マークが設定されていません')
    const selfBoat = boats.find((boat) => boat.isSelf)
    const observedAt = new Date().toISOString()
    const target = input.markId ? marks.find((mark) => mark.id === input.markId) : undefined
    if (input.markId && !target) throw new Error('対象マークが現在のコースにありません')
    const targetLabel = target
      ? `${target.label}${target.id === ownWindMarkId ? '（自分）' : ''}`
      : '本部船・全体風'
    const nextWind: WindObservation = {
      directionDegrees: input.directionDegrees,
      speedKnots: input.speedKnots,
      gustKnots: input.gustKnots,
      observedAt,
      source: eventAccess?.displayName ?? windDetails.source,
      trend: 'steady',
      confidence: input.confidence,
      position: selfBoat?.position,
      raceId: activeRace.id,
      committeeBoatId: selfBoat?.id,
      markId: input.markId,
    }
    const payload = {
      directionDegrees: input.directionDegrees,
      speedKnots: input.speedKnots,
      gustKnots: input.gustKnots,
      averagingSeconds: input.averagingSeconds,
      observedAt,
      confidence: input.confidence,
      position: selfBoat?.position,
      committeeBoatId: selfBoat?.id,
      markId: input.markId,
    }
    let state: MarkWindSaveResult['state'] = 'queued'
    if (realtime.status === 'live' && realtime.connectedKey === sessionConnectionKey) {
      try {
        await realtime.sendConfirmed('wind', payload, activeRace.id)
        state = 'shared'
      } catch (reason) {
        if (!(reason instanceof RealtimeOperationError) || !['LIVE_CONNECTION_REQUIRED', 'CONNECTION_CLOSED'].includes(reason.code)) throw reason
        await sendRealtimeOperation('wind', payload, activeRace.id)
      }
    } else {
      await sendRealtimeOperation('wind', payload, activeRace.id)
    }
    setCourseWindDirection(input.directionDegrees)
    setCourseWindSpeed(input.speedKnots)
    setWindDetails(nextWind)
    if (nextWind.markId || nextWind.committeeBoatId) {
      setMarkWinds((current) => [
        nextWind,
        ...current.filter((observation) => {
          if (observation.raceId !== nextWind.raceId) return true
          if (nextWind.markId) return observation.markId !== nextWind.markId
          return Boolean(observation.markId) || observation.committeeBoatId !== nextWind.committeeBoatId
        }),
      ])
    }
    return { state, observedAt, targetLabel }
  }

  const shareCurrent = () => {
    if (!canShareEnvironment) return
    const selfBoat = boats.find((boat) => boat.isSelf)
    const observedAt = new Date().toISOString()
    setSeaCurrent((current) => ({
      ...current,
      observedAt,
      source: eventAccess?.displayName ?? current.source,
      position: selfBoat?.position ?? current.position,
    }))
    void sendRealtimeOperation('current', {
      directionDegrees: seaCurrent.directionDegrees,
      speedKnots: seaCurrent.speedKnots,
      observedAt,
      confidence: seaCurrent.confidence,
      position: selfBoat?.position,
      committeeBoatId: selfBoat?.id,
    }, activeRace.id)
  }

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault()
    const body = messageDraft.trim()
    if (!body) return
    const id = await sendRealtimeOperation('message', {
      body,
      priority: messagePriority,
      ...messageTargetPayload(messageTarget, activeRace.id),
    }, activeRace.id)
    const targetPayload = messageTargetPayload(messageTarget, activeRace.id)
    const selectedTargetLabel = messageTargetLabel(messageTarget, activeRace.number, eventResources)
    setMessages((current) => current.some((message) => message.id === id) ? current : [...current, {
      id,
      raceId: activeRace.id,
      sender: eventAccess?.displayName ?? (session.mode === 'authenticated' ? session.user.displayName : '自分'),
      channel: targetPayload.targetType === 'race' ? `race:${activeRace.id}` : `${targetPayload.targetType}:${targetPayload.targetId ?? ''}`,
      text: body,
      sentAt: new Date().toISOString(),
      priority: messagePriority,
      target: { type: targetPayload.targetType, id: targetPayload.targetId, label: selectedTargetLabel },
      receipts: { targetCount: 0, deliveredCount: 0, readCount: 0, acknowledgedCount: 0 },
    }])
    setMessageDraft('')
    setMessagePriority('normal')
  }

  const openCourseSettings = () => {
    const supported = ['O2', 'I2', 'L2', 'L3', 'W2', 'T2', 'トライアングル'].includes(activeRace.courseCode)
      ? activeRace.courseCode as CourseTemplate
      : 'O2'
    setCourseTemplate(normalizeCoursePresetCode(selectedClass, supported))
    setLowerGate(activeRace.marks.some((mark) => mark.label.startsWith('下ゲート') || mark.label.startsWith('内側ゲート')) || activeRace.courseCode.includes('ゲート'))
    setFinishLineMode(activeRace.finishLineMode ?? 'separate')
    setFinishDistanceSelection(inferFinishDistanceMode(activeRace.finishDistanceMetres))
    setCustomFinishDistanceNm(
      activeRace.finishDistanceMetres
        ? metresToNauticalMiles(activeRace.finishDistanceMetres).toFixed(2)
        : '0.15',
    )
    setUpperGate(activeRace.marks.some((mark) => mark.label.startsWith('上ゲート')))
    setSecondGate(activeRace.marks.some((mark) => mark.label.startsWith('中ゲート')))
    setGateWidthMetres(130)
    setCourseSaveError(undefined)
    setCourseHistory([])
    setSettingsOpen(true)
    if (canViewCourseHistory) {
      setCourseHistoryLoading(true)
      void loadCourseRevisions(eventId, activeRace.id)
        .then((revisions) => {
          setCourseHistory(revisions)
          const savedWidth = revisions[0]?.gateConfig.gates?.[0]?.widthMetres
          if (savedWidth && Number.isFinite(savedWidth)) setGateWidthMetres(Math.round(savedWidth))
          setFinishLineMode(revisions[0]?.gateConfig.finishLineMode === 'shared-rc' ? 'shared-rc' : 'separate')
          const savedFinishDistance = revisions[0]?.gateConfig.finishDistanceMetres
          setFinishDistanceSelection(inferFinishDistanceMode(savedFinishDistance))
          setCustomFinishDistanceNm(savedFinishDistance ? metresToNauticalMiles(savedFinishDistance).toFixed(2) : '0.15')
        })
        .catch((reason) => setCourseSaveError(reason instanceof Error ? reason.message : 'コース版履歴を取得できません'))
        .finally(() => setCourseHistoryLoading(false))
    }
  }

  const restoreCourseRevision = async (source: CourseRevisionSummary) => {
    if (!canRollbackCourse) return
    setCourseRollbackWorking(source.revision)
    setCourseSaveError(undefined)
    try {
      const restored = await rollbackCourseRevision(eventId, activeRace.id, source.revision)
      setRaces((current) => current.map((race) => race.id === activeRace.id ? {
        ...race,
        courseCode: restored.courseCode,
        finishLineMode: source.gateConfig.finishLineMode === 'shared-rc' ? 'shared-rc' : 'separate',
        finishDistanceMetres: source.gateConfig.finishDistanceMetres,
      } : race))
      void sendRealtimeOperation('course', {
        action: 'refresh',
        revisionId: restored.revisionId,
        revision: restored.revision,
        sourceRevision: restored.sourceRevision,
      }, activeRace.id)
      setEventRefreshKey((current) => current + 1)
      setCourseHistory(await loadCourseRevisions(eventId, activeRace.id))
    } catch (reason) {
      if (reason instanceof EventApiError && reason.code === 'RECENT_AUTHENTICATION_REQUIRED') setAuthOpen(true)
      setCourseSaveError(reason instanceof Error ? reason.message : 'コース版を復元できません')
    } finally {
      setCourseRollbackWorking(undefined)
    }
  }

  const saveCourse = async () => {
    if (locked) return
    if (finishDistanceSupported && !finishDistanceInputValid) {
      setCourseSaveError('フィニッシュ距離は0.05〜0.50 NMで入力してください')
      return
    }
    setCourseSaving(true)
    setCourseSaveError(undefined)
    const startLine = startPinPosition && startSignalPosition
      ? { pin: startPinPosition, signal: startSignalPosition }
      : undefined
    const center: LngLat = startLine
      ? midpoint(startLine.pin, startLine.signal)
      : marks[0]?.target ?? [131.5221959, 33.2786648]
    const plan = generateCoursePlan({
      center,
      startLine,
      windDirection: courseWindDirection,
      windSpeed: courseWindSpeed,
      totalLengthMetres: recommendation.kilometres * 1_000,
      courseCode: courseTemplate,
      className: selectedClass,
      lowerGate,
      upperGate,
      secondGate,
      gateWidthMetres,
      finishLineMode,
      finishDistanceMetres: configuredFinishDistanceMetres,
    })
    const allPhysicalMarks = new Map<string, { id: string; label: string }>()
    marks.forEach((mark) => allPhysicalMarks.set(mark.label, mark))
    eventResources.marks
      .filter((mark) => !activeRace.raceAreaId || !mark.raceAreaId || mark.raceAreaId === activeRace.raceAreaId)
      .forEach((mark) => allPhysicalMarks.set(mark.label, mark))
    const plannedMarks = plan.flatMap((node) => {
      const physical = allPhysicalMarks.get(node.label) ?? (!eventAccess ? { id: node.key, label: node.label } : undefined)
      if (!physical) return []
      const existing = marks.find((mark) => mark.id === physical.id)
      return [{
        id: physical.id,
        label: node.label,
        shortLabel: shortCourseMarkLabel(node.label),
        target: node.target,
        actual: existing?.actual,
        status: existing?.status ?? 'planned' as const,
        assignedBoatId: existing?.assignedBoatId,
        isGate: node.nodeType === 'gate',
        gateSide: node.label.endsWith('S') ? 'S' as const : node.label.endsWith('P') ? 'P' as const : undefined,
      }]
    })
    if (plannedMarks.length < 3) {
      setCourseSaveError('この大会には選択したコース用の物理マークが不足しています')
      setCourseSaving(false)
      return
    }
    try {
      if (eventAccess) {
        const saved = await saveCourseRevision(eventId, activeRace.id, {
          courseCode: courseTemplate,
          windDirection: courseWindDirection,
          windSpeed: courseWindSpeed,
          targetLengthMetres: recommendation.kilometres * 1_000,
          lowerGate,
          upperGate,
          secondGate,
          finishLineMode,
          finishDistanceMetres: configuredFinishDistanceMetres,
          nodes: plannedMarks.map((mark) => ({
            markId: mark.id,
            label: mark.label,
            nodeType: mark.label === 'スタート・ピン' || mark.label === 'シグナルボート'
              ? 'start'
              : mark.label === 'フィニッシュマーク' || mark.label === 'フィニッシュ艇' ? 'finish'
              : mark.label.includes('オフセット') ? 'offset' : mark.isGate ? 'gate' : 'single',
            rounding: mark.isGate ? 'gate' : 'port',
            target: mark.target,
          })),
        })
        void sendRealtimeOperation('course', {
          action: 'refresh',
          revisionId: saved.revisionId,
          revision: saved.revision,
        }, activeRace.id)
      }
      setRaces((current) => current.map((race) => race.id === activeRace.id ? {
        ...race,
        courseCode: courseTemplate,
        finishLineMode,
        finishDistanceMetres: configuredFinishDistanceMetres,
        marks: plannedMarks,
      } : race))
      setSettingsOpen(false)
    } catch (reason) {
      setCourseSaveError(reason instanceof Error ? reason.message : 'コース案を保存できません')
    } finally {
      setCourseSaving(false)
    }
  }

  const openAdminRevision = () => {
    if (revisionDraft) {
      setPendingMarkCorrection(undefined)
      setRevisionReason(revisionDraft.reason)
      setRevisionCourseCode(revisionDraft.corrections.courseCode ?? activeRace.courseCode)
      setRevisionTargetMinutes(revisionDraft.corrections.targetMinutes ?? activeRace.targetMinutes)
      setRevisionNote(revisionDraft.corrections.markPosition?.note ?? revisionDraft.corrections.note ?? '')
      setRevisionConfirmation('')
      setRevisionError(undefined)
      setRevisionOpen(true)
      return
    }
    setPendingMarkCorrection(undefined)
    setRevisionCourseCode(activeRace.courseCode)
    setRevisionTargetMinutes(activeRace.targetMinutes)
    setRevisionReason('確定後に判明した運営記録の訂正')
    setRevisionNote('')
    setRevisionConfirmation('')
    setRevisionError(undefined)
    setRevisionOpen(true)
  }

  const closeAdminRevision = () => {
    setRevisionOpen(false)
    setRevisionConfirmation('')
    if (!revisionDraft) setPendingMarkCorrection(undefined)
  }

  const submitAdminRevision = async (event: React.FormEvent) => {
    event.preventDefault()
    setRevisionWorking(true)
    setRevisionError(undefined)
    try {
      if (!revisionDraft) {
        const created = await createPostFinalizationRevisionDraft(
          eventId,
          activeRace.id,
          revisionReason,
          pendingMarkCorrection ? {
            markPosition: {
              markId: pendingMarkCorrection.markId,
              actual: pendingMarkCorrection.actual,
              recordedAt: pendingMarkCorrection.recordedAt,
              committeeBoatId: pendingMarkCorrection.committeeBoatId,
              accuracyMetres: pendingMarkCorrection.accuracyMetres,
              positionSource: pendingMarkCorrection.source,
              coordinateEntryMode: pendingMarkCorrection.entryMode,
              coordinateDatum: 'WGS84',
              note: revisionNote.trim() || pendingMarkCorrection.note,
            },
          } : {
            courseCode: revisionCourseCode,
            targetMinutes: revisionTargetMinutes,
            note: revisionNote,
          },
        )
        setRevisionDrafts((current) => ({ ...current, [activeRace.id]: created.draft }))
        setPendingMarkCorrection(undefined)
        setRevisionReason(created.draft.reason)
        setRevisionNote(created.draft.corrections.markPosition?.note ?? created.draft.corrections.note ?? '')
        setRevisionConfirmation('')
        return
      }
      const saved = await publishPostFinalizationRevisionDraft(
        eventId,
        activeRace.id,
        revisionDraft.id,
        revisionConfirmation,
      )
      setRaces((current) => current.map((race) => {
        if (race.id !== activeRace.id) return race
        if (saved.corrections.markPosition) {
          return {
            ...race,
            finalizedRevision: saved.revision,
            finalizedAt: saved.createdAt,
            marks: race.marks.map((mark) => mark.id === saved.corrections.markPosition?.markId ? {
              ...mark,
              actual: saved.corrections.markPosition?.actual,
              status: 'confirmed' as const,
            } : mark),
          }
        }
        return {
          ...race,
          courseCode: saved.corrections.courseCode ?? race.courseCode,
          targetMinutes: saved.corrections.targetMinutes ?? race.targetMinutes,
          warningAt: saved.corrections.warningAt ?? race.warningAt,
          finalizedRevision: saved.revision,
          finalizedAt: saved.createdAt,
        }
      }))
      setEventRefreshKey((current) => current + 1)
      void sendRealtimeOperation('course', { action: 'refresh', finalizedRevision: saved.revision }, activeRace.id)
      setRevisionDrafts((current) => {
        const next = { ...current }
        delete next[activeRace.id]
        return next
      })
      setPendingMarkCorrection(undefined)
      setRevisionConfirmation('')
      setRevisionOpen(false)
    } catch (reason) {
      if (reason instanceof EventApiError && reason.code === 'RECENT_AUTHENTICATION_REQUIRED') {
        setFinalizeNeedsReauth(true)
      }
      setRevisionError(reason instanceof Error ? reason.message : '管理者修正版を処理できません')
    } finally {
      setRevisionWorking(false)
    }
  }

  const discardAdminRevision = async () => {
    if (!revisionDraft) {
      closeAdminRevision()
      return
    }
    setRevisionWorking(true)
    setRevisionError(undefined)
    try {
      await discardPostFinalizationRevisionDraft(eventId, activeRace.id, revisionDraft.id)
      setRevisionDrafts((current) => {
        const next = { ...current }
        delete next[activeRace.id]
        return next
      })
      setPendingMarkCorrection(undefined)
      setRevisionConfirmation('')
      setRevisionOpen(false)
    } catch (reason) {
      if (reason instanceof EventApiError && reason.code === 'RECENT_AUTHENTICATION_REQUIRED') {
        setFinalizeNeedsReauth(true)
      }
      setRevisionError(reason instanceof Error ? reason.message : '管理者修正版を破棄できません')
    } finally {
      setRevisionWorking(false)
    }
  }

  const eventAccessPanels = (
    <Suspense fallback={null}>
      {authOpen && (
        <AuthPanel
          session={session}
          onSessionChange={(nextSession) => {
            setSession(nextSession)
            if (nextSession.mode === 'authenticated' && resumeEventIssuanceAfterAuth) {
              setResumeEventIssuanceAfterAuth(false)
              setAuthOpen(false)
              setEventManagerOpen(true)
            }
          }}
          onClose={() => { setAuthOpen(false); setResumeEventIssuanceAfterAuth(false) }}
        />
      )}

      {eventManagerOpen && (
        <EventManager
          session={session}
          currentEventSlug={eventId}
          currentEventId={eventDatabaseId}
          currentEventName={eventRoute ? eventName : '未発行'}
          hasCurrentEvent={eventRoute}
          isCurrentEventOwner={eventRoute && (eventAccess?.isOwner ?? false)}
          resources={eventResources}
          races={races}
          assignmentRealtimeAvailable={realtime.status === 'live'}
          initialCreationPlan={preEventPlan}
          onUpdateAssignment={async (input) => { await realtime.sendConfirmed('assignment', input) }}
          onEventStructureChanged={(change) => {
            setEventRefreshKey((current) => current + 1)
            if (change) {
              void sendRealtimeOperation('course', {
                action: 'refresh', revisionId: change.revisionId, revision: change.revision,
              }, change.raceId)
            }
          }}
          onRequestAuthentication={() => {
            setEventManagerOpen(false)
            setResumeEventIssuanceAfterAuth(true)
            setAuthOpen(true)
          }}
          onRecoverParticipation={() => { setEventManagerOpen(false); setRecoveryOpen(true) }}
          onClose={() => setEventManagerOpen(false)}
        />
      )}
    </Suspense>
  )

  if (!eventRoute) {
    return (
      <div className="pre-event-root">
        <PreEventCoursePlanner
          onIssueEvent={(plan) => {
            setPreEventPlan(plan)
            if (session.mode === 'authenticated') setEventManagerOpen(true)
            else {
              setResumeEventIssuanceAfterAuth(true)
              setAuthOpen(true)
            }
          }}
          onOpenEvents={() => {
            setPreEventPlan(undefined)
            setEventManagerOpen(true)
          }}
        />
        {eventAccessPanels}
      </div>
    )
  }

  return (
    <div className={`app-shell ${canFinalizeRace || (locked && eventAccess?.isOwner) ? 'has-mobile-owner-actions' : ''}`}>
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark"><Anchor size={22} /></div>
          <div>
            <strong>Sailing Race Supporter</strong>
            <small>Created by Dit-Lab.（Daiki ITO）</small>
          </div>
        </div>

        <button type="button" className="event-selector" onClick={() => setEventManagerOpen(true)}>
          <span><small>大会を発行・選択</small><strong>{eventName}</strong></span>
          <ChevronDown size={16} />
        </button>

        <RaceTabs
          races={races}
          activeRaceId={activeRace.id}
          serverOffsetMs={realtime.serverOffsetMs}
          messages={messages}
          revisionDraftRaceIds={Object.keys(revisionDrafts)}
          onSelectRace={(raceId) => {
            setActiveRaceId(raceId)
            setSelectedMarkId(undefined)
          }}
        />

        <div className="header-actions">
          <span className={`connection-pill status-${realtime.status}`}>
            {realtime.status === 'live' ? <RadioTower size={14} /> : <CloudOff size={14} />}
            {realtime.status === 'live' ? '同期中' : realtime.status === 'connecting' ? '接続中' : `オフライン${realtime.pendingCount ? `・未同期${realtime.pendingCount}` : ''}`}
          </span>
          <button type="button" className="header-icon" onClick={() => setMessagesOpen(true)} aria-label="メッセージ">
            <MessageSquareText size={19} /><i>{messages.filter((message) => message.acknowledgement === 'pending').length}</i>
          </button>
          {session.mode === 'authenticated' && (
            <button type="button" className="header-icon" onClick={() => setLogsOpen(true)} aria-label="運営ログ" title="運営ログ">
              <ScrollText size={19} />
            </button>
          )}
          <button type="button" className="owner-button" onClick={() => { setResumeEventIssuanceAfterAuth(false); setAuthOpen(true) }}>
            <CircleUserRound size={21} />
            <span>
              <strong>{session.mode === 'authenticated' ? session.user.displayName : '伊藤 大輝'}</strong>
              <small>{session.mode === 'authenticated' ? '認証済み管理者' : session.mode === 'offline-demo' ? 'オフラインデモ' : '本人確認が必要'}</small>
            </span>
          </button>
          <button type="button" className="mobile-menu" onClick={openCourseSettings} aria-label="メニュー"><Menu size={21} /></button>
        </div>
      </header>

      <StartSequence
        eventSlug={eventId}
        eventName={eventName}
        raceId={activeRace.id}
        raceNumber={activeRace.number}
        className={activeRace.className}
        warningAt={activeRace.warningAt}
        latestSignal={activeRace.latestSignal}
        marks={marks}
        serverOffsetMs={realtime.serverOffsetMs}
        canControlSignals={canControlSignals}
        canChangeCourse={canChangeCourse}
        raceStatus={activeRace.status}
        preparatoryFlag={preparatoryFlag}
        officialAudio={officialAudio.state}
        officialAudioDeviceId={officialAudio.deviceId}
        officialAudioDeviceSecret={officialAudio.deviceSecret}
        canForceAudioTakeover={eventAccess?.isOwner ?? false}
        onClaimOfficialAudio={officialAudio.claim}
        onReleaseOfficialAudio={officialAudio.release}
        onSignalExecuted={recordSignal}
        onAudioExecuted={recordSignalAudio}
      />

      <OperationalCommandBar
        raceLabel={activeRace.number}
        courseLabel={`${activeCoursePreset.displayCode}・${activeRace.className}`}
        guidance={guidance}
        onActivate={activateGuidance}
      />

      {operationError && (
        <div className="operation-error-toast" role="alert">
          <AlertTriangle size={18} />
          <span><strong>サーバーが操作を拒否しました</strong><small>{operationError}・大会の最新状態を再取得しています</small></span>
          <button type="button" onClick={() => setEventRefreshKey((current) => current + 1)}>再同期</button>
          <button type="button" className="operation-error-toast__close" onClick={() => setOperationError(undefined)} aria-label="通知を閉じる"><X size={16} /></button>
        </div>
      )}

      <main
        className={`race-workspace ${mobileMapPriority ? 'mobile-map-priority' : ''}`}
        style={{ '--map-split': `${mapSplit}%` } as React.CSSProperties}
      >
        <div className={`map-column ${selectedMarkId ? 'has-selected-mark' : ''}`}>
          <Suspense fallback={<div className="map-loading"><RadioTower size={24} /><strong>海面地図を準備中…</strong></div>}>
            <MapView
              marks={marks}
              boats={boats}
              wind={windDetails}
              current={seaCurrent}
              selectedMarkId={selectedMarkId}
              onSelectMark={(markId) => {
                if (markId) focusMark(markId)
                else setSelectedMarkId(undefined)
              }}
              onUseCurrentLocation={updateSelfLocation}
              onRecordDrop={recordMarkDrop}
              onRecordManualPosition={recordManualMarkPosition}
              onRecordConfirmation={recordMarkConfirmation}
              onRecordRecovery={recordMarkRecovery}
              onRecordLeadingPassage={recordLeadingPassage}
              onAdoptLeadingPassage={adoptLeadingPassage}
              leadingPassages={leadingPassages}
              raceId={activeRace.id}
              raceAreaName={activeRace.raceAreaName}
              raceAreaCenter={raceAreaCenter}
              courseCode={activeCoursePreset.displayCode}
              courseName={activeCoursePreset.shortName}
              courseRoute={activeCoursePreset.route}
              canChangeCourse={canChangeCourse}
              onOpenCourseSettings={openCourseSettings}
              canRecordWind={canShareEnvironment}
              windTargetLabel={windTargetLabel}
              onOpenWindEntry={openWindEntry}
              markWinds={markWinds.filter((observation) => !observation.raceId || observation.raceId === activeRace.id)}
              locked={locked}
              canVerifyMarks={canVerifyMarks}
              manageableMarkIds={manageableMarkIds}
              canEditFinalizedPosition={Boolean(eventAccess?.isOwner)}
              canPlaceMarksFreely={Boolean(eventAccess?.isOwner) || session.mode === 'offline-demo'}
              passageLocked={locked && !eventAccess?.isOwner}
              canAdoptLeadingPassage={canAdoptLeadingPassage}
            />
          </Suspense>
          <div className={`course-advisor glass-panel ${courseAdvisorExpanded ? 'is-expanded' : ''}`}>
            <button
              type="button"
              className="course-advisor__mobile-toggle"
              aria-expanded={courseAdvisorExpanded}
              onClick={() => setCourseAdvisorExpanded((current) => !current)}
            >
              <SlidersHorizontal size={17} />
              <span><small>推奨第1レグ</small><strong>{recommendation.firstLegKilometres.toFixed(2)} km <em>{selectedClass}・計算風 {formatWindSpeedDual(courseWindSpeed)}</em></strong></span>
              <ChevronDown size={17} />
            </button>
            <div className="course-advisor__title">
              <SlidersHorizontal size={16} />
              <span><small>目標時間と選択コースから算出</small><strong>推奨第1レグ</strong></span>
            </div>
            <label>
              <span>クラス</span>
              <select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value as SailingClass)}>
                {CLASS_PROFILES.map((profile) => <option key={profile.className}>{profile.className}</option>)}
              </select>
            </label>
            <label>
              <span>計算用風速 <strong>{formatWindSpeedDual(courseWindSpeed)}</strong></span>
              <input type="range" min="2" max="20" step="0.5" value={courseWindSpeed} onChange={(event) => setCourseWindSpeed(Number(event.target.value))} />
              <small>実測共有は地図の「風を記録」から</small>
            </label>
            <div className="course-advisor__result">
              <strong>{recommendation.firstLegKilometres.toFixed(2)} km</strong>
              <span>{recommendation.firstLegNauticalMiles.toFixed(2)} NM・総航程 {recommendation.kilometres.toFixed(1)} km・暫定/低信頼</span>
            </div>
            <button type="button" onClick={openCourseSettings}><Settings2 size={16} /> 詳細設定</button>
          </div>
        </div>

        <button
          type="button"
          className="split-handle"
          onPointerDown={(event) => {
            if (event.currentTarget.offsetWidth > event.currentTarget.offsetHeight) return
            event.currentTarget.setPointerCapture(event.pointerId)
            draggingSplit.current = true
          }}
          onClick={(event) => {
            if (event.currentTarget.offsetWidth <= event.currentTarget.offsetHeight) return
            setMobileMapPriority((current) => !current)
          }}
          aria-label={mobileMapPriority ? '運用ボードを広げる' : '地図を広げる'}
        ><span /><b>{mobileMapPriority ? '運用を広げる' : '地図を広げる'}</b></button>

        <OperationsBoard
          race={activeRace}
          races={races}
          marks={marks}
          boats={boats}
          tasks={activeTasks}
          allTasks={tasks}
          messages={messages}
          wind={windDetails}
          markWinds={markWinds.filter((observation) => !observation.raceId || observation.raceId === activeRace.id)}
          current={seaCurrent}
          freeTierBudget={freeTierBudget}
          runtimeBudget={realtime.budgetStatus}
          scale={boardScale}
          detail={boardDetail}
          postponed={postponed}
          locked={locked}
          socketStatus={realtime.status}
          pendingCount={realtime.pendingCount}
          memberCount={memberCount}
          operationMode={operationMode}
          latestSignal={activeRace.latestSignal}
          firstFinish={firstFinish}
          latestPassage={latestPassage}
          canRecordFinish={canRecordFinish}
          canAdoptFinish={canAdoptFinish}
          onScaleChange={setBoardScale}
          onDetailChange={setBoardDetail}
          onSelectMark={(markId) => {
            focusMark(markId)
          }}
          onSelectRace={(raceId) => {
            setActiveRaceId(raceId)
            setSelectedMarkId(undefined)
          }}
          onAcknowledgeMessage={acknowledgeMessage}
          onOpenMessages={() => setMessagesOpen(true)}
          onOpenTaskMessage={openTaskMessage}
          onTaskStatusChange={advanceTask}
          onRecordFinish={recordFirstFinish}
          onAdoptFinish={adoptFirstFinish}
        />
      </main>

      <MobileCommandDock
        activeView={mobileMapPriority ? 'map' : 'operations'}
        messageCount={messageAttentionCount}
        windEnabled={canShareEnvironment}
        onShowMap={() => setMobileMapPriority(true)}
        onShowOperations={() => setMobileMapPriority(false)}
        onOpenWind={openWindEntry}
        onOpenMessages={() => setMessagesOpen(true)}
        onOpenMenu={openCourseSettings}
      />

      <div className="floating-owner-actions">
        {canFinalizeRace && (
          <button type="button" className="finalize-button" onClick={openFinalizeConfirmation}>
            <ShieldCheck size={17} /> {activeRace.number}を確定
          </button>
        )}
        {locked && eventAccess?.isOwner && (
          <button type="button" className="revision-button" onClick={openAdminRevision}>
            <FilePenLine size={17} /> {revisionDraft ? '管理者修正中を再開' : '管理者修正版を作成'}
          </button>
        )}
      </div>

      {windEntryOpen && (
        <WindEntrySheet
          raceNumber={activeRace.number}
          marks={windObservationMarks}
          ownMarkId={ownWindMarkId}
          defaultMarkId={defaultWindMarkId}
          canChooseMark={canChooseWindMark}
          allowOverallWind={allowOverallWind}
          initialWind={initialWindForEntry}
          selfBoat={boats.find((boat) => boat.isSelf)}
          realtimeLive={realtime.status === 'live' && realtime.connectedKey === sessionConnectionKey}
          onClose={() => setWindEntryOpen(false)}
          onSubmit={recordMarkWind}
        />
      )}

      {messagesOpen && (
        <div className="drawer-backdrop drawer-backdrop--map-visible" role="presentation" onMouseDown={() => setMessagesOpen(false)}>
          <aside className="message-drawer" aria-label="大会メッセージ" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><span className="eyebrow">{eventName}</span><strong>運営メッセージ</strong></div>
              <button type="button" onClick={() => setMessagesOpen(false)} aria-label="閉じる"><X size={20} /></button>
            </header>
            <label className="message-target-picker">
              <span>宛先</span>
              <select value={messageTarget} onChange={(event) => setMessageTarget(event.target.value)}>
                <option value="event">大会全体</option>
                <option value="race">{activeRace.number}・全運営</option>
                {eventResources.areas.length > 0 && <optgroup label="レースエリア">
                  {eventResources.areas.map((area) => <option key={area.id} value={`area:${area.id}`}>{area.name}・全運営</option>)}
                </optgroup>}
                {eventResources.boats.length > 0 && <optgroup label="運営ボート">
                  {eventResources.boats.map((boat) => <option key={boat.id} value={`boat:${boat.id}`}>{boat.assignment}</option>)}
                </optgroup>}
                {eventResources.marks.length > 0 && <optgroup label="マーク">
                  {eventResources.marks.map((mark) => <option key={mark.id} value={`mark:${mark.id}`}>{mark.label}</option>)}
                </optgroup>}
                {messageRoles.length > 0 && <optgroup label="役割">
                  {messageRoles.map((role) => <option key={role} value={`role:${role}`}>{operationRoleLabel(role)}担当</option>)}
                </optgroup>}
                {eventResources.members.length > 1 && <optgroup label="個人">
                  {eventResources.members.filter((member) => member.id !== memberId).map((member) => (
                    <option key={member.id} value={`member:${member.id}`}>{member.displayName}（{member.assignment}）</option>
                  ))}
                </optgroup>}
              </select>
            </label>
            <div className="drawer-messages">
              {messages.map((message) => (
                <article className={`drawer-message priority-${message.priority}`} key={message.id}>
                  <div><strong>{message.sender}</strong><time>{formatClock(message.sentAt)}</time></div>
                  <p>{message.text}</p>
                  <small>{message.target?.label ?? message.channel}</small>
                  {messageReceiptLabel(message) && <small className="message-receipt-status">{messageReceiptLabel(message)}</small>}
                  {((message.ownReceipt && message.ownReceipt !== 'acknowledged') || (!message.target && message.acknowledgement === 'pending')) && message.priority !== 'normal' && (
                    <button type="button" onClick={() => acknowledgeMessage(message.id)}>了解</button>
                  )}
                </article>
              ))}
            </div>
            <form className={`message-composer priority-${messagePriority}`} onSubmit={(event) => void sendMessage(event)}>
              <button
                type="button"
                aria-label={`優先度: ${messagePriority}`}
                title="通常 → 要確認 → 緊急"
                onClick={() => setMessagePriority((current) => current === 'normal' ? 'confirm' : current === 'confirm' ? 'urgent' : 'normal')}
              ><BellRing size={18} /></button>
              <input aria-label="メッセージ" placeholder="運営連絡を入力…" value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} maxLength={1_000} />
              <button type="submit" disabled={!messageDraft.trim()}>送信</button>
            </form>
          </aside>
        </div>
      )}

      {logsOpen && (
        <div className="drawer-backdrop drawer-backdrop--map-visible" role="presentation" onMouseDown={() => setLogsOpen(false)}>
          <Suspense fallback={<aside className="log-drawer"><div className="log-state">ログ画面を準備中…</div></aside>}>
            <div onMouseDown={(event) => event.stopPropagation()}>
              <LogDrawer eventSlug={eventId} eventName={eventName} races={races} activeRaceId={activeRace.id} onClose={() => setLogsOpen(false)} />
            </div>
          </Suspense>
        </div>
      )}

      {settingsOpen && (
        <div className="drawer-backdrop drawer-backdrop--map-visible" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <aside className="settings-sheet" aria-label="コース設定" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="eyebrow">{activeRace.number}</span><strong>コースを選ぶ・位置を作る</strong></div><button type="button" onClick={() => setSettingsOpen(false)} aria-label="コース設定を閉じる"><X size={20} /></button></header>
            <nav className="course-setup-steps" aria-label="コース設定の手順">
              <strong>この順番なら迷いません</strong>
              <ol>
                <li><b>1</b><span>コース</span></li>
                <li><b>2</b><span>スタート</span></li>
                <li><b>3</b><span>条件確認</span></li>
                <li><b>4</b><span>保存・共有</span></li>
              </ol>
            </nav>
            {!canChangeCourse && <div className="course-permission-note" role="status"><LockKeyhole size={16} /><span><strong>{locked ? 'このレースは確定済みです' : '現在は閲覧のみです'}</strong><small>{locked ? eventAccess?.isOwner ? '変更する場合は画面下の「管理者修正版を作成」から開始してください。' : '確定後の変更は大会管理者だけが管理者修正版として行えます。' : 'コース変更は未確定レースの管理者、PRO、RO、コースセッターが行えます。'}</small></span></div>}
            <label><span>競技ヨットクラス</span><select value={selectedClass} disabled={!canChangeCourse} onChange={(event) => changeSelectedClass(event.target.value as SailingClass)}>{CLASS_PROFILES.map((profile) => <option key={profile.className}>{profile.className}</option>)}</select></label>
            <CoursePresetPicker className={selectedClass} value={courseTemplate} label="① コースを選ぶ" disabled={!canChangeCourse} onChange={changeCourseTemplate} />
            <section className={`course-selection-state ${selectedCoursePreset.code !== activeCoursePreset.code || selectedClass !== activeRace.className ? 'has-change' : ''}`} aria-live="polite">
              <span><small>現在共有中</small><strong>{activeCoursePreset.displayCode}・{activeCoursePreset.name}</strong></span>
              <span><small>今回の選択</small><strong>{selectedCoursePreset.displayCode}・{selectedCoursePreset.name}</strong></span>
              <p>{selectedCoursePreset.code !== activeCoursePreset.code || selectedClass !== activeRace.className ? '未保存の変更があります。最後の「④ 保存・共有」で全員に反映します。' : '現在の共有コースと同じです。選んだだけではマーク位置は変わりません。'}</p>
            </section>
            <section className={`start-line-basis ${useRecordedStartLine ? 'is-recorded' : ''}`} aria-label="推奨マーク位置の基準">
              <header>
                <span><Anchor size={17} /><strong>② スタートラインを決める</strong></span>
                <b>{useRecordedStartLine ? '実位置 2/2' : `実位置 ${recordedStartEndpoints}/2`}</b>
              </header>
              <p>地図でPINとRCを選び、「マーク操作」から現在地またはハンディGPSの位置を記録します。</p>
              {startLineLength !== undefined && startLineBearing !== undefined && (
                <div className="start-line-basis__metrics">
                  <span><small>使用するライン</small><strong>{useRecordedStartLine ? '記録した実位置' : '現在の計画位置'}</strong></span>
                  <span><small>長さ</small><strong>{Math.round(startLineLength)} m</strong></span>
                  <span><small>PIN → RC</small><strong>{formatTrueBearing(startLineBearing)}</strong></span>
                </div>
              )}
              <div className="start-line-basis__actions">
                <button type="button" disabled={!startPinMark || !canChangeCourse} onClick={() => {
                  if (!startPinMark) return
                  setSettingsOpen(false)
                  setSelectedMarkId(startPinMark.id)
                  setMobileMapPriority(true)
                }}>PINを地図で決める</button>
                <button type="button" disabled={!startSignalMark || !canChangeCourse} onClick={() => {
                  if (!startSignalMark) return
                  setSettingsOpen(false)
                  setSelectedMarkId(startSignalMark.id)
                  setMobileMapPriority(true)
                }}>RCを地図で決める</button>
              </div>
            </section>
            <div className="settings-subsection course-condition-heading">
              <span className="eyebrow">③ 風・ゲート条件を確認</span>
              <small>風向とゲート有無を確認してから推奨位置を作ります</small>
            </div>
            <label><span>計画風向（真方位・°T）</span><input type="number" min="0" max="359" value={courseWindDirection} disabled={!canChangeCourse} onChange={(event) => setCourseWindDirection(Number(event.target.value))} /><small>推奨マーク位置の計算値です。実測風の共有は地図の「風を記録」を使います。</small></label>
            <div className="settings-subsection">
              <span className="eyebrow">潮流観測</span>
              <small>流向は海水が流れていく方向を真方位で入力</small>
            </div>
            <label><span>流向（真方位・行き先・°T）</span><input type="number" min="0" max="359" value={seaCurrent.directionDegrees} disabled={!canShareEnvironment} onChange={(event) => setSeaCurrent((current) => ({ ...current, directionDegrees: Number(event.target.value) }))} /></label>
            <label><span>流速（kt）</span><input type="number" min="0" max="20" step="0.1" value={seaCurrent.speedKnots} disabled={!canShareEnvironment} onChange={(event) => setSeaCurrent((current) => ({ ...current, speedKnots: Number(event.target.value) }))} /></label>
            <label><span>信頼度</span><select value={seaCurrent.confidence} disabled={!canShareEnvironment} onChange={(event) => setSeaCurrent((current) => ({ ...current, confidence: event.target.value as CurrentObservation['confidence'] }))}><option value="low">低・目測</option><option value="medium">中・複数回確認</option><option value="high">高・機器観測</option></select></label>
            <button type="button" className="sheet-secondary" onClick={shareCurrent} disabled={!canShareEnvironment}>
              <Waves size={17} /> 潮流を現在地と共有
            </button>
            <label className="switch-row"><span><strong>風下／内側ゲート</strong><small>{courseTemplate === 'I2' ? '4S / 4Pを使用' : courseTemplate === 'L2' || courseTemplate === 'L3' ? '2S / 2Pを使用' : '3S / 3Pを使用'}</small></span><input type="checkbox" checked={lowerGate} disabled={!canChangeCourse} onChange={(event) => setLowerGate(event.target.checked)} /></label>
            <label><span>フィニッシュライン</span><select value={finishLineMode} disabled={!canChangeCourse} onChange={(event) => setFinishLineMode(event.target.value as 'separate' | 'shared-rc')}><option value="separate">別に設置（FIN艇＋Fマーク）</option><option value="shared-rc">本船兼用（RC＋Fマーク・FIN艇不要）</option></select><small>{finishLineMode === 'separate' ? finishDistanceSupported ? `3マークから${metresToNauticalMiles(configuredFinishDistanceMetres!).toFixed(2)} NM（約${Math.round(configuredFinishDistanceMetres!)} m）先に、最終レグと直角の緑ラインを作ります。` : '最終マークの先に、最終レグと直角の緑ラインを作ります。' : 'RCから風下方向へ50 mの緑ラインを作ります。練習やワンオペ向けです。'}</small></label>
            {finishDistanceSupported && (
              <FinishDistanceControl
                mode={finishDistanceSelection}
                customNauticalMiles={customFinishDistanceNm}
                disabled={!canChangeCourse}
                onModeChange={setFinishDistanceSelection}
                onCustomNauticalMilesChange={setCustomFinishDistanceNm}
              />
            )}
            <label className="switch-row"><span><strong>上ゲート</strong><small>1S / 1Pを使用</small></span><input type="checkbox" checked={upperGate} disabled={!canChangeCourse} onChange={(event) => setUpperGate(event.target.checked)} /></label>
            {(courseTemplate === 'O2' || courseTemplate === 'I2' || courseTemplate === 'T2' || courseTemplate === 'トライアングル') && <label className="switch-row"><span><strong>中ゲート</strong><small>2マークを2S / 2Pへ切替</small></span><input type="checkbox" checked={secondGate} disabled={!canChangeCourse} onChange={(event) => setSecondGate(event.target.checked)} /></label>}
            {(lowerGate || upperGate || secondGate) && <label><span>計画ゲート幅（m・全ゲート共通）</span><input type="number" min="40" max="600" step="5" value={gateWidthMetres} disabled={!canChangeCourse} onChange={(event) => setGateWidthMetres(Math.min(600, Math.max(40, Number(event.target.value) || 40)))} /></label>}
            <div className="settings-subsection course-condition-heading">
              <span className="eyebrow">その他の運営設定（任意）</span>
              <small>コース位置の保存とは別に、予告予定と準備信号を共有できます</small>
            </div>
            <label><span>予告信号の予定時刻</span><input type="datetime-local" value={scheduleWarningInput} onChange={(event) => setScheduleWarningDrafts((current) => ({ ...current, [activeRace.id]: event.target.value }))} disabled={!canScheduleRace} /></label>
            <label><span>変更理由</span><textarea rows={2} maxLength={500} value={scheduleReason} onChange={(event) => setScheduleReason(event.target.value)} disabled={!canScheduleRace} /></label>
            {!['planning', 'setup'].includes(activeRace.status) && !locked && <small className="settings-guidance">開始手順中の変更は、先に本部船が延期・ゼネラルリコール・中止を記録してください。</small>}
            {scheduleError && <div className="auth-error" role="alert">{scheduleError}</div>}
            <button type="button" className="sheet-secondary" onClick={() => void shareRaceSchedule()} disabled={!canScheduleRace || realtime.status !== 'live' || scheduleWorking}>
              <BellRing size={17} /> {scheduleWorking ? '予告予定を共有中…' : '予告予定を全運営へ共有'}
            </button>
            <label><span>準備信号</span><select value={preparatoryFlag} disabled={!canControlSignals} onChange={(event) => setPreparatoryFlag(event.target.value)}><option>P旗</option><option>I旗</option><option>Z旗</option><option>Z旗 + I旗</option><option>U旗</option><option>黒旗</option></select></label>
            {canViewCourseHistory && <section className="course-history" aria-label="コース版履歴">
              <div className="settings-subsection">
                <span className="eyebrow">コース版履歴</span>
                <small>過去版は消さず、選んだ内容を新しい版として復元</small>
              </div>
              {courseHistoryLoading && <small className="course-history-state">履歴を読み込み中…</small>}
              {!courseHistoryLoading && courseHistory.length === 0 && <small className="course-history-state">保存済みの版はまだありません</small>}
              {courseHistory.map((revision, index) => (
                <article className="course-history-item" key={revision.id}>
                  <div>
                    <span>第{revision.revision}版{index === 0 && <em>現在</em>}</span>
                    <strong>{revision.courseCode}</strong>
                    <small>{revision.createdBy ?? '運営メンバー'}・{formatCourseRevisionTime(revision.createdAt)}・{revision.nodeCount}点</small>
                    {revision.gateConfig.finishDistanceMetres !== undefined && (
                      <small>3マーク→FIN: {metresToNauticalMiles(revision.gateConfig.finishDistanceMetres).toFixed(2)} NM（約{Math.round(revision.gateConfig.finishDistanceMetres)} m）</small>
                    )}
                    {revision.gateConfig.gates?.map((gate) => <small className="course-history-gate" key={gate.key}>
                      {gate.label}: {Math.round(gate.widthMetres)}m / {formatTrueBearing(gate.bearingDegreesTrue, { padInteger: 3 })}（S→P）・中央 {gate.center[1].toFixed(5)}, {gate.center[0].toFixed(5)}
                    </small>)}
                    {revision.basedOnRevision != null && <small>第{revision.basedOnRevision}版を基に作成</small>}
                  </div>
                  {index > 0 && <button
                    type="button"
                    onClick={() => void restoreCourseRevision(revision)}
                    disabled={!canRollbackCourse || courseRollbackWorking != null}
                    title={locked && !eventAccess?.isOwner ? '確定後は大会管理者だけが復元できます' : undefined}
                  >{courseRollbackWorking === revision.revision ? '復元中…' : '新しい版として復元'}</button>}
                </article>
              ))}
            </section>}
            {courseSaveError && <div className="auth-error" role="alert">{courseSaveError}</div>}
            <button type="button" className="sheet-secondary" onClick={() => { setSettingsOpen(false); setEventManagerOpen(true) }}><Anchor size={17} /> 大会を発行・選択・共有</button>
            {session.mode === 'authenticated' && <button type="button" className="sheet-secondary" onClick={() => { setSettingsOpen(false); setLogsOpen(true) }}><ScrollText size={17} /> 大会・レース別の運営ログ</button>}
            <button type="button" className="sheet-secondary" onClick={() => { setSettingsOpen(false); setResumeEventIssuanceAfterAuth(false); setAuthOpen(true) }}><ShieldCheck size={17} /> 本人確認・パスキー</button>
            <button type="button" className="sheet-primary" onClick={() => void saveCourse()} disabled={courseSaving || !canChangeCourse || (finishDistanceSupported && !finishDistanceInputValid)}>{courseSaving ? '推奨位置を計算・保存中…' : useRecordedStartLine ? '④ 推奨マーク位置を保存・全員へ共有' : '④ 計画ラインから保存・全員へ共有'}</button>
          </aside>
        </div>
      )}

      {confirmFinalize && (
        <div className="modal-backdrop" role="presentation">
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="finalize-title">
            <div className="confirm-icon"><LockKeyhole size={24} /></div>
            <span className="eyebrow">大会管理者・PRO・RO</span>
            <h2 id="finalize-title">{activeRace.number}を確定しますか？</h2>
            <p>確定後、通常メンバーは編集できません。管理者の修正は旧版を残した新しい版として記録されます。</p>
            <div className="finalize-summary" aria-label="確定対象の要約">
              <div><span>対象</span><strong>{activeRace.number}・1レース</strong></div>
              <div><span>投下済みマーク</span><strong>{marks.filter((mark) => Boolean(mark.actual)).length}/{marks.length}</strong></div>
              <div><span>未完了タスク</span><strong>{activeTasks.filter((task) => task.status !== 'done').length}件</strong></div>
              <div><span>先頭フィニッシュ</span><strong>{firstFinish?.adoptedObservationId ? '採用済み' : '未採用'}</strong></div>
            </div>
            {!recentAuthentication && session.mode === 'authenticated' && (
              <div className="finalize-reauth">
                <strong>確定前の本人確認が必要です</strong>
                <small>直近15分以内のパスキー認証をサーバーでも検証します。</small>
                <button type="button" onClick={() => void reauthenticateCriticalOperation()} disabled={finalizeReauthWorking || finalizeWorking}>
                  {finalizeReauthWorking ? '本人確認中…' : 'パスキーで本人確認'}
                </button>
              </div>
            )}
            <label className="finalize-confirmation-field">
              <span>誤操作防止のため「<strong>{finalizePhrase}</strong>」と入力</span>
              <input
                value={finalizeConfirmation}
                onChange={(event) => setFinalizeConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={finalizeWorking}
              />
            </label>
            {realtime.status !== 'live' && <div className="finalize-warning">リアルタイム接続後に確定できます。</div>}
            {recentAuthentication && realtime.status === 'live' && realtime.connectedKey !== sessionConnectionKey && (
              <div className="finalize-warning">本人確認後の接続を更新しています。</div>
            )}
            {realtime.pendingCount > 0 && <div className="finalize-warning">未同期操作 {realtime.pendingCount}件の同期完了を待ってください。</div>}
            {finalizeError && <div className="auth-error" role="alert">{finalizeError}</div>}
            <div className="finalize-actions">
              <button type="button" onClick={() => setConfirmFinalize(false)} disabled={finalizeWorking}>キャンセル</button>
              <button
                type="button"
                className="danger-confirm"
                onClick={() => void finalizeRace()}
                disabled={
                  finalizeWorking ||
                  finalizeReauthWorking ||
                  !recentAuthentication ||
                  realtime.status !== 'live' ||
                  realtime.connectedKey !== sessionConnectionKey ||
                  realtime.pendingCount > 0 ||
                  finalizeConfirmation !== finalizePhrase
                }
              >{finalizeWorking ? 'サーバーで確定中…' : '確定してロック'}</button>
            </div>
          </section>
        </div>
      )}

      {revisionOpen && (
        <div className="modal-backdrop revision-backdrop" role="presentation">
          <form className="revision-modal" role="dialog" aria-modal="true" aria-labelledby="revision-title" onSubmit={(event) => void submitAdminRevision(event)}>
            <button type="button" className="revision-close" onClick={closeAdminRevision}><X size={19} /></button>
            <div className="confirm-icon"><FilePenLine size={24} /></div>
            <span className="eyebrow">大会作成者のみ・旧確定版を保持</span>
            <h2 id="revision-title">{activeRace.number} {revisionMarkCorrection ? 'マーク位置を訂正' : '管理者修正版'}</h2>
            <p>元の確定版は変更しません。まず未公開の下書きを保存し、内容確認後に再確定すると全運営へ反映されます。</p>
            {revisionDraft && (
              <div className="revision-draft-status" role="status">
                <strong>管理者修正中・未公開</strong>
                <small>一般メンバーには最後の確定版を表示中・基準は確定版v{revisionDraft.baseRevision}</small>
              </div>
            )}
            {!recentAuthentication && session.mode === 'authenticated' && (
              <div className="finalize-reauth">
                <strong>管理者修正版の作成前に本人確認が必要です</strong>
                <small>直近15分以内のパスキー認証をサーバーでも検証します。</small>
                <button
                  type="button"
                  onClick={() => void reauthenticateCriticalOperation('revision')}
                  disabled={finalizeReauthWorking || revisionWorking}
                >{finalizeReauthWorking ? '本人確認中…' : 'パスキーで本人確認'}</button>
              </div>
            )}
            {revisionMarkCorrection ? (
              <div className="revision-mark-summary">
                <span><strong>{revisionMarkCorrection.label}</strong><small>訂正対象</small></span>
                <span><strong>{revisionMarkCorrection.actual[1].toFixed(6)}, {revisionMarkCorrection.actual[0].toFixed(6)}</strong><small>WGS 84・緯度, 経度</small></span>
                <span><strong>{revisionMarkCorrection.source === 'handheld-gps-manual' ? 'ハンディGPS' : 'スマホ現在地'}</strong><small>{revisionMarkCorrection.accuracyMetres == null ? '精度未入力' : `表示精度 ${revisionMarkCorrection.accuracyMetres}m`}</small></span>
              </div>
            ) : (
              <div className="revision-grid">
                <label><span>コース記号</span><input value={revisionCourseCode} onChange={(event) => setRevisionCourseCode(event.target.value)} maxLength={80} required disabled={Boolean(revisionDraft)} /></label>
                <label><span>目標時間（分）</span><input type="number" min="5" max="360" value={revisionTargetMinutes} onChange={(event) => setRevisionTargetMinutes(Number(event.target.value))} required disabled={Boolean(revisionDraft)} /></label>
              </div>
            )}
            <label><span>修正理由（必須）</span><textarea value={revisionReason} onChange={(event) => setRevisionReason(event.target.value)} minLength={5} maxLength={500} required disabled={Boolean(revisionDraft)} /></label>
            <label><span>修正メモ</span><textarea value={revisionNote} onChange={(event) => setRevisionNote(event.target.value)} maxLength={revisionMarkCorrection ? 120 : 2_000} placeholder="元記録との差異、確認者、根拠など" disabled={Boolean(revisionDraft)} /></label>
            {revisionDraft && <label><span>再確定の確認（「{finalizePhrase}」と入力）</span><input value={revisionConfirmation} onChange={(event) => setRevisionConfirmation(event.target.value)} autoComplete="off" required /></label>}
            {revisionError && <div className="auth-error" role="alert">{revisionError}</div>}
            <div className="revision-actions">
              <button type="button" onClick={closeAdminRevision} disabled={revisionWorking}>{revisionDraft ? '閉じる' : 'キャンセル'}</button>
              {revisionDraft && <button type="button" className="revision-discard" onClick={() => void discardAdminRevision()} disabled={revisionWorking}>下書きを破棄</button>}
              <button type="submit" disabled={revisionWorking || finalizeReauthWorking || !recentAuthentication || revisionReason.trim().length < 5 || Boolean(revisionDraft && revisionConfirmation !== finalizePhrase)}>{revisionWorking ? (revisionDraft ? '再確定中…' : '保存中…') : (revisionDraft ? '訂正して再確定' : '未公開の下書きを保存')}</button>
            </div>
          </form>
        </div>
      )}

      {eventAccessPanels}

      <Suspense fallback={null}>
        {joinContext && (
          <JoinRecoveryPanel
            eventSlug={eventId}
            mode={{ kind: 'join', ...joinContext }}
            onSessionChange={setSession}
            onComplete={() => setJoinContext(undefined)}
          />
        )}

        {recoveryOpen && (
          <JoinRecoveryPanel
            eventSlug={eventId}
            mode={{ kind: 'recover' }}
            onSessionChange={setSession}
            onComplete={() => setRecoveryOpen(false)}
            onClose={() => setRecoveryOpen(false)}
          />
        )}
      </Suspense>
    </div>
  )
}
