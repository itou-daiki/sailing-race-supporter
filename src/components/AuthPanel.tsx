import {
  CheckCircle2,
  CloudOff,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  LogOut,
  Upload,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  authErrorMessage,
  authenticatePasskey,
  loadAuthSecurity,
  logout,
  recoverOwnerAccount,
  registerAdditionalPasskey,
  registerPasskey,
  type AuthSecuritySummary,
  type OwnerRecoveryKit,
  type SessionState,
} from '../authClient'
import { confirmOwnerRecoveryKit } from '../eventClient'
import { decryptOwnerRecoveryKit, type EncryptedOwnerRecoveryKit } from '../ownerRecovery'
import { OwnerRecoveryKitPanel } from './OwnerRecoveryKitPanel'

interface AuthPanelProps {
  session: SessionState
  onSessionChange: (session: SessionState) => void
  onClose: () => void
}

export function AuthPanel({ session, onSessionChange, onClose }: AuthPanelProps) {
  const [displayName, setDisplayName] = useState('伊藤 大輝')
  const [working, setWorking] = useState<'register' | 'additional' | 'login' | 'logout' | 'recover' | 'file'>()
  const [error, setError] = useState<string>()
  const [security, setSecurity] = useState<AuthSecuritySummary>()
  const [showOwnerRecovery, setShowOwnerRecovery] = useState(false)
  const [recoveryEvent, setRecoveryEvent] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')
  const [recoveryPassphrase, setRecoveryPassphrase] = useState('')
  const [recoveryFile, setRecoveryFile] = useState<File>()
  const [replacementKit, setReplacementKit] = useState<OwnerRecoveryKit>()
  const passkeySupported = typeof PublicKeyCredential !== 'undefined'

  useEffect(() => {
    if (session.mode !== 'authenticated') return
    let active = true
    void loadAuthSecurity()
      .then((summary) => { if (active) setSecurity(summary) })
      .catch((reason) => { if (active) setError(authErrorMessage(reason)) })
    return () => { active = false }
  }, [session])

  const register = async () => {
    setWorking('register')
    setError(undefined)
    try {
      onSessionChange(await registerPasskey(displayName))
    } catch (reason) {
      setError(authErrorMessage(reason))
    } finally {
      setWorking(undefined)
    }
  }

  const addPasskey = async () => {
    setWorking('additional')
    setError(undefined)
    try {
      const nextSession = await registerAdditionalPasskey()
      onSessionChange(nextSession)
      setSecurity(await loadAuthSecurity())
    } catch (reason) {
      setError(authErrorMessage(reason))
    } finally {
      setWorking(undefined)
    }
  }

  const login = async () => {
    setWorking('login')
    setError(undefined)
    try {
      onSessionChange(await authenticatePasskey())
    } catch (reason) {
      setError(authErrorMessage(reason))
    } finally {
      setWorking(undefined)
    }
  }

  const signOut = async () => {
    setWorking('logout')
    setError(undefined)
    try {
      await logout()
      onSessionChange({ mode: 'anonymous' })
    } catch (reason) {
      setError(authErrorMessage(reason))
    } finally {
      setWorking(undefined)
    }
  }

  const normalizedEventReference = () => {
    const value = recoveryEvent.trim()
    try {
      const url = new URL(value)
      const match = url.pathname.match(/^\/e\/([^/]+)/u)
      return match ? decodeURIComponent(match[1]) : value
    } catch {
      return value.replace(/^\/e\//u, '').split('/')[0]
    }
  }

  const restoreRecoveryFile = async () => {
    if (!recoveryFile) return
    setWorking('file')
    setError(undefined)
    try {
      if (recoveryFile.size > 64 * 1_024) throw new Error('復旧ファイルが大きすぎます')
      const encrypted = JSON.parse(await recoveryFile.text()) as EncryptedOwnerRecoveryKit
      const kit = await decryptOwnerRecoveryKit(encrypted, recoveryPassphrase)
      setRecoveryEvent(kit.eventSlug)
      setRecoveryCode(kit.recoveryCode)
      setRecoveryPassphrase('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '復旧ファイルを読み込めません')
    } finally {
      setWorking(undefined)
    }
  }

  const recoverOwner = async () => {
    setWorking('recover')
    setError(undefined)
    try {
      const recovered = await recoverOwnerAccount(normalizedEventReference(), recoveryCode)
      onSessionChange(recovered.session)
      setReplacementKit(recovered.ownerRecoveryKit)
    } catch (reason) {
      setError(authErrorMessage(reason))
    } finally {
      setWorking(undefined)
    }
  }

  const confirmReplacementKit = async () => {
    if (!replacementKit) return
    await confirmOwnerRecoveryKit(replacementKit.eventSlug, replacementKit.recoveryId)
    window.location.assign(`/e/${encodeURIComponent(replacementKit.eventSlug)}`)
  }

  return (
    <>
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="auth-panel" aria-label="本人確認とパスキー" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span className="eyebrow">セキュリティ</span><strong>本人確認・パスキー</strong></div>
          <button type="button" onClick={onClose} aria-label="閉じる"><X size={20} /></button>
        </header>

        {session.mode === 'authenticated' ? (
          <div className="auth-panel__body">
            <div className="auth-identity-card">
              <span className="auth-identity-icon"><ShieldCheck size={25} /></span>
              <div><span className="eyebrow">認証済み</span><strong>{session.user.displayName}</strong><small>パスキーによる本人確認が有効です</small></div>
              <CheckCircle2 size={20} />
            </div>
            <div className="auth-info-list">
              <div><KeyRound size={17} /><span><strong>大会管理者の重要操作</strong><small>大会作成、確定、権限変更、復元時に再確認します</small></span></div>
              <div><Smartphone size={17} /><span><strong>予備パスキー {security ? `${security.credentialCount}個` : '確認中'}</strong><small>{security?.resilientForEventCreation ? '2個以上のパスキーでアカウント喪失に備えています' : '別端末へ2個目を登録するか、大会ごとの復旧キットを保存します'}</small></span></div>
            </div>
            <button type="button" className="auth-primary" onClick={() => void addPasskey()} disabled={!passkeySupported || Boolean(working)}>{working === 'additional' ? <LoaderCircle className="is-spinning" size={17} /> : <KeyRound size={17} />}このアカウントへ予備パスキーを追加</button>
            <button type="button" className="auth-secondary" onClick={signOut} disabled={Boolean(working)}>
              {working === 'logout' ? <LoaderCircle className="is-spinning" size={17} /> : <LogOut size={17} />}
              この端末からログアウト
            </button>
          </div>
        ) : session.mode === 'offline-demo' ? (
          <div className="auth-panel__body">
            <div className="auth-offline-card"><CloudOff size={28} /><strong>オフラインデモ</strong><p>Pagesでは画面確認と端末内保存を利用できます。パスキーと共有機能はWorkers接続後に有効になります。</p></div>
            <div className="auth-info-list">
              <div><Fingerprint size={17} /><span><strong>本番ではパスキー必須</strong><small>管理者の秘密鍵は端末外へ送信されません</small></span></div>
            </div>
          </div>
        ) : (
          <div className="auth-panel__body">
            <div className="passkey-intro"><span><Fingerprint size={30} /></span><h2>パスワードを使わず安全に参加</h2><p>Face ID、Touch ID、Windows Hello、セキュリティキー等を利用します。</p></div>
            <label className="auth-name-field"><span>大会管理者名</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} autoComplete="name" /></label>
            <button type="button" className="auth-primary" onClick={register} disabled={!passkeySupported || Boolean(working) || displayName.trim().length < 2}>
              {working === 'register' ? <LoaderCircle className="is-spinning" size={18} /> : <Fingerprint size={18} />}
              新しい管理者パスキーを登録
            </button>
            <div className="auth-divider"><span>または</span></div>
            <button type="button" className="auth-secondary" onClick={login} disabled={!passkeySupported || Boolean(working)}>
              {working === 'login' ? <LoaderCircle className="is-spinning" size={18} /> : <KeyRound size={18} />}
              登録済みパスキーでログイン
            </button>
            <div className="auth-divider"><span>管理者端末を失った場合</span></div>
            <button type="button" className="auth-secondary" onClick={() => setShowOwnerRecovery((current) => !current)} disabled={Boolean(working)}><ShieldCheck size={17} />大会オーナー復旧キットを使う</button>
            {showOwnerRecovery && (
              <div className="owner-recovery-form">
                <p>復旧すると旧パスキーと全ログインセッション、使用したコードを失効し、この端末に新しいパスキーを作成します。</p>
                <label><span>大会URLまたは大会ID</span><input value={recoveryEvent} onChange={(event) => setRecoveryEvent(event.target.value)} placeholder="https://…/e/event-slug" /></label>
                <label><span>一回限りの復旧コード</span><input value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} autoCapitalize="characters" autoCorrect="off" placeholder="SRSO-…" /></label>
                <button type="button" className="auth-primary" onClick={() => void recoverOwner()} disabled={!passkeySupported || Boolean(working) || !recoveryEvent.trim() || recoveryCode.trim().length < 20}>{working === 'recover' ? <LoaderCircle className="is-spinning" size={17} /> : <KeyRound size={17} />}新しいパスキーで管理者を復旧</button>
                <div className="auth-divider"><span>暗号化ファイルから入力</span></div>
                <label className="owner-recovery-file"><Upload size={17} /><span>{recoveryFile?.name ?? '.srs-owner-recoveryを選択'}</span><input type="file" accept=".srs-owner-recovery,application/json" onChange={(event) => setRecoveryFile(event.target.files?.[0])} /></label>
                <label><span>ファイルのパスフレーズ</span><input type="password" value={recoveryPassphrase} onChange={(event) => setRecoveryPassphrase(event.target.value)} /></label>
                <button type="button" className="auth-secondary" onClick={() => void restoreRecoveryFile()} disabled={Boolean(working) || !recoveryFile || recoveryPassphrase.length < 10}>{working === 'file' ? <LoaderCircle className="is-spinning" size={17} /> : <Upload size={17} />}復号して入力欄へ反映</button>
              </div>
            )}
            {!passkeySupported && <p className="auth-error">このブラウザはパスキーに対応していません</p>}
          </div>
        )}

        {error && <div className="auth-error" role="alert">{error}</div>}
        <footer>Sailing Race Supporterはパスキーの秘密鍵を保存しません。</footer>
      </aside>
    </div>
    {replacementKit && <OwnerRecoveryKitPanel kit={replacementKit} onConfirm={confirmReplacementKit} />}
    </>
  )
}
