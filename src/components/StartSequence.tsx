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
import type { OfficialAudioState } from '../audioDeviceClient'

interface StartSequenceProps {
  warningAt: string
  postponed: boolean
  serverOffsetMs: number
  canControlSignals: boolean
  preparatoryFlag: string
  officialAudio: OfficialAudioState
  canForceAudioTakeover: boolean
  onClaimOfficialAudio: (force?: boolean) => Promise<void>
  onReleaseOfficialAudio: () => Promise<void>
  onPostpone: () => void
  onResume: () => void
  onSignalExecuted: (signal: { action: string; label: string; flag: string; sound: string; executedAt: string }) => void
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

export function StartSequence({
  warningAt,
  postponed,
  serverOffsetMs,
  canControlSignals,
  preparatoryFlag,
  officialAudio,
  canForceAudioTakeover,
  onClaimOfficialAudio,
  onReleaseOfficialAudio,
  onPostpone,
  onResume,
  onSignalExecuted,
}: StartSequenceProps) {
  const [now, setNow] = useState(() => new Date(warningAt).getTime())
  const [armedRaceId, setArmedRaceId] = useState<string>()
  const [audioTestedRaceId, setAudioTestedRaceId] = useState<string>()
  const [audioWorking, setAudioWorking] = useState(false)
  const [audioError, setAudioError] = useState<string>()
  const playedRef = useRef(new Set<number>())
  const audioArmed = armedRaceId === officialAudio.raceId && officialAudio.status === 'mine'

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now() + serverOffsetMs), 250)
    return () => window.clearInterval(interval)
  }, [serverOffsetMs])

  useEffect(() => {
    playedRef.current.clear()
  }, [warningAt])

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
    onSignalExecuted({
      action: stage.offsetSeconds === 300 ? 'warning' : stage.offsetSeconds === 240 ? 'preparatory' : stage.offsetSeconds === 60 ? 'one-minute' : 'start',
      label: stage.label,
      flag: stage.offsetSeconds === 240 ? preparatoryFlag : stage.flag,
      sound: stage.sound,
      executedAt: new Date(Date.now() + serverOffsetMs).toISOString(),
    })
  }, [audioArmed, onSignalExecuted, postponed, preparatoryFlag, remainingSeconds, serverOffsetMs])

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
      } catch (reason) {
        setAudioError(reason instanceof Error ? reason.message : '公式音響を引き継げません')
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
      } catch (reason) {
        setAudioError(reason instanceof Error ? reason.message : '公式音響端末に設定できません')
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
    } catch (reason) {
      setAudioError(reason instanceof Error ? reason.message : '公式音響端末を解除できません')
    } finally {
      setAudioWorking(false)
    }
  }

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

  return (
    <section className={`start-sequence ${postponed ? 'is-postponed' : ''}`} aria-label="スタートシーケンス">
      <div className="start-sequence__clock">
        <span className="eyebrow">{postponed ? 'AP・延期中' : `次: ${activeStage.label}`}</span>
        <strong>{postponed ? 'HOLD' : formatCountdown(remainingSeconds)}</strong>
      </div>
      <div className="start-sequence__signal">
        {postponed ? <CirclePause size={19} /> : <Flag size={19} />}
        <div>
          <strong>{postponed ? 'シグナルボートの再設定待ち' : activeStage.offsetSeconds === 240 ? preparatoryFlag : activeStage.flag}</strong>
          <small>{postponed ? '未実行音は取り消されています' : `${activeStage.sound}・${audioStatus}`}</small>
        </div>
      </div>
      <div className="start-sequence__actions">
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
        {postponed ? (
          <button type="button" className="resume-button" onClick={onResume} disabled={!canControlSignals}>
            <RotateCcw size={18} /><span>予告を再設定</span>
          </button>
        ) : (
          <button type="button" className="postpone-button" onClick={onPostpone} disabled={!canControlSignals}>
            {audioArmed ? <BellOff size={18} /> : <Bell size={18} />}<span>延期</span>
          </button>
        )}
      </div>
    </section>
  )
}
