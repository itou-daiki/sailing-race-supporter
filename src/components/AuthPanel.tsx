import {
  CheckCircle2,
  CloudOff,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  LogOut,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react'
import { useState } from 'react'
import {
  authErrorMessage,
  authenticatePasskey,
  logout,
  registerPasskey,
  type SessionState,
} from '../authClient'

interface AuthPanelProps {
  session: SessionState
  onSessionChange: (session: SessionState) => void
  onClose: () => void
}

export function AuthPanel({ session, onSessionChange, onClose }: AuthPanelProps) {
  const [displayName, setDisplayName] = useState('伊藤 大輝')
  const [working, setWorking] = useState<'register' | 'login' | 'logout'>()
  const [error, setError] = useState<string>()
  const passkeySupported = typeof PublicKeyCredential !== 'undefined'

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

  return (
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
              <div><Smartphone size={17} /><span><strong>予備パスキー</strong><small>管理者は別端末にも2個目のパスキー登録を推奨します</small></span></div>
            </div>
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
            {!passkeySupported && <p className="auth-error">このブラウザはパスキーに対応していません</p>}
          </div>
        )}

        {error && <div className="auth-error" role="alert">{error}</div>}
        <footer>Sailing Race Supporterはパスキーの秘密鍵を保存しません。</footer>
      </aside>
    </div>
  )
}
