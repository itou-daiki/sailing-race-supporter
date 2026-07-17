import {
  Anchor,
  BellRing,
  ChevronDown,
  CircleUserRound,
  CloudOff,
  LockKeyhole,
  Menu,
  MessageSquareText,
  RadioTower,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { recommendedCourseLength } from './course'
import {
  CLASS_PROFILES,
  DEMO_BOATS,
  DEMO_MESSAGES,
  DEMO_RACES,
  DEMO_TASKS,
  INITIAL_WIND,
  type BoardDetail,
  type CommitteeBoat,
  type LngLat,
  type OperationalMessage,
  type RaceDefinition,
  type SailingClass,
} from './domain'
import { MapView } from './components/MapView'
import { OperationsBoard } from './components/OperationsBoard'
import { StartSequence } from './components/StartSequence'

type SocketStatus = 'connecting' | 'live' | 'offline'

const DETAIL_KEY = 'srs-board-detail'
const SCALE_KEY = 'srs-board-scale'
const SPLIT_KEY = 'srs-map-split'

function storedNumber(key: string, fallback: number): number {
  const value = Number(window.localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function useEventRoom(eventId: string) {
  const [status, setStatus] = useState<SocketStatus>('connecting')

  useEffect(() => {
    let socket: WebSocket | undefined
    let reconnectTimer: number | undefined
    let cancelled = false

    const connect = () => {
      if (cancelled) return
      setStatus('connecting')
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${protocol}//${window.location.host}/api/events/${eventId}/room`)
      socket.addEventListener('open', () => setStatus('live'))
      socket.addEventListener('close', () => {
        setStatus('offline')
        if (!cancelled) reconnectTimer = window.setTimeout(connect, 5_000)
      })
      socket.addEventListener('error', () => setStatus('offline'))
    }

    connect()
    return () => {
      cancelled = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [eventId])

  return status
}

function formatClock(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso))
}

export default function App() {
  const [activeRaceId, setActiveRaceId] = useState(DEMO_RACES[0].id)
  const [races, setRaces] = useState<readonly RaceDefinition[]>(DEMO_RACES)
  const [boats, setBoats] = useState<readonly CommitteeBoat[]>(DEMO_BOATS)
  const [selectedMarkId, setSelectedMarkId] = useState<string>()
  const [messages, setMessages] = useState<readonly OperationalMessage[]>(DEMO_MESSAGES)
  const [messagesOpen, setMessagesOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [postponed, setPostponed] = useState(false)
  const [confirmFinalize, setConfirmFinalize] = useState(false)
  const [boardScale, setBoardScale] = useState(() => storedNumber(SCALE_KEY, 100))
  const [boardDetail, setBoardDetail] = useState<BoardDetail>(() => {
    const stored = window.localStorage.getItem(DETAIL_KEY)
    return stored === 'overview' || stored === 'detail' ? stored : 'standard'
  })
  const [mapSplit, setMapSplit] = useState(() => storedNumber(SPLIT_KEY, 58))
  const [selectedClass, setSelectedClass] = useState<SailingClass>('470')
  const [windSpeed, setWindSpeed] = useState(INITIAL_WIND.speedKnots)
  const draggingSplit = useRef(false)

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
  const socketStatus = useEventRoom('enoshima-summer-regatta')
  const recommendation = recommendedCourseLength(selectedClass, windSpeed)
  const locked = activeRace.status === 'finalized'

  useEffect(() => window.localStorage.setItem(SCALE_KEY, String(boardScale)), [boardScale])
  useEffect(() => window.localStorage.setItem(DETAIL_KEY, boardDetail), [boardDetail])
  useEffect(() => window.localStorage.setItem(SPLIT_KEY, String(mapSplit)), [mapSplit])

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

  const updateSelfLocation = (position: LngLat) => {
    setBoats((current) => current.map((boat) => (
      boat.isSelf ? { ...boat, position, freshnessSeconds: 0 } : boat
    )))
  }

  const acknowledgeMessage = (messageId: string) => {
    setMessages((current) => current.map((message) => (
      message.id === messageId ? { ...message, acknowledgement: 'acknowledged' as const } : message
    )))
  }

  const finalizeRace = () => {
    setRaces((current) => current.map((race) => (
      race.id === activeRace.id ? { ...race, status: 'finalized' as const } : race
    )))
    setConfirmFinalize(false)
  }

  const resumeAfterPostponement = () => {
    const nextWarningAt = new Date(Date.now() + 5 * 60_000).toISOString()
    setRaces((current) => current.map((race) => (
      race.id === activeRace.id ? { ...race, warningAt: nextWarningAt } : race
    )))
    setPostponed(false)
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

        <button type="button" className="event-selector">
          <span><small>大会</small><strong>2026 江の島サマーレガッタ</strong></span>
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
          <span className={`connection-pill status-${socketStatus}`}>
            {socketStatus === 'live' ? <RadioTower size={14} /> : <CloudOff size={14} />}
            {socketStatus === 'live' ? '同期中' : socketStatus === 'connecting' ? '接続中' : 'オフライン'}
          </span>
          <button type="button" className="header-icon" onClick={() => setMessagesOpen(true)} aria-label="メッセージ">
            <MessageSquareText size={19} /><i>{messages.filter((message) => message.acknowledgement === 'pending').length}</i>
          </button>
          <button type="button" className="owner-button">
            <CircleUserRound size={21} />
            <span><strong>伊藤 大輝</strong><small>大会管理者</small></span>
          </button>
          <button type="button" className="mobile-menu" onClick={() => setSettingsOpen(true)} aria-label="メニュー"><Menu size={21} /></button>
        </div>
      </header>

      <StartSequence
        warningAt={activeRace.warningAt}
        postponed={postponed}
        onPostpone={() => setPostponed(true)}
        onResume={resumeAfterPostponement}
      />

      <main
        className="race-workspace"
        style={{ '--map-split': `${mapSplit}%` } as React.CSSProperties}
      >
        <div className="map-column">
          <MapView
            marks={marks}
            boats={boats}
            wind={{ ...INITIAL_WIND, speedKnots: windSpeed }}
            selectedMarkId={selectedMarkId}
            onSelectMark={setSelectedMarkId}
            onUseCurrentLocation={updateSelfLocation}
          />
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
              <input type="range" min="2" max="20" step="0.5" value={windSpeed} onChange={(event) => setWindSpeed(Number(event.target.value))} />
            </label>
            <div className="course-advisor__result">
              <strong>{recommendation.kilometres.toFixed(1)} km</strong>
              <span>{recommendation.nauticalMiles.toFixed(2)} NM・暫定/低信頼</span>
            </div>
            <button type="button" onClick={() => setSettingsOpen(true)}><Settings2 size={16} /> 詳細設定</button>
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
          tasks={DEMO_TASKS}
          messages={messages}
          wind={{ ...INITIAL_WIND, speedKnots: windSpeed }}
          scale={boardScale}
          detail={boardDetail}
          postponed={postponed}
          locked={locked}
          socketStatus={socketStatus}
          onScaleChange={setBoardScale}
          onDetailChange={setBoardDetail}
          onSelectMark={setSelectedMarkId}
          onAcknowledgeMessage={acknowledgeMessage}
          onOpenMessages={() => setMessagesOpen(true)}
        />
      </main>

      <div className="floating-owner-actions">
        {!locked && (
          <button type="button" className="finalize-button" onClick={() => setConfirmFinalize(true)}>
            <ShieldCheck size={17} /> {activeRace.number}を確定
          </button>
        )}
      </div>

      {messagesOpen && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={() => setMessagesOpen(false)}>
          <aside className="message-drawer" aria-label="大会メッセージ" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><span className="eyebrow">2026 江の島サマーレガッタ</span><strong>運営メッセージ</strong></div>
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
            <form className="message-composer" onSubmit={(event) => event.preventDefault()}>
              <button type="button" aria-label="優先度"><BellRing size={18} /></button>
              <input aria-label="メッセージ" placeholder="運営連絡を入力…" />
              <button type="submit">送信</button>
            </form>
          </aside>
        </div>
      )}

      {settingsOpen && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={() => setSettingsOpen(false)}>
          <aside className="settings-sheet" aria-label="コース設定" onMouseDown={(event) => event.stopPropagation()}>
            <header><div><span className="eyebrow">{activeRace.number}</span><strong>コース・表示設定</strong></div><button type="button" onClick={() => setSettingsOpen(false)}><X size={20} /></button></header>
            <label><span>競技ヨットクラス</span><select value={selectedClass} onChange={(event) => setSelectedClass(event.target.value as SailingClass)}>{CLASS_PROFILES.map((profile) => <option key={profile.className}>{profile.className}</option>)}</select></label>
            <label><span>コース</span><select defaultValue="O2"><option>O2</option><option>I2</option><option>L2</option><option>L3</option><option>W2</option></select></label>
            <label className="switch-row"><span><strong>下ゲート</strong><small>3S / 3Pを使用</small></span><input type="checkbox" defaultChecked /></label>
            <label className="switch-row"><span><strong>上ゲート</strong><small>1マークを左右2点にする</small></span><input type="checkbox" /></label>
            <button type="button" className="sheet-primary" onClick={() => setSettingsOpen(false)}>設定案を保存</button>
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
    </div>
  )
}
