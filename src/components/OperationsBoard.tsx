import {
  AlertTriangle,
  BellRing,
  Check,
  CircleDot,
  Clock3,
  HelpCircle,
  LockKeyhole,
  MapPin,
  Maximize2,
  MessageSquareText,
  Minus,
  MoreHorizontal,
  Plus,
  RadioTower,
  Route,
  ShieldAlert,
  ShipWheel,
  TimerReset,
  Users,
  Waves,
  Wind,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type {
  BoardDetail,
  CommitteeBoat,
  CourseMark,
  CurrentObservation,
  FinishRecord,
  OperationalMessage,
  OperationalTask,
  RaceDefinition,
  RaceSignalEvent,
  WindObservation,
} from '../domain'
import { signalDefinition } from '../signals'
import { FirstFinishPanel } from './FirstFinishPanel'
import type { FreeTierBudgetEstimate, RuntimeBudgetStatus } from '../../shared/freeTierBudget'
import type { LatestPassageSummary } from '../passages'
import { buildRaceTimeline, deriveRacePhases, type RacePhaseState } from '../racePhases'
import { formatTrueBearing } from '../../shared/trueBearing'
import { assignWindReadingsToMarks, formatWindSpeedDual } from '../markWind'
import { summarizeReadiness } from '../readiness'
import type { OperationMode } from '../../shared/operationModes'

interface OperationsBoardProps {
  race: RaceDefinition
  races: readonly RaceDefinition[]
  marks: readonly CourseMark[]
  boats: readonly CommitteeBoat[]
  tasks: readonly OperationalTask[]
  allTasks: readonly OperationalTask[]
  messages: readonly OperationalMessage[]
  wind: WindObservation
  markWinds: readonly WindObservation[]
  current: CurrentObservation
  freeTierBudget: FreeTierBudgetEstimate
  runtimeBudget?: RuntimeBudgetStatus
  scale: number
  detail: BoardDetail
  postponed: boolean
  locked: boolean
  socketStatus: 'connecting' | 'live' | 'offline'
  pendingCount: number
  memberCount: number
  operationMode: OperationMode
  latestSignal?: RaceSignalEvent
  firstFinish?: FinishRecord
  latestPassage?: LatestPassageSummary
  canRecordFinish: boolean
  canAdoptFinish: boolean
  onScaleChange: (scale: number) => void
  onDetailChange: (detail: BoardDetail) => void
  onSelectMark: (markId: string) => void
  onSelectRace: (raceId: string) => void
  onAcknowledgeMessage: (messageId: string) => void
  onOpenMessages: () => void
  onOpenTaskMessage: (task: OperationalTask) => void
  onTaskStatusChange: (taskId: string) => void
  onRecordFinish: (sailNumber?: string, note?: string) => void
  onAdoptFinish: (observationId: string) => void
}

const taskStatusLabel: Record<OperationalTask['status'], string> = {
  blocked: 'ブロッカー',
  waiting: '確認待ち',
  doing: '対応中',
  done: '完了',
}

const detailLabels: Record<BoardDetail, string> = {
  overview: 'かんたん',
  standard: '標準',
  detail: '詳細',
}

const phaseStateLabels: Record<RacePhaseState, string> = {
  'not-started': '未着手',
  'in-progress': '進行中',
  waiting: '確認待ち',
  completed: '完了',
  warning: '要注意',
  stopped: '停止',
}

const raceStatusLabels: Record<RaceDefinition['status'], string> = {
  planning: '計画中',
  setup: 'コース設営',
  'start-sequence': 'スタート手順',
  racing: 'レース中',
  provisional: '暫定記録',
  finalized: '確定済み',
}

function phaseStateIcon(state: RacePhaseState) {
  if (state === 'completed') return <Check size={13} />
  if (state === 'warning') return <AlertTriangle size={13} />
  if (state === 'stopped') return <TimerReset size={13} />
  if (state === 'in-progress') return <CircleDot size={13} />
  if (state === 'waiting') return <Clock3 size={13} />
  return <MoreHorizontal size={13} />
}

function operationTime(value: string | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '—'
  return new Intl.DateTimeFormat('ja-JP', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(value))
}

export function OperationsBoard({
  race,
  races,
  marks,
  boats,
  tasks,
  allTasks,
  messages,
  wind,
  markWinds,
  current,
  freeTierBudget,
  runtimeBudget,
  scale,
  detail,
  postponed,
  locked,
  socketStatus,
  pendingCount,
  memberCount,
  operationMode,
  latestSignal,
  firstFinish,
  latestPassage,
  canRecordFinish,
  canAdoptFinish,
  onScaleChange,
  onDetailChange,
  onSelectMark,
  onSelectRace,
  onAcknowledgeMessage,
  onOpenMessages,
  onOpenTaskMessage,
  onTaskStatusChange,
  onRecordFinish,
  onAdoptFinish,
}: OperationsBoardProps) {
  const isSolo = operationMode === 'solo'
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now())
  useEffect(() => {
    const interval = window.setInterval(() => setFreshnessNow(Date.now()), 15_000)
    return () => window.clearInterval(interval)
  }, [])
  const confirmedMarks = marks.filter((mark) => mark.status === 'confirmed').length
  const liveBoats = boats.filter((boat) => boat.status !== 'offline' && boat.freshnessSeconds <= 60).length
  const staleBoats = boats.filter((boat) => boat.status === 'offline' || boat.freshnessSeconds > 60)
  const readiness = summarizeReadiness(tasks)
  const orderedTasks = [...readiness.required, ...readiness.reference]
  const controlSignal = latestSignal && signalDefinition(latestSignal.action).group !== 'sequence' ? latestSignal : undefined
  const raceMessages = messages.filter((message) => !message.raceId || message.raceId === race.id)
  const unresolvedUrgent = raceMessages.filter((message) => (
    message.priority === 'urgent' && (message.ownReceipt === 'unread' || message.acknowledgement === 'pending')
  )).length
  const phaseContext = { race, marks, tasks, postponed, latestPassage, firstFinish }
  const phases = deriveRacePhases(phaseContext)
  const currentPhase = phases.find((phase) => phase.isCurrent) ?? phases[0]!
  const timelineEvents = buildRaceTimeline(phaseContext)
  const markWindReadings = assignWindReadingsToMarks(marks, markWinds)
  const freshMarkWindCount = [...markWindReadings.values()].filter((reading) => (
    freshnessNow - Date.parse(reading.observation.observedAt) <= 5 * 60_000
  )).length
  const windAgeSeconds = Math.max(0, Math.round((freshnessNow - Date.parse(wind.observedAt)) / 1_000))

  const setScale = (next: number) => onScaleChange(Math.min(200, Math.max(75, next)))

  return (
    <section
      className={`operations-board detail-${detail} ${isSolo ? 'mode-solo' : 'mode-team'}`}
      style={{ '--board-scale': `${scale / 100}` } as React.CSSProperties}
      aria-label="レース運用ボード"
    >
      <div className="board-toolbar">
        <div>
          <span className="eyebrow">運用ボード</span>
          <strong>{race.number}・{race.className}</strong>
        </div>
        <div className="board-toolbar__controls">
          <div className="segmented-control" aria-label="表示情報量">
            {(Object.keys(detailLabels) as BoardDetail[]).map((value) => (
              <button
                type="button"
                className={detail === value ? 'is-active' : ''}
                aria-pressed={detail === value}
                onClick={() => onDetailChange(value)}
                key={value}
              >
                {detailLabels[value]}
              </button>
            ))}
          </div>
          <div className="zoom-control" aria-label="運用ボード拡大縮小">
            <button type="button" onClick={() => setScale(scale - 25)} aria-label="縮小"><Minus size={15} /></button>
            <button type="button" className="zoom-value" onClick={() => setScale(100)}>{scale}%</button>
            <button type="button" onClick={() => setScale(scale + 25)} aria-label="拡大"><Plus size={15} /></button>
            <button type="button" className="zoom-fit" onClick={() => setScale(75)} aria-label="全体を表示"><Maximize2 size={15} /><span>全体</span></button>
          </div>
        </div>
      </div>

      <div className="board-scroll">
        <div className="status-banner-row">
          {postponed ? (
            <div className="status-banner status-banner--warning">
              <TimerReset size={18} />
              <div><strong>{controlSignal?.label ?? '信号により待機中'}</strong><small>{controlSignal?.flag ?? '未実行の信号音は取消済み'}{controlSignal?.reason ? `・${controlSignal.reason}` : ''}</small></div>
            </div>
          ) : controlSignal ? (
            <div className={`status-banner ${controlSignal.action.includes('recall') || controlSignal.action.startsWith('abandon') ? 'status-banner--warning' : 'status-banner--signal'}`}>
              <BellRing size={18} />
              <div><strong>{controlSignal.label}</strong><small>{controlSignal.flag}・{controlSignal.sound}{controlSignal.finishAt ? `・${controlSignal.finishAt}` : ''}</small></div>
            </div>
          ) : (
            <div className="status-banner status-banner--live">
              <RadioTower size={18} />
              <div><strong>{socketStatus === 'live' ? 'リアルタイム同期中' : socketStatus === 'connecting' ? '接続中' : 'オフライン継続中'}</strong><small>最新状態を端末に保存</small></div>
            </div>
          )}
          {locked && (
            <div className="status-banner status-banner--locked">
              <LockKeyhole size={18} />
              <div><strong>確定・編集ロック</strong><small>管理者のみ修正版を作成可能</small></div>
            </div>
          )}
          {isSolo && (
            <div className="status-banner status-banner--solo">
              <Users size={18} />
              <div><strong>ワンオペ運営</strong><small>全運営を自分で兼務・移動中は見張りと安全を優先</small></div>
            </div>
          )}
        </div>

        <section className="regatta-overview-card" aria-label="大会全レースの状況">
          <header>
            <div><span className="eyebrow">大会全体</span><strong>全レースの状況</strong></div>
            <small>タップしてレースを切替</small>
          </header>
          <div className="regatta-race-grid">
            {races.map((candidate) => {
              const candidateMarks = candidate.id === race.id ? marks : candidate.marks
              const candidateTasks = allTasks.filter((task) => !task.raceId || task.raceId === candidate.id)
              const markDone = candidateMarks.filter((mark) => mark.status === 'confirmed').length
              const blockers = candidateTasks.filter((task) => task.priority === 'required' && task.status === 'blocked').length
              const requiredRemaining = candidateTasks.filter((task) => task.priority === 'required' && task.status !== 'done').length
              return (
                <button
                  type="button"
                  className={`${candidate.id === race.id ? 'is-active' : ''} status-${candidate.status}`}
                  aria-current={candidate.id === race.id ? 'page' : undefined}
                  onClick={() => onSelectRace(candidate.id)}
                  key={candidate.id}
                >
                  <span><strong>{candidate.number}</strong><small>{candidate.className}・{candidate.courseCode.split(' / ')[0]}</small></span>
                  <b>{raceStatusLabels[candidate.status]}</b>
                  <span className="regatta-race-progress">マーク {markDone}/{candidateMarks.length || '—'}・必須残り {requiredRemaining}</span>
                  {blockers > 0 && <em><AlertTriangle size={11} /> ブロッカー {blockers}</em>}
                </button>
              )
            })}
          </div>
        </section>

        <details className="beginner-guide">
          <summary><HelpCircle size={16} /><span><strong>初めて使う方へ</strong><small>海上で迷わない5ステップと用語</small></span></summary>
          <div className="beginner-guide__body">
            <ol>
              {isSolo
                ? <li><b>ワンオペ条件を確認</b><span>安全要員、見張り、通信、緊急時の中止基準を確認します。このモードは大会の人員要件を緩和しません。</span></li>
                : <li><b>担当を確認</b><span>自分の名前・艇・担当マークが「（自分）」になっているか確認します。</span></li>}
              <li><b>位置共有を開始</b><span>スマホの位置情報を許可します。競技中のヨットではなく、運営ボートだけを共有します。</span></li>
              <li><b>計画位置へ移動</b><span>地図の番号をタップし、距離・目標方位・ETAを見て移動します。</span></li>
              {isSolo
                ? <li><b>投下と再確認</b><span>投下地点を記録し、安全に移動した後でGPS差分を再確認します。補助艇が来た場合は別艇確認も使えます。</span></li>
                : <li><b>投下と別艇確認</b><span>投下地点を記録し、可能なら別の運営艇が「位置確認」を行います。</span></li>}
              <li><b>本部船の信号を優先</b><span>予定時刻より、延期・リコール・中止を含む本部船の信号を常に優先します。</span></li>
            </ol>
            <dl>
              <div><dt>°T</dt><dd>真方位。磁気コンパス方位と混同しないでください。</dd></div>
              <div><dt>COG</dt><dd>運営ボートが実際に進んでいる対地針路です。</dd></div>
              <div><dt>計画／投下</dt><dd>推奨位置と、実際にマークを落とした位置です。差を地図で確認できます。</dd></div>
              <div><dt>kt／m/s</dt><dd>ノットとメートル毎秒。風速は両方を併記します。</dd></div>
            </dl>
          </div>
        </details>

        <section className="race-phase-card" aria-label="レースフェーズ">
          <header>
            <div>
              <span className="eyebrow">現在フェーズ</span>
              <strong>{race.number}・{currentPhase.label}</strong>
            </div>
            <span className={`race-phase-current state-${currentPhase.state}`}>
              {phaseStateIcon(currentPhase.state)} {phaseStateLabels[currentPhase.state]}・{currentPhase.progress}
            </span>
          </header>
          <div className="race-phase-list">
            {phases.map((phase, index) => (
              <article className={`race-phase state-${phase.state} ${phase.isCurrent ? 'is-current' : ''}`} key={phase.id} aria-current={phase.isCurrent ? 'step' : undefined}>
                <span className="race-phase__index">{phaseStateIcon(phase.state)} {index + 1}</span>
                <strong>{phase.label}</strong>
                <small>{phaseStateLabels[phase.state]}・{phase.progress}</small>
                {detail !== 'overview' && <small>担当 {phase.owner}</small>}
                {detail === 'detail' && <small>期限 {operationTime(phase.dueAt)}・更新 {operationTime(phase.lastUpdatedAt)}</small>}
              </article>
            ))}
          </div>
        </section>

        <div className="metric-grid">
          <article className="metric-card metric-course">
            <span><Route size={16} /> コース</span>
            <strong>{race.courseCode.split(' / ')[0]}</strong>
            <small>{race.courseCode.split(' / ')[1]}</small>
          </article>
          <article className="metric-card metric-marks">
            <span><CircleDot size={16} /> マーク</span>
            <strong>{confirmedMarks}<small> / {marks.length}</small></strong>
            <small>{marks.length - confirmedMarks}件の確認が必要</small>
          </article>
          <article className="metric-card metric-boats">
            <span><ShipWheel size={16} /> 運営ボート</span>
            <strong>{liveBoats}<small> / {boats.length}</small></strong>
            <small>{staleBoats.length ? `要確認 ${staleBoats.length}艇（60秒以上更新なし）` : '全艇が60秒以内に更新'}</small>
          </article>
          <article className={`metric-card metric-wind ${windAgeSeconds > 300 ? 'metric-card--warning' : ''}`}>
            <span><Wind size={16} /> 5分平均風</span>
            <strong>{formatTrueBearing(wind.directionDegrees)} <small>{formatWindSpeedDual(wind.speedKnots)}</small></strong>
            <small>ガスト {formatWindSpeedDual(wind.gustKnots)}・{windAgeSeconds > 300 ? `${Math.floor(windAgeSeconds / 60)}分更新なし` : `${Math.max(0, Math.floor(windAgeSeconds / 60))}分前`}</small>
          </article>
          <article className={`metric-card metric-mark-wind ${freshMarkWindCount < Math.min(isSolo ? 1 : 3, marks.length) ? 'metric-card--warning' : ''}`}>
            <span><Wind size={16} /> マーク別風</span>
            <strong>{freshMarkWindCount}<small> / {marks.length}</small></strong>
            <small>{isSolo ? '全体風を優先・マーク別観測は可能な範囲' : '5分以内の担当艇観測・地図に表示'}</small>
          </article>
          <article className="metric-card metric-current">
            <span><Waves size={16} /> 潮流（流向）</span>
            <strong>{formatTrueBearing(current.directionDegrees)} <small>{current.speedKnots.toFixed(1)}kt</small></strong>
            <small>{current.source}・信頼度 {current.confidence === 'high' ? '高' : current.confidence === 'medium' ? '中' : '低'}</small>
          </article>
          <article className={`metric-card metric-budget budget-stage-${runtimeBudget?.stage ?? freeTierBudget.stage}`}>
            <span><RadioTower size={16} /> 無料枠・稼働監視</span>
            <strong>{Math.ceil(runtimeBudget?.maxPercent ?? freeTierBudget.maxPercent)}<small>%</small></strong>
            <small>最大：{runtimeBudget?.limitingMetricLabel ?? `${freeTierBudget.limitingMetric.label}（標準負荷試算）`}</small>
            {runtimeBudget && <small>
              大会ルーム実測 {runtimeBudget.observedDurableObjectRowsWritten.toLocaleString('ja-JP')} / {runtimeBudget.durableObjectRowsWrittenLimit.toLocaleString('ja-JP')}行（UTC日次）
            </small>}
            {runtimeBudget && runtimeBudget.stage !== 'normal' && runtimeBudget.stage !== 'observe' && <small>
              位置更新 {runtimeBudget.policy.transientPositionMinIntervalMs / 1_000}秒以上へ縮退・重要イベントは維持
            </small>}
          </article>
          <article className={`metric-card metric-passage ${latestPassage?.hasConflict ? 'metric-card--warning' : ''}`}>
            <span><Clock3 size={16} /> 最新先頭通過</span>
            <strong>{latestPassage ? new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(latestPassage.passedAt)) : '未記録'}</strong>
            <small>{latestPassage ? `${latestPassage.markLabel}・${latestPassage.lapNumber}周目・${latestPassage.adopted ? '採用済' : '観測候補'}${latestPassage.hasConflict ? '・時刻差あり' : ''}` : 'マーク通過時に記録'}</small>
          </article>
          <button type="button" className={`metric-card metric-urgent metric-card--action ${unresolvedUrgent ? 'metric-card--urgent' : ''}`} onClick={onOpenMessages}>
            <span><ShieldAlert size={16} /> 緊急連絡</span>
            <strong>{unresolvedUrgent}<small> 件未確認</small></strong>
            <small>{unresolvedUrgent ? 'タップして確認・応答' : '未確認なし'}</small>
          </button>
        </div>

        {(race.status === 'racing' || race.status === 'provisional' || race.status === 'finalized' || firstFinish) && (
          <FirstFinishPanel
            race={race}
            record={firstFinish}
            canRecord={canRecordFinish}
            canAdopt={canAdoptFinish}
            onRecord={onRecordFinish}
            onAdopt={onAdoptFinish}
          />
        )}

        <article className="readiness-card">
          <header>
            <div>
              <span className="eyebrow">スタート準備度</span>
              <strong>{readiness.completion}%</strong>
            </div>
            <span className={`readiness-state is-${readiness.state}`}>
              {readiness.state === 'unconfigured' ? <><AlertTriangle size={14} /> 準備項目未設定</>
                : readiness.state === 'blocked' ? <><AlertTriangle size={14} /> ブロッカー {readiness.blockers.length}件</>
                  : readiness.state === 'incomplete' ? <><Clock3 size={14} /> 必須残り {readiness.remainingRequired}件</>
                    : <><Check size={14} /> 準備完了候補</>}
            </span>
          </header>
          <small className="readiness-breakdown">
            必須 {readiness.requiredDone}/{readiness.required.length}・参考 {readiness.referenceDone}/{readiness.reference.length}
          </small>
          <div className="progress-track"><span style={{ width: `${readiness.completion}%` }} /></div>
          <div className="task-list">
            {!orderedTasks.length && <p className="task-list-empty">このレースの必須準備項目を設定してください。</p>}
            {orderedTasks.map((task) => (
              <div
                className={`task-row task-row--${task.status}`}
                key={task.id}
              >
                <button
                  type="button"
                  className="task-row__status-button"
                  onClick={() => onTaskStatusChange(task.id)}
                  disabled={locked}
                  aria-label={`${task.title}の状態を変更・現在${taskStatusLabel[task.status]}`}
                >
                  <span className="task-status-icon">
                    {task.status === 'done' ? <Check size={15} /> : task.status === 'blocked' ? <AlertTriangle size={15} /> : <Clock3 size={15} />}
                  </span>
                  <span className="task-body">
                    <strong><span className={`task-priority is-${task.priority}`}>{task.priority === 'required' ? '必須' : '参考'}</span>{task.title}</strong>
                    <small>{task.owner}・{task.dueLabel}</small>
                  </span>
                  <span className={`task-state state-${task.status}`}>{taskStatusLabel[task.status]}</span>
                </button>
                <span className="task-row__actions">
                  {task.markId && (
                    <button type="button" onClick={() => onSelectMark(task.markId as string)} aria-label={`${task.title}の対象マークを地図で開く`} title="対象マークを地図で開く">
                      <MapPin size={15} />
                    </button>
                  )}
                  {!isSolo && <button type="button" onClick={() => onOpenTaskMessage(task)} aria-label={`${task.title}について担当者へ連絡`} title="担当者へ連絡">
                    <MessageSquareText size={15} />
                  </button>}
                </span>
              </div>
            ))}
          </div>
        </article>

        {detail !== 'overview' && (
          <div className="board-columns">
            <article className="panel-card">
              <header className="panel-header">
                <div><span className="eyebrow">運営ボート</span><strong>位置・担当</strong></div>
                <button type="button" className="icon-button" aria-label="詳細"><MoreHorizontal size={18} /></button>
              </header>
              <div className="boat-list">
                {boats.map((boat) => (
                  <div className={`boat-row ${boat.isSelf ? 'is-self' : ''}`} key={boat.id}>
                    <span className="boat-avatar"><ShipWheel size={16} /></span>
                    <span className="boat-row__body">
                      <strong>{boat.assignment}</strong>
                      <small>{boat.name}・{boat.freshnessSeconds}秒前</small>
                    </span>
                    <span className="boat-motion">
                      <strong>{boat.speedKnots.toFixed(1)}</strong><small>kt</small>
                      {boat.courseDegrees !== undefined && <small>COG {formatTrueBearing(boat.courseDegrees)}</small>}
                    </span>
                  </div>
                ))}
              </div>
            </article>

            <article className="panel-card">
              <header className="panel-header">
                <div><span className="eyebrow">メッセージ</span><strong>要確認・運営連絡</strong></div>
                <button type="button" className="text-button" onClick={onOpenMessages}>すべて</button>
              </header>
              <div className="message-list">
                {raceMessages.map((message) => (
                  <div className={`message-row priority-${message.priority}`} key={message.id}>
                    <span className="message-icon">
                      {message.priority === 'urgent' ? <ShieldAlert size={16} /> : message.priority === 'confirm' ? <BellRing size={16} /> : <MessageSquareText size={16} />}
                    </span>
                    <div>
                      <span><strong>{message.sender}</strong><small>{message.target?.label ?? message.channel}</small></span>
                      <p>{message.text}</p>
                      {message.receipts && message.receipts.targetCount > 0 && (
                        <small className="message-receipt-status">
                          {message.priority === 'normal'
                            ? `既読 ${message.receipts.readCount}/${message.receipts.targetCount}`
                            : `確認 ${message.receipts.acknowledgedCount}/${message.receipts.targetCount}・既読 ${message.receipts.readCount}`}
                        </small>
                      )}
                      {((message.ownReceipt && message.ownReceipt !== 'acknowledged') || (!message.target && message.acknowledgement === 'pending')) && message.priority !== 'normal' && (
                        <button type="button" onClick={() => onAcknowledgeMessage(message.id)}>了解として確認</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </div>
        )}

        {detail === 'detail' && (
          <article className="timeline-card">
            <header className="panel-header">
              <div><span className="eyebrow">時系列</span><strong>予定と実績</strong></div>
              <span className="timeline-range">{timelineEvents.length}件</span>
            </header>
            <div className="race-timeline-events">
              {timelineEvents.map((event) => (
                <div className={`race-timeline-event kind-${event.kind}`} key={event.id}>
                  <i aria-hidden="true" />
                  <span><strong>{event.label}</strong><small>{event.kind === 'planned' ? '予定' : '実績'}</small></span>
                  <time dateTime={event.at}>{operationTime(event.at)}</time>
                </div>
              ))}
              {timelineEvents.length === 0 && <p>予定・実績はまだありません</p>}
            </div>
          </article>
        )}
      </div>

      <footer className="board-footer">
        <span><Users size={14} /> {isSolo ? `ワンオペ・${memberCount}人` : `${memberCount}人参加中`}</span>
        <span><RadioTower size={14} /> {socketStatus === 'live' ? '同期済み' : `端末保存中${pendingCount ? `・未同期${pendingCount}` : ''}`}</span>
      </footer>
    </section>
  )
}
