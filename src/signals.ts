import type { RaceSignalAction, RaceSignalEvent } from './domain.js'

export interface SignalDefinition {
  action: RaceSignalAction
  label: string
  flag: string
  sound: string
  soundCount: number
  group: 'sequence' | 'postponement' | 'recall' | 'course' | 'safety' | 'abandonment'
}

export const SIGNAL_DEFINITIONS: Record<RaceSignalAction, SignalDefinition> = {
  warning: { action: 'warning', label: '予告信号', flag: 'クラス旗 掲揚', sound: '短音1回', soundCount: 1, group: 'sequence' },
  preparatory: { action: 'preparatory', label: '準備信号', flag: '準備旗 掲揚', sound: '短音1回', soundCount: 1, group: 'sequence' },
  'one-minute': { action: 'one-minute', label: '1分信号', flag: '準備旗 降下', sound: '長音1回', soundCount: 1, group: 'sequence' },
  start: { action: 'start', label: 'スタート信号', flag: 'クラス旗 降下', sound: '短音1回', soundCount: 1, group: 'sequence' },
  postpone: { action: 'postpone', label: '延期', flag: 'AP旗 掲揚', sound: '短音2回', soundCount: 2, group: 'postponement' },
  'postpone-h': { action: 'postpone-h', label: '延期・陸上で次の信号', flag: 'AP旗 over H旗 掲揚', sound: '短音2回', soundCount: 2, group: 'postponement' },
  'postpone-a': { action: 'postpone-a', label: '延期・本日これ以上なし', flag: 'AP旗 over A旗 掲揚', sound: '短音2回', soundCount: 2, group: 'postponement' },
  resume: { action: 'resume', label: '延期解除・再予告設定', flag: 'AP旗 降下', sound: '短音1回', soundCount: 1, group: 'postponement' },
  'individual-recall': { action: 'individual-recall', label: '個別リコール', flag: 'X旗 掲揚', sound: '短音1回', soundCount: 1, group: 'recall' },
  'individual-recall-clear': { action: 'individual-recall-clear', label: '個別リコール終了', flag: 'X旗 降下', sound: '音響なし', soundCount: 0, group: 'recall' },
  'general-recall': { action: 'general-recall', label: 'ゼネラルリコール', flag: '第一代表旗 掲揚', sound: '短音2回', soundCount: 2, group: 'recall' },
  'general-recall-clear': { action: 'general-recall-clear', label: '第一代表旗降下・再予告設定', flag: '第一代表旗 降下', sound: '短音1回', soundCount: 1, group: 'recall' },
  shorten: { action: 'shorten', label: 'コース短縮', flag: 'S旗 掲揚', sound: '短音2回', soundCount: 2, group: 'course' },
  'course-change': { action: 'course-change', label: '次のレグを変更', flag: 'C旗 掲揚', sound: '反復短音（6声/1サイクル）', soundCount: 6, group: 'course' },
  'mark-missing': { action: 'mark-missing', label: '欠損マークを代替', flag: 'M旗 掲揚', sound: '反復短音（6声/1サイクル）', soundCount: 6, group: 'course' },
  'search-rescue': { action: 'search-rescue', label: '捜索救助通信', flag: 'V旗 掲揚', sound: '短音1回', soundCount: 1, group: 'safety' },
  abandon: { action: 'abandon', label: 'レース中止・スタート海面へ帰着', flag: 'N旗 掲揚', sound: '短音3回', soundCount: 3, group: 'abandonment' },
  'abandon-h': { action: 'abandon-h', label: 'レース中止・陸上で次の信号', flag: 'N旗 over H旗 掲揚', sound: '短音3回', soundCount: 3, group: 'abandonment' },
  'abandon-a': { action: 'abandon-a', label: 'レース中止・本日これ以上なし', flag: 'N旗 over A旗 掲揚', sound: '短音3回', soundCount: 3, group: 'abandonment' },
  'abandon-clear': { action: 'abandon-clear', label: 'N旗降下・再予告設定', flag: 'N旗 降下', sound: '短音1回', soundCount: 1, group: 'abandonment' },
}

