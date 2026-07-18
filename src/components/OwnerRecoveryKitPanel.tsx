import { Check, Clipboard, Download, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import type { OwnerRecoveryKit } from '../authClient'
import { encryptOwnerRecoveryKit, ownerRecoveryQrPayload } from '../ownerRecovery'

interface OwnerRecoveryKitPanelProps {
  kit: OwnerRecoveryKit
  onConfirm: () => Promise<void>
}

export function OwnerRecoveryKitPanel({ kit, onConfirm }: OwnerRecoveryKitPanelProps) {
  const [passphrase, setPassphrase] = useState('')
  const [downloaded, setDownloaded] = useState(false)
  const [screenshotConfirmed, setScreenshotConfirmed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [working, setWorking] = useState<'download' | 'confirm'>()
  const [error, setError] = useState<string>()
  const [qrCode, setQrCode] = useState<string>()

  useEffect(() => {
    let active = true
    void QRCode.toDataURL(ownerRecoveryQrPayload(kit), {
      width: 260,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#081c36', light: '#ffffff' },
    }).then((value) => { if (active) setQrCode(value) })
      .catch(() => { if (active) setError('復旧QRを作成できません。手入力コードと暗号化ファイルを保存してください') })
    return () => { active = false }
  }, [kit])

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(`${kit.eventSlug}\n${kit.recoveryCode}`)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      setError('クリップボードへコピーできません。コードを手動で保存してください')
    }
  }

  const downloadEncrypted = async () => {
    setWorking('download')
    setError(undefined)
    try {
      const encrypted = await encryptOwnerRecoveryKit(kit, passphrase)
      const content = JSON.stringify(encrypted, null, 2)
      const url = URL.createObjectURL(new Blob([content], { type: 'application/vnd.sailing-race-supporter.owner-recovery+json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${kit.eventSlug}-owner-recovery.srs-owner-recovery`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
      setDownloaded(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '復旧ファイルを暗号化できません')
    } finally {
      setWorking(undefined)
    }
  }

  const confirm = async () => {
    setWorking('confirm')
    setError(undefined)
    try {
      await onConfirm()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '復旧キットの保存を確定できません')
      setWorking(undefined)
    }
  }

  return (
    <div className="owner-recovery-backdrop" role="presentation">
      <section className="owner-recovery-panel" role="dialog" aria-modal="true" aria-labelledby="owner-recovery-title">
        <header>
          <span><ShieldCheck size={24} /></span>
          <div><small>大会管理者・アカウント喪失対策</small><h2 id="owner-recovery-title">オーナー復旧キットを保存</h2></div>
        </header>
        <p className="owner-recovery-lead">この画面を閉じると復旧コードは再表示できません。全パスキーを失ったとき、新端末で大会管理者へ復帰する一回限りの秘密です。</p>
        <div className="owner-recovery-identity">
          <span><strong>{kit.eventName}</strong><small>大会URL: /e/{kit.eventSlug}</small></span>
          <KeyRound size={20} />
        </div>
        <div className="owner-recovery-grid">
          <div className="owner-recovery-qr">
            {qrCode ? <img src={qrCode} alt="大会IDとオーナー復旧コードのQR" /> : <LoaderCircle className="is-spinning" size={28} />}
            <small>通信せずに読み取れる復旧QR</small>
          </div>
          <div className="owner-recovery-code">
            <span>手入力コード</span>
            <code>{kit.recoveryCode}</code>
            <button type="button" onClick={() => void copyCode()}><Clipboard size={16} />{copied ? 'コピーしました' : '大会URLとコードをコピー'}</button>
          </div>
        </div>
        <div className="owner-recovery-encryption">
          <label><span>暗号化ファイル用パスフレーズ（10文字以上）</span><input type="password" value={passphrase} onChange={(event) => { setPassphrase(event.target.value); setDownloaded(false) }} autoComplete="new-password" placeholder="ファイルとは別の安全な場所に記録" /></label>
          <button type="button" onClick={() => void downloadEncrypted()} disabled={passphrase.length < 10 || Boolean(working)}>{working === 'download' ? <LoaderCircle className="is-spinning" size={17} /> : <Download size={17} />}{downloaded ? '暗号化ファイルを再保存' : '暗号化ファイルを保存'}</button>
          <small>パスフレーズと復旧コードの平文はサーバーへ送信・保存されません。</small>
        </div>
        <label className="owner-recovery-check"><input type="checkbox" checked={screenshotConfirmed} onChange={(event) => setScreenshotConfirmed(event.target.checked)} /><span><strong>この画面のスクリーンショットも保存しました</strong><small>暗号化ファイルと同じ端末だけに置かず、運営責任者の安全な保管先にも残してください。</small></span></label>
        {error && <div className="auth-error" role="alert">{error}</div>}
        <button type="button" className="owner-recovery-confirm" onClick={() => void confirm()} disabled={!downloaded || !screenshotConfirmed || Boolean(working)}>{working === 'confirm' ? <LoaderCircle className="is-spinning" size={18} /> : <Check size={18} />}保存を確認して大会へ進む</button>
        <footer>Sailing Race Supporter<br /><small>Created by Dit-Lab.（Daiki ITO）</small></footer>
      </section>
    </div>
  )
}
