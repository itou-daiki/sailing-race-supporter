import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OperationsBoard } from '../src/components/OperationsBoard'
import { DEMO_BOATS, DEMO_RACES, INITIAL_CURRENT, INITIAL_WIND, type OperationalTask } from '../src/domain'
import { estimateRegattaFreeTierUsage, STANDARD_REGATTA_LOAD } from '../shared/freeTierBudget'

describe('OperationsBoard solo mode', () => {
  it('keeps self-operated tasks actionable without asking the operator to message themselves', () => {
    const onTaskStatusChange = vi.fn()
    const task: OperationalTask = {
      id: 'solo-task',
      raceId: DEMO_RACES[0].id,
      title: 'ワンオペの安全条件と中止基準を確認',
      owner: '表示確認用管理者',
      status: 'waiting',
      dueLabel: '予告30分前',
      priority: 'required',
    }

    render(<OperationsBoard
      race={DEMO_RACES[0]}
      races={[DEMO_RACES[0]]}
      marks={DEMO_RACES[0].marks}
      boats={[{ ...DEMO_BOATS[0], name: 'ワンオペ運営艇', assignment: '全運営（自分）', isSelf: true }]}
      tasks={[task]}
      allTasks={[task]}
      messages={[]}
      wind={INITIAL_WIND}
      markWinds={[]}
      current={INITIAL_CURRENT}
      freeTierBudget={estimateRegattaFreeTierUsage(STANDARD_REGATTA_LOAD)}
      scale={100}
      detail="overview"
      postponed={false}
      locked={false}
      socketStatus="live"
      pendingCount={0}
      memberCount={1}
      operationMode="solo"
      canRecordFinish
      canAdoptFinish
      onScaleChange={vi.fn()}
      onDetailChange={vi.fn()}
      onSelectMark={vi.fn()}
      onSelectRace={vi.fn()}
      onAcknowledgeMessage={vi.fn()}
      onOpenMessages={vi.fn()}
      onOpenTaskMessage={vi.fn()}
      onTaskStatusChange={onTaskStatusChange}
      onRecordFinish={vi.fn()}
      onAdoptFinish={vi.fn()}
    />)

    expect(screen.getByText('ワンオペ運営')).toBeInTheDocument()
    expect(screen.getByText('ワンオペ・1人')).toBeInTheDocument()
    expect(screen.getByText('全体風を優先・マーク別観測は可能な範囲')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /担当者へ連絡/u })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: `${task.title}の状態を変更・現在確認待ち` }))
    expect(onTaskStatusChange).toHaveBeenCalledWith('solo-task')
  })
})
