import {
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
import { generateCoursePlan, recommendedCourseLength, type CourseTemplate } from './course'
import {
  CLASS_PROFILES,
  DEMO_BOATS,
  DEMO_MESSAGES,
  DEMO_RACES,
  DEMO_TASKS,
  INITIAL_CURRENT,
  INITIAL_WIND,
  type BoardDetail,
  type CommitteeBoat,
  type CurrentObservation,
  type FinishObservation,
  type FinishRecord,
  type LeadingPassageObservation,
  type LeadingPassageVisit,
  type LngLat,
  type OperationalMessage,
  type OperationalTask,
  type RaceDefinition,
  type RaceSignalEvent,
  type SailingClass,
  type WindObservation,
} from './domain'
import { OperationsBoard } from './components/OperationsBoard'
import { StartSequence } from './components/StartSequence'
import { RaceTabs } from './components/RaceTabs'
import {
  authenticatePasskey,
  authErrorMessage,
  hasRecentPasskeyAuthentication,
  loadSession,
  type SessionState,
} from './authClient'
import { createPostFinalizationRevision, EventApiError, loadEventBootstrap, saveCourseRevision } from './eventClient'
import type { EventAccessSummary, EventResources } from './eventClient'
import { loadEventSnapshot, saveEventSnapshot } from './offlineStore'
import { RealtimeOperationError, useEventRoom, type SequencedOperation } from './realtime'
import { useOfficialAudioDevice } from './audioDeviceClient'
import { adoptPassageObservation, mergePassageObservation, passageVisitKey } from './passages'
import { adoptFinishObservation, finishRecordKey, mergeFinishObservation } from './finishes'
import { isRaceSignalHeld, makeRaceSignalEvent } from './signals'
import { raceFinalizationPhrase } from '../shared/finalization'
import { estimateRegattaFreeTierUsage, STANDARD_REGATTA_LOAD } from '../shared/freeTierBudget'

const DETAIL_KEY = 'srs-board-detail'
const SCALE_KEY = 'srs-board-scale'
const SPLIT_KEY = 'srs-map-split'

interface CachedAppState {
  eventName: string
  races: readonly RaceDefinition[]
  boats: readonly CommitteeBoat[]
  messages: readonly OperationalMessage[]
  tasks: readonly OperationalTask[]
  leadingPassages: Record<string, LeadingPassageVisit>
  finishes: Record<string, FinishRecord>
  memberCount: number
  wind?: WindObservation
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

function operationRoleLabel(role: string): string {
  const labels: Record<string, string> = {
    owner: '大会管理者', pro: 'PRO', ro: 'RO', 'course-setter': 'コースセッター',
    'signal-boat': 'シグナルボート', 'mark-boat': 'マークボート', 'safety-boat': '安全ボート',
    timekeeper: 'タイムキーパー', 'record-keeper': '記録員', jury: 'ジュリー', protest: 'プロテスト', viewer: '閲覧者',
  }
  return labels[role] ?? role
}

function messageTargetLabel(value: string, raceNumber: string, resources: EventResources): string {
  if (value === 'event') return '大会全体'
  if (value === 'race') return `${raceNumber}・全運営`
  const separator = value.indexOf(':')
  const type = value.slice(0, separator)
  const id = value.slice(separator + 1)
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
  const [eventName, setEventName] = useState('2026 江の島サマーレガッタ')
  const [memberId, setMemberId] = useState(localMemberId)
  const [activeRaceId, setActiveRaceId] = useState(DEMO_RACES[0].id)
  const [races, setRaces] = useState<readonly RaceDefinition[]>(DEMO_RACES)
  const [boats, setBoats] = useState<readonly CommitteeBoat[]>(DEMO_BOATS)
  const [selectedMarkId, setSelectedMarkId] = useState<string>()
  const [messages, setMessages] = useState<readonly OperationalMessage[]>(DEMO_MESSAGES)
  const [tasks, setTasks] = useState<readonly OperationalTask[]>(DEMO_TASKS)
  const [memberCount, setMemberCount] = useState(18)
  const [messagesOpen, setMessagesOpen] = useState(false)
  const [logsOpen, setLogsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [eventManagerOpen, setEventManagerOpen] = useState(false)
  const [joinContext, setJoinContext] = useState(joinContextFromLocation)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [session, setSession] = useState<SessionState>({ mode: 'checking' })
  const [eventAccess, setEventAccess] = useState<EventAccessSummary>()
  const [eventResources, setEventResources] = useState<EventResources>({ boats: [], marks: [], members: [] })
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
  const [revisionWorking, setRevisionWorking] = useState(false)
  const [revisionError, setRevisionError] = useState<string>()
  const [boardScale, setBoardScale] = useState(() => storedNumber(SCALE_KEY, 100))
  const [boardDetail, setBoardDetail] = useState<BoardDetail>(() => {
    const stored = window.localStorage.getItem(DETAIL_KEY)
    return stored === 'overview' || stored === 'detail' ? stored : 'standard'
  })
  const [mapSplit, setMapSplit] = useState(() => storedNumber(SPLIT_KEY, 58))
  const [selectedClass, setSelectedClass] = useState<SailingClass>('470')
  const [windSpeed, setWindSpeed] = useState(INITIAL_WIND.speedKnots)
  const [windDirection, setWindDirection] = useState(INITIAL_WIND.directionDegrees)
  const [windDetails, setWindDetails] = useState<WindObservation>(INITIAL_WIND)
  const [seaCurrent, setSeaCurrent] = useState<CurrentObservation>(INITIAL_CURRENT)
  const [courseTemplate, setCourseTemplate] = useState<CourseTemplate>('O2')
  const [lowerGate, setLowerGate] = useState(true)
  const [upperGate, setUpperGate] = useState(false)
  const [courseSaving, setCourseSaving] = useState(false)
  const [courseSaveError, setCourseSaveError] = useState<string>()
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
      const payload = event.payload as { committeeBoatId?: string; position?: LngLat; speedKnots?: number; courseDegrees?: number }
      if (!payload.committeeBoatId || !payload.position) return
      setBoats((current) => current.map((boat) => (
        boat.id === payload.committeeBoatId
          ? {
              ...boat,
              position: payload.position as LngLat,
              speedKnots: payload.speedKnots ?? boat.speedKnots,
              courseDegrees: payload.courseDegrees ?? boat.courseDegrees,
              freshnessSeconds: 0,
            }
          : boat
      )))
    }

    if (event.type === 'mark') {
      const payload = event.payload as { markId?: string; actual?: LngLat; status?: 'deployed' | 'confirmed' }
      if (!event.raceId || !payload.markId || !payload.actual) return
      setRaces((current) => current.map((race) => (
        race.id === event.raceId
          ? {
              ...race,
              marks: race.marks.map((mark) => (
                mark.id === payload.markId
                  ? { ...mark, actual: payload.actual, status: payload.status ?? 'deployed' }
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
      const payload = event.payload as { taskId?: string; status?: OperationalTask['status'] }
      if (!payload.taskId || !payload.status) return
      setTasks((current) => current.map((task) => (
        task.id === payload.taskId ? { ...task, status: payload.status as OperationalTask['status'] } : task
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
      if (typeof payload.directionDegrees === 'number') setWindDirection(payload.directionDegrees)
      if (typeof payload.speedKnots === 'number') setWindSpeed(payload.speedKnots)
      if (typeof payload.directionDegrees === 'number' && typeof payload.speedKnots === 'number') {
        setWindDetails({
          directionDegrees: payload.directionDegrees,
          speedKnots: payload.speedKnots,
          gustKnots: payload.gustKnots ?? payload.speedKnots,
          observedAt: payload.observedAt ?? event.serverTime,
          source: payload.source ?? '運営メンバー',
          trend: payload.trend ?? 'steady',
          confidence: payload.confidence ?? 'low',
          position: payload.position,
        })
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
  })
  const sendRealtimeOperation = realtime.send

  const activeRace = races.find((race) => race.id === activeRaceId) ?? races[0]
  const postponed = isRaceSignalHeld(activeRace.latestSignal)
  const marks = useMemo(() => {
    if (activeRace.marks.length) return activeRace.marks
    return races[0].marks.map((mark) => ({
      ...mark,
      id: `${activeRace.id}-${mark.id}`,
      actual: undefined,
      status: 'planned' as const,
    }))
  }, [activeRace, races])
  const recommendation = recommendedCourseLength(selectedClass, windSpeed)
  const freeTierBudget = useMemo(() => estimateRegattaFreeTierUsage(STANDARD_REGATTA_LOAD), [])
  const activeTasks = useMemo(
    () => tasks.filter((task) => !task.raceId || task.raceId === activeRace.id),
    [activeRace.id, tasks],
  )
  const locked = activeRace.status === 'finalized'
  const canControlSignals = !locked && (!eventAccess || eventAccess.isOwner || ['pro', 'ro', 'signal-boat'].includes(eventAccess.role))
  const canChangeCourse = !locked && (!eventAccess || eventAccess.isOwner || ['pro', 'ro'].includes(eventAccess.role))
  const canShareEnvironment = !locked && (!eventAccess || eventAccess.isOwner || ['pro', 'ro', 'course-setter', 'signal-boat', 'mark-boat', 'safety-boat'].includes(eventAccess.role))
  const canScheduleRace = !locked && ['planning', 'setup'].includes(activeRace.status) && Boolean(eventAccess) && (
    Boolean(eventAccess?.isOwner) || ['pro', 'ro'].includes(eventAccess?.role ?? '')
  )
  const scheduleWarningInput = scheduleWarningDrafts[activeRace.id] ?? dateTimeLocalValue(activeRace.warningAt)
  const canAdoptLeadingPassage = !eventAccess || eventAccess.isOwner || ['pro', 'ro', 'timekeeper', 'record-keeper', 'signal-boat'].includes(eventAccess.role)
  const canRecordFinish = (!locked || Boolean(eventAccess?.isOwner)) && (
    !eventAccess || eventAccess.isOwner || ['pro', 'ro', 'timekeeper', 'record-keeper', 'signal-boat'].includes(eventAccess.role)
  )
  const canAdoptFinish = canRecordFinish
  const finalizePhrase = raceFinalizationPhrase(activeRace.number)
  const recentAuthentication = hasRecentPasskeyAuthentication(session) && !finalizeNeedsReauth
  const firstFinish = finishes[finishRecordKey(activeRace.id, 1)]
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
      setRaces(cached.value.races)
      setActiveRaceId((current) => cached.value.races.some((race) => race.id === current) ? current : cached.value.races[0]?.id ?? current)
      setBoats(cached.value.boats)
      setMessages(cached.value.messages)
      setTasks(cached.value.tasks ?? [])
      setLeadingPassages(cached.value.leadingPassages)
      setFinishes(cached.value.finishes ?? {})
      setMemberCount(cached.value.memberCount ?? 0)
      if (cached.value.wind) {
        setWindSpeed(cached.value.wind.speedKnots)
        setWindDirection(cached.value.wind.directionDegrees)
        setWindDetails({ ...INITIAL_WIND, ...cached.value.wind })
      }
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
        setEventAccess(bootstrap.access)
        setEventResources(bootstrap.resources)
        setMemberId(bootstrap.access.memberId)
        if (bootstrap.races.length) {
          setRaces(bootstrap.races)
          setActiveRaceId(bootstrap.races[0].id)
          setSelectedClass(bootstrap.races[0].className)
        }
        setBoats(bootstrap.boats)
        setMessages(bootstrap.messages)
        setTasks(bootstrap.tasks)
        setLeadingPassages(bootstrap.leadingPassages)
        setFinishes(bootstrap.finishes)
        setMemberCount(bootstrap.memberCount)
        if (bootstrap.wind) {
          setWindSpeed(bootstrap.wind.speedKnots)
          setWindDirection(bootstrap.wind.directionDegrees)
          setWindDetails(bootstrap.wind)
        }
        if (bootstrap.current) setSeaCurrent(bootstrap.current)
      })
      .catch(() => void applyCachedState())
    return () => { active = false }
  }, [eventId, eventRoute, session.mode, sessionUserId])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void saveEventSnapshot({
        eventId,
        sequence: realtime.lastSequence,
        savedAt: new Date().toISOString(),
        value: {
          eventName,
          races,
          boats,
          messages,
          tasks,
          leadingPassages,
          finishes,
          memberCount,
          wind: { ...windDetails, speedKnots: windSpeed, directionDegrees: windDirection },
          current: seaCurrent,
        },
      })
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [boats, eventId, eventName, finishes, leadingPassages, memberCount, messages, races, realtime.lastSequence, seaCurrent, tasks, windDetails, windDirection, windSpeed])

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
    setBoats((current) => current.map((boat) => (
      boat.isSelf ? {
        ...boat,
        position,
        speedKnots: motion.speedKnots ?? boat.speedKnots,
        courseDegrees: motion.courseDegrees ?? boat.courseDegrees,
        freshnessSeconds: 0,
        status: 'moving' as const,
      } : boat
    )))
    if (selfBoat) {
      void sendRealtimeOperation('position', {
        committeeBoatId: selfBoat.id,
        position,
        speedKnots: motion.speedKnots ?? selfBoat.speedKnots,
        courseDegrees: motion.courseDegrees ?? selfBoat.courseDegrees,
        accuracyMetres: motion.accuracyMetres,
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
    if (locked) return
    const task = tasks.find((candidate) => candidate.id === taskId)
    if (!task) return
    const nextStatus: OperationalTask['status'] = task.status === 'done'
      ? 'waiting'
      : task.status === 'doing' ? 'done' : 'doing'
    setTasks((current) => current.map((candidate) => (
      candidate.id === taskId ? { ...candidate, status: nextStatus } : candidate
    )))
    void sendRealtimeOperation('task', { taskId, status: nextStatus }, task.raceId ?? activeRace.id)
  }

  const recordMarkDrop = (markId: string) => {
    if (locked) return
    const selfBoat = boats.find((boat) => boat.isSelf)
    if (!selfBoat) return
    setRaces((current) => current.map((race) => {
      if (race.id !== activeRace.id) return race
      const sourceMarks = race.marks.length ? race.marks : marks
      return {
        ...race,
        marks: sourceMarks.map((mark) => (
          mark.id === markId
            ? { ...mark, actual: selfBoat.position, status: 'deployed' as const }
            : mark
        )),
      }
    }))
    void sendRealtimeOperation('mark', {
      markId,
      actual: selfBoat.position,
      status: 'deployed',
      recordedAt: new Date().toISOString(),
      committeeBoatId: selfBoat.id,
    }, activeRace.id)
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

  const shareWind = () => {
    if (!canShareEnvironment) return
    const selfBoat = boats.find((boat) => boat.isSelf)
    const observedAt = new Date().toISOString()
    const nextWind: WindObservation = {
      ...windDetails,
      directionDegrees: windDirection,
      speedKnots: windSpeed,
      gustKnots: Math.max(windSpeed, windDetails.gustKnots),
      observedAt,
      source: eventAccess?.displayName ?? windDetails.source,
      confidence: 'medium',
      position: selfBoat?.position ?? windDetails.position,
    }
    setWindDetails(nextWind)
    void sendRealtimeOperation('wind', {
      directionDegrees: windDirection,
      speedKnots: windSpeed,
      gustKnots: nextWind.gustKnots,
      averagingSeconds: 300,
      observedAt,
      confidence: 'medium',
      position: selfBoat?.position,
      committeeBoatId: selfBoat?.id,
    }, activeRace.id)
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

  const shareEnvironment = () => {
    shareWind()
    shareCurrent()
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
    const supported = ['O2', 'I2', 'L2', 'L3', 'W2', 'トライアングル'].includes(activeRace.courseCode)
      ? activeRace.courseCode as CourseTemplate
      : 'O2'
    setCourseTemplate(supported)
    setLowerGate(activeRace.marks.some((mark) => mark.label.startsWith('下ゲート')) || activeRace.courseCode.includes('ゲート'))
    setUpperGate(activeRace.marks.some((mark) => mark.label.startsWith('上ゲート')))
    setCourseSaveError(undefined)
    setSettingsOpen(true)
  }

  const saveCourse = async () => {
    if (locked) return
    setCourseSaving(true)
    setCourseSaveError(undefined)
    const pin = marks.find((mark) => mark.label === 'スタート・ピン')
    const signal = marks.find((mark) => mark.label === 'シグナルボート')
    const center: LngLat = pin && signal
      ? [(pin.target[0] + signal.target[0]) / 2, (pin.target[1] + signal.target[1]) / 2]
      : marks[0]?.target ?? [139.4638, 35.283]
    const plan = generateCoursePlan({
      center,
      windDirection,
      totalLengthMetres: recommendation.kilometres * 1_000,
      courseCode: courseTemplate,
      lowerGate,
      upperGate,
    })
    const allPhysicalMarks = new Map<string, { id: string; label: string }>()
    marks.forEach((mark) => allPhysicalMarks.set(mark.label, mark))
    eventResources.marks.forEach((mark) => allPhysicalMarks.set(mark.label, mark))
    const plannedMarks = plan.flatMap((node) => {
      const physical = allPhysicalMarks.get(node.label)
      if (!physical) return []
      const existing = marks.find((mark) => mark.id === physical.id)
      return [{
        id: physical.id,
        label: node.label,
        shortLabel: node.label === 'スタート・ピン' ? 'PIN' : node.label === 'シグナルボート' ? 'RC' : node.label.replace('オフセット ', '').replace('下ゲート ', '').replace('上ゲート ', '').replace('マーク', '').trim(),
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
        await saveCourseRevision(eventId, activeRace.id, {
          courseCode: courseTemplate,
          windDirection,
          windSpeed,
          targetLengthMetres: recommendation.kilometres * 1_000,
          lowerGate,
          upperGate,
          nodes: plannedMarks.map((mark) => ({
            markId: mark.id,
            label: mark.label,
            nodeType: mark.label === 'スタート・ピン' || mark.label === 'シグナルボート'
              ? 'start'
              : mark.label.includes('オフセット') ? 'offset' : mark.isGate ? 'gate' : 'single',
            rounding: mark.isGate ? 'gate' : 'port',
            target: mark.target,
          })),
        })
      }
      setRaces((current) => current.map((race) => race.id === activeRace.id ? {
        ...race,
        courseCode: courseTemplate,
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
    setRevisionCourseCode(activeRace.courseCode)
    setRevisionTargetMinutes(activeRace.targetMinutes)
    setRevisionReason('確定後に判明した運営記録の訂正')
    setRevisionNote('')
    setRevisionError(undefined)
    setRevisionOpen(true)
  }

  const submitAdminRevision = async (event: React.FormEvent) => {
    event.preventDefault()
    setRevisionWorking(true)
    setRevisionError(undefined)
    try {
      await createPostFinalizationRevision(eventId, activeRace.id, revisionReason, {
        courseCode: revisionCourseCode,
        targetMinutes: revisionTargetMinutes,
        note: revisionNote,
      })
      setRaces((current) => current.map((race) => race.id === activeRace.id ? {
        ...race,
        courseCode: revisionCourseCode,
        targetMinutes: revisionTargetMinutes,
      } : race))
      setRevisionOpen(false)
    } catch (reason) {
      if (reason instanceof EventApiError && reason.code === 'RECENT_AUTHENTICATION_REQUIRED') {
        setFinalizeNeedsReauth(true)
      }
      setRevisionError(reason instanceof Error ? reason.message : '管理者修正版を作成できません')
    } finally {
      setRevisionWorking(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark"><Anchor size={22} /></div>
          <div>
            <strong>Sailing Race Supporter</strong>
            <small>Created by Dit-Lab.（Daiki ITO）</small>
          </div>
        </div>

        <button type="button" className="event-selector" onClick={() => setEventManagerOpen(true)}>
          <span><small>大会</small><strong>{eventName}</strong></span>
          <ChevronDown size={16} />
        </button>

        <RaceTabs
          races={races}
          activeRaceId={activeRace.id}
          serverOffsetMs={realtime.serverOffsetMs}
          messages={messages}
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
          <button type="button" className="owner-button" onClick={() => setAuthOpen(true)}>
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

      <main
        className="race-workspace"
        style={{ '--map-split': `${mapSplit}%` } as React.CSSProperties}
      >
        <div className="map-column">
          <Suspense fallback={<div className="map-loading"><RadioTower size={24} /><strong>海面地図を準備中…</strong></div>}>
            <MapView
              marks={marks}
              boats={boats}
              wind={{ ...windDetails, directionDegrees: windDirection, speedKnots: windSpeed }}
              current={seaCurrent}
              selectedMarkId={selectedMarkId}
              onSelectMark={setSelectedMarkId}
              onUseCurrentLocation={updateSelfLocation}
              onRecordDrop={recordMarkDrop}
              onRecordLeadingPassage={recordLeadingPassage}
              onAdoptLeadingPassage={adoptLeadingPassage}
              leadingPassages={leadingPassages}
              raceId={activeRace.id}
              locked={locked}
              passageLocked={locked && !eventAccess?.isOwner}
              canAdoptLeadingPassage={canAdoptLeadingPassage}
            />
          </Suspense>
          <div className="course-advisor glass-panel">
            <div className="course-advisor__title">
              <SlidersHorizontal size={16} />
              <span><small>目標時間から算出</small><strong>推奨コース長</strong></span>
            </div>
            <label>
              <span>クラス</span>
              <select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value as SailingClass)}>
                {CLASS_PROFILES.map((profile) => <option key={profile.className}>{profile.className}</option>)}
              </select>
            </label>
            <label>
              <span>風速 <strong>{windSpeed.toFixed(1)}kt</strong></span>
              <input type="range" min="2" max="20" step="0.5" value={windSpeed} onChange={(event) => setWindSpeed(Number(event.target.value))} onPointerUp={shareWind} disabled={!canShareEnvironment} />
            </label>
            <div className="course-advisor__result">
              <strong>{recommendation.kilometres.toFixed(1)} km</strong>
              <span>{recommendation.nauticalMiles.toFixed(2)} NM・暫定/低信頼</span>
            </div>
            <button type="button" onClick={openCourseSettings}><Settings2 size={16} /> 詳細設定</button>
          </div>
        </div>

        <button
          type="button"
          className="split-handle"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            draggingSplit.current = true
          }}
          aria-label="地図と運用ボードの幅を調整"
        ><span /></button>

        <OperationsBoard
          race={activeRace}
          marks={marks}
          boats={boats}
          tasks={activeTasks}
          messages={messages}
          wind={{ ...windDetails, directionDegrees: windDirection, speedKnots: windSpeed }}
          current={seaCurrent}
          freeTierBudget={freeTierBudget}
          scale={boardScale}
          detail={boardDetail}
          postponed={postponed}
          locked={locked}
          socketStatus={realtime.status}
          pendingCount={realtime.pendingCount}
          memberCount={memberCount}
          latestSignal={activeRace.latestSignal}
          firstFinish={firstFinish}
          canRecordFinish={canRecordFinish}
          canAdoptFinish={canAdoptFinish}
          onScaleChange={setBoardScale}
          onDetailChange={setBoardDetail}
          onSelectMark={setSelectedMarkId}
          onAcknowledgeMessage={acknowledgeMessage}
          onOpenMessages={() => setMessagesOpen(true)}
          onTaskStatusChange={advanceTask}
          onRecordFinish={recordFirstFinish}
          onAdoptFinish={adoptFirstFinish}
        />
      </main>

      <div className="floating-owner-actions">
        {!locked && (!eventAccess || eventAccess.isOwner || eventAccess.role === 'pro' || eventAccess.role === 'ro') && (
          <button type="button" className="finalize-button" onClick={openFinalizeConfirmation}>
            <ShieldCheck size={17} /> {activeRace.number}を確定
          </button>
        )}
        {locked && eventAccess?.isOwner && (
          <button type="button" className="revision-button" onClick={openAdminRevision}>
            <FilePenLine size={17} /> 管理者修正版を作成
          </button>
        )}
      </div>

      {messagesOpen && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={() => setMessagesOpen(false)}>
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
        <div className="drawer-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <aside className="settings-sheet" aria-label="コース設定" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="eyebrow">{activeRace.number}</span><strong>コース・表示設定</strong></div><button type="button" onClick={() => setSettingsOpen(false)}><X size={20} /></button></header>
            <label><span>競技ヨットクラス</span><select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value as SailingClass)}>{CLASS_PROFILES.map((profile) => <option key={profile.className}>{profile.className}</option>)}</select></label>
            <label><span>コース</span><select value={courseTemplate} onChange={(event) => setCourseTemplate(event.target.value as CourseTemplate)}><option>O2</option><option>I2</option><option>L2</option><option>L3</option><option>W2</option><option>トライアングル</option></select></label>
            <div className="settings-subsection">
              <span className="eyebrow">レース予告予定</span>
              <small>変更時に未完了タスクとリマインドを同じ差分で再計算</small>
            </div>
            <label><span>予告信号の予定時刻</span><input type="datetime-local" value={scheduleWarningInput} onChange={(event) => setScheduleWarningDrafts((current) => ({ ...current, [activeRace.id]: event.target.value }))} disabled={!canScheduleRace} /></label>
            <label><span>変更理由</span><textarea rows={2} maxLength={500} value={scheduleReason} onChange={(event) => setScheduleReason(event.target.value)} disabled={!canScheduleRace} /></label>
            {!['planning', 'setup'].includes(activeRace.status) && !locked && <small className="settings-guidance">開始手順中の変更は、先に本部船が延期・ゼネラルリコール・中止を記録してください。</small>}
            {scheduleError && <div className="auth-error" role="alert">{scheduleError}</div>}
            <button type="button" className="sheet-secondary" onClick={() => void shareRaceSchedule()} disabled={!canScheduleRace || realtime.status !== 'live' || scheduleWorking}>
              <BellRing size={17} /> {scheduleWorking ? '予告予定を共有中…' : '予告予定を全運営へ共有'}
            </button>
            <label><span>風向（真方位）</span><input type="number" min="0" max="360" value={windDirection} onChange={(event) => setWindDirection(Number(event.target.value))} /></label>
            <div className="settings-subsection">
              <span className="eyebrow">潮流観測</span>
              <small>流向は海水が流れていく方向を真方位で入力</small>
            </div>
            <label><span>流向（真方位・行き先）</span><input type="number" min="0" max="360" value={seaCurrent.directionDegrees} onChange={(event) => setSeaCurrent((current) => ({ ...current, directionDegrees: Number(event.target.value) }))} /></label>
            <label><span>流速（kt）</span><input type="number" min="0" max="20" step="0.1" value={seaCurrent.speedKnots} onChange={(event) => setSeaCurrent((current) => ({ ...current, speedKnots: Number(event.target.value) }))} /></label>
            <label><span>信頼度</span><select value={seaCurrent.confidence} onChange={(event) => setSeaCurrent((current) => ({ ...current, confidence: event.target.value as CurrentObservation['confidence'] }))}><option value="low">低・目測</option><option value="medium">中・複数回確認</option><option value="high">高・機器観測</option></select></label>
            <button type="button" className="sheet-secondary" onClick={shareEnvironment} disabled={!canShareEnvironment}>
              <Waves size={17} /> 風・潮流を現在地と共有
            </button>
            <label><span>準備信号</span><select value={preparatoryFlag} onChange={(event) => setPreparatoryFlag(event.target.value)}><option>P旗</option><option>I旗</option><option>Z旗</option><option>Z旗 + I旗</option><option>U旗</option><option>黒旗</option></select></label>
            <label className="switch-row"><span><strong>下ゲート</strong><small>3S / 3Pを使用</small></span><input type="checkbox" checked={lowerGate} onChange={(event) => setLowerGate(event.target.checked)} /></label>
            <label className="switch-row"><span><strong>上ゲート</strong><small>1S / 1Pを使用</small></span><input type="checkbox" checked={upperGate} onChange={(event) => setUpperGate(event.target.checked)} /></label>
            {courseSaveError && <div className="auth-error" role="alert">{courseSaveError}</div>}
            <button type="button" className="sheet-secondary" onClick={() => { setSettingsOpen(false); setEventManagerOpen(true) }}><Anchor size={17} /> 大会URL・参加者・バックアップ</button>
            {session.mode === 'authenticated' && <button type="button" className="sheet-secondary" onClick={() => { setSettingsOpen(false); setLogsOpen(true) }}><ScrollText size={17} /> 大会・レース別の運営ログ</button>}
            <button type="button" className="sheet-secondary" onClick={() => { setSettingsOpen(false); setAuthOpen(true) }}><ShieldCheck size={17} /> 本人確認・パスキー</button>
            <button type="button" className="sheet-primary" onClick={() => void saveCourse()} disabled={courseSaving || locked}>{courseSaving ? '座標を計算・保存中…' : '設定案を保存'}</button>
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
            <button type="button" className="revision-close" onClick={() => setRevisionOpen(false)}><X size={19} /></button>
            <div className="confirm-icon"><FilePenLine size={24} /></div>
            <span className="eyebrow">大会作成者のみ・旧確定版を保持</span>
            <h2 id="revision-title">{activeRace.number} 管理者修正版</h2>
            <p>元の確定版は変更しません。以下の訂正を新しい確定版として追記し、差分・理由・時刻・ハッシュを監査ログへ残します。</p>
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
            <div className="revision-grid">
              <label><span>コース記号</span><input value={revisionCourseCode} onChange={(event) => setRevisionCourseCode(event.target.value)} maxLength={80} required /></label>
              <label><span>目標時間（分）</span><input type="number" min="5" max="360" value={revisionTargetMinutes} onChange={(event) => setRevisionTargetMinutes(Number(event.target.value))} required /></label>
            </div>
            <label><span>修正理由（必須）</span><textarea value={revisionReason} onChange={(event) => setRevisionReason(event.target.value)} minLength={5} maxLength={500} required /></label>
            <label><span>修正メモ</span><textarea value={revisionNote} onChange={(event) => setRevisionNote(event.target.value)} maxLength={2_000} placeholder="元記録との差異、確認者、根拠など" /></label>
            {revisionError && <div className="auth-error" role="alert">{revisionError}</div>}
            <div className="revision-actions"><button type="button" onClick={() => setRevisionOpen(false)}>キャンセル</button><button type="submit" disabled={revisionWorking || finalizeReauthWorking || !recentAuthentication || revisionReason.trim().length < 5}>{revisionWorking ? '作成中…' : '新しい確定版を追記'}</button></div>
          </form>
        </div>
      )}

      <Suspense fallback={null}>
        {authOpen && (
          <AuthPanel session={session} onSessionChange={setSession} onClose={() => setAuthOpen(false)} />
        )}

        {eventManagerOpen && (
          <EventManager
            session={session}
            currentEventSlug={eventId}
            currentEventId={eventDatabaseId}
            currentEventName={eventName}
            isCurrentEventOwner={eventAccess?.isOwner ?? false}
            resources={eventResources}
            onRequestAuthentication={() => { setEventManagerOpen(false); setAuthOpen(true) }}
            onRecoverParticipation={() => { setEventManagerOpen(false); setRecoveryOpen(true) }}
            onClose={() => setEventManagerOpen(false)}
          />
        )}

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
