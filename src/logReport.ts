import { loadEventLogExport, type EventLogCategory, type EventLogResponse } from './logClient'

const APP_NAME = 'Sailing Race Supporter'
const CREATOR = 'Created by Dit-Lab.（Daiki ITO）'

const categoryLabels: Record<EventLogCategory, string> = {
  audit: '監査',
  mark: 'マーク',
  wind: '風',
  current: '潮流',
  signal: '信号',
  schedule: '予告予定',
  passage: '先頭通過',
  finish: 'フィニッシュ',
  task: 'タスク',
  message: '連絡',
  position: '運営ボート位置',
}

export interface EventLogReportOptions {
  eventSlug: string
  eventName: string
  raceId: string | null
  raceLabel?: string
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function displayTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

function reportScope(report: EventLogResponse, options: EventLogReportOptions): string {
  const raceId = report.raceId === undefined ? options.raceId : report.raceId
  if (raceId === null) return '大会全体'
  return options.raceLabel || '選択レース'
}

function categorySummary(report: EventLogResponse): string {
  const counts = new Map<EventLogCategory, number>()
  report.entries.forEach((entry) => counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1))
  return Object.entries(categoryLabels)
    .map(([category, label]) => ({ label, count: counts.get(category as EventLogCategory) ?? 0 }))
    .filter(({ count }) => count > 0)
    .map(({ label, count }) => `<li><span>${escapeHtml(label)}</span><strong>${count}</strong></li>`)
    .join('')
}

