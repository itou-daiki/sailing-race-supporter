import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventManager } from '../src/components/EventManager'

describe('EventManager free-only backup UI', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses device backups without offering an R2 archive', () => {
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

    expect(screen.getByText('課金のない端末保存')).toBeInTheDocument()
    expect(screen.getByText(/D1には無料のTime Travelが常時有効/u)).toBeInTheDocument()
    expect(screen.queryByText('R2暗号化バックアップ')).not.toBeInTheDocument()
  })
})
