import { ListChecks, Map as MapIcon, Menu, MessageSquareText, Wind } from 'lucide-react'

interface MobileCommandDockProps {
  activeView: 'map' | 'operations'
  messageCount: number
  windEnabled: boolean
  onShowMap: () => void
  onShowOperations: () => void
  onOpenWind: () => void
  onOpenMessages: () => void
  onOpenMenu: () => void
}

export function MobileCommandDock({
  activeView,
  messageCount,
  windEnabled,
  onShowMap,
  onShowOperations,
  onOpenWind,
  onOpenMessages,
  onOpenMenu,
}: MobileCommandDockProps) {
  return (
    <nav className="mobile-command-dock" aria-label="主要操作">
      <button type="button" className={activeView === 'map' ? 'is-active' : ''} aria-current={activeView === 'map' ? 'page' : undefined} onClick={onShowMap}>
        <MapIcon size={21} /><span>海面</span>
      </button>
      <button type="button" className={activeView === 'operations' ? 'is-active' : ''} aria-current={activeView === 'operations' ? 'page' : undefined} onClick={onShowOperations}>
        <ListChecks size={21} /><span>やること</span>
      </button>
      <button
        type="button"
        className="mobile-command-dock__primary"
        disabled={!windEnabled}
        aria-label={windEnabled ? '風を記録' : '風の記録（この担当では権限がありません）'}
        onClick={onOpenWind}
      >
        <Wind size={21} /><span>{windEnabled ? '風を記録' : '風（権限外）'}</span>
      </button>
      <button type="button" onClick={onOpenMessages}>
        <MessageSquareText size={21} /><span>連絡</span>
        {messageCount > 0 && <i aria-label={`要確認 ${messageCount}件`}>{messageCount > 99 ? '99+' : messageCount}</i>}
      </button>
      <button type="button" onClick={onOpenMenu}>
        <Menu size={21} /><span>設定</span>
      </button>
    </nav>
  )
}
