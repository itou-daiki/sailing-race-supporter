import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventManager } from '../src/components/EventManager'

describe('EventManager free-only backup UI', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('separates event creation from management and uses device backups', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))

    render(<EventManager
      session={{
        mode: 'authenticated',
        user: { id: 'owner-1', displayName: '大会管理者' },
        expiresAt: '2026-07-20T00:00:00.000Z',
        authenticatedAt: '2026-07-19T00:00:00.000Z',
      }}
      currentEventSlug="free-regatta"
      currentEventId="event-1"
      currentEventName="無料運用大会"
      isCurrentEventOwner
      resources={{ areas: [], boats: [], marks: [], members: [] }}
      races={[]}
      assignmentRealtimeAvailable={false}
      onUpdateAssignment={vi.fn()}
      onRequestAuthentication={vi.fn()}
      onEventStructureChanged={vi.fn()}
      onRecoverParticipation={vi.fn()}
      onClose={vi.fn()}
    />)

    expect(screen.getByRole('button', { name: /新しい大会を作る/u })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /大会を選ぶ/u })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByText('課金のない端末保存')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /現在の大会を管理/u }))
    expect(screen.getByText('課金のない端末保存')).toBeInTheDocument()
    expect(screen.getByText(/D1には無料のTime Travelが常時有効/u)).toBeInTheDocument()
    expect(screen.queryByText('R2暗号化バックアップ')).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'タイムキーパー' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '記録員' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /新しい大会を作る/u }))
    expect(screen.getByText('大会名と日程')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: '初期コース' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: '大会名' }), { target: { value: '2026 別府湾サマーレガッタ' } })
    fireEvent.click(screen.getByRole('button', { name: '次へ：レース設定' }))

    expect(screen.getByRole('combobox', { name: '初期コース' })).toHaveValue('O2')
    expect(screen.getByRole('radio', { name: /O2.*トラペゾイド・アウターループ/u })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('トラペゾイド（O2）— アウター・風上レグ2回')).toBeInTheDocument()
    expect(screen.getByLabelText('標準回航順序：Start、1、2、3S/3P、2、3P、Finish')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '次へ：海面と確認' }))
    expect(screen.getByText('レース海面を決めて確認')).toBeInTheDocument()
    expect(screen.getByText('地図をタップ、またはピンを移動')).toBeInTheDocument()
    expect(screen.getByText('緯度・経度を直接入力する')).toBeInTheDocument()
    expect(screen.getByLabelText('レース海面の経度')).toHaveValue(131.5221959)
    expect(screen.getByLabelText('レース海面の緯度')).toHaveValue(33.2786648)
    expect(screen.getByText('2026 別府湾サマーレガッタ')).toBeInTheDocument()
    expect(screen.getByText('3レース・470')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /この内容で大会URLを発行/u })).toBeEnabled()
  })

  it('guides an anonymous organizer into authentication and back to event issuance', () => {
    const onRequestAuthentication = vi.fn()
    render(<EventManager
      session={{ mode: 'anonymous' }}
      currentEventSlug="demo"
      currentEventName="デモ大会"
      isCurrentEventOwner={false}
      resources={{ areas: [], boats: [], marks: [], members: [] }}
      races={[]}
      assignmentRealtimeAvailable={false}
      onUpdateAssignment={vi.fn()}
      onRequestAuthentication={onRequestAuthentication}
      onEventStructureChanged={vi.fn()}
      onRecoverParticipation={vi.fn()}
      onClose={vi.fn()}
    />)

    expect(screen.getByText('大会の発行には本人確認が必要です')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '管理者登録へ進む' }))
    expect(onRequestAuthentication).toHaveBeenCalledOnce()
  })
})
