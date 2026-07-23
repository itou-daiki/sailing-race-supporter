import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

    fireEvent.click(within(screen.getByRole('navigation', { name: '設定する項目' })).getByRole('button', { name: /本部船.*位置/u }))
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
      finishLineMode: 'separate',
      targetLengthMetres: Number(recommendedCourseLength('470', 4, undefined, 'O2').kilometres.toFixed(2)) * 1_000,
    }))
  })

  it('offers a practice finish that reuses RC with one F mark and no FIN boat', async () => {
    const onIssueEvent = vi.fn()
    const { container } = render(<PreEventCoursePlanner onIssueEvent={onIssueEvent} onOpenEvents={vi.fn()} />)

    fireEvent.click(within(container).getByRole('radio', { name: '本船兼用（RC＋F）' }))
    expect(within(container).getByText('練習向け・FIN艇不要')).toBeInTheDocument()
    expect(within(container).getByText('RCから風下へFマークを置き、緑のフィニッシュラインを作ります。')).toBeInTheDocument()

    const issueButton = within(container).getAllByRole('button', { name: '大会URLを発行' }).at(-1)!
    await waitFor(() => expect(issueButton).toBeEnabled())
    fireEvent.click(issueButton)
    expect(onIssueEvent).toHaveBeenCalledWith(expect.objectContaining({ finishLineMode: 'shared-rc' }))
  })

  it('lets the host enter a custom trapezoid finish distance and includes it in issuance', async () => {
    const onIssueEvent = vi.fn()
    const { container } = render(<PreEventCoursePlanner onIssueEvent={onIssueEvent} onOpenEvents={vi.fn()} />)

    fireEvent.click(within(container).getByRole('radio', { name: /手動で指定/u }))
    fireEvent.change(within(container).getByRole('spinbutton', { name: '3マークからフィニッシュまでの距離' }), {
      target: { value: '0.25' },
    })
    expect(within(container).getByText(/0\.25 NM（約463 m）先/u)).toBeInTheDocument()
    fireEvent.click(within(container).getByRole('radio', { name: '本船兼用（RC＋F）' }))
    fireEvent.click(within(container).getByRole('radio', { name: '別に設置（FIN艇＋F）' }))
    expect(within(container).getByRole('spinbutton', { name: '3マークからフィニッシュまでの距離' })).toHaveValue(0.25)

    const issueButton = within(container).getAllByRole('button', { name: '大会URLを発行' }).at(-1)!
    await waitFor(() => expect(issueButton).toBeEnabled())
    fireEvent.click(issueButton)
    expect(onIssueEvent).toHaveBeenCalledWith(expect.objectContaining({
      finishLineMode: 'separate',
      finishDistanceMetres: 0.25 * 1_852,
    }))
  })

  it('switches between a custom target time and the class wind-speed standard', async () => {
    const onIssueEvent = vi.fn()
    const { container } = render(<PreEventCoursePlanner onIssueEvent={onIssueEvent} onOpenEvents={vi.fn()} />)
    const targetMinutes = within(container).getByRole('spinbutton', { name: '目標レース時間（分）' })

    fireEvent.change(targetMinutes, { target: { value: '65' } })
    expect(targetMinutes).toHaveValue(65)
    expect(within(container).getByText(/目標時間 65分/u)).toBeInTheDocument()

    fireEvent.click(within(container).getByRole('radio', { name: '風速から標準距離' }))
    expect(targetMinutes).toBeDisabled()
    expect(targetMinutes).toHaveValue(50)

    const issueButton = within(container).getAllByRole('button', { name: '大会URLを発行' }).at(-1)!
    await waitFor(() => expect(issueButton).toBeEnabled())
    fireEvent.click(issueButton)
    expect(onIssueEvent).toHaveBeenCalledWith(expect.objectContaining({ targetMinutes: 50 }))
  })
})
