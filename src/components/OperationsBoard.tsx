import {
  AlertTriangle,
  BellRing,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  LockKeyhole,
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
  Wind,
} from 'lucide-react'
import type {
  BoardDetail,
  CommitteeBoat,
  CourseMark,
  OperationalMessage,
  OperationalTask,
  RaceDefinition,
  RaceSignalEvent,
  WindObservation,
} from '../domain'
import { signalDefinition } from '../signals'

interface OperationsBoardProps {
  race: RaceDefinition
  marks: readonly CourseMark[]
  boats: readonly CommitteeBoat[]
  tasks: readonly OperationalTask[]
  messages: readonly OperationalMessage[]
  wind: WindObservation
  scale: number
  detail: BoardDetail
  postponed: boolean
  locked: boolean
  socketStatus: 'connecting' | 'live' | 'offline'
  pendingCount: number
  memberCount: number
  latestSignal?: RaceSignalEvent
  onScaleChange: (scale: number) => void
  onDetailChange: (detail: BoardDetail) => void
  onSelectMark: (markId: string) => void
  onAcknowledgeMessage: (messageId: string) => void
  onOpenMessages: () => void
  onTaskStatusChange: (taskId: string) => void
}

const taskStatusLabel: Record<OperationalTask['status'], string> = {
  blocked: 'ブロッカー',
  waiting: '確認待ち',
  doing: '対応中',
  done: '完了',
}

const detailLabels: Record<BoardDetail, string> = {
  overview: '全体',
  standard: '標準',
  detail: '詳細',
}

export function OperationsBoard({
  race,
  marks,
  boats,
  tasks,
  messages,
  wind,
  scale,
  detail,
  postponed,
  locked,
  socketStatus,
  pendingCount,
  memberCount,
  latestSignal,
  onScaleChange,
  onDetailChange,
  onSelectMark,
  onAcknowledgeMessage,
  onOpenMessages,
  onTaskStatusChange,
}: OperationsBoardProps) {
  const confirmedMarks = marks.filter((mark) => mark.status === 'confirmed').length
  const liveBoats = boats.filter((boat) => boat.status !== 'offline').length
  const blockers = tasks.filter((task) => task.status === 'blocked')
  const completion = tasks.length
    ? Math.round((tasks.filter((task) => task.status === 'done').length / tasks.length) * 100)
    : 0
  const controlSignal = latestSignal && signalDefinition(latestSignal.action).group !== 'sequence' ? latestSignal : undefined

  const setScale = (next: number) => onScaleChange(Math.min(200, Math.max(75, next)))

  return (
    <section
      className={`operations-board detail-${detail}`}
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
            <button type="button" onClick={() => setScale(75)} aria-label="全体を表示"><Maximize2 size={15} /></button>
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
        </div>

        <div className="metric-grid">
          <article className="metric-card">
            <span><Route size={16} /> コース</span>
            <strong>{race.courseCode.split(' / ')[0]}</strong>
            <small>{race.courseCode.split(' / ')[1]}</small>
          </article>
          <article className="metric-card">
            <span><CircleDot size={16} /> マーク</span>
            <strong>{confirmedMarks}<small> / {marks.length}</small></strong>
            <small>{marks.length - confirmedMarks}件の確認が必要</small>
          </article>
          <article className="metric-card">
            <span><ShipWheel size={16} /> 運営ボート</span>
            <strong>{liveBoats}<small> / {boats.length}</small></strong>
            <small>全艇と通信中</small>
          </article>
          <article className="metric-card">
            <span><Wind size={16} /> 5分平均風</span>
            <strong>{wind.directionDegrees}° <small>{wind.speedKnots.toFixed(1)}kt</small></strong>
            <small>ガスト {wind.gustKnots.toFixed(1)}kt・安定</small>
          </article>
        </div>

        <article className="readiness-card">
          <header>
            <div>
              <span className="eyebrow">スタート準備度</span>
              <strong>{completion}%</strong>
            </div>
            <span className={blockers.length ? 'readiness-state is-blocked' : 'readiness-state'}>
              {blockers.length ? <><AlertTriangle size={14} /> ブロッカー {blockers.length}件</> : <><Check size={14} /> 準備完了候補</>}
            </span>
          </header>
          <div className="progress-track"><span style={{ width: `${completion}%` }} /></div>
          <div className="task-list">
            {tasks.map((task) => (
              <button
                type="button"
                className={`task-row task-row--${task.status}`}
                onClick={() => {
                  if (locked) return
                  onTaskStatusChange(task.id)
                  if (task.markId) onSelectMark(task.markId)
                }}
                disabled={locked}
                key={task.id}
              >
                <span className="task-status-icon">
                  {task.status === 'done' ? <Check size={15} /> : task.status === 'blocked' ? <AlertTriangle size={15} /> : <Clock3 size={15} />}
                </span>
                <span className="task-body">
                  <strong>{task.title}</strong>
                  <small>{task.owner}・{task.dueLabel}</small>
                </span>
                <span className={`task-state state-${task.status}`}>{taskStatusLabel[task.status]}</span>
                {task.markId && <ChevronRight size={15} />}
              </button>
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
                      {boat.courseDegrees !== undefined && <small>{boat.courseDegrees}°</small>}
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
                {messages.map((message) => (
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
              <span className="timeline-range">30分</span>
            </header>
            <div className="timeline-track">
              <div className="timeline-now"><span>現在</span></div>
              <div className="timeline-item is-done" style={{ left: '7%' }}><i /><span>コース承認<small>09:43</small></span></div>
              <div className="timeline-item is-done" style={{ left: '26%' }}><i /><span>1マーク確認<small>09:49</small></span></div>
              <div className="timeline-item is-next" style={{ left: '58%' }}><i /><span>予告信号<small>10:00</small></span></div>
              <div className="timeline-item" style={{ left: '77%' }}><i /><span>スタート<small>10:05</small></span></div>
            </div>
          </article>
        )}
      </div>

      <footer className="board-footer">
        <span><Users size={14} /> {memberCount}人参加中</span>
        <span><RadioTower size={14} /> {socketStatus === 'live' ? '同期済み' : `端末保存中${pendingCount ? `・未同期${pendingCount}` : ''}`}</span>
      </footer>
    </section>
  )
}
