import {
  Bell,
  BellOff,
  CirclePause,
  Flag,
  RotateCcw,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface StartSequenceProps {
  warningAt: string
  postponed: boolean
  onPostpone: () => void
  onResume: () => void
}

interface SignalStage {
  offsetSeconds: number
  label: string
  flag: string
  sound: '短音1回' | '長音1回'
}

const SIGNAL_STAGES: readonly SignalStage[] = [
  { offsetSeconds: 300, label: '予告信号', flag: 'クラス旗 掲揚', sound: '短音1回' },
  { offsetSeconds: 240, label: '準備信号', flag: 'P / I / Z / U / 黒旗', sound: '短音1回' },
  { offsetSeconds: 60, label: '1分信号', flag: '準備旗 降下', sound: '長音1回' },
  { offsetSeconds: 0, label: 'スタート', flag: 'クラス旗 降下', sound: '短音1回' },
] as const

function formatCountdown(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? '+' : '−'
  const absolute = Math.abs(totalSeconds)
  const minutes = Math.floor(absolute / 60)
  const seconds = absolute % 60
  return `${sign}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
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

export function StartSequence({ warningAt, postponed, onPostpone, onResume }: StartSequenceProps) {
  const [now, setNow] = useState(() => new Date(warningAt).getTime())
  const [audioArmed, setAudioArmed] = useState(false)
  const playedRef = useRef(new Set<number>())

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(interval)
  }, [])

  const startAt = new Date(warningAt).getTime() + 300_000
  const remainingSeconds = Math.ceil((startAt - now) / 1_000)
  const activeStage = SIGNAL_STAGES.find((stage, index) => {
    const next = SIGNAL_STAGES[index + 1]
    return remainingSeconds <= stage.offsetSeconds && (!next || remainingSeconds > next.offsetSeconds)
  }) ?? SIGNAL_STAGES[0]

  useEffect(() => {
    if (!audioArmed || postponed) return
    const stage = SIGNAL_STAGES.find((item) => item.offsetSeconds === remainingSeconds)
    if (!stage || playedRef.current.has(stage.offsetSeconds)) return
    playedRef.current.add(stage.offsetSeconds)
    playSignal(stage.sound === '長音1回')
  }, [audioArmed, postponed, remainingSeconds])

  const toggleAudio = () => {
    if (!audioArmed) playSignal(false)
    setAudioArmed((current) => !current)
  }

  return (
    <section className={`start-sequence ${postponed ? 'is-postponed' : ''}`} aria-label="スタートシーケンス">
      <div className="start-sequence__clock">
        <span className="eyebrow">{postponed ? 'AP・延期中' : `次: ${activeStage.label}`}</span>
        <strong>{postponed ? 'HOLD' : formatCountdown(remainingSeconds)}</strong>
      </div>
      <div className="start-sequence__signal">
        {postponed ? <CirclePause size={19} /> : <Flag size={19} />}
        <div>
          <strong>{postponed ? 'シグナルボートの再設定待ち' : activeStage.flag}</strong>
          <small>{postponed ? '未実行音は取り消されています' : `${activeStage.sound}・端末時刻同期済み`}</small>
        </div>
      </div>
      <div className="start-sequence__actions">
        <button
          type="button"
          className={`audio-button ${audioArmed ? 'is-armed' : ''}`}
          onClick={toggleAudio}
          aria-pressed={audioArmed}
        >
          {audioArmed ? <Volume2 size={18} /> : <VolumeX size={18} />}
          <span>{audioArmed ? '公式音響ON' : '音響を準備'}</span>
        </button>
        {postponed ? (
          <button type="button" className="resume-button" onClick={onResume}>
            <RotateCcw size={18} /><span>予告を再設定</span>
          </button>
        ) : (
          <button type="button" className="postpone-button" onClick={onPostpone}>
            {audioArmed ? <BellOff size={18} /> : <Bell size={18} />}<span>延期</span>
          </button>
        )}
      </div>
    </section>
  )
}
