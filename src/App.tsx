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
  INITIAL_WIND,
  type BoardDetail,
  type CommitteeBoat,
  type LeadingPassageObservation,
  type LeadingPassageVisit,
  type LngLat,
  type OperationalMessage,
  type OperationalTask,
  type RaceDefinition,
  type SailingClass,
} from './domain'
import { OperationsBoard } from './components/OperationsBoard'
import { StartSequence } from './components/StartSequence'
import { loadSession, type SessionState } from './authClient'
import { createPostFinalizationRevision, loadEventBootstrap, saveCourseRevision } from './eventClient'
import type { EventAccessSummary, EventResources } from './eventClient'
import { loadEventSnapshot, saveEventSnapshot } from './offlineStore'
import { useEventRoom, type SequencedOperation } from './realtime'
import { useOfficialAudioDevice } from './audioDeviceClient'
import { adoptPassageObservation, mergePassageObservation, passageVisitKey } from './passages'

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
  memberCount: number
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

export default function App() {
  const [eventId] = useState(eventSlugFromLocation)
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
  const [eventResources, setEventResources] = useState<EventResources>({ boats: [], marks: [] })
  const [postponed, setPostponed] = useState(false)
  const [confirmFinalize, setConfirmFinalize] = useState(false)
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
  const [courseTemplate, setCourseTemplate] = useState<CourseTemplate>('O2')
  const [lowerGate, setLowerGate] = useState(true)
  const [upperGate, setUpperGate] = useState(false)
  const [courseSaving, setCourseSaving] = useState(false)
  const [courseSaveError, setCourseSaveError] = useState<string>()
  const [preparatoryFlag, setPreparatoryFlag] = useState('P旗')
  const [messageDraft, setMessageDraft] = useState('')
  const [messagePriority, setMessagePriority] = useState<OperationalMessage['priority']>('normal')
  const [leadingPassages, setLeadingPassages] = useState<Record<string, LeadingPassageVisit>>({})
  const draggingSplit = useRef(false)

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

    if (event.type === 'task') {
      const payload = event.payload as { taskId?: string; status?: OperationalTask['status'] }
      if (!payload.taskId || !payload.status) return
      setTasks((current) => current.map((task) => (
        task.id === payload.taskId ? { ...task, status: payload.status as OperationalTask['status'] } : task
      )))
    }

    if (event.type === 'wind') {
      const payload = event.payload as { directionDegrees?: number; speedKnots?: number }
      if (typeof payload.directionDegrees === 'number') setWindDirection(payload.directionDegrees)
      if (typeof payload.speedKnots === 'number') setWindSpeed(payload.speedKnots)
    }

    if (event.type === 'message') {
      const payload = event.payload as {
        action?: string; messageId?: string; body?: string; sender?: string; channel?: string
        priority?: OperationalMessage['priority']; sentAt?: string
      }
      if (payload.action === 'acknowledge' && payload.messageId) {
        setMessages((current) => current.map((message) => (
          message.id === payload.messageId ? { ...message, acknowledgement: 'acknowledged' as const } : message
        )))
      } else if (payload.body) {
        setMessages((current) => current.some((message) => message.id === event.id) ? current : [...current, {
          id: event.id,
          sender: payload.sender ?? '運営メンバー',
          channel: payload.channel ?? event.raceId ?? 'event',
          text: payload.body as string,
          sentAt: payload.sentAt ?? event.serverTime,
          priority: payload.priority ?? 'normal',
          acknowledgement: payload.priority === 'confirm' || payload.priority === 'urgent' ? 'pending' : undefined,
        }])
      }
    }

    if (event.type === 'finalize' && event.raceId) {
      setRaces((current) => current.map((race) => (
        race.id === event.raceId ? { ...race, status: 'finalized' as const } : race
      )))
    }

    if (event.type === 'signal') {
      const payload = event.payload as { action?: 'postpone' | 'resume'; warningAt?: string }
      if (payload.action === 'postpone') setPostponed(true)
      if (payload.action === 'resume') {
        setPostponed(false)
        if (event.raceId && payload.warningAt) {
          setRaces((current) => current.map((race) => (
            race.id === event.raceId ? { ...race, warningAt: payload.warningAt as string } : race
          )))
        }
      }
    }
  }, [])

  const realtime = useEventRoom({
    eventId,
    memberId,
    enabled: session.mode === 'authenticated',
    onEvent: applyRemoteEvent,
  })
  const sendRealtimeOperation = realtime.send

  const activeRace = races.find((race) => race.id === activeRaceId) ?? races[0]
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
  const activeTasks = useMemo(
    () => tasks.filter((task) => !task.raceId || task.raceId === activeRace.id),
    [activeRace.id, tasks],
  )
  const locked = activeRace.status === 'finalized'
  const canControlSignals = !eventAccess || eventAccess.isOwner || ['pro', 'ro', 'signal-boat'].includes(eventAccess.role)
  const canAdoptLeadingPassage = !eventAccess || eventAccess.isOwner || ['pro', 'ro', 'timekeeper', 'record-keeper', 'signal-boat'].includes(eventAccess.role)
  const officialAudio = useOfficialAudioDevice({
    eventSlug: eventId,
    raceId: activeRace.id,
    enabled: session.mode === 'authenticated' && Boolean(eventAccess) && canControlSignals,
    serverOffsetMs: realtime.serverOffsetMs,
  })

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
    if (session.mode !== 'authenticated' && session.mode !== 'offline-demo') return
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
      setMemberCount(cached.value.memberCount ?? 0)
    }
    if (session.mode === 'offline-demo') {
      void applyCachedState()
      return () => { active = false }
    }
    void loadEventBootstrap(eventId)
      .then((bootstrap) => {
        if (!active) return
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
        setMemberCount(bootstrap.memberCount)
        if (bootstrap.wind) {
          setWindSpeed(bootstrap.wind.speedKnots)
          setWindDirection(bootstrap.wind.directionDegrees)
        }
      })
      .catch(() => void applyCachedState())
    return () => { active = false }
  }, [eventId, session.mode])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void saveEventSnapshot({
        eventId,
        sequence: realtime.lastSequence,
        savedAt: new Date().toISOString(),
        value: { eventName, races, boats, messages, tasks, leadingPassages, memberCount },
      })
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [boats, eventId, eventName, leadingPassages, memberCount, messages, races, realtime.lastSequence, tasks])

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
    setMessages((current) => current.map((message) => (
      message.id === messageId ? { ...message, acknowledgement: 'acknowledged' as const } : message
    )))
    void sendRealtimeOperation('message', { action: 'acknowledge', messageId }, activeRace.id)
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

  const finalizeRace = () => {
    setRaces((current) => current.map((race) => (
      race.id === activeRace.id ? { ...race, status: 'finalized' as const } : race
    )))
    void sendRealtimeOperation('finalize', {
      finalizedAt: new Date().toISOString(),
      reason: '大会管理者による確定',
    }, activeRace.id)
    setConfirmFinalize(false)
  }

  const resumeAfterPostponement = () => {
    const nextWarningAt = new Date(Date.now() + 5 * 60_000).toISOString()
    setRaces((current) => current.map((race) => (
      race.id === activeRace.id ? { ...race, warningAt: nextWarningAt } : race
    )))
    setPostponed(false)
    void sendRealtimeOperation('signal', { action: 'resume', warningAt: nextWarningAt }, activeRace.id)
  }

  const postponeRace = () => {
    setPostponed(true)
    void sendRealtimeOperation('signal', { action: 'postpone', executedAt: new Date().toISOString() }, activeRace.id)
  }

  const recordSignal = useCallback((signal: { action: string; label: string; flag: string; sound: string; executedAt: string }) => {
    void sendRealtimeOperation('signal', signal, activeRace.id)
  }, [activeRace.id, sendRealtimeOperation])

  const shareWind = () => {
    void sendRealtimeOperation('wind', {
      directionDegrees: windDirection,
      speedKnots: windSpeed,
      gustKnots: Math.max(windSpeed, INITIAL_WIND.gustKnots),
      averagingSeconds: 300,
      observedAt: new Date().toISOString(),
      confidence: 'medium',
    }, activeRace.id)
  }

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault()
    const body = messageDraft.trim()
    if (!body) return
    const id = await sendRealtimeOperation('message', {
      body,
      priority: messagePriority,
      channel: `race:${activeRace.id}`,
    }, activeRace.id)
    setMessages((current) => current.some((message) => message.id === id) ? current : [...current, {
      id,
      sender: eventAccess?.displayName ?? (session.mode === 'authenticated' ? session.user.displayName : '自分'),
      channel: `${activeRace.number}・全運営`,
      text: body,
      sentAt: new Date().toISOString(),
      priority: messagePriority,
      acknowledgement: messagePriority === 'confirm' || messagePriority === 'urgent' ? 'pending' : undefined,
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

        <nav className="race-tabs" aria-label="レース切替">
          {races.map((race) => (
            <button
              type="button"
              className={activeRace.id === race.id ? 'is-active' : ''}
              onClick={() => {
                setActiveRaceId(race.id)
                setSelectedMarkId(undefined)
                setPostponed(false)
              }}
              key={race.id}
            >
              <span>{race.number}</span>
              <small>{race.className}</small>
              {race.status === 'finalized' && <LockKeyhole size={11} />}
            </button>
          ))}
        </nav>

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
        warningAt={activeRace.warningAt}
        postponed={postponed}
        serverOffsetMs={realtime.serverOffsetMs}
        canControlSignals={canControlSignals}
        preparatoryFlag={preparatoryFlag}
        officialAudio={officialAudio.state}
        canForceAudioTakeover={eventAccess?.isOwner ?? false}
        onClaimOfficialAudio={officialAudio.claim}
        onReleaseOfficialAudio={officialAudio.release}
        onPostpone={postponeRace}
        onResume={resumeAfterPostponement}
        onSignalExecuted={recordSignal}
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
              wind={{ ...INITIAL_WIND, directionDegrees: windDirection, speedKnots: windSpeed }}
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
              <input type="range" min="2" max="20" step="0.5" value={windSpeed} onChange={(event) => setWindSpeed(Number(event.target.value))} onPointerUp={shareWind} />
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
          wind={{ ...INITIAL_WIND, directionDegrees: windDirection, speedKnots: windSpeed }}
          scale={boardScale}
          detail={boardDetail}
          postponed={postponed}
          locked={locked}
          socketStatus={realtime.status}
          pendingCount={realtime.pendingCount}
          memberCount={memberCount}
          onScaleChange={setBoardScale}
          onDetailChange={setBoardDetail}
          onSelectMark={setSelectedMarkId}
          onAcknowledgeMessage={acknowledgeMessage}
          onOpenMessages={() => setMessagesOpen(true)}
          onTaskStatusChange={advanceTask}
        />
      </main>

      <div className="floating-owner-actions">
        {!locked && (!eventAccess || eventAccess.isOwner || eventAccess.role === 'pro' || eventAccess.role === 'ro') && (
          <button type="button" className="finalize-button" onClick={() => setConfirmFinalize(true)}>
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
            <div className="channel-tabs"><button className="is-active">{activeRace.number}</button><button>海面A</button><button>自分の艇</button></div>
            <div className="drawer-messages">
              {messages.map((message) => (
                <article className={`drawer-message priority-${message.priority}`} key={message.id}>
                  <div><strong>{message.sender}</strong><time>{formatClock(message.sentAt)}</time></div>
                  <p>{message.text}</p>
                  <small>{message.channel}</small>
                  {message.acknowledgement === 'pending' && <button type="button" onClick={() => acknowledgeMessage(message.id)}>了解</button>}
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
            <label><span>風向（真方位）</span><input type="number" min="0" max="360" value={windDirection} onChange={(event) => setWindDirection(Number(event.target.value))} /></label>
            <label><span>準備信号</span><select value={preparatoryFlag} onChange={(event) => setPreparatoryFlag(event.target.value)}><option>P旗</option><option>I旗</option><option>Z旗</option><option>Z旗 + I旗</option><option>U旗</option><option>黒旗</option></select></label>
            <label className="switch-row"><span><strong>下ゲート</strong><small>3S / 3Pを使用</small></span><input type="checkbox" checked={lowerGate} onChange={(event) => setLowerGate(event.target.checked)} /></label>
            <label className="switch-row"><span><strong>上ゲート</strong><small>1S / 1Pを使用</small></span><input type="checkbox" checked={upperGate} onChange={(event) => setUpperGate(event.target.checked)} /></label>
            {courseSaveError && <div className="auth-error" role="alert">{courseSaveError}</div>}
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
            <span className="eyebrow">大会管理者のみ</span>
            <h2 id="finalize-title">{activeRace.number}を確定しますか？</h2>
            <p>確定後、通常メンバーは編集できません。管理者の修正は旧版を残した新しい版として記録されます。</p>
            <div><button type="button" onClick={() => setConfirmFinalize(false)}>キャンセル</button><button type="button" className="danger-confirm" onClick={finalizeRace}>確定してロック</button></div>
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
            <div className="revision-grid">
              <label><span>コース記号</span><input value={revisionCourseCode} onChange={(event) => setRevisionCourseCode(event.target.value)} maxLength={80} required /></label>
              <label><span>目標時間（分）</span><input type="number" min="5" max="360" value={revisionTargetMinutes} onChange={(event) => setRevisionTargetMinutes(Number(event.target.value))} required /></label>
            </div>
            <label><span>修正理由（必須）</span><textarea value={revisionReason} onChange={(event) => setRevisionReason(event.target.value)} minLength={5} maxLength={500} required /></label>
            <label><span>修正メモ</span><textarea value={revisionNote} onChange={(event) => setRevisionNote(event.target.value)} maxLength={2_000} placeholder="元記録との差異、確認者、根拠など" /></label>
            {revisionError && <div className="auth-error" role="alert">{revisionError}</div>}
            <div className="revision-actions"><button type="button" onClick={() => setRevisionOpen(false)}>キャンセル</button><button type="submit" disabled={revisionWorking || revisionReason.trim().length < 5}>{revisionWorking ? '作成中…' : '新しい確定版を追記'}</button></div>
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
