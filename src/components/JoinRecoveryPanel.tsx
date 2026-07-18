import {
  Camera,
  CheckCircle2,
  Clipboard,
  Download,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  ScanQrCode,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { SessionState } from '../authClient'
import {
  exchangeInvite,
  newRecoverySecret,
  previewInvite,
  recoverMember,
  sessionFromInvite,
  type InvitePreview,
  type InviteResult,
} from '../inviteClient'
import { saveMemberProfile } from '../offlineStore'
import { createMemberRecoveryQrPayload, decodeMemberRecoveryQrImage } from '../memberRecoveryCard'

type JoinMode = { kind: 'join'; inviteId: string; secret: string }
type RecoverMode = { kind: 'recover' }

interface JoinRecoveryPanelProps {
  eventSlug: string
  mode: JoinMode | RecoverMode
  onSessionChange: (session: SessionState) => void
  onComplete: () => void
  onClose?: () => void
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    pro: 'PRO', ro: 'RO', 'course-setter': 'コースセッター', 'signal-boat': 'シグナルボート',
    'mark-boat': 'マークボート', 'safety-boat': '安全ボート', jury: 'ジュリー', protest: 'プロテスト', viewer: '閲覧者',
  }
  return labels[role] ?? role
}

function RecoveryCard({
  result,
  recoverySecret,
  onContinue,
}: {
  result: InviteResult
  recoverySecret: string
  onContinue: () => void
}) {
  const [qrUrl, setQrUrl] = useState<string>()
  const [confirmed, setConfirmed] = useState(false)
  const [copied, setCopied] = useState(false)
  const payload = useMemo(
    () => createMemberRecoveryQrPayload(result.event.slug, result.member.id, recoverySecret),
    [recoverySecret, result.event.slug, result.member.id],
  )

  useEffect(() => {
    let active = true
    void import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(payload, { width: 240, margin: 1, errorCorrectionLevel: 'M' }))
      .then((url) => { if (active) setQrUrl(url) })
    return () => { active = false }
  }, [payload])

  const copyCode = async () => {
    await navigator.clipboard.writeText(`${result.member.id}\n${recoverySecret}`)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2_000)
  }

  const download = () => {
    const card = JSON.stringify({
      format: 'srs-member-recovery-card',
      version: 1,
      createdBy: 'Sailing Race Supporter / Created by Dit-Lab.（Daiki ITO）',
      event: result.event,
      member: result.member,
      recovery: { ...result.recovery, memberId: result.member.id, secret: recoverySecret },
    }, null, 2)
    const url = URL.createObjectURL(new Blob([card], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `srs-recovery-${result.event.slug}-${result.member.id.slice(0, 8)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="recovery-card-screen">
      <div className="recovery-warning">
        <Camera size={32} />
        <h2>この画面をスクリーンショットしてください</h2>
        <p>端末を紛失したときに、同じ名前・担当へ復元するための情報です。第三者へ送らないでください。</p>
      </div>
      <section className="recovery-card">
        <div className="recovery-card__brand"><ShieldCheck size={21} /><span><strong>Sailing Race Supporter</strong><small>Created by Dit-Lab.（Daiki ITO）</small><small>参加復元カード</small></span></div>
        <dl>
          <div><dt>大会</dt><dd>{result.event.name}</dd></div>
          <div><dt>名前</dt><dd>{result.member.displayName}</dd></div>
          <div><dt>担当</dt><dd>{roleLabel(result.member.role)}／{result.member.assignment}</dd></div>
          <div><dt>メンバーID</dt><dd>{result.member.id}</dd></div>
        </dl>
        {qrUrl ? <img src={qrUrl} alt="参加情報復元用QRコード" /> : <div className="recovery-qr-loading"><LoaderCircle className="is-spinning" /></div>}
        <div className="recovery-code"><span>手入力コード</span><code>{recoverySecret}</code></div>
        <small>有効期限 {new Date(result.recovery.expiresAt).toLocaleString('ja-JP')}</small>
      </section>
      <div className="recovery-card-actions">
        <button type="button" onClick={() => void copyCode()}><Clipboard size={17} />{copied ? 'コピー済み' : 'IDとコードをコピー'}</button>
        <button type="button" onClick={download}><Download size={17} />ファイル保存</button>
      </div>
      <label className="recovery-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><strong>スクリーンショットを保存しました</strong><small>写真共有アルバム等へ意図せず共有されないことも確認しました</small></span></label>
      <button type="button" className="recovery-continue" disabled={!confirmed} onClick={onContinue}><CheckCircle2 size={18} />大会の運用画面へ</button>
    </div>
  )
}

export function JoinRecoveryPanel({ eventSlug, mode, onSessionChange, onComplete, onClose }: JoinRecoveryPanelProps) {
  const [preview, setPreview] = useState<InvitePreview>()
  const [displayName, setDisplayName] = useState('')
  const [memberId, setMemberId] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [replacementSecret, setReplacementSecret] = useState<string>()
  const [result, setResult] = useState<InviteResult>()
  const [working, setWorking] = useState(mode.kind === 'join')
  const [qrWorking, setQrWorking] = useState(false)
  const [qrStatus, setQrStatus] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (mode.kind !== 'join') return
    let active = true
    void previewInvite(mode.inviteId, mode.secret)
      .then((loaded) => { if (active) setPreview(loaded) })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '招待URLを確認できません') })
      .finally(() => { if (active) setWorking(false) })
    return () => { active = false }
  }, [mode])

  const submitJoin = async (event: React.FormEvent) => {
    event.preventDefault()
    if (mode.kind !== 'join') return
    setWorking(true)
    setError(undefined)
    const recoverySecret = newRecoverySecret()
    try {
      setResult(await exchangeInvite(mode.inviteId, mode.secret, displayName, recoverySecret))
      setReplacementSecret(recoverySecret)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '大会へ参加できません')
    } finally {
      setWorking(false)
    }
  }

  const submitRecovery = async (event: React.FormEvent) => {
    event.preventDefault()
    setWorking(true)
    setError(undefined)
    const nextSecret = newRecoverySecret()
    try {
      setResult(await recoverMember(eventSlug, memberId.trim(), recoveryCode.trim(), nextSecret))
      setReplacementSecret(nextSecret)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '参加情報を復元できません')
    } finally {
      setWorking(false)
    }
  }

  const readRecoveryQr = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setQrWorking(true)
    setQrStatus(undefined)
    setError(undefined)
    try {
      const payload = await decodeMemberRecoveryQrImage(file)
      if (payload.eventSlug !== eventSlug) {
        throw new Error(`このQRは別の大会（${payload.eventSlug}）の復元カードです`)
      }
      setMemberId(payload.memberId)
      setRecoveryCode(payload.secret)
      setQrStatus('QRを読み取りました。大会名と担当を確認して復元してください。')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '参加復元QRを読み取れません')
    } finally {
      setQrWorking(false)
    }
  }

  const finish = () => {
    if (!result || !replacementSecret) return
    void saveMemberProfile({
      eventId: result.event.slug,
      memberId: result.member.id,
      displayName: result.member.displayName,
      role: result.member.role,
      assignment: result.member.assignment,
      recoveryHint: replacementSecret.slice(-4),
      savedAt: new Date().toISOString(),
    })
    onSessionChange(sessionFromInvite(result))
    window.history.replaceState(null, '', `/e/${encodeURIComponent(result.event.slug)}`)
    onComplete()
  }

  return (
    <div className="modal-backdrop join-backdrop" role="presentation">
      <section className="join-panel" role="dialog" aria-modal="true" aria-label={mode.kind === 'join' ? '大会参加' : '参加情報復元'}>
        {onClose && <button type="button" className="join-close" onClick={onClose} aria-label="閉じる"><X size={20} /></button>}
        {result && replacementSecret ? (
          <RecoveryCard result={result} recoverySecret={replacementSecret} onContinue={finish} />
        ) : mode.kind === 'join' ? (
          <div className="join-form-screen">
            <div className="join-product-brand"><strong>Sailing Race Supporter</strong><small>Created by Dit-Lab.（Daiki ITO）</small></div>
            <span className="join-icon"><KeyRound size={30} /></span>
            <span className="eyebrow">招待URLから参加</span>
            <h1>{preview?.event.name ?? '大会情報を確認中'}</h1>
            {working && !preview ? <div className="event-loading"><LoaderCircle className="is-spinning" size={19} />招待を確認しています</div> : preview && (
              <>
                <div className="join-assignment"><span>許可された担当</span><strong>{roleLabel(preview.invite.role)}／{preview.invite.assignment}</strong><small>入力内容から権限が拡大されることはありません</small></div>
                <form onSubmit={(event) => void submitJoin(event)}>
                  <label><span>あなたの名前</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="運営メンバーの表示名" minLength={2} maxLength={80} autoComplete="name" required /></label>
                  <button type="submit" disabled={working || displayName.trim().length < 2}>{working ? <LoaderCircle className="is-spinning" size={18} /> : <ShieldCheck size={18} />}名前と担当を登録して参加</button>
                </form>
              </>
            )}
            {error && <div className="auth-error" role="alert">{error}</div>}
          </div>
        ) : (
          <div className="join-form-screen">
            <div className="join-product-brand"><strong>Sailing Race Supporter</strong><small>Created by Dit-Lab.（Daiki ITO）</small></div>
            <span className="join-icon"><RotateCcw size={30} /></span>
            <span className="eyebrow">端末喪失・機種変更</span>
            <h1>参加情報を復元</h1>
            <p className="join-intro">保存した参加復元カードのメンバーIDと手入力コードを入力してください。成功後、旧セッションと旧コードは失効します。</p>
            <label className={`recovery-qr-import ${qrWorking ? 'is-working' : ''}`}>
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void readRecoveryQr(event)} disabled={qrWorking || working} />
              {qrWorking ? <LoaderCircle className="is-spinning" size={22} /> : <ScanQrCode size={22} />}
              <span><strong>{qrWorking ? 'QR画像を解析中…' : '復元カードのQR画像を読み込む'}</strong><small>スクリーンショットは端末内だけで処理し、サーバーへ送信しません</small></span>
            </label>
            {qrStatus && <div className="recovery-qr-status" role="status"><CheckCircle2 size={17} />{qrStatus}</div>}
            <div className="recovery-or"><span>または手入力</span></div>
            <form onSubmit={(event) => void submitRecovery(event)}>
              <label><span>メンバーID</span><input value={memberId} onChange={(event) => setMemberId(event.target.value)} autoCapitalize="none" autoCorrect="off" required /></label>
              <label><span>手入力コード</span><input value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} autoCapitalize="none" autoCorrect="off" required /></label>
              <button type="submit" disabled={working || !memberId.trim() || !recoveryCode.trim()}>{working ? <LoaderCircle className="is-spinning" size={18} /> : <RotateCcw size={18} />}担当と参加情報を復元</button>
            </form>
            <small className="join-security-note">大会管理者・PRO/RO等の重要権限は、このカードだけでは復旧できません。</small>
            {error && <div className="auth-error" role="alert">{error}</div>}
          </div>
        )}
      </section>
    </div>
  )
}
