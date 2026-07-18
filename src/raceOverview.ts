import type { RaceDefinition } from './domain.js'
import { isRaceSignalHeld } from './signals.js'

export type RaceOverviewTone = 'normal' | 'scheduled' | 'live' | 'held' | 'complete'

export interface RaceTabOverview {
  shortLabel: string
  description: string
  tone: RaceOverviewTone
  needsAttention: boolean
}

function clock(time: number): string {
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time))
}

function countdown(milliseconds: number): string {
  const totalSeconds = Math.ceil(Math.abs(milliseconds) / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${milliseconds < 0 ? '+' : '−'}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function raceTabOverview(race: RaceDefinition, now: number): RaceTabOverview {
  if (isRaceSignalHeld(race.latestSignal)) {
    return { shortLabel: 'HOLD', description: `${race.number}は${race.latestSignal?.label ?? '運営判断'}で保留中`, tone: 'held', needsAttention: true }
  }
  if (race.status === 'racing') {
    return { shortLabel: '競技中', description: `${race.number}は競技中`, tone: 'live', needsAttention: true }
  }
  if (race.status === 'provisional') {
    return { shortLabel: '暫定', description: `${race.number}は暫定完了`, tone: 'live', needsAttention: true }
  }
  if (race.status === 'finalized') {
    return { shortLabel: '確定', description: `${race.number}は確定済み`, tone: 'complete', needsAttention: false }
  }

  const warningTime = Date.parse(race.warningAt)
  if (!Number.isFinite(warningTime)) {
    return { shortLabel: '時刻未定', description: `${race.number}の予告時刻は未設定`, tone: 'normal', needsAttention: false }
  }
  const startTime = warningTime + 300_000
  const untilStart = startTime - now
  if (race.status === 'start-sequence' || untilStart <= 30 * 60_000) {
    return {
      shortLabel: countdown(untilStart),
      description: `${race.number}・スタート${untilStart < 0 ? '予定から' : 'まで'}${countdown(untilStart)}・予告 ${clock(warningTime)}`,
      tone: untilStart < 0 ? 'held' : 'scheduled',
      needsAttention: true,
    }
  }
  return {
    shortLabel: `予告 ${clock(warningTime)}`,
    description: `${race.number}・予告予定 ${clock(warningTime)}`,
    tone: 'normal',
    needsAttention: false,
  }
}
