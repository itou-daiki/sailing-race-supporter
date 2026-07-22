import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PreEventCoursePlanner } from '../src/components/PreEventCoursePlanner'
import { recommendedCourseLength } from '../src/course'

vi.mock('../src/coastClearance', () => ({
  assessCoastClearance: vi.fn().mockResolvedValue({ status: 'safe', minimumMetres: 300 }),
  findCoastClearSignalPosition: vi.fn(),
}))

describe('PreEventCoursePlanner mobile navigation', () => {
  it('separates the setup into course, position, and wind panels while keeping issuance available', async () => {
    const onIssueEvent = vi.fn()
    const { container } = render(
      <PreEventCoursePlanner onIssueEvent={onIssueEvent} onOpenEvents={vi.fn()} />,
    )

    const coursePanel = container.querySelector('[data-mobile-panel="course"]')
    const positionPanel = container.querySelector('[data-mobile-panel="position"]')
    const windPanel = container.querySelector('[data-mobile-panel="wind"]')

    expect(coursePanel).toHaveClass('is-mobile-active')
    expect(positionPanel).not.toHaveClass('is-mobile-active')

    fireEvent.click(screen.getByRole('button', { name: /本部船.*位置/u }))
    expect(coursePanel).not.toHaveClass('is-mobile-active')
    expect(positionPanel).toHaveClass('is-mobile-active')

    fireEvent.click(screen.getByRole('button', { name: /風・長さ.*推奨値/u }))
    expect(positionPanel).not.toHaveClass('is-mobile-active')
    expect(windPanel).toHaveClass('is-mobile-active')

    fireEvent.change(screen.getByRole('spinbutton', { name: '風速（kt）' }), { target: { value: '4' } })
    expect(screen.getByLabelText('現在の設定概要')).toHaveTextContent('350°T・4.0kt')
    expect(screen.getByLabelText('現在の設定概要')).toHaveTextContent('第1レグ')

    const issueButton = screen.getAllByRole('button', { name: '大会URLを発行' }).at(-1)!
    await waitFor(() => expect(issueButton).toBeEnabled())
    fireEvent.click(issueButton)
    expect(onIssueEvent).toHaveBeenCalledWith(expect.objectContaining({
      className: '470',
      courseCode: 'O2',
      windSpeed: 4,
      targetLengthMetres: Number(recommendedCourseLength('470', 4, undefined, 'O2').kilometres.toFixed(1)) * 1_000,
    }))
  })
})
