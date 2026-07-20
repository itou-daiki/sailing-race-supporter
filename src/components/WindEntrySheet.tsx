import { CheckCircle2, CloudOff, Gauge, LocateFixed, Navigation, Wind, X } from 'lucide-react'
import { useState } from 'react'
import { formatTrueBearing } from '../../shared/trueBearing'
import type { CommitteeBoat, CourseMark, WindObservation } from '../domain'
import { formatWindSpeedDual, knotsToMetresPerSecond } from '../markWind'

export interface MarkWindInput {
  markId?: string
  directionDegrees: number
  speedKnots: number
  gustKnots: number
  averagingSeconds: number
  confidence: NonNullable<WindObservation['confidence']>
}

export interface MarkWindSaveResult {
  state: 'shared' | 'queued'
  observedAt: string
  targetLabel: string
}

interface WindEntrySheetProps {
  raceNumber: string
  marks: readonly CourseMark[]
  ownMarkId?: string
  defaultMarkId?: string
  canChooseMark: boolean
  allowOverallWind: boolean
  initialWind: WindObservation
  selfBoat?: CommitteeBoat
  realtimeLive: boolean
  onClose: () => void
  onSubmit: (input: MarkWindInput) => Promise<MarkWindSaveResult>
}

function adjustedDirection(value: string, delta: number): string {
  const current = Number(value)
  if (!Number.isFinite(current)) return '0'
  return String(((Math.round(current) + delta) % 360 + 360) % 360)
}

function targetLabel(marks: readonly CourseMark[], markId: string, ownMarkId?: string): string {
  const mark = marks.find((candidate) => candidate.id === markId)
  if (!mark) return '本部船・全体風'
  return `${mark.label}${mark.id === ownMarkId ? '（自分）' : ''}`
}

