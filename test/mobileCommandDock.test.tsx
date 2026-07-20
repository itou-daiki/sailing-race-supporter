import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileCommandDock } from '../src/components/MobileCommandDock'

afterEach(cleanup)

describe('MobileCommandDock', () => {
  it('exposes the five primary operations with text labels', () => {
    const onShowOperations = vi.fn()
    const onOpenWind = vi.fn()
    render(<MobileCommandDock
      activeView="map"
      messageCount={2}
      windEnabled
      onShowMap={vi.fn()}
      onShowOperations={onShowOperations}
      onOpenWind={onOpenWind}
      onOpenMessages={vi.fn()}
      onOpenMenu={vi.fn()}
    />)

    expect(screen.getByRole('button', { name: '海面' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: '連絡要確認 2件' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'やること' }))
    fireEvent.click(screen.getByRole('button', { name: '風を記録' }))
    expect(onShowOperations).toHaveBeenCalledOnce()
    expect(onOpenWind).toHaveBeenCalledOnce()
  })

  it('clearly disables wind entry when the role cannot record it', () => {
    render(<MobileCommandDock
      activeView="operations"
      messageCount={0}
      windEnabled={false}
      onShowMap={vi.fn()}
      onShowOperations={vi.fn()}
      onOpenWind={vi.fn()}
      onOpenMessages={vi.fn()}
      onOpenMenu={vi.fn()}
    />)
    expect(screen.getByRole('button', { name: '風の記録（この担当では権限がありません）' })).toBeDisabled()
  })
})
