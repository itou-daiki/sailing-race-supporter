import { AlertTriangle, Check, FlagTriangleRight, Timer } from 'lucide-react'
import { useState } from 'react'
import type { FinishRecord, RaceDefinition } from '../domain'

interface FirstFinishPanelProps {
  race: RaceDefinition
  record?: FinishRecord
  canRecord: boolean
  canAdopt: boolean
  onRecord: (sailNumber?: string, note?: string) => void
  onAdopt: (observationId: string) => void
}

function finishTime(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
  }).format(new Date(iso))
}

export function FirstFinishPanel({ race, record, canRecord, canAdopt, onRecord, onAdopt }: FirstFinishPanelProps) {
  const [sailNumber, setSailNumber] = useState('')
  const [note, setNote] = useState('')
  const observations = record?.observations.filter((observation) => observation.status === 'active') ?? []
  const adopted = observations.find((observation) => observation.id === record?.adoptedObservationId)
  const raceAcceptsFinish = race.status === 'racing' || race.status === 'provisional' || race.status === 'finalized'
  const headline = adopted
    ? `先頭競技ヨット ${finishTime(adopted.finishedAt)}`
    : observations.length ? '採用時刻を選択してください'
    : race.status === 'finalized' ? '先頭フィニッシュ記録なし'
    : '先頭競技ヨットの時刻'

  return (
    <article className={`first-finish-card ${adopted ? 'is-adopted' : ''}`} aria-label="先頭フィニッシュ記録">
      <header>
        <div>
          <span className="eyebrow"><FlagTriangleRight size={14} /> フィニッシュ</span>
          <strong>{headline}</strong>
          <small>{adopted?.sailNumber ? `セール番号 ${adopted.sailNumber}` : adopted ? 'セール番号 未入力' : race.status === 'finalized' && !observations.length ? '確定スナップショットに採用記録がありません' : '目視した瞬間を記録・後から採用'}</small>
        </div>
        {adopted && <span className="first-finish-card__adopted"><Check size={14} /> 採用済</span>}
      </header>

      {canRecord && raceAcceptsFinish && (
        <div className="first-finish-entry">
          <label><span>セール番号（任意）</span><input value={sailNumber} onChange={(event) => setSailNumber(event.target.value)} maxLength={80} placeholder="例: JPN 1234" /></label>
          <label><span>メモ（任意）</span><input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="判定・録音参照など" /></label>
          <button type="button" onClick={() => {
            onRecord(sailNumber.trim() || undefined, note.trim() || undefined)
            setSailNumber('')
            setNote('')
          }}>
            <Timer size={19} /> {observations.length ? '別観測を追加' : '先頭フィニッシュを観測'}
          </button>
        </div>
      )}

      {record?.hasConflict && (
        <p className="first-finish-conflict"><AlertTriangle size={14} /> 観測差 {(record.spreadMilliseconds / 1_000).toFixed(1)}秒。自動平均せず採用時刻を選択してください。</p>
      )}

      {observations.length > 0 && (
        <div className="first-finish-observations" aria-label="先頭フィニッシュの観測候補">
          {observations.map((observation) => (
            <div className={observation.id === record?.adoptedObservationId ? 'is-adopted' : ''} key={observation.id}>
              <span>
                <strong>{finishTime(observation.finishedAt)}</strong>
                <small>{observation.recordedBy}{observation.sailNumber ? `・${observation.sailNumber}` : ''}{observation.wasOffline ? '・オフライン観測' : ''}</small>
              </span>
              {observation.id === record?.adoptedObservationId
                ? <b>採用済</b>
                : canAdopt && <button type="button" onClick={() => onAdopt(observation.id)}>この時刻を採用</button>}
            </div>
          ))}
        </div>
      )}

      {!raceAcceptsFinish && <p className="first-finish-guidance">レース開始後に観測ボタンが有効になります。</p>}
    </article>
  )
}