function reportRows(report: EventLogResponse): string {
  if (report.entries.length === 0) {
    return '<tr><td colspan="7" class="empty">この対象範囲の記録はありません。</td></tr>'
  }
  return report.entries.map((entry, index) => {
    const hash = entry.eventHash
      ? `<code title="${escapeHtml(entry.eventHash)}">${escapeHtml(entry.eventHash)}</code>`
      : '<span class="muted">—</span>'
    return `<tr>
      <td class="number">${index + 1}</td>
      <td><time datetime="${escapeHtml(entry.occurredAt)}">${escapeHtml(displayTime(entry.occurredAt))}</time></td>
      <td>${escapeHtml(entry.raceNumber ?? '大会全体')}</td>
      <td><span class="category">${escapeHtml(categoryLabels[entry.category])}</span></td>
      <td><strong>${escapeHtml(entry.title)}</strong><small>${escapeHtml(entry.detail || '詳細なし')}</small></td>
      <td>${escapeHtml(entry.actor)}</td>
      <td>${entry.sequence === null ? '<span class="muted">—</span>' : `#${entry.sequence}`}${hash}</td>
    </tr>`
  }).join('')
}

export function buildPrintableEventLogHtml(report: EventLogResponse, options: EventLogReportOptions): string {
  const eventName = report.event?.name || options.eventName
  const eventId = report.event?.id || options.eventSlug
  const eventSlug = report.event?.slug || options.eventSlug
  const scope = reportScope(report, options)
  const createdAt = displayTime(report.createdAt)
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="generator" content="${APP_NAME} / ${CREATOR}">
  <title>${escapeHtml(eventName)} ${escapeHtml(scope)} 運営ログ - ${APP_NAME}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", "Noto Sans JP", sans-serif; color: #102a43; background: #eaf5ff; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #eaf5ff; }
    .toolbar { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px max(16px, env(safe-area-inset-right)) 12px max(16px, env(safe-area-inset-left)); color: #fff; background: #073b66; box-shadow: 0 4px 18px #073b6633; }
    .toolbar p { margin: 0; font-size: 13px; line-height: 1.5; }
    .toolbar button { min-width: 152px; min-height: 48px; padding: 0 18px; color: #fff; background: #1e90ff; border: 2px solid #80c4ff; border-radius: 12px; font: inherit; font-weight: 800; cursor: pointer; }
    .page { width: min(1120px, calc(100% - 24px)); margin: 20px auto; padding: 32px; background: #fff; box-shadow: 0 16px 45px #073b6620; }
    .brand { display: inline-grid; gap: 2px; padding-left: 12px; border-left: 6px solid #1e90ff; }
    .brand strong { font-size: 22px; letter-spacing: -.02em; }
    .brand span { color: #496173; font-size: 11px; }
    h1 { margin: 28px 0 4px; font-size: 28px; }
    .scope { margin: 0 0 20px; color: #1b5f97; font-size: 17px; font-weight: 800; }
    .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; margin: 0 0 18px; padding: 1px; background: #b8d8ee; border: 1px solid #b8d8ee; }
    .meta div { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 8px; padding: 9px 10px; background: #f7fbff; }
    .meta dt { color: #496173; font-size: 11px; font-weight: 700; }
    .meta dd { margin: 0; overflow-wrap: anywhere; font-size: 11px; font-weight: 700; }
    .summary { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 18px; padding: 0; list-style: none; }
    .summary li { display: inline-flex; align-items: center; gap: 7px; padding: 6px 9px; background: #edf7ff; border: 1px solid #b8dcf8; border-radius: 999px; font-size: 10px; }
    .summary strong { color: #006fd6; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 8.5px; }
    thead { display: table-header-group; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    th { padding: 7px 5px; color: #fff; background: #073b66; border: 1px solid #073b66; text-align: left; font-size: 8px; }
    td { padding: 6px 5px; border: 1px solid #c9dce9; vertical-align: top; overflow-wrap: anywhere; line-height: 1.45; }
    tbody tr:nth-child(even) { background: #f7fbff; }
    th:nth-child(1), td:nth-child(1) { width: 4%; }
    th:nth-child(2), td:nth-child(2) { width: 14%; }
    th:nth-child(3), td:nth-child(3) { width: 8%; }
    th:nth-child(4), td:nth-child(4) { width: 9%; }
    th:nth-child(5), td:nth-child(5) { width: 31%; }
    th:nth-child(6), td:nth-child(6) { width: 11%; }
    th:nth-child(7), td:nth-child(7) { width: 23%; }
    td strong, td small, td code { display: block; }
    td small { margin-top: 3px; color: #496173; font-size: 8px; }
    td code { margin-top: 3px; color: #35546c; font: 6.8px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
    .number { text-align: right; font-variant-numeric: tabular-nums; }
    .category { display: inline-block; padding: 2px 4px; color: #005dae; background: #dff1ff; border-radius: 4px; font-weight: 800; }
    .muted { color: #7b8b98; }
    .empty { padding: 32px; text-align: center; }
    .report-footer { margin-top: 18px; padding-top: 12px; color: #496173; border-top: 2px solid #1e90ff; font-size: 9px; line-height: 1.6; }
    .report-footer strong { color: #102a43; }
    @page { size: A4 portrait; margin: 12mm 9mm 14mm; }
    @media print {
      body { background: #fff; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
      .no-print { display: none !important; }
      .page { width: auto; margin: 0; padding: 0; box-shadow: none; }
      h1 { margin-top: 18px; }
    }
    @media (max-width: 720px) {
      .toolbar { align-items: stretch; flex-direction: column; }
      .toolbar button { width: 100%; }
      .page { width: 100%; margin: 0; padding: 20px 12px; box-shadow: none; }
      .meta { grid-template-columns: 1fr; }
      table { font-size: 7.5px; }
    }
  </style>
</head>
<body>
  <div class="toolbar no-print">
    <p><strong>PDF保存用レポート</strong><br>ボタンを押し、印刷画面で「PDFとして保存」を選択してください。</p>
    <button id="srs-print-button" type="button">PDFとして保存・印刷</button>
  </div>
  <main class="page">
    <header>
      <div class="brand"><strong>${APP_NAME}</strong><span>${CREATOR}</span></div>
      <h1>運営ログレポート</h1>
      <p class="scope">${escapeHtml(eventName)} ／ ${escapeHtml(scope)}</p>
    </header>
    <dl class="meta">
      <div><dt>大会ID</dt><dd>${escapeHtml(eventId)}</dd></div>
      <div><dt>大会URL識別子</dt><dd>${escapeHtml(eventSlug)}</dd></div>
      <div><dt>対象範囲</dt><dd>${escapeHtml(scope)}</dd></div>
      <div><dt>出力日時</dt><dd>${escapeHtml(createdAt)}<br>${escapeHtml(report.createdAt)}</dd></div>
      <div><dt>スキーマ</dt><dd>${escapeHtml(report.format)} v${report.schemaVersion}</dd></div>
      <div><dt>記録件数</dt><dd>${report.entries.length}件（最大2,500件）</dd></div>
    </dl>
    <ul class="summary" aria-label="記録種別の内訳">${categorySummary(report)}</ul>
    <table>
      <thead><tr><th>No.</th><th>発生時刻</th><th>レース</th><th>種別</th><th>内容・詳細</th><th>操作者</th><th>監査連番・ハッシュ</th></tr></thead>
      <tbody>${reportRows(report)}</tbody>
    </table>
    <footer class="report-footer">
      <strong>${APP_NAME}</strong> — ${CREATOR}<br>
      本レポートはレース運営補助記録です。監査検証や機械的な再利用には、同じ対象範囲のJSON出力とイベントハッシュを使用してください。
    </footer>
  </main>
</body>
</html>`
}

function writePrintDocument(target: Window, html: string): void {
  target.document.open()
  target.document.write(html)
  target.document.close()
}

function loadingDocument(eventName: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ログレポートを作成中 - ${APP_NAME}</title><style>body{display:grid;min-height:100vh;place-items:center;margin:0;padding:24px;color:#102a43;background:#eaf5ff;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic",sans-serif}.card{max-width:520px;padding:28px;background:#fff;border-top:6px solid #1e90ff;border-radius:16px;box-shadow:0 16px 45px #073b6620}h1{font-size:20px}p{line-height:1.7}</style></head><body><main class="card"><strong>${APP_NAME}</strong><h1>${escapeHtml(eventName)}のログレポートを作成中…</h1><p>権限を確認し、大会URL単位の記録を取得しています。このタブを閉じずにお待ちください。</p></main></body></html>`
}

function errorDocument(message: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ログレポート作成エラー - ${APP_NAME}</title><style>body{display:grid;min-height:100vh;place-items:center;margin:0;padding:24px;color:#102a43;background:#fff4f2;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic",sans-serif}.card{max-width:560px;padding:28px;background:#fff;border-top:6px solid #cf2f1d;border-radius:16px;box-shadow:0 16px 45px #5b120d20}h1{font-size:20px}p{line-height:1.7}</style></head><body><main class="card"><strong>${APP_NAME}</strong><h1>ログレポートを作成できませんでした</h1><p>${escapeHtml(message)}</p><p>元の画面へ戻り、接続状態と権限を確認して再試行してください。</p></main></body></html>`
}

export async function openEventLogPrintView(options: EventLogReportOptions): Promise<void> {
  const printWindow = window.open('', '_blank')
  if (!printWindow) throw new Error('PDF保存画面を開けません。ブラウザでポップアップを許可して再試行してください。')
  printWindow.opener = null
  writePrintDocument(printWindow, loadingDocument(options.eventName))
  try {
    const report = await loadEventLogExport(options.eventSlug, options.raceId)
    writePrintDocument(printWindow, buildPrintableEventLogHtml(report, options))
    printWindow.document.getElementById('srs-print-button')?.addEventListener('click', () => {
      printWindow.focus()
      printWindow.print()
    })
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : '不明なエラーが発生しました'
    writePrintDocument(printWindow, errorDocument(message))
    throw reason
  }
}
