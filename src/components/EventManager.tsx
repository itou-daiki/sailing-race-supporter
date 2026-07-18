import {
  CalendarDays,
  Archive,
  DatabaseBackup,
  Download,
  Check,
  Clipboard,
  ExternalLink,
  KeyRound,
  Link2,
  LocateFixed,
  LoaderCircle,
  Plus,
  Sailboat,
  Share2,
  ShieldCheck,
  Trash2,
  Upload,
  UserPlus,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { OwnerRecoveryKit, SessionState } from '../authClient'
import { CLASS_PROFILES, type RaceDefinition, type SailingClass } from '../domain'
import {
  assignRaceArea,
  createRaceArea,
  createEvent,
  confirmOwnerRecoveryKit,
  listEvents,
  loadRetentionPreview,
  loadRetentionSettings,
  saveRetentionHold,
  saveRetentionPolicy,
  runRetentionNow,
  type EventResources,
  type EventSummary,
  type RetentionPolicy,
  type RetentionHold,
  type RetentionPreview,
} from '../eventClient'
import { createInvite, listInvites, revokeInvite, type InviteRecord } from '../inviteClient'
import {
  decryptBackup,
  encryptBackup,
  requestBackupRestorePreview,
  requestServerBackup,
  restoreServerBackup,
  verifyServerBackup,
  type BackupPayload,
  type BackupRestorePreview,
  type BackupRestoreReport,
  type BackupVerificationReport,
  type EncryptedBackup,
} from '../backup'
import { exportLocalEventData } from '../offlineStore'
import { OwnerRecoveryKitPanel } from './OwnerRecoveryKitPanel'

interface EventManagerProps {
  session: SessionState
  currentEventSlug: string
  currentEventId?: string
  currentEventName: string
  isCurrentEventOwner: boolean
  resources: EventResources
  races: readonly RaceDefinition[]
  assignmentRealtimeAvailable: boolean
  onUpdateAssignment: (input: {
    memberId: string
    assignment: string
    raceAreaId?: string
    committeeBoatId?: string
    markId?: string
    reason: string
  }) => Promise<void>
  onRequestAuthentication: () => void
  onEventStructureChanged: (change?: { raceId: string; revisionId: string; revision: number }) => void
  onRecoverParticipation: () => void
  onClose: () => void
}

function localDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function localDateTime(date: Date): string {
  return `${localDate(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function formatBytes(value: number): string {
  if (value < 1_024 * 1_024) return `${Math.ceil(value / 1_024)} KiB`
  return `${(value / (1_024 * 1_024)).toFixed(1)} MiB`
}

export function EventManager({
  session,
  currentEventSlug,
  currentEventId,
  currentEventName,
  isCurrentEventOwner,
  resources,
  races,
  assignmentRealtimeAvailable,
  onUpdateAssignment,
  onRequestAuthentication,
  onEventStructureChanged,
  onRecoverParticipation,
  onClose,
}: EventManagerProps) {
  const today = useMemo(() => new Date(), [])
  const [events, setEvents] = useState<EventSummary[]>([])
  const [loading, setLoading] = useState(session.mode === 'authenticated')
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const [name, setName] = useState('')
  const [startsOn, setStartsOn] = useState(localDate(today))
  const [endsOn, setEndsOn] = useState(localDate(today))
  const [raceCount, setRaceCount] = useState(3)
  const [className, setClassName] = useState<SailingClass>('470')
  const [courseCode, setCourseCode] = useState('O2')
  const [firstWarningAt, setFirstWarningAt] = useState(localDateTime(new Date(today.getTime() + 60 * 60_000)))
  const [center, setCenter] = useState<{ longitude: number; latitude: number }>()
  const [invites, setInvites] = useState<InviteRecord[]>([])
  const [inviteRole, setInviteRole] = useState('mark-boat')
  const [inviteAreaId, setInviteAreaId] = useState('')
  const [inviteAssignment, setInviteAssignment] = useState('1マーク')
  const [inviteBoatId, setInviteBoatId] = useState('')
  const [inviteMarkId, setInviteMarkId] = useState('')
  const [inviteMaxUses, setInviteMaxUses] = useState(1)
  const [generatedInviteUrl, setGeneratedInviteUrl] = useState<string>()
  const [inviteWorking, setInviteWorking] = useState(false)
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, {
    assignment: string; raceAreaId: string; committeeBoatId: string; markId: string
  }>>({})
  const [assignmentWorkingMemberId, setAssignmentWorkingMemberId] = useState<string>()
  const [areaName, setAreaName] = useState(`海面${String.fromCharCode(65 + Math.min(resources.areas.length, 25))}`)
  const [areaCenter, setAreaCenter] = useState<{ longitude: number; latitude: number }>()
  const [areaWorking, setAreaWorking] = useState(false)
  const [raceAreaDrafts, setRaceAreaDrafts] = useState<Record<string, string>>({})
  const [backupPassphrase, setBackupPassphrase] = useState('')
  const [backupFile, setBackupFile] = useState<File>()
  const [verifiedBackup, setVerifiedBackup] = useState<BackupPayload>()
  const [backupVerification, setBackupVerification] = useState<BackupVerificationReport>()
  const [backupRestorePreview, setBackupRestorePreview] = useState<BackupRestorePreview>()
  const [restoreDownloadReport, setRestoreDownloadReport] = useState<BackupRestoreReport>()
  const [restoreReason, setRestoreReason] = useState('通信障害後の検証済みバックアップからコース版を復元')
  const [backupWorking, setBackupWorking] = useState(false)
  const [backupReport, setBackupReport] = useState<string>()
  const [retention, setRetention] = useState<RetentionPolicy>({
    finalizedRecordsDays: 1_826,
    observationsDays: 365,
    sampledPositionsDays: 90,
    localHighFrequencyTrackDays: 7,
    regularMessagesDays: 90,
    memberProfilesDays: 365,
    authSecretsAfterEventDays: 30,
    securityLogsDays: 365,
  })
  const [retentionWorking, setRetentionWorking] = useState(false)
  const [retentionHold, setRetentionHold] = useState<RetentionHold>({ active: false, until: null, reason: null, indefinite: false })
  const [holdDesiredActive, setHoldDesiredActive] = useState(false)
  const [holdIndefinite, setHoldIndefinite] = useState(true)
  const [holdUntilDate, setHoldUntilDate] = useState(localDate(new Date(today.getTime() + 365 * 86_400_000)))
  const [holdReason, setHoldReason] = useState('抗議・審問・事故調査に関する記録を保全するため')
  const [retentionPreview, setRetentionPreview] = useState<RetentionPreview>()
  const [latestBackupAt, setLatestBackupAt] = useState<string>()
  const [pendingOwnerRecovery, setPendingOwnerRecovery] = useState<{ kit: OwnerRecoveryKit; url: string }>()

  useEffect(() => {
    if (session.mode !== 'authenticated') return
    let active = true
    void listEvents()
      .then((loaded) => { if (active) setEvents(loaded) })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '大会一覧を取得できません') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [session.mode])

  useEffect(() => {
    if (session.mode !== 'authenticated' || !isCurrentEventOwner) return
    let active = true
    void listInvites(currentEventSlug)
      .then((loaded) => { if (active) setInvites(loaded) })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '招待一覧を取得できません') })
    void loadRetentionSettings(currentEventSlug)
      .then((loaded) => {
        if (!active) return
        setRetention(loaded.policy)
        setRetentionHold(loaded.hold)
        setHoldDesiredActive(loaded.hold.active)
        setHoldIndefinite(loaded.hold.indefinite)
        if (loaded.hold.reason) setHoldReason(loaded.hold.reason)
        if (loaded.hold.until && !loaded.hold.indefinite) setHoldUntilDate(localDate(new Date(loaded.hold.until)))
        setLatestBackupAt(loaded.latestBackup?.created_at)
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : '保存期間を取得できません') })
    return () => { active = false }
  }, [currentEventSlug, isCurrentEventOwner, session.mode])

  const shareCurrent = async () => {
    const shareData = { title: currentEventName, text: `${currentEventName}の運営URL`, url: window.location.href }
    if (navigator.share) {
      await navigator.share(shareData)
      return
    }
    await navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2_000)
  }

  const useCurrentLocation = () => {
    setError(undefined)
    navigator.geolocation.getCurrentPosition(
      (position) => setCenter({ longitude: position.coords.longitude, latitude: position.coords.latitude }),
      () => setError('現在地を取得できません。大会作成後に地図を移動して設定できます。'),
      { enableHighAccuracy: true, timeout: 12_000 },
    )
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setCreating(true)
    setError(undefined)
    try {
      const created = await createEvent({
        name: name.trim(),
        startsOn,
        endsOn,
        raceCount,
        className,
        courseCode,
        firstWarningAt: new Date(firstWarningAt).toISOString(),
        center,
      })
      if (created.ownerRecoveryKit) {
        setPendingOwnerRecovery({ kit: created.ownerRecoveryKit, url: created.url })
        setCreating(false)
      } else {
        window.location.assign(created.url)
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '大会を作成できません'
      setError(message)
      if (message.includes('再認証')) onRequestAuthentication()
      setCreating(false)
    }
  }

  const confirmPendingOwnerRecovery = async () => {
    if (!pendingOwnerRecovery) return
    try {
      await confirmOwnerRecoveryKit(
        pendingOwnerRecovery.kit.eventSlug,
        pendingOwnerRecovery.kit.recoveryId,
      )
      window.location.assign(pendingOwnerRecovery.url)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '復旧キットの保存を確定できません'
      if (message.includes('再認証')) onRequestAuthentication()
      throw reason
    }
  }

  const issueInvite = async (event: React.FormEvent) => {
    event.preventDefault()
    setInviteWorking(true)
    setError(undefined)
    try {
      const created = await createInvite(currentEventSlug, {
        role: inviteRole,
        assignment: inviteAssignment.trim(),
        raceAreaId: inviteAreaId || undefined,
        committeeBoatId: inviteBoatId || undefined,
        markId: inviteMarkId || undefined,
        maxUses: inviteMaxUses,
      })
      setGeneratedInviteUrl(new URL(created.url, window.location.origin).href)
      setInvites((current) => [created.invite, ...current])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '招待URLを発行できません')
    } finally {
      setInviteWorking(false)
    }
  }

  const removeInvite = async (inviteId: string) => {
    if (!window.confirm('この招待を失効し、参加済みメンバーのセッションも無効化しますか？')) return
    setInviteWorking(true)
    setError(undefined)
    try {
      await revokeInvite(currentEventSlug, inviteId)
      setInvites((current) => current.map((invite) => invite.id === inviteId ? { ...invite, revoked_at: new Date().toISOString() } : invite))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '招待を失効できません')
    } finally {
      setInviteWorking(false)
    }
  }

  const updateMemberAssignment = async (memberId: string) => {
    const draft = assignmentDrafts[memberId]
    if (!draft?.assignment.trim()) return
    setAssignmentWorkingMemberId(memberId)
    setError(undefined)
    try {
      await onUpdateAssignment({
        memberId,
        assignment: draft.assignment.trim(),
        raceAreaId: draft.raceAreaId || undefined,
        committeeBoatId: draft.committeeBoatId || undefined,
        markId: draft.markId || undefined,
        reason: '大会管理者による担当・操作範囲の変更',
      })
      setAssignmentDrafts((current) => {
        const next = { ...current }
        delete next[memberId]
        return next
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '担当変更を反映できません')
    } finally {
      setAssignmentWorkingMemberId(undefined)
    }
  }

  const useAreaCurrentLocation = () => {
    setError(undefined)
    navigator.geolocation.getCurrentPosition(
      (position) => setAreaCenter({ longitude: position.coords.longitude, latitude: position.coords.latitude }),
      () => setError('追加する海面の中心位置を取得できません。位置情報の許可を確認してください。'),
      { enableHighAccuracy: true, timeout: 12_000 },
    )
  }

  const addRaceArea = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!areaCenter) return
    setAreaWorking(true)
    setError(undefined)
    try {
      await createRaceArea(currentEventSlug, { name: areaName.trim(), center: areaCenter })
      setAreaName(`海面${String.fromCharCode(66 + Math.min(resources.areas.length, 24))}`)
      setAreaCenter(undefined)
      onEventStructureChanged()
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'レースエリアを追加できません'
      setError(message)
      if (message.includes('再認証')) onRequestAuthentication()
    } finally {
      setAreaWorking(false)
    }
  }

  const moveRaceToArea = async (race: RaceDefinition) => {
    const raceAreaId = raceAreaDrafts[race.id] ?? race.raceAreaId
    if (!raceAreaId || raceAreaId === race.raceAreaId) return
    setAreaWorking(true)
    setError(undefined)
    try {
      const changed = await assignRaceArea(currentEventSlug, race.id, raceAreaId)
      if (changed.revisionId && changed.revision != null) {
        onEventStructureChanged({ raceId: race.id, revisionId: changed.revisionId, revision: changed.revision })
      } else {
        onEventStructureChanged()
      }
      setRaceAreaDrafts((current) => {
        const next = { ...current }
        delete next[race.id]
        return next
      })
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'レースの海面を変更できません'
      setError(message)
      if (message.includes('再認証')) onRequestAuthentication()
    } finally {
      setAreaWorking(false)
    }
  }

  const downloadBackup = async () => {
    setBackupWorking(true)
    setError(undefined)
    setBackupReport(undefined)
    try {
      const [server, localText] = await Promise.all([
        requestServerBackup(currentEventSlug),
        exportLocalEventData(currentEventSlug),
      ])
      const encrypted = await encryptBackup({ server, local: JSON.parse(localText) }, backupPassphrase)
      const content = JSON.stringify(encrypted)
      const url = URL.createObjectURL(new Blob([content], { type: 'application/vnd.sailing-race-supporter.backup+json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${currentEventSlug}-${new Date().toISOString().slice(0, 10)}.srs-backup`
      anchor.click()
      URL.revokeObjectURL(url)
      const size = new Blob([content]).size
      setBackupReport(`暗号化バックアップを端末へ保存しました（${formatBytes(size)}・監査連番 ${server.manifest.eventSequence}）`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'バックアップを作成できません')
    } finally {
      setBackupWorking(false)
    }
  }

  const verifyBackup = async () => {
    if (!backupFile) return
    setBackupWorking(true)
    setError(undefined)
    setBackupReport(undefined)
    setBackupVerification(undefined)
    setBackupRestorePreview(undefined)
    setRestoreDownloadReport(undefined)
    try {
      if (backupFile.size > 25 * 1_024 * 1_024) throw new Error('バックアップは25 MiB以下を選択してください')
      let encrypted: EncryptedBackup
      try {
        encrypted = JSON.parse(await backupFile.text()) as EncryptedBackup
      } catch {
        throw new Error('バックアップファイルが正しいJSONではありません')
      }
      const verified = await decryptBackup(encrypted, backupPassphrase)
      if (verified.server.event.slug !== currentEventSlug) throw new Error('選択中の大会とは異なるバックアップです')
      if (currentEventId && verified.server.event.id !== currentEventId) throw new Error('大会IDが選択中の大会と一致しません')
      const verification = await verifyServerBackup(verified.server)
      setBackupVerification(verification)
      if (!verification.valid) throw new Error('バックアップ内部の整合性検証に失敗しました。復元はできません')
      setVerifiedBackup(verified)
      const preview = await requestBackupRestorePreview(currentEventSlug, verified.server)
      setBackupRestorePreview(preview)
      setBackupReport(`復元前検証に成功：${verification.event.name}・差分あり ${preview.restorableCount}レース・監査連番 ${verification.auditSequence}`)
    } catch (reason) {
      setVerifiedBackup(undefined)
      setError(reason instanceof Error ? reason.message : 'バックアップを検証できません')
    } finally {
      setBackupWorking(false)
    }
  }

  const restoreBackup = async () => {
    if (!verifiedBackup || !backupRestorePreview) return
    if (!window.confirm(`現在のデータを上書きせず、差分のある未確定 ${backupRestorePreview.restorableCount}レースに新しいコース復元版を作成します。続けますか？`)) return
    setBackupWorking(true)
    setError(undefined)
    try {
      const result = await restoreServerBackup(
        currentEventSlug,
        verifiedBackup.server,
        restoreReason,
        backupRestorePreview.stateHash,
      )
      setRestoreDownloadReport(result.report)
      setBackupReport(`${result.restored.length}レースに復元版を作成しました。監査連番 ${result.report.audit.sequence}・レポートを保存できます`)
      setVerifiedBackup(undefined)
      setBackupRestorePreview(undefined)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'バックアップを復元できません'
      setError(message)
      if (message.includes('再認証')) onRequestAuthentication()
    } finally {
      setBackupWorking(false)
    }
  }

  const downloadRestoreReport = () => {
    if (!restoreDownloadReport) return
    const content = JSON.stringify(restoreDownloadReport, null, 2)
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${currentEventSlug}-restore-${restoreDownloadReport.restoreId}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const saveRetention = async () => {
    setRetentionWorking(true)
    setError(undefined)
    try {
      setRetention(await saveRetentionPolicy(currentEventSlug, retention))
      setRetentionPreview(undefined)
      setBackupReport('大会の保存期間ポリシーを監査ログ付きで更新しました')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '保存期間を更新できません'
      setError(message)
      if (message.includes('再認証')) onRequestAuthentication()
    } finally {
      setRetentionWorking(false)
    }
  }

  const saveHold = async () => {
    setRetentionWorking(true)
    setError(undefined)
    try {
      const hold = await saveRetentionHold(currentEventSlug, {
        active: holdDesiredActive,
        until: holdDesiredActive && !holdIndefinite ? new Date(`${holdUntilDate}T23:59:59.999`).toISOString() : null,
        reason: holdReason,
      })
      setRetentionHold(hold)
      setRetentionPreview(undefined)
      setBackupReport(hold.active ? `保存ホールドを設定しました（${hold.indefinite ? '解除まで無期限' : hold.until}）` : '保存ホールドを解除し、履歴へ記録しました')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '保存ホールドを更新できません'
      setError(message)
      if (message.includes('再認証')) onRequestAuthentication()
    } finally {
      setRetentionWorking(false)
    }
  }

  const previewRetention = async () => {
    setRetentionWorking(true)
    setError(undefined)
    try {
      const preview = await loadRetentionPreview(currentEventSlug)
      setRetentionPreview(preview)
      setLatestBackupAt(preview.lastBackupAt ?? undefined)
      setBackupReport(preview.hold.active
        ? `保存ホールド中です。削除候補 ${preview.expiredCount}件は処理されません`
        : `現在の保存期間による期限到来候補は ${preview.expiredCount}件です`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '削除候補を確認できません')
    } finally {
      setRetentionWorking(false)
    }
  }

  const runRetention = async () => {
    if (!retentionPreview) {
      await previewRetention()
      return
    }
    const destructive = retentionPreview.items.filter((item) => item.expired && item.count > 0 && item.key !== 'finalizedRecordsDays' && item.key !== 'localHighFrequencyTrackDays')
    if (!window.confirm(`${destructive.reduce((sum, item) => sum + item.count, 0)}件を保存期間に従って削除・匿名化します。最終バックアップ: ${latestBackupAt ? formatTimestamp(latestBackupAt) : '記録なし'}。続けますか？`)) return
    setRetentionWorking(true)
    setError(undefined)
    try {
      const report = await runRetentionNow(currentEventSlug)
      const affected = Object.values(report.counts).reduce((sum, count) => sum + count, 0)
      setBackupReport(`${report.detail}（処理 ${affected}件）`)
      setRetentionPreview(undefined)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '保存期間処理を実行できません'
      setError(message)
      if (message.includes('再認証')) onRequestAuthentication()
    } finally {
      setRetentionWorking(false)
    }
  }

  return (
    <>
    <div className="drawer-backdrop" role="presentation" onMouseDown={pendingOwnerRecovery ? undefined : onClose}>
      <aside className="event-manager" aria-label="大会URLと大会作成" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div><span className="eyebrow">固定共有URL</span><strong>大会を選択・作成</strong></div>
          <button type="button" onClick={onClose} aria-label="閉じる"><X size={20} /></button>
        </header>

        <section className="event-current-card">
          <div><span className="eyebrow">現在の大会</span><strong>{currentEventName}</strong><small>/e/{currentEventSlug}</small></div>
          <button type="button" onClick={() => void shareCurrent()}>{copied ? <Check size={17} /> : <Share2 size={17} />}{copied ? 'コピー済み' : 'URLを共有'}</button>
        </section>

        <button type="button" className="event-recovery-link" onClick={onRecoverParticipation}><KeyRound size={16} />参加復元カードから担当を復元</button>

        {session.mode !== 'authenticated' ? (
          <section className="event-auth-required">
            <ShieldCheck size={31} />
            <h2>大会の発行には本人確認が必要です</h2>
            <p>大会URLを発行したパスキー認証済みユーザーが、唯一の大会管理者になります。</p>
            <button type="button" onClick={onRequestAuthentication}>パスキーを登録・ログイン</button>
          </section>
        ) : (
          <>
            <section className="event-list-section">
              <div className="event-section-title"><span><Sailboat size={17} />参加中の大会</span><small>{events.length}件</small></div>
              {loading ? <div className="event-loading"><LoaderCircle className="is-spinning" size={20} /> 読み込み中</div> : events.length ? (
                <div className="event-list">
                  {events.map((item) => (
                    <a href={`/e/${encodeURIComponent(item.slug)}`} className={item.slug === currentEventSlug ? 'is-current' : ''} key={item.id}>
                      <span><strong>{item.name}</strong><small>{item.starts_on}〜{item.ends_on}・{item.relationship === 'owner' ? '大会管理者' : item.assignment}</small></span>
                      <ExternalLink size={16} />
                    </a>
                  ))}
                </div>
              ) : <p className="event-empty">作成・参加済みの大会はまだありません。</p>}
            </section>

            {isCurrentEventOwner && (
              <section className="race-area-manager-section">
                <div className="event-section-title"><span><LocateFixed size={17} />大会内のレースエリア</span><small>{resources.areas.length}/6海面</small></div>
                <div className="race-area-list">
                  {resources.areas.map((area) => <article key={area.id}>
                    <span><strong>{area.name}</strong><small>{area.centerLat != null && area.centerLng != null ? `${area.centerLat.toFixed(5)}, ${area.centerLng.toFixed(5)}` : '中心位置未設定'}</small></span>
                    <b>{races.filter((race) => race.raceAreaId === area.id).length}レース</b>
                  </article>)}
                </div>
                {resources.areas.length < 6 && <form className="race-area-create" onSubmit={(event) => void addRaceArea(event)}>
                  <label className="event-field"><span>追加する海面名</span><input value={areaName} minLength={2} maxLength={50} onChange={(event) => setAreaName(event.target.value)} required /></label>
                  <button type="button" className={`event-location-button ${areaCenter ? 'is-set' : ''}`} onClick={useAreaCurrentLocation}>
                    <LocateFixed size={16} />{areaCenter ? `中心 ${areaCenter.latitude.toFixed(5)}, ${areaCenter.longitude.toFixed(5)}` : '現在地を新しい海面中心にする'}
                  </button>
                  <button type="submit" className="invite-issue-button" disabled={areaWorking || !areaCenter || areaName.trim().length < 2}>{areaWorking ? <LoaderCircle className="is-spinning" size={17} /> : <Plus size={17} />}標準マーク付きで海面を追加</button>
                </form>}
                {resources.areas.length > 1 && <div className="race-area-assignments">
                  <p>開始前のレースだけ移動できます。旧コース版を残し、新海面の標準マークに対応した版を作成します。</p>
                  {races.map((race) => {
                    const draft = raceAreaDrafts[race.id] ?? race.raceAreaId ?? ''
                    return <article key={race.id}>
                      <span><strong>{race.number}</strong><small>{race.className}・{race.status === 'planning' ? '開始前' : '進行済み／移動不可'}</small></span>
                      <select value={draft} disabled={race.status !== 'planning' || areaWorking} onChange={(event) => setRaceAreaDrafts((current) => ({ ...current, [race.id]: event.target.value }))}>{resources.areas.map((area) => <option value={area.id} key={area.id}>{area.name}</option>)}</select>
                      <button type="button" disabled={race.status !== 'planning' || areaWorking || draft === race.raceAreaId} onClick={() => void moveRaceToArea(race)}>反映</button>
                    </article>
                  })}
                </div>}
              </section>
            )}

            {isCurrentEventOwner && (
              <section className="invite-manager-section">
                <div className="event-section-title"><span><UserPlus size={17} />役割・担当別の招待URL</span><small>管理者のみ</small></div>
                <form className="invite-create-form" onSubmit={(event) => void issueInvite(event)}>
                  <div className="event-form-grid">
                    <label className="event-field"><span>役割</span><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}><option value="mark-boat">マークボート</option><option value="signal-boat">シグナルボート</option><option value="course-setter">コースセッター</option><option value="safety-boat">安全ボート</option><option value="jury">ジュリー</option><option value="protest">プロテスト</option><option value="pro">PRO</option><option value="ro">RO</option><option value="viewer">閲覧者</option></select></label>
                    <label className="event-field"><span>表示する担当</span><input value={inviteAssignment} onChange={(event) => setInviteAssignment(event.target.value)} maxLength={100} required /></label>
                    <label className="event-field"><span>担当レースエリア</span><select value={inviteAreaId} onChange={(event) => { setInviteAreaId(event.target.value); setInviteMarkId('') }}><option value="">大会全体</option>{resources.areas.map((area) => <option value={area.id} key={area.id}>{area.name}</option>)}</select></label>
                    <label className="event-field"><span>担当運営ボート</span><select value={inviteBoatId} onChange={(event) => {
                      setInviteBoatId(event.target.value)
                      const boat = resources.boats.find((item) => item.id === event.target.value)
                      if (boat && !inviteMarkId) setInviteAssignment(boat.assignment)
                    }}><option value="">指定なし</option>{resources.boats.map((boat) => <option value={boat.id} key={boat.id}>{boat.name}／{boat.assignment}</option>)}</select></label>
                    <label className="event-field"><span>担当マーク</span><select value={inviteMarkId} onChange={(event) => {
                      setInviteMarkId(event.target.value)
                      const mark = resources.marks.find((item) => item.id === event.target.value)
                      if (mark) { setInviteAssignment(mark.label); if (mark.raceAreaId) setInviteAreaId(mark.raceAreaId) }
                    }}><option value="">指定なし</option>{resources.marks.filter((mark) => !inviteAreaId || !mark.raceAreaId || mark.raceAreaId === inviteAreaId).map((mark) => <option value={mark.id} key={mark.id}>{mark.label}</option>)}</select></label>
                    <label className="event-field"><span>使用可能人数</span><input type="number" min="1" max="500" value={inviteMaxUses} onChange={(event) => setInviteMaxUses(Number(event.target.value))} /></label>
                  </div>
                  <button type="submit" className="invite-issue-button" disabled={inviteWorking || !inviteAssignment.trim()}>{inviteWorking ? <LoaderCircle className="is-spinning" size={17} /> : <Link2 size={17} />}招待URLを発行</button>
                </form>
                {generatedInviteUrl && (
                  <div className="generated-invite">
                    <span><strong>今だけ表示される招待URL</strong><small>秘密値は再表示できません。必要な相手へ安全に共有してください。</small></span>
                    <code>{generatedInviteUrl}</code>
                    <button type="button" onClick={() => void navigator.clipboard.writeText(generatedInviteUrl)}><Clipboard size={16} />コピー</button>
                  </div>
                )}
                {invites.length > 0 && <div className="invite-list">{invites.slice(0, 10).map((invite) => (
                  <div className={invite.revoked_at ? 'is-revoked' : ''} key={invite.id}>
                    <span><strong>{invite.assignment}</strong><small>{invite.role}・使用 {invite.use_count}/{invite.max_uses ?? '∞'}{invite.revoked_at ? '・失効済み' : ''}</small></span>
                    {!invite.revoked_at && <button type="button" onClick={() => void removeInvite(invite.id)} aria-label="招待を失効"><Trash2 size={15} /></button>}
                  </div>
                ))}</div>}
              </section>
            )}

            {isCurrentEventOwner && resources.members.some((member) => member.role !== 'owner') && (
              <section className="member-assignment-section">
                <div className="event-section-title"><span><UserPlus size={17} />参加者の現在担当</span><small>即時反映・追記監査</small></div>
                <p>変更対象の旧接続を切り、最新の海面・運営ボート・マーク権限で自動再接続します。</p>
                <div className="member-assignment-list">
                  {resources.members.filter((member) => member.role !== 'owner').map((member) => {
                    const draft = assignmentDrafts[member.id] ?? {
                      assignment: member.assignment,
                      raceAreaId: member.raceAreaId ?? '',
                      committeeBoatId: member.committeeBoatId ?? '',
                      markId: member.markId ?? '',
                    }
                    const marksForArea = resources.marks.filter((mark) => !draft.raceAreaId || !mark.raceAreaId || mark.raceAreaId === draft.raceAreaId)
                    return <article key={member.id}>
                      <header><span><strong>{member.displayName}</strong><small>{member.role}・現在 {member.assignment}</small></span></header>
                      <div className="event-form-grid">
                        <label className="event-field"><span>表示する担当</span><input value={draft.assignment} maxLength={100} onChange={(event) => setAssignmentDrafts((current) => ({ ...current, [member.id]: { ...draft, assignment: event.target.value } }))} /></label>
                        <label className="event-field"><span>レースエリア</span><select value={draft.raceAreaId} onChange={(event) => setAssignmentDrafts((current) => ({ ...current, [member.id]: { ...draft, raceAreaId: event.target.value, markId: '' } }))}><option value="">大会全体</option>{resources.areas.map((area) => <option value={area.id} key={area.id}>{area.name}</option>)}</select></label>
                        <label className="event-field"><span>運営ボート</span><select value={draft.committeeBoatId} onChange={(event) => {
                          const boat = resources.boats.find((candidate) => candidate.id === event.target.value)
                          setAssignmentDrafts((current) => ({ ...current, [member.id]: { ...draft, committeeBoatId: event.target.value, assignment: boat?.assignment ?? draft.assignment } }))
                        }}><option value="">指定なし</option>{resources.boats.map((boat) => <option value={boat.id} key={boat.id}>{boat.name}／{boat.assignment}</option>)}</select></label>
                        <label className="event-field"><span>マーク</span><select value={draft.markId} onChange={(event) => {
                          const mark = resources.marks.find((candidate) => candidate.id === event.target.value)
                          setAssignmentDrafts((current) => ({ ...current, [member.id]: { ...draft, markId: event.target.value, raceAreaId: mark?.raceAreaId ?? draft.raceAreaId, assignment: mark?.label ?? draft.assignment } }))
                        }}><option value="">指定なし</option>{marksForArea.map((mark) => <option value={mark.id} key={mark.id}>{mark.label}</option>)}</select></label>
                      </div>
                      <button type="button" className="invite-issue-button" disabled={!assignmentRealtimeAvailable || assignmentWorkingMemberId === member.id || !draft.assignment.trim()} onClick={() => void updateMemberAssignment(member.id)}>
                        {assignmentWorkingMemberId === member.id ? <LoaderCircle className="is-spinning" size={17} /> : <ShieldCheck size={17} />}担当と権限を反映
                      </button>
                    </article>
                  })}
                </div>
              </section>
            )}

            {isCurrentEventOwner && (
              <section className="backup-manager-section">
                <div className="event-section-title"><span><DatabaseBackup size={17} />暗号化ローカルバックアップ</span><small>AES-GCM</small></div>
                <div className="backup-manager-card">
                  <label className="event-field"><span>端末内だけで使うパスフレーズ（10文字以上）</span><input type="password" value={backupPassphrase} onChange={(event) => { setBackupPassphrase(event.target.value); setVerifiedBackup(undefined); setBackupVerification(undefined); setBackupRestorePreview(undefined) }} autoComplete="new-password" placeholder="忘れると復元できません" /></label>
                  <p>パスフレーズと復号鍵はサーバーへ送信しません。認証Cookie、招待秘密、復元コード、パスキー秘密鍵もバックアップへ含めません。</p>
                  <div className="backup-cloud-option"><ShieldCheck size={19} /><span><strong>課金のない端末保存</strong><small>R2は使用しません。ファイルを2台以上の端末や外部メディアへコピーしてください</small></span></div>
                  <button type="button" className="backup-primary" onClick={() => void downloadBackup()} disabled={backupWorking || backupPassphrase.length < 10}>{backupWorking ? <LoaderCircle className="is-spinning" size={17} /> : <DatabaseBackup size={17} />}大会記録を暗号化して保存</button>
                  <p>Cloudflare D1には無料のTime Travelが常時有効で、過去7日以内のサーバーデータを管理者が復旧できます。長期保管はこの暗号化ファイルを使います。</p>
                  <div className="backup-divider"><span>検証・復元</span></div>
                  <label className="backup-file"><Upload size={18} /><span>{backupFile?.name ?? '.srs-backupファイルを選択（25 MiB以下）'}</span><input type="file" accept=".srs-backup,application/json" onChange={(event) => { setBackupFile(event.target.files?.[0]); setVerifiedBackup(undefined); setBackupVerification(undefined); setBackupRestorePreview(undefined) }} /></label>
                  <button type="button" className="backup-secondary" onClick={() => void verifyBackup()} disabled={backupWorking || !backupFile || backupPassphrase.length < 10}>復号してハッシュをローカル検証</button>
                  {backupVerification && (
                    <div className={`backup-verification ${backupVerification.valid ? 'is-valid' : 'is-invalid'}`}>
                      <header><span>{backupVerification.valid ? <Check size={17} /> : <X size={17} />}<strong>{backupVerification.valid ? '復元可能' : '整合性エラー'}</strong></span><small>{backupVerification.totalRecords}件・{backupVerification.sectionCount}セクション</small></header>
                      <div className="backup-verification__checks">
                        {[
                          ['eventIdentity', '大会ID・固定URL・大会名'],
                          ['dataHash', '大会データ全体 SHA-256'],
                          ['sectionCounts', 'セクション別レコード件数'],
                          ['auditChain', '監査ログの連番・ハッシュチェーン'],
                          ['auditRoot', `監査最終ルート（連番 ${backupVerification.auditSequence}）`],
                          ['serverSignature', 'Ed25519 サーバー署名'],
                        ].map(([key, label]) => {
                          const valid = backupVerification.checks[key as keyof BackupVerificationReport['checks']]
                          return <span className={valid ? 'is-valid' : 'is-invalid'} key={key}>{valid ? <Check size={13} /> : <X size={13} />}{label}</span>
                        })}
                      </div>
                      {backupVerification.issues.length > 0 && <ul>{backupVerification.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
                      <p>作成 {formatTimestamp(backupVerification.createdAt)}・形式 v{backupVerification.schemaVersion}。この検証は端末内で行われ、パスフレーズは送信されません。</p>
                    </div>
                  )}
                  {backupRestorePreview && (
                    <div className="backup-restore-preview">
                      <header><strong>現在の大会との差分</strong><small>復元 {backupRestorePreview.restorableCount}・確定済み {backupRestorePreview.finalizedSkippedCount}・同一 {backupRestorePreview.unchangedSkippedCount}</small></header>
                      <div>{backupRestorePreview.items.map((item) => {
                        const actionLabel = item.action === 'restore' ? `復元版 v${item.createdRevision}を作成` : item.action === 'skip-finalized' ? '確定済み・変更しない' : item.action === 'skip-unchanged' ? '同一・変更しない' : '元版なし'
                        return <article className={item.action === 'restore' ? 'is-restore' : ''} key={item.raceId}><span><strong>{item.raceNumber}</strong><small>現在 v{item.currentRevision} {item.currentCourseCode ?? '—'} → 保存 v{item.sourceRevision ?? '—'} {item.sourceCourseCode ?? '—'}</small></span><span><b>{actionLabel}</b><small>{item.differences.length ? item.differences.join('・') : `${item.sourceNodeCount}ノード`}</small></span></article>
                      })}</div>
                      <p>差分確認後にコースや確定状態が変わった場合、復元は停止して再確認を求めます。</p>
                    </div>
                  )}
                  {verifiedBackup && backupRestorePreview && <div className="backup-restore-controls"><label className="event-field"><span>復元理由（監査ログへ記録）</span><textarea value={restoreReason} onChange={(event) => setRestoreReason(event.target.value)} minLength={5} maxLength={500} /></label><button type="button" onClick={() => void restoreBackup()} disabled={backupWorking || restoreReason.trim().length < 5 || backupRestorePreview.restorableCount === 0}>{backupRestorePreview.restorableCount > 0 ? `${backupRestorePreview.restorableCount}レースを新しい復元版として反映` : '復元が必要な差分はありません'}</button></div>}
                  {restoreDownloadReport && <button type="button" className="backup-report-download" onClick={downloadRestoreReport}><Download size={16} />監査情報付き復元レポートJSONを保存</button>}
                  {backupReport && <div className="backup-report"><Check size={16} />{backupReport}</div>}
                </div>
              </section>
            )}

            {isCurrentEventOwner && (
              <section className="retention-manager-section">
                <div className="event-section-title"><span><Archive size={17} />データ保存期間</span><small>大会終了日から</small></div>
                <div className="retention-card">
                  <div className="retention-grid">
                    <label className="event-field"><span>確定版・監査記録（日）</span><input type="number" min="1" max="36500" value={retention.finalizedRecordsDays} onChange={(event) => setRetention((current) => ({ ...current, finalizedRecordsDays: Number(event.target.value) }))} /></label>
                    <label className="event-field"><span>風・潮流観測（日）</span><input type="number" min="1" max="36500" value={retention.observationsDays} onChange={(event) => setRetention((current) => ({ ...current, observationsDays: Number(event.target.value) }))} /></label>
                    <label className="event-field"><span>D1位置サンプル（日）</span><input type="number" min="1" max="36500" value={retention.sampledPositionsDays} onChange={(event) => setRetention((current) => ({ ...current, sampledPositionsDays: Number(event.target.value) }))} /></label>
                    <label className="event-field"><span>通常メッセージ（日）</span><input type="number" min="1" max="36500" value={retention.regularMessagesDays} onChange={(event) => setRetention((current) => ({ ...current, regularMessagesDays: Number(event.target.value) }))} /></label>
                    <label className="event-field"><span>名前・担当（日）</span><input type="number" min="1" max="36500" value={retention.memberProfilesDays} onChange={(event) => setRetention((current) => ({ ...current, memberProfilesDays: Number(event.target.value) }))} /></label>
                    <label className="event-field"><span>招待・復元秘密（日）</span><input type="number" min="1" max="36500" value={retention.authSecretsAfterEventDays} onChange={(event) => setRetention((current) => ({ ...current, authSecretsAfterEventDays: Number(event.target.value) }))} /></label>
                  </div>
                  <p>初期推奨は確定・監査5年、観測・名前・担当1年、位置・通常メッセージ90日、招待・復元秘密30日です。期間短縮前に暗号化バックアップを端末へ保存してください。</p>
                  <div className={`retention-hold ${retentionHold.active ? 'is-active' : ''}`}>
                    <div className="retention-hold__status">
                      <ShieldCheck size={19} />
                      <span>
                        <strong>{retentionHold.active ? '保存ホールド中' : '保存ホールドなし'}</strong>
                        <small>{retentionHold.active ? `${retentionHold.indefinite ? '解除まで無期限' : retentionHold.until ? formatTimestamp(retentionHold.until) : '期限未設定'}・${retentionHold.reason}` : '抗議、審問、事故調査中の自動削除を停止できます'}</small>
                      </span>
                    </div>
                    <label className="retention-hold__toggle"><input type="checkbox" checked={holdDesiredActive} onChange={(event) => {
                      const active = event.target.checked
                      setHoldDesiredActive(active)
                      if (!active && retentionHold.active) setHoldReason('調査・審問が完了したため保存ホールドを解除')
                      if (active && !retentionHold.active) setHoldReason('抗議・審問・事故調査に関する記録を保全するため')
                    }} /><span>{holdDesiredActive ? 'ホールドを有効にする' : 'ホールドを使用しない'}</span></label>
                    <label className="event-field"><span>{retentionHold.active && !holdDesiredActive ? '解除理由' : '保全理由'}（監査ログに保存）</span><textarea value={holdReason} onChange={(event) => setHoldReason(event.target.value)} minLength={5} maxLength={500} rows={2} /></label>
                    {holdDesiredActive && (
                      <div className="retention-hold__period">
                        <label><input type="checkbox" checked={holdIndefinite} onChange={(event) => setHoldIndefinite(event.target.checked)} />解除操作まで無期限</label>
                        {!holdIndefinite && <label className="event-field"><span>ホールド終了日</span><input type="date" min={localDate(new Date(today.getTime() + 86_400_000))} value={holdUntilDate} onChange={(event) => setHoldUntilDate(event.target.value)} /></label>}
                      </div>
                    )}
                    <button type="button" className="retention-hold__save" onClick={() => void saveHold()} disabled={retentionWorking || holdReason.trim().length < 5 || !retentionHold.active && !holdDesiredActive}>{retentionHold.active && !holdDesiredActive ? '保存ホールドを解除' : !retentionHold.active && !holdDesiredActive ? 'ホールドを有効にすると記録できます' : '保存ホールドを記録'}</button>
                  </div>
                  {retentionPreview && (
                    <div className="retention-preview">
                      <header><strong>削除・匿名化プレビュー</strong><small>大会終了 {retentionPreview.eventEndsOn}・{retentionPreview.hold.active ? 'ホールド中' : '実行可能'}</small></header>
                      <div className="retention-preview__list">
                        {retentionPreview.items.map((item) => (
                          <div className={item.expired ? 'is-expired' : ''} key={item.key}>
                            <span><strong>{item.label}</strong><small>{item.operation}・期限 {formatTimestamp(item.expiresAt)}</small></span>
                            <b>{item.expired ? `${item.count}件` : '未到来'}</b>
                          </div>
                        ))}
                      </div>
                      <p>最終バックアップ: {retentionPreview.lastBackupAt ? formatTimestamp(retentionPreview.lastBackupAt) : '記録なし'}</p>
                    </div>
                  )}
                  <div className="retention-actions">
                    <button type="button" onClick={() => void saveRetention()} disabled={retentionWorking}>{retentionWorking ? <LoaderCircle className="is-spinning" size={17} /> : <Archive size={17} />}保存期間を更新</button>
                    <button type="button" onClick={() => void previewRetention()} disabled={retentionWorking}><Check size={17} />削除対象を確認</button>
                    <button type="button" className="is-danger" onClick={() => void runRetention()} disabled={retentionWorking || retentionHold.active}><Trash2 size={17} />{retentionPreview ? '確認した対象を処理' : '期限到来分を今すぐ処理'}</button>
                  </div>
                </div>
              </section>
            )}

            <form className="event-create-form" onSubmit={submit}>
              <div className="event-section-title"><span><Plus size={17} />新しい大会URLを発行</span></div>
              <label className="event-field event-field--wide"><span>大会名</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="例：2026 江の島サマーレガッタ" minLength={2} maxLength={100} required /></label>
              <div className="event-form-grid">
                <label className="event-field"><span>開始日</span><input type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} required /></label>
                <label className="event-field"><span>終了日</span><input type="date" min={startsOn} value={endsOn} onChange={(event) => setEndsOn(event.target.value)} required /></label>
                <label className="event-field"><span>レース数</span><input type="number" min="1" max="20" value={raceCount} onChange={(event) => setRaceCount(Number(event.target.value))} required /></label>
                <label className="event-field"><span>競技ヨットクラス</span><select value={className} onChange={(event) => setClassName(event.target.value as SailingClass)}>{CLASS_PROFILES.map((profile) => <option key={profile.className}>{profile.className}</option>)}</select></label>
                <label className="event-field"><span>初期コース</span><select value={courseCode} onChange={(event) => setCourseCode(event.target.value)}><option>O2</option><option>I2</option><option>L2</option><option>L3</option><option>W2</option><option>トライアングル</option></select></label>
                <label className="event-field"><span>1R 予告予定</span><input type="datetime-local" value={firstWarningAt} onChange={(event) => setFirstWarningAt(event.target.value)} required /></label>
              </div>
              <button type="button" className={`event-location-button ${center ? 'is-set' : ''}`} onClick={useCurrentLocation}>
                <LocateFixed size={17} />{center ? `海面中心 ${center.latitude.toFixed(4)}, ${center.longitude.toFixed(4)}` : '現在地を海面中心にする'}
              </button>
              <div className="event-create-note"><CalendarDays size={17} /><p>大会内の1R〜{raceCount}R、海面A、標準マークと運営ボートを作成します。予備パスキーが2個未満の場合は、発行直後に一回限りのオーナー復旧キットを保存します。</p></div>
              <button type="submit" className="event-create-submit" disabled={creating || name.trim().length < 2}>
                {creating ? <LoaderCircle className="is-spinning" size={18} /> : <Clipboard size={18} />}
                {creating ? '大会URLを発行中…' : '大会URLを発行する'}
              </button>
            </form>
          </>
        )}
        {error && <div className="auth-error" role="alert">{error}</div>}
      </aside>
    </div>
    {pendingOwnerRecovery && <OwnerRecoveryKitPanel kit={pendingOwnerRecovery.kit} onConfirm={confirmPendingOwnerRecovery} />}
    </>
  )
}
