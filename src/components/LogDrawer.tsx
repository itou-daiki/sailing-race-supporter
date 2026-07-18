import { Download, FileJson2, RefreshCw, ScrollText, ShieldCheck, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { RaceDefinition } from '../domain'
import { downloadEventLog, loadEventLogs, type EventLogCategory, type EventLogEntry } from '../logClient'

interface LogDrawerProps {
  eventSlug: string
  eventName: string
  races: readonly RaceDefinition[]
  activeRaceId: string
  onClose: () => void
}

const categoryLabels: Record<EventLogCategory, string> = {
  audit: '監査', mark: 'マーク', wind: '風', signal: '信号', passage: '先頭通過',
  finish: 'フィニッシュ', task: 'タスク', message: '連絡', position: '運営ボート位置',
}

function displayTime(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(iso))
}

export function LogDrawer({ eventSlug, eventName, races, activeRaceId, onClose }: LogDrawerProps) {
  const [raceId, setRaceId] = useState<string | null>(activeRaceId)
  const [category, setCategory] = useState<EventLogCategory | 'all'>('all')
  const [entries, setEntries] = useState<EventLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [exporting, setExporting] = useState<'json' | 'csv'>()
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let active = true
    void loadEventLogs(eventSlug, raceId)
      .then((result) => { if (active) setEntries(result.entries) })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'ログを取得できません') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [eventSlug, raceId, refreshKey])

  const visibleEntries = useMemo(
    () => category === 'all' ? entries : entries.filter((entry) => entry.category === category),
    [category, entries],
  )

  const selectRace = (nextRaceId: string | null) => {
    setLoading(true)
    setError(undefined)
    setRaceId(nextRaceId)
  }

  const refresh = () => {
    setLoading(true)
    setError(undefined)
    setRefreshKey((current) => current + 1)
  }

  const exportLog = async (format: 'json' | 'csv') => {
    setExporting(format)
    setError(undefined)
    try {
      await downloadEventLog(eventSlug, raceId, format)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'ログを書き出せません')
    } finally {
      setExporting(undefined)
    }
  }

  return (
    <aside className="log-drawer" aria-label="大会ログ">
      <header>
        <div><span className="eyebrow">{eventName}</span><strong><ScrollText size={17} /> 運営ログ</strong></div>
        <button type="button" onClick={onClose} aria-label="閉じる"><X size={20} /></button>
      </header>
      <div className="log-controls">
        <div className="channel-tabs" aria-label="ログ対象">
          <button type="button" className={raceId === null ? 'is-active' : ''} onClick={() => selectRace(null)}>大会全体</button>
          {races.map((race) => (
            <button type="button" className={raceId === race.id ? 'is-active' : ''} onClick={() => selectRace(race.id)} key={race.id}>{race.number}</button>
          ))}
        </div>
        <div className="log-filter-row">
          <label><span>種別</span><select value={category} onChange={(event) => setCategory(event.target.value as EventLogCategory | 'all')}><option value="all">すべて</option>{Object.entries(categoryLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <button type="button" onClick={refresh} disabled={loading}><RefreshCw size={15} /> 更新</button>
        </div>
      </div>
      <div className="log-list" aria-live="polite">
        {loading && <div className="log-state"><RefreshCw className="spin" size={20} />ログを取得中…</div>}
        {!loading && error && <div className="log-state is-error">{error}</div>}
        {!loading && !error && visibleEntries.length === 0 && <div className="log-state">この条件の記録はまだありません</div>}
        {!loading && !error && visibleEntries.map((entry) => (
          <article className={`log-entry category-${entry.category}`} key={`${entry.category}:${entry.id}`}>
            <div className="log-entry__meta">
              <span>{categoryLabels[entry.category]}</span>
              <time>{displayTime(entry.occurredAt)}</time>
            </div>
            <strong>{entry.title}</strong>
            <p>{entry.detail || '詳細なし'}</p>
            <footer><span>{entry.actor}</span>{entry.sequence !== null && <span>監査 #{entry.sequence}</span>}{entry.eventHash && <span title={entry.eventHash}><ShieldCheck size={12} /> ハッシュ記録</span>}</footer>
          </article>
        ))}
      </div>
      <footer className="log-export">
        <div><strong>{visibleEntries.length}件を表示</strong><small>出力は最大2,500件・大会URL単位</small></div>
        <button type="button" onClick={() => void exportLog('json')} disabled={Boolean(exporting)}><FileJson2 size={16} /> {exporting === 'json' ? '作成中…' : 'JSON'}</button>
        <button type="button" onClick={() => void exportLog('csv')} disabled={Boolean(exporting)}><Download size={16} /> {exporting === 'csv' ? '作成中…' : 'CSV'}</button>
      </footer>
    </aside>
  )
}