export function WindEntrySheet({
  raceNumber,
  marks,
  ownMarkId,
  defaultMarkId,
  canChooseMark,
  allowOverallWind,
  initialWind,
  selfBoat,
  realtimeLive,
  onClose,
  onSubmit,
}: WindEntrySheetProps) {
  const [markId, setMarkId] = useState(defaultMarkId ?? '')
  const [direction, setDirection] = useState(String(Math.round(initialWind.directionDegrees)))
  const [speed, setSpeed] = useState(initialWind.speedKnots.toFixed(1))
  const [gust, setGust] = useState(Math.max(initialWind.speedKnots, initialWind.gustKnots).toFixed(1))
  const [averagingSeconds, setAveragingSeconds] = useState(60)
  const [confidence, setConfidence] = useState<NonNullable<WindObservation['confidence']>>('medium')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState<MarkWindSaveResult>()
  const directionValue = Number(direction)
  const speedValue = Number(speed)
  const gustValue = Number(gust)
  const selectedTargetLabel = targetLabel(marks, markId, ownMarkId)
  const valid = Number.isFinite(directionValue)
    && directionValue >= 0 && directionValue < 360
    && Number.isFinite(speedValue) && speedValue >= 0 && speedValue <= 60
    && Number.isFinite(gustValue) && gustValue >= speedValue && gustValue <= 80
    && (allowOverallWind || Boolean(markId))

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid || working) return
    setWorking(true)
    setError(undefined)
    setSaved(undefined)
    try {
      setSaved(await onSubmit({
        markId: markId || undefined,
        directionDegrees: directionValue,
        speedKnots: speedValue,
        gustKnots: gustValue,
        averagingSeconds,
        confidence,
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '風向・風速を共有できませんでした')
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="drawer-backdrop drawer-backdrop--map-visible wind-entry-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="wind-entry-sheet" role="dialog" aria-modal="true" aria-labelledby="wind-entry-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={submit}>
        <header>
          <div>
            <span className="eyebrow"><Wind size={14} /> {raceNumber}・海上観測</span>
            <strong id="wind-entry-title">担当地点の風を記録</strong>
          </div>
          <button type="button" onClick={onClose} aria-label="風観測入力を閉じる"><X size={20} /></button>
        </header>

        <div className="wind-entry-scroll">
          <section className="wind-target-card">
            <span><Navigation size={19} /></span>
            <div><small>今回記録する場所</small><strong>{selectedTargetLabel}</strong></div>
            {ownMarkId && markId === ownMarkId && <b>担当</b>}
          </section>

          {canChooseMark && (
            <label className="wind-entry-field">
              <span>観測対象</span>
              <select value={markId} onChange={(event) => { setMarkId(event.target.value); setSaved(undefined) }}>
                {allowOverallWind && <option value="">本部船・全体風</option>}
                {marks.map((mark) => <option key={mark.id} value={mark.id}>{targetLabel(marks, mark.id, ownMarkId)}</option>)}
              </select>
            </label>
          )}

          {!canChooseMark && !markId && (
            <div className="wind-entry-warning" role="alert">担当マークが未設定です。大会管理者に担当を設定してもらってください。</div>
          )}

          <section className="wind-entry-measurements">
            <label className="wind-entry-field wind-direction-field">
              <span>風向 <small>風が吹いてくる方向・真方位</small></span>
              <div className="wind-number-input"><input type="number" inputMode="numeric" min="0" max="359" step="1" value={direction} onChange={(event) => { setDirection(event.target.value); setSaved(undefined) }} /><b>°T</b></div>
              <strong>{Number.isFinite(directionValue) ? formatTrueBearing(directionValue) : '—'}</strong>
              <div className="wind-adjust-buttons" aria-label="風向の微調整">
                {[-10, -1, 1, 10].map((delta) => <button type="button" key={delta} onClick={() => { setDirection(adjustedDirection(direction, delta)); setSaved(undefined) }}>{delta > 0 ? `+${delta}` : delta}°</button>)}
              </div>
            </label>

            <label className="wind-entry-field">
              <span>平均風速 <small>計器のkt値を入力</small></span>
              <div className="wind-number-input"><input type="number" inputMode="decimal" min="0" max="60" step="0.1" value={speed} onChange={(event) => { setSpeed(event.target.value); setSaved(undefined) }} /><b>kt</b></div>
              <strong>{Number.isFinite(speedValue) ? `${knotsToMetresPerSecond(speedValue).toFixed(1)} m/s` : '— m/s'}</strong>
            </label>

            <label className="wind-entry-field">
              <span>最大風速（ガスト）</span>
              <div className="wind-number-input"><input type="number" inputMode="decimal" min="0" max="80" step="0.1" value={gust} onChange={(event) => { setGust(event.target.value); setSaved(undefined) }} /><b>kt</b></div>
              <strong>{Number.isFinite(gustValue) ? `${knotsToMetresPerSecond(gustValue).toFixed(1)} m/s` : '— m/s'}</strong>
            </label>
          </section>

          <div className="wind-entry-options">
            <label><span>平均時間</span><select value={averagingSeconds} onChange={(event) => setAveragingSeconds(Number(event.target.value))}><option value={10}>10秒</option><option value={60}>1分</option><option value={300}>5分</option></select></label>
            <label><span>測定方法</span><select value={confidence} onChange={(event) => setConfidence(event.target.value as NonNullable<WindObservation['confidence']>)}><option value="high">機器で測定</option><option value="medium">複数回確認</option><option value="low">目測・概算</option></select></label>
          </div>

          <div className={`wind-location-status ${selfBoat ? 'has-location' : ''}`}>
            {selfBoat ? <>
              <LocateFixed size={17} />
              <span><strong>運営ボートの現在地も記録</strong><small>{selfBoat.accuracyMetres === undefined ? 'GPS精度不明' : `GPS精度 ±${Math.round(selfBoat.accuracyMetres)}m`}・{selfBoat.name}</small></span>
            </> : <>
              <CloudOff size={17} />
              <span><strong>位置なしで記録します</strong><small>地図の「位置共有」を開始すると観測地点も残せます</small></span>
            </>}
          </div>

          {!valid && markId && <div className="wind-entry-warning" role="alert">風向は0〜359°、平均風速は0〜60kt、ガストは平均風速以上で入力してください。</div>}
          {error && <div className="wind-entry-error" role="alert">{error}</div>}
          {saved && <div className={`wind-entry-saved is-${saved.state}`} role="status">
            {saved.state === 'shared' ? <CheckCircle2 size={20} /> : <CloudOff size={20} />}
            <span><strong>{saved.state === 'shared' ? `${saved.targetLabel}へ共有しました` : `${saved.targetLabel}の観測を端末へ保存しました`}</strong><small>{new Date(saved.observedAt).toLocaleTimeString('ja-JP')}・{formatTrueBearing(directionValue)}・{formatWindSpeedDual(speedValue)}{saved.state === 'queued' ? '・回線復帰後に自動送信' : ''}</small></span>
          </div>}
        </div>

        <footer>
          <span><Gauge size={16} /> {realtimeLive ? 'リアルタイム接続中' : 'オフライン保存対応'}</span>
          <button type="submit" disabled={!valid || working || (!allowOverallWind && !markId)}>{working ? '共有中…' : `${selectedTargetLabel}へ記録`}</button>
        </footer>
      </form>
    </div>
  )
}