const HELD_ACTIONS = new Set<RaceSignalAction>([
  'postpone', 'postpone-h', 'postpone-a', 'general-recall', 'abandon', 'abandon-h', 'abandon-a',
])

const TERMINAL_ACTIONS = new Set<RaceSignalAction>(['postpone-h', 'postpone-a', 'abandon-h', 'abandon-a'])

export function signalDefinition(action: RaceSignalAction): SignalDefinition {
  return SIGNAL_DEFINITIONS[action]
}

export function isRaceSignalHeld(signal?: RaceSignalEvent): boolean {
  return signal ? HELD_ACTIONS.has(signal.action) : false
}

export function isTerminalRaceSignal(signal?: RaceSignalEvent): boolean {
  return signal ? TERMINAL_ACTIONS.has(signal.action) : false
}

export function canClearRaceSignal(signal?: RaceSignalEvent): boolean {
  return signal?.action === 'postpone' || signal?.action === 'general-recall' || signal?.action === 'abandon'
}

export function clearActionFor(signal: RaceSignalEvent): RaceSignalAction {
  if (signal.action === 'general-recall') return 'general-recall-clear'
  if (signal.action === 'abandon') return 'abandon-clear'
  return 'resume'
}

export function nextWarningAfterFlagRemoval(removalTime: string): string {
  const parsed = Date.parse(removalTime)
  if (!Number.isFinite(parsed)) throw new Error('旗降下時刻が不正です')
  return new Date(parsed + 60_000).toISOString()
}

export function signalFlagDescription(
  action: RaceSignalAction,
  details: Pick<RaceSignalEvent, 'newBearing' | 'directionChange' | 'lengthChange' | 'targetMarkLabel' | 'communicationChannel'>,
): string {
  if (action === 'course-change') {
    const changes = [
      typeof details.newBearing === 'number' ? `新方位 ${String(Math.round(details.newBearing)).padStart(3, '0')}°T` : null,
      details.directionChange === 'starboard' ? '緑三角・右へ変更' : details.directionChange === 'port' ? '赤長方形・左へ変更' : null,
      details.lengthChange === 'increase' ? '距離 +' : details.lengthChange === 'decrease' ? '距離 −' : null,
    ].filter(Boolean)
    return `C旗 掲揚${changes.length ? `・${changes.join('・')}` : ''}`
  }
  if (action === 'mark-missing') {
    return `M旗 掲揚${details.targetMarkLabel ? `・${details.targetMarkLabel}を代替` : ''}`
  }
  if (action === 'search-rescue') {
    return `V旗 掲揚${details.communicationChannel ? `・${details.communicationChannel}を聴取` : ''}`
  }
  return signalDefinition(action).flag
}

export function makeRaceSignalEvent(
  id: string,
  action: RaceSignalAction,
  executedAt: string,
  details: Partial<Omit<RaceSignalEvent, 'id' | 'action' | 'executedAt'>> = {},
): RaceSignalEvent {
  const definition = signalDefinition(action)
  return {
    id,
    action,
    label: details.label ?? definition.label,
    flag: details.flag ?? definition.flag,
    sound: details.sound ?? definition.sound,
    soundCount: details.soundCount ?? definition.soundCount,
    executedAt,
    scheduledAt: details.scheduledAt,
    visualExecutedAt: details.visualExecutedAt ?? executedAt,
    soundExecutedAt: details.soundExecutedAt,
    soundStatus: details.soundStatus ?? 'legacy',
    officialAudioDeviceId: details.officialAudioDeviceId,
    warningAt: details.warningAt,
    reason: details.reason,
    targetSailNumbers: details.targetSailNumbers,
    finishAt: details.finishAt,
    changeFromMarkId: details.changeFromMarkId,
    changeFromMarkLabel: details.changeFromMarkLabel,
    targetMarkId: details.targetMarkId,
    targetMarkLabel: details.targetMarkLabel,
    newBearing: details.newBearing,
    directionChange: details.directionChange,
    lengthChange: details.lengthChange,
    replacementObject: details.replacementObject,
    communicationChannel: details.communicationChannel,
    safetyInstructions: details.safetyInstructions,
    actor: details.actor,
  }
}
