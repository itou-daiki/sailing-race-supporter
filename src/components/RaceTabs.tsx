import { LockKeyhole, ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { OperationalMessage, RaceDefinition } from '../domain'
import { raceTabOverview } from '../raceOverview'

interface RaceTabsProps {
  races: readonly RaceDefinition[]
  activeRaceId: string
  serverOffsetMs: number
  messages: readonly OperationalMessage[]
  revisionDraftRaceIds?: readonly string[]
  onSelectRace: (raceId: string) => void
}

function hasUnconfirmedUrgentMessage(messages: readonly OperationalMessage[], raceId: string): boolean {
  return messages.some((message) => (
    message.raceId === raceId &&
    message.priority === 'urgent' &&
    (message.ownReceipt === 'unread' || message.acknowledgement === 'pending')
  ))
}

export function RaceTabs({ races, activeRaceId, serverOffsetMs, messages, revisionDraftRaceIds = [], onSelectRace }: RaceTabsProps) {
  const [now, setNow] = useState(() => Date.now() + serverOffsetMs)

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now() + serverOffsetMs), 1_000)
    return () => window.clearInterval(interval)
  }, [serverOffsetMs])

  return (
    <nav className="race-tabs" aria-label="レース切替">
      {races.map((race) => {
        const overview = raceTabOverview(race, now)
        const urgent = hasUnconfirmedUrgentMessage(messages, race.id)
        const correctionDraft = revisionDraftRaceIds.includes(race.id)
        return (
          <button
            type="button"
            className={`${activeRaceId === race.id ? 'is-active' : ''} tone-${overview.tone} ${overview.needsAttention || urgent ? 'needs-attention' : ''} ${urgent ? 'has-urgent' : ''} ${correctionDraft ? 'is-correction-draft' : ''}`}
            onClick={() => onSelectRace(race.id)}
            aria-current={activeRaceId === race.id ? 'page' : undefined}
            aria-label={`${race.number} ${race.className}${race.raceAreaName ? `・${race.raceAreaName}` : ''}・${overview.description}${correctionDraft ? '・管理者修正中' : ''}${urgent ? '・未確認の緊急連絡あり' : ''}`}
            title={`${race.className}${race.raceAreaName ? `・${race.raceAreaName}` : ''}・${overview.description}${correctionDraft ? '・管理者修正中' : ''}${urgent ? '・未確認の緊急連絡あり' : ''}`}
            key={race.id}
          >
            <span>{race.number}</span>
            <small>{race.className}{race.raceAreaName ? `・${race.raceAreaName}` : ''}</small>
            <em>{correctionDraft ? '管理者修正中' : `${overview.shortLabel}${race.status === 'finalized' && (race.finalizedRevision ?? 1) > 1 ? ` v${race.finalizedRevision}` : ''}`}</em>
            {race.status === 'finalized' && <LockKeyhole size={11} />}
            {urgent && <ShieldAlert className="race-tab__urgent" size={12} />}
          </button>
        )
      })}
    </nav>
  )
}
