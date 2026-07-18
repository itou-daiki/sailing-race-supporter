import {
  AlertTriangle,
  Bell,
  BellOff,
  CirclePause,
  Flag,
  RotateCcw,
  Smartphone,
  Scissors,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { OfficialAudioState } from '../audioDeviceClient'
import type { CourseMark, RaceDefinition, RaceSignalAction, RaceSignalEvent } from '../domain'
import {
  canClearRaceSignal,
  clearActionFor,
  isRaceSignalHeld,
  isTerminalRaceSignal,
  nextWarningAfterFlagRemoval,
  signalDefinition,
  signalFlagDescription,
} from '../signals'
import { useRaceDeviceAssist } from '../raceDeviceAssist'

type SignalExecution = Omit<RaceSignalEvent, 'id'> & { officialAudioDeviceSecret?: string }

interface StartSequenceProps {
  eventSlug: string
  eventName: string
  raceId: string
  raceNumber: string
  className: string
  warningAt: string
  latestSignal?: RaceSignalEvent
  marks: readonly CourseMark[]
  serverOffsetMs: number
  canControlSignals: boolean
  canChangeCourse: boolean
  raceStatus: RaceDefinition['status']
  preparatoryFlag: string
  officialAudio: OfficialAudioState
  officialAudioDeviceId: string
  officialAudioDeviceSecret?: string
  canForceAudioTakeover: boolean
  onClaimOfficialAudio: (force?: boolean) => Promise<void>
  onReleaseOfficialAudio: () => Promise<void>
  onSignalExecuted: (signal: SignalExecution) => void
  onAudioExecuted: (execution: { raceId: string; signalId: string; soundExecutedAt: string; deviceId: string; deviceSecret: string }) => void
}

interface SignalStage {
  offsetSeconds: number
  action: RaceSignalAction
  label: string
  flag: string
  sound: '短音1回' | '長音1回'
}

const SIGNAL_STAGES: readonly SignalStage[] = [
  { offsetSeconds: 300, action: 'warning', label: '予告信号', flag: 'クラス旗 掲揚', sound: '短音1回' },
  { offsetSeconds: 240, action: 'preparatory', label: '準備信号', flag: 'P / I / Z / U / 黒旗', sound: '短音1回' },
  { offsetSeconds: 60, action: 'one-minute', label: '1分信号', flag: '準備旗 降下', sound: '長音1回' },
  { offsetSeconds: 0, action: 'start', label: 'スタート', flag: 'クラス旗 降下', sound: '短音1回' },
] as const

const CONTROL_ACTIONS: readonly RaceSignalAction[] = [
  'postpone', 'individual-recall', 'general-recall', 'shorten',
  'course-change', 'mark-missing', 'search-rescue', 'abandon',
]

const DEFAULT_REASONS: Partial<Record<RaceSignalAction, string>> = {
  postpone: '風待ち・コース設定のため',
  'postpone-h': '陸上で次の信号を行うため',
  'postpone-a': '本日のレースを終了するため',
  'individual-recall': 'OCS艇を確認したため',
  'individual-recall-clear': '対象艇が正しくスタートしたため',
  'general-recall': 'OCS艇を特定できない、またはスタート手順に誤りがあったため',
  'general-recall-clear': '第一代表旗を降下し再スタートするため',
  shorten: '目標時間と海況を踏まえて短縮するため',
  'course-change': '風向・レグ長の変化に合わせて次のレグを変更するため',
  'mark-missing': 'マークが欠損または所定位置から外れたため',
  'search-rescue': '捜索救助指示を全艇へ伝達するため',
  abandon: '安全またはレースの公正性を確保するため',
  'abandon-h': 'レースを中止し、陸上で次の信号を行うため',
  'abandon-a': 'レースを中止し、本日のレースを終了するため',
  'abandon-clear': 'N旗を降下し再スタートするため',
  resume: 'AP旗を降下し再スタートするため',
}

function formatCountdown(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? '+' : '−'
  const absolute = Math.abs(totalSeconds)
  const minutes = Math.floor(absolute / 60)
  const seconds = absolute % 60
  return `${sign}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso))
}

function playSignal(long: boolean) {
  const AudioContextClass = window.AudioContext
  const context = new AudioContextClass()
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.frequency.value = 740
  gain.gain.setValueAtTime(0.0001, context.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.22, context.currentTime + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + (long ? 1.15 : 0.28))
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start()
  oscillator.stop(context.currentTime + (long ? 1.2 : 0.32))
  oscillator.addEventListener('ended', () => void context.close())
}

function playSignalPattern(count: number, long = false) {
  for (let index = 0; index < count; index += 1) {
    window.setTimeout(() => playSignal(long), index * (long ? 1_450 : 620))
  }
}

function signalKey(signal: Pick<RaceSignalEvent, 'action' | 'executedAt'>): string {
  return `${signal.action}:${signal.executedAt}`
}

export function StartSequence({
  eventSlug,
  eventName,
  raceId,
  raceNumber,
  className,
  warningAt,
  latestSignal,
  marks,
  serverOffsetMs,
  canControlSignals,
  canChangeCourse,
  raceStatus,
  preparatoryFlag,
  officialAudio,
  officialAudioDeviceId,
  officialAudioDeviceSecret,
  canForceAudioTakeover,
  onClaimOfficialAudio,
  onReleaseOfficialAudio,
  onSignalExecuted,
  onAudioExecuted,
}: StartSequenceProps) {
  const [now, setNow] = useState(() => new Date(warningAt).getTime())
  const [armedRaceId, setArmedRaceId] = useState<string>()
  const [audioTestedRaceId, setAudioTestedRaceId] = useState<string>()
  const [audioWorking, setAudioWorking] = useState(false)
  const [audioError, setAudioError] = useState<string>()
  const [dialogAction, setDialogAction] = useState<RaceSignalAction>()
  const [reason, setReason] = useState('')
  const [targetSailNumbers, setTargetSailNumbers] = useState('')
  const [finishAt, setFinishAt] = useState('')
  const [changeFromMarkId, setChangeFromMarkId] = useState('')
  const [targetMarkId, setTargetMarkId] = useState('')
  const [newBearing, setNewBearing] = useState('')
  const [directionChange, setDirectionChange] = useState<'' | 'port' | 'starboard'>('')
  const [lengthChange, setLengthChange] = useState<'' | 'increase' | 'decrease'>('')
  const [replacementObject, setReplacementObject] = useState('M旗を掲げた運営ボート')
  const [communicationChannel, setCommunicationChannel] = useState('VHF 72')
  const [safetyInstructions, setSafetyInstructions] = useState('全艇・公式艇・支援艇は捜索救助指示を受信してください')
  const playedStagesRef = useRef(new Set<number>())
  const playedSignalsRef = useRef(new Set<string>())
  const audioArmed = armedRaceId === officialAudio.raceId && officialAudio.status === 'mine' && Boolean(officialAudioDeviceSecret)
  const parsedBearing = newBearing === '' ? undefined : Number(newBearing)
  const bearingValid = parsedBearing === undefined || (
    Number.isInteger(parsedBearing) && parsedBearing >= 0 && parsedBearing < 360
  )
  const held = isRaceSignalHeld(latestSignal)
  const terminal = isTerminalRaceSignal(latestSignal)
  const deviceAssist = useRaceDeviceAssist({
    eventSlug,
    eventName,
    raceId,
    raceNumber,
    className,
    warningAt,
    serverOffsetMs,
    remindersPaused: held || terminal,
  })

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now() + serverOffsetMs), 250)
    return () => window.clearInterval(interval)
  }, [serverOffsetMs])

  useEffect(() => {
    playedStagesRef.current.clear()
  }, [warningAt])

  const startAt = new Date(warningAt).getTime() + 300_000
  const remainingSeconds = Math.ceil((startAt - now) / 1_000)
  const activeStage = SIGNAL_STAGES.find((stage, index) => {
    const next = SIGNAL_STAGES[index + 1]
    return remainingSeconds <= stage.offsetSeconds && (!next || remainingSeconds > next.offsetSeconds)
  }) ?? SIGNAL_STAGES[0]

  useEffect(() => {
    if (!audioArmed || held) return
    const stage = SIGNAL_STAGES.find((item) => item.offsetSeconds === remainingSeconds)
    if (!stage || playedStagesRef.current.has(stage.offsetSeconds)) return
    playedStagesRef.current.add(stage.offsetSeconds)
    const executedAt = new Date(Date.now() + serverOffsetMs).toISOString()
    const scheduledAt = new Date(startAt - stage.offsetSeconds * 1_000).toISOString()
    playedSignalsRef.current.add(`${stage.action}:${executedAt}`)
    playSignalPattern(1, stage.sound === '長音1回')
    onSignalExecuted({
      action: stage.action,
      label: stage.label,
      flag: stage.action === 'preparatory' ? preparatoryFlag : stage.flag,
      sound: stage.sound,
      soundCount: 1,
      executedAt,
      scheduledAt,
      visualExecutedAt: executedAt,
      soundExecutedAt: executedAt,
      soundStatus: 'played',
      officialAudioDeviceId,
      officialAudioDeviceSecret,
    })
  }, [audioArmed, held, officialAudioDeviceId, officialAudioDeviceSecret, onSignalExecuted, preparatoryFlag, remainingSeconds, serverOffsetMs, startAt])

  useEffect(() => {
    if (!latestSignal || !audioArmed || !officialAudioDeviceSecret || latestSignal.soundCount < 1 || latestSignal.soundStatus !== 'pending') return
    const key = signalKey(latestSignal)
    if (playedSignalsRef.current.has(key)) return
    const age = Date.now() + serverOffsetMs - Date.parse(latestSignal.executedAt)
    if (!Number.isFinite(age) || age < -2_000 || age > 8_000) return
    playedSignalsRef.current.add(key)
    playSignalPattern(latestSignal.soundCount, latestSignal.sound.includes('長音'))
    onAudioExecuted({
      raceId: officialAudio.raceId,
      signalId: latestSignal.id,
      soundExecutedAt: new Date(Date.now() + serverOffsetMs).toISOString(),
      deviceId: officialAudioDeviceId,
      deviceSecret: officialAudioDeviceSecret,
    })
  }, [audioArmed, latestSignal, officialAudio.raceId, officialAudioDeviceId, officialAudioDeviceSecret, onAudioExecuted, serverOffsetMs])

  const toggleAudio = async () => {
    if (!canControlSignals || audioWorking) return
    setAudioError(undefined)
    if (officialAudio.status === 'loading') return
    if (officialAudio.status === 'other') {
      if (!canForceAudioTakeover || !window.confirm(`${officialAudio.device?.deviceLabel ?? '別の端末'}から公式音響を強制的に引き継ぎますか？`)) return
      setAudioWorking(true)
      try {
        playSignal(false)
        await onClaimOfficialAudio(true)
        setArmedRaceId(officialAudio.raceId)
      } catch (error) {
        setAudioError(error instanceof Error ? error.message : '公式音響を引き継げません')
      } finally {
        setAudioWorking(false)
      }
      return
    }
    if (officialAudio.status === 'available') {
      if (audioTestedRaceId !== officialAudio.raceId) {
        playSignal(false)
        setAudioTestedRaceId(officialAudio.raceId)
        return
      }
      setAudioWorking(true)
      try {
        await onClaimOfficialAudio(false)
        setArmedRaceId(officialAudio.raceId)
      } catch (error) {
        setAudioError(error instanceof Error ? error.message : '公式音響端末に設定できません')
      } finally {
        setAudioWorking(false)
      }
      return
    }
    if (!audioArmed) playSignal(false)
    setArmedRaceId(audioArmed ? undefined : officialAudio.raceId)
  }

  const releaseAudio = async () => {
    if (!window.confirm('このレースの公式音響端末を解除しますか？')) return
    setAudioWorking(true)
    setAudioError(undefined)
    try {
      await onReleaseOfficialAudio()
      setArmedRaceId(undefined)
      setAudioTestedRaceId(undefined)
    } catch (error) {
      setAudioError(error instanceof Error ? error.message : '公式音響端末を解除できません')
    } finally {
      setAudioWorking(false)
    }
  }

  const openSignalDialog = (action: RaceSignalAction) => {
    setDialogAction(action)
    setReason(DEFAULT_REASONS[action] ?? '')
    setTargetSailNumbers('')
    setFinishAt(marks.find((mark) => mark.status === 'confirmed')?.label ?? marks[0]?.label ?? '')
    const firstCourseMarkIndex = marks.findIndex((mark) => !['PIN', 'RC'].includes(mark.shortLabel))
    const firstCourseMark = marks[Math.max(0, firstCourseMarkIndex)]
    const followingMark = marks[Math.min(marks.length - 1, Math.max(0, firstCourseMarkIndex) + 1)]
    setChangeFromMarkId(firstCourseMark?.id ?? marks[0]?.id ?? '')
    setTargetMarkId(followingMark?.id ?? firstCourseMark?.id ?? marks[0]?.id ?? '')
    setNewBearing('')
    setDirectionChange('')
    setLengthChange('')
    setReplacementObject('M旗を掲げた運営ボート')
    setCommunicationChannel('VHF 72')
    setSafetyInstructions('全艇・公式艇・支援艇は捜索救助指示を受信してください')
  }

  const executeControlSignal = () => {
    if (!dialogAction || !reason.trim()) return
    const definition = signalDefinition(dialogAction)
    const executedAt = new Date(Date.now() + serverOffsetMs).toISOString()
    const clearsHold = ['resume', 'general-recall-clear', 'abandon-clear'].includes(dialogAction)
    const selectedTargetMark = marks.find((mark) => mark.id === targetMarkId)
    const execution: SignalExecution = {
      action: dialogAction,
      label: definition.label,
      flag: signalFlagDescription(dialogAction, {
        newBearing: bearingValid ? parsedBearing : undefined,
        directionChange: directionChange || undefined,
        lengthChange: lengthChange || undefined,
        targetMarkLabel: selectedTargetMark?.label,
        communicationChannel: communicationChannel.trim() || undefined,
      }),
      sound: definition.sound,
      soundCount: definition.soundCount,
      executedAt,
      visualExecutedAt: executedAt,
      soundExecutedAt: audioArmed && definition.soundCount > 0 ? executedAt : undefined,
      soundStatus: definition.soundCount === 0 ? 'not-required' : audioArmed ? 'played' : 'pending',
      officialAudioDeviceId: audioArmed && definition.soundCount > 0 ? officialAudioDeviceId : undefined,
      officialAudioDeviceSecret: audioArmed && definition.soundCount > 0 ? officialAudioDeviceSecret : undefined,
      warningAt: clearsHold ? nextWarningAfterFlagRemoval(executedAt) : undefined,
      reason: reason.trim(),
      targetSailNumbers: dialogAction === 'individual-recall' ? targetSailNumbers.trim() || undefined : undefined,
      finishAt: dialogAction === 'shorten' ? finishAt : undefined,
      changeFromMarkId: dialogAction === 'course-change' ? changeFromMarkId : undefined,
      targetMarkId: ['course-change', 'mark-missing'].includes(dialogAction) ? targetMarkId : undefined,
      newBearing: dialogAction === 'course-change' && bearingValid ? parsedBearing : undefined,
      directionChange: dialogAction === 'course-change' ? directionChange || undefined : undefined,
      lengthChange: dialogAction === 'course-change' ? lengthChange || undefined : undefined,
      replacementObject: dialogAction === 'mark-missing' ? replacementObject.trim() : undefined,
      communicationChannel: dialogAction === 'search-rescue' ? communicationChannel.trim() : undefined,
      safetyInstructions: dialogAction === 'search-rescue' ? safetyInstructions.trim() : undefined,
    }
    playedSignalsRef.current.add(signalKey(execution))
    if (audioArmed) playSignalPattern(execution.soundCount, execution.sound.includes('長音'))
    onSignalExecuted(execution)
    setDialogAction(undefined)
  }

  const courseChangeComplete = dialogAction !== 'course-change' || (
    Boolean(changeFromMarkId && targetMarkId && bearingValid) &&
    (parsedBearing !== undefined || Boolean(directionChange || lengthChange))
  )
  const markReplacementComplete = dialogAction !== 'mark-missing' || Boolean(targetMarkId && replacementObject.trim())
  const searchRescueComplete = dialogAction !== 'search-rescue' || Boolean(communicationChannel.trim() && safetyInstructions.trim())
  const canExecuteControlSignal = Boolean(reason.trim() && courseChangeComplete && markReplacementComplete && searchRescueComplete)

  const audioLabel = !canControlSignals
    ? '参考端末'
    : officialAudio.status === 'loading' ? '音響状態を確認中'
    : officialAudio.status === 'other' ? canForceAudioTakeover ? '管理者が引継ぎ' : `公式: ${officialAudio.device?.deviceLabel ?? '他端末'}`
    : officialAudio.status === 'available'
      ? audioTestedRaceId === officialAudio.raceId ? '聞こえた・公式にする' : 'テスト音を鳴らす'
      : audioArmed ? '公式音響ON' : '公式音響をON'

  const audioStatus = audioError ?? officialAudio.error ?? (
    officialAudio.status === 'mine'
      ? officialAudio.networkAvailable ? 'この端末が公式音響・端末時刻同期済み' : '通信断・この端末で公式音響を継続'
      : officialAudio.status === 'other' ? `公式音響は ${officialAudio.device?.deviceLabel ?? '別端末'}`
      : officialAudio.status === 'available'
        ? audioTestedRaceId === officialAudio.raceId ? 'テスト音が聞こえたら、音響ボタンをもう一度タップ' : '公式音響端末は未選出'
        : '公式音響端末を確認中'
  )

  const latestControlSignal = latestSignal && signalDefinition(latestSignal.action).group !== 'sequence' ? latestSignal : undefined
  const displayLabel = held ? latestControlSignal?.label ?? '信号中' : latestControlSignal?.label ?? `次: ${activeStage.label}`
  const displayFlag = held
    ? latestControlSignal?.flag ?? '運営判断待ち'
    : latestControlSignal?.flag ?? (activeStage.action === 'preparatory' ? preparatoryFlag : activeStage.flag)
  const displayDetail = latestControlSignal
    ? `${latestControlSignal.sound}・視覚 ${formatTime(latestControlSignal.visualExecutedAt)}・音響 ${latestControlSignal.soundStatus === 'played' && latestControlSignal.soundExecutedAt ? formatTime(latestControlSignal.soundExecutedAt) : latestControlSignal.soundStatus === 'not-required' ? 'なし' : latestControlSignal.soundStatus === 'pending' ? '公式端末待ち' : '記録不明'}${latestControlSignal.reason ? `・${latestControlSignal.reason}` : ''}`
    : `${activeStage.sound}・${audioStatus}・${deviceAssist.status}`
  const clearDefinition = useMemo(() => latestSignal && canClearRaceSignal(latestSignal)
    ? signalDefinition(clearActionFor(latestSignal))
    : undefined, [latestSignal])

  return (
    <section className={`start-sequence ${held ? 'is-postponed is-held' : ''} ${terminal ? 'is-terminal' : ''}`} aria-label="スタートシーケンス">
      <div className="start-sequence__clock">
        <span className="eyebrow">{displayLabel}</span>
        <strong>{held ? terminal ? 'STOP' : 'HOLD' : formatCountdown(remainingSeconds)}</strong>
      </div>
      <div className="start-sequence__signal">
        {held ? <CirclePause size={19} /> : <Flag size={19} />}
        <div>
          <strong>{displayFlag}</strong>
          <small>{displayDetail}</small>
        </div>
      </div>
      <div className="start-sequence__actions">
        <button
          type="button"
          className={`device-assist-button ${deviceAssist.enabled ? 'is-active' : ''}`}
          onClick={() => void deviceAssist.toggle()}
          aria-pressed={deviceAssist.enabled}
          aria-label={deviceAssist.label}
          title={`${deviceAssist.label}（アプリを開いている間の端末内リマインド）`}
        >
          <Smartphone size={18} />
          <span>{deviceAssist.enabled ? '運営モードON' : '通知・画面維持'}</span>
        </button>
        <button
          type="button"
          className={`audio-button ${audioArmed ? 'is-armed' : ''}`}
          onClick={() => void toggleAudio()}
          disabled={!canControlSignals || audioWorking || (officialAudio.status === 'other' && !canForceAudioTakeover)}
          aria-pressed={audioArmed}
          aria-label={audioLabel}
          title={audioLabel}
        >
          {audioArmed || audioTestedRaceId === officialAudio.raceId ? <Volume2 size={18} /> : <VolumeX size={18} />}
          <span>{audioWorking ? '設定中…' : audioLabel}</span>
        </button>
        {officialAudio.status === 'mine' && (
          <button type="button" className="audio-release-button" onClick={() => void releaseAudio()} disabled={audioWorking} title="公式音響端末を解除" aria-label="公式音響端末を解除"><VolumeX size={17} /></button>
        )}
        {clearDefinition ? (
          <button type="button" className="resume-button" onClick={() => openSignalDialog(clearDefinition.action)} disabled={!canControlSignals} aria-label={clearDefinition.label} title={clearDefinition.label}>
            <RotateCcw size={18} /><span>{clearDefinition.flag}</span>
          </button>
        ) : latestSignal?.action === 'individual-recall' ? (
          <button type="button" className="resume-button" onClick={() => openSignalDialog('individual-recall-clear')} disabled={!canControlSignals} aria-label="個別リコール終了・X旗降下" title="個別リコール終了・X旗降下">
            <RotateCcw size={18} /><span>X旗降下</span>
          </button>
        ) : (
          <button type="button" className="postpone-button" onClick={() => openSignalDialog('postpone')} disabled={!canControlSignals} aria-label="レース信号を選択" title="レース信号を選択">
            {audioArmed ? <BellOff size={18} /> : <Bell size={18} />}<span>レース信号</span>
          </button>
        )}
      </div>

      {dialogAction && createPortal(
        <div className="signal-dialog-backdrop" role="presentation" onMouseDown={() => setDialogAction(undefined)}>
          <div className="signal-dialog" role="dialog" aria-modal="true" aria-labelledby="signal-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div><span className="eyebrow">公式信号</span><strong id="signal-dialog-title">レース委員会の信号を確認</strong></div>
              <button type="button" onClick={() => setDialogAction(undefined)} aria-label="閉じる"><X size={20} /></button>
            </header>

            {!['resume', 'general-recall-clear', 'abandon-clear', 'individual-recall-clear'].includes(dialogAction) && (
              <div className="signal-action-grid" aria-label="信号種別">
                {CONTROL_ACTIONS.map((action) => {
                  const definition = signalDefinition(action)
                  const unavailable = (action === 'course-change' && !canChangeCourse) ||
                    (['course-change', 'mark-missing'].includes(action) && raceStatus !== 'racing')
                  return (
                    <button type="button" className={dialogAction === action ? 'is-selected' : ''} onClick={() => openSignalDialog(action)} disabled={unavailable} title={unavailable ? action === 'course-change' && !canChangeCourse ? 'C旗はPRO・RO・大会管理者が実行します' : 'スタート後のレースで使用します' : undefined} key={action}>
                      {action === 'shorten' ? <Scissors size={19} /> : action.includes('recall') || action === 'course-change' ? <RotateCcw size={19} /> : action === 'mark-missing' ? <Flag size={19} /> : <AlertTriangle size={19} />}
                      <span><strong>{definition.label}</strong><small>{definition.flag}・{definition.sound}</small></span>
                    </button>
                  )
                })}
              </div>
            )}

            {dialogAction === 'postpone' || dialogAction === 'postpone-h' || dialogAction === 'postpone-a' ? (
              <label className="signal-dialog__field"><span>延期信号</span><select value={dialogAction} onChange={(event) => openSignalDialog(event.target.value as RaceSignalAction)}><option value="postpone">AP・海上で再開可能</option><option value="postpone-h">AP over H・次の信号は陸上</option><option value="postpone-a">AP over A・本日これ以上なし</option></select></label>
            ) : null}
            {dialogAction === 'abandon' || dialogAction === 'abandon-h' || dialogAction === 'abandon-a' ? (
              <label className="signal-dialog__field"><span>中止信号</span><select value={dialogAction} onChange={(event) => openSignalDialog(event.target.value as RaceSignalAction)}><option value="abandon">N・スタート海面へ戻る</option><option value="abandon-h">N over H・次の信号は陸上</option><option value="abandon-a">N over A・本日これ以上なし</option></select></label>
            ) : null}
            {dialogAction === 'individual-recall' && <label className="signal-dialog__field"><span>対象艇（任意・未特定でも実行可）</span><input value={targetSailNumbers} onChange={(event) => setTargetSailNumbers(event.target.value)} maxLength={200} placeholder="例: JPN 1234, JPN 5678" /></label>}
            {dialogAction === 'shorten' && <label className="signal-dialog__field"><span>短縮フィニッシュ位置</span><select value={finishAt} onChange={(event) => setFinishAt(event.target.value)}>{marks.map((mark) => <option value={mark.label} key={mark.id}>{mark.label}</option>)}</select></label>}
            {dialogAction === 'course-change' && (
              <div className="signal-course-fields">
                <label className="signal-dialog__field"><span>変更を知らせる回航点・ゲート</span><select value={changeFromMarkId} onChange={(event) => setChangeFromMarkId(event.target.value)}>{marks.map((mark) => <option value={mark.id} key={mark.id}>{mark.label}</option>)}</select></label>
                <label className="signal-dialog__field"><span>位置を変更する次のマーク／フィニッシュ</span><select value={targetMarkId} onChange={(event) => setTargetMarkId(event.target.value)}>{marks.map((mark) => <option value={mark.id} key={mark.id}>{mark.label}</option>)}</select></label>
                <label className="signal-dialog__field"><span>新方位（任意・0〜359°）</span><input type="number" min="0" max="359" step="1" value={newBearing} onChange={(event) => setNewBearing(event.target.value)} placeholder="例: 015" /></label>
                <label className="signal-dialog__field"><span>左右変更（任意）</span><select value={directionChange} onChange={(event) => setDirectionChange(event.target.value as typeof directionChange)}><option value="">表示なし</option><option value="starboard">緑三角・右へ</option><option value="port">赤長方形・左へ</option></select></label>
                <label className="signal-dialog__field"><span>距離変更（任意）</span><select value={lengthChange} onChange={(event) => setLengthChange(event.target.value as typeof lengthChange)}><option value="">表示なし</option><option value="increase">＋ 延長</option><option value="decrease">− 短縮</option></select></label>
              </div>
            )}
            {dialogAction === 'mark-missing' && (
              <div className="signal-course-fields">
                <label className="signal-dialog__field"><span>欠損・位置ずれしたマーク</span><select value={targetMarkId} onChange={(event) => setTargetMarkId(event.target.value)}>{marks.map((mark) => <option value={mark.id} key={mark.id}>{mark.label}</option>)}</select></label>
                <label className="signal-dialog__field"><span>M旗を掲げる代替物</span><input value={replacementObject} onChange={(event) => setReplacementObject(event.target.value)} maxLength={200} /></label>
              </div>
            )}
            {dialogAction === 'search-rescue' && (
              <div className="signal-safety-fields">
                <label className="signal-dialog__field"><span>聴取するレース委員会通信</span><input value={communicationChannel} onChange={(event) => setCommunicationChannel(event.target.value)} maxLength={80} placeholder="例: VHF 72" /></label>
                <label className="signal-dialog__field"><span>捜索救助指示</span><textarea value={safetyInstructions} onChange={(event) => setSafetyInstructions(event.target.value)} maxLength={500} rows={3} /></label>
              </div>
            )}
            <label className="signal-dialog__field"><span>決定理由（監査ログに保存）</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} /></label>

            <div className="signal-confirmation">
              <Flag size={22} />
              <div><strong>{signalFlagDescription(dialogAction, { newBearing: newBearing === '' ? undefined : Number(newBearing), directionChange: directionChange || undefined, lengthChange: lengthChange || undefined, targetMarkLabel: marks.find((mark) => mark.id === targetMarkId)?.label, communicationChannel: communicationChannel.trim() || undefined })}</strong><small>{signalDefinition(dialogAction).sound}{['resume', 'general-recall-clear', 'abandon-clear'].includes(dialogAction) ? '・降下1分後に予告信号' : ['course-change', 'mark-missing'].includes(dialogAction) ? '・全艇が次のレグ開始前に反復して知らせます' : ''}</small></div>
            </div>
            {!audioArmed && <p className="signal-audio-warning"><AlertTriangle size={15} />この端末は公式音響ONではありません。記録は共有され、音はONの公式端末で実行されます。</p>}
            <footer>
              <button type="button" className="secondary-button" onClick={() => setDialogAction(undefined)}>戻る</button>
              <button type="button" className="signal-execute-button" onClick={executeControlSignal} disabled={!canExecuteControlSignal || dialogAction === 'shorten' && !finishAt}>
                <Bell size={17} /> 旗・音響を実行して記録
              </button>
            </footer>
          </div>
        </div>,
        document.body,
      )}
    </section>
  )
}
