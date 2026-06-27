import { useState, useCallback, useRef, useEffect } from 'react'
import {
  MessageSquare,
  Network,
  Settings,
  Search,
  MoreVertical,
  Pencil,
  Trash2,
  Star,
  StarOff,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import type { Chat } from '../../../../shared/types'

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function timeAgo(ts: number): string {
  const diff = (Date.now() - ts) / 1000
  if (diff < 60)    return 'just now'
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function groupChats(chats: Chat[]): { label: string; items: Chat[] }[] {
  const now       = Date.now()
  const DAY       = 86_400_000
  const starred: Chat[]   = []
  const today: Chat[]     = []
  const yesterday: Chat[] = []
  const earlier: Chat[]   = []

  for (const c of chats) {
    if (c.starred) {
      starred.push(c)
      continue
    }
    const age = now - c.updatedAt
    if (age < DAY)          today.push(c)
    else if (age < 2 * DAY) yesterday.push(c)
    else                    earlier.push(c)
  }

  const groups: { label: string; items: Chat[] }[] = []
  if (starred.length)   groups.push({ label: 'Starred',   items: starred })
  if (today.length)     groups.push({ label: 'Today',     items: today })
  if (yesterday.length) groups.push({ label: 'Yesterday', items: yesterday })
  if (earlier.length)   groups.push({ label: 'Earlier',   items: earlier })
  return groups
}

// ----------------------------------------------------------------
// RailButton — icon button for the permanent 44px rail
// ----------------------------------------------------------------
function RailButton({
  active = false,
  disabled = false,
  onClick,
  title,
  style: extraStyle,
  children,
}: {
  active?:   boolean
  disabled?: boolean
  onClick?:  () => void
  title?:    string
  style?:    React.CSSProperties
  children:  React.ReactNode
}) {
  const [hovered, setHovered] = useState(false)

  if (disabled) {
    return (
      <div
        className="flex items-center justify-center rounded-[6px] text-content-secondary"
        style={{ width: 28, height: 28, opacity: 0.35, cursor: 'default', pointerEvents: 'none', ...extraStyle }}
      >
        {children}
      </div>
    )
  }

  return (
    <button
      onClick={onClick}
      title={title}
      className="no-drag flex items-center justify-center rounded-[6px]"
      style={{
        width:      28,
        height:     28,
        border:     'none',
        padding:    0,
        cursor:     'pointer',
        transition: 'background 100ms ease, color 100ms ease',
        background: active
          ? 'rgba(229,57,53,0.15)'
          : hovered
          ? 'rgba(255,255,255,0.06)'
          : 'transparent',
        color: active ? 'rgba(229,57,53,0.8)' : 'rgba(255,255,255,0.25)',
        ...extraStyle,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
    </button>
  )
}

// ----------------------------------------------------------------
// ChatItem
// ----------------------------------------------------------------
interface ChatItemProps {
  chat:     Chat
  isActive: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onStar:   (id: string, starred: boolean) => void
}

function ChatItem({ chat, isActive, onSelect, onDelete, onRename, onStar }: ChatItemProps) {
  const [hovered,      setHovered]      = useState(false)
  const [menuOpen,     setMenuOpen]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing,      setEditing]      = useState(false)
  const [draftTitle,   setDraftTitle]   = useState(chat.title)
  const inputRef  = useRef<HTMLInputElement>(null)
  const menuRef   = useRef<HTMLDivElement>(null)
  const dotBtnRef = useRef<HTMLButtonElement>(null)

  // Sync draft when prop changes (optimistic update resolves)
  useEffect(() => {
    if (!editing) setDraftTitle(chat.title)
  }, [chat.title, editing])

  // Auto-focus + select-all on entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  // Close menu when clicking outside
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current   && !menuRef.current.contains(e.target as Node) &&
        dotBtnRef.current && !dotBtnRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  // Close confirm strip when clicking outside this item
  useEffect(() => {
    if (!confirmDelete) return
    const handler = (e: MouseEvent) => {
      const row = dotBtnRef.current?.closest('[data-chat-item]') as HTMLElement | null
      if (row && !row.contains(e.target as Node)) {
        setConfirmDelete(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [confirmDelete])

  const enterEditing = useCallback(() => {
    setMenuOpen(false)
    setConfirmDelete(false)
    setDraftTitle(chat.title)
    setEditing(true)
  }, [chat.title])

  const commitRename = useCallback(() => {
    const trimmed = draftTitle.trim()
    if (trimmed && trimmed !== chat.title) {
      onRename(chat.id, trimmed)
    } else {
      setDraftTitle(chat.title)
    }
    setEditing(false)
  }, [chat.id, chat.title, draftTitle, onRename])

  const handleRowDoubleClick = useCallback((e: React.MouseEvent) => {
    // Don't trigger rename if the user double-clicked the ⋮ button itself
    if (dotBtnRef.current && dotBtnRef.current.contains(e.target as Node)) return
    if (editing) return
    enterEditing()
  }, [editing, enterEditing])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      setDraftTitle(chat.title)
      setEditing(false)
    }
  }, [commitRename, chat.title])

  const handleDotBtn = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmDelete(false)
    setMenuOpen((v) => !v)
  }, [])

  const handleMenuStar = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuOpen(false)
    onStar(chat.id, !chat.starred)
  }, [chat.id, chat.starred, onStar])

  const handleMenuRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuOpen(false)
    enterEditing()
  }, [enterEditing])

  const handleMenuDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuOpen(false)
    setConfirmDelete(true)
  }, [])

  const handleConfirmDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(chat.id)
  }, [chat.id, onDelete])

  const handleCancelDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setConfirmDelete(false)
  }, [])

  const isInteractive = !editing && !confirmDelete

  return (
    <div
      data-chat-item
      style={{ borderBottom: '0.5px solid rgba(255,255,255,0.03)' }}
    >
      {/* ── Main row ── */}
      <div
        onClick={() => isInteractive && onSelect(chat.id)}
        onDoubleClick={handleRowDoubleClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display:    'flex',
          alignItems: 'stretch',
          cursor:     isInteractive ? 'pointer' : 'default',
          background: (editing || menuOpen || confirmDelete || hovered)
            ? 'rgba(229,57,53,0.04)'
            : 'transparent',
          transition: 'background 120ms ease',
          position:   'relative',
        }}
      >
        {/* Left accent bar */}
        <div
          style={{
            width:      2,
            flexShrink: 0,
            background: (editing || confirmDelete)
              ? 'rgba(229,57,53,0.4)'
              : isActive
              ? 'rgba(229,57,53,0.6)'
              : hovered
              ? 'rgba(255,255,255,0.1)'
              : 'transparent',
            transition: 'background 120ms ease',
          }}
        />

        {/* Content */}
        <div style={{ flex: 1, minWidth: 0, padding: editing ? '9px 8px 7px 10px' : '9px 8px 9px 10px' }}>
          {editing ? (
            <input
              ref={inputRef}
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={commitRename}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="selectable"
              style={{
                display:      'block',
                width:        '100%',
                fontFamily:   'inherit',
                fontSize:     12,
                fontWeight:   500,
                color:        'rgba(255,255,255,0.85)',
                background:   'rgba(255,255,255,0.05)',
                border:       '0.5px solid rgba(229,57,53,0.4)',
                borderRadius: 4,
                padding:      '1px 5px',
                outline:      'none',
                lineHeight:   1.35,
                boxSizing:    'border-box',
              }}
              maxLength={120}
            />
          ) : (
            <>
              <p
                style={{
                  fontFamily:   'inherit',
                  fontSize:     12,
                  fontWeight:   isActive ? 500 : 400,
                  color:        confirmDelete
                    ? 'rgba(255,255,255,0.35)'
                    : isActive
                    ? 'rgba(255,255,255,0.85)'
                    : hovered
                    ? 'rgba(255,255,255,0.65)'
                    : 'rgba(255,255,255,0.38)',
                  whiteSpace:   'nowrap',
                  overflow:     'hidden',
                  textOverflow: 'ellipsis',
                  lineHeight:   1.35,
                  transition:   'color 120ms ease',
                  margin:       0,
                  userSelect:   'none',
                }}
              >
                {chat.title}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                <p
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize:   9,
                    color:      isActive
                      ? 'rgba(229,57,53,0.4)'
                      : 'rgba(255,255,255,0.15)',
                    margin:     0,
                    transition: 'color 120ms ease',
                  }}
                >
                  {timeAgo(chat.updatedAt)}
                </p>
                {chat.starred && (
                  <Star
                    style={{
                      width:   9,
                      height:  9,
                      color:   'rgba(229,57,53,0.4)',
                      fill:    'rgba(229,57,53,0.15)',
                      flexShrink: 0,
                    }}
                  />
                )}
              </div>
            </>
          )}
        </div>

        {/* Three-dot button — visible on hover or when menu is open, hidden during editing/confirm */}
        {!editing && !confirmDelete && (
          <button
            ref={dotBtnRef}
            onClick={handleDotBtn}
            title="More options"
            style={{
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              width:          22,
              height:         22,
              flexShrink:     0,
              marginRight:    6,
              background:     menuOpen ? 'rgba(255,255,255,0.07)' : 'transparent',
              border:         menuOpen ? '0.5px solid rgba(255,255,255,0.1)' : '0.5px solid transparent',
              borderRadius:   4,
              cursor:         'pointer',
              color:          menuOpen
                ? 'rgba(255,255,255,0.7)'
                : hovered
                ? 'rgba(255,255,255,0.45)'
                : 'transparent',
              transition:     'color 120ms ease, background 120ms ease, border-color 120ms ease',
              padding:        0,
              alignSelf:      'center',
            }}
          >
            <MoreVertical style={{ width: 13, height: 13 }} />
          </button>
        )}

        {/* Dropdown menu */}
        {menuOpen && (
          <div
            ref={menuRef}
            onClick={(e) => e.stopPropagation()}
            style={{
              position:     'absolute',
              right:        6,
              top:          '100%',
              zIndex:       50,
              width:        148,
              background:   '#1a1a1a',
              border:       '0.5px solid rgba(255,255,255,0.1)',
              borderRadius: 7,
              padding:      4,
              marginTop:    2,
            }}
          >
            <button
              onClick={handleMenuStar}
              style={{
                display:      'flex',
                alignItems:   'center',
                gap:          8,
                width:        '100%',
                padding:      '6px 9px',
                borderRadius: 5,
                background:   'transparent',
                border:       'none',
                cursor:       'pointer',
                fontSize:     11,
                color:        'rgba(255,255,255,0.65)',
                textAlign:    'left',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
            >
              {chat.starred
                ? <StarOff style={{ width: 14, height: 14, flexShrink: 0 }} />
                : <Star    style={{ width: 14, height: 14, flexShrink: 0 }} />
              }
              {chat.starred ? 'Unstar' : 'Star'}
            </button>
            <div style={{ borderTop: '0.5px solid rgba(255,255,255,0.07)', margin: '3px 0' }} />
            <button
              onClick={handleMenuRename}
              style={{
                display:      'flex',
                alignItems:   'center',
                gap:          8,
                width:        '100%',
                padding:      '6px 9px',
                borderRadius: 5,
                background:   'transparent',
                border:       'none',
                cursor:       'pointer',
                fontSize:     11,
                color:        'rgba(255,255,255,0.65)',
                textAlign:    'left',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
            >
              <Pencil style={{ width: 13, height: 13, flexShrink: 0 }} />
              Rename
            </button>
            <div style={{ borderTop: '0.5px solid rgba(255,255,255,0.07)', margin: '3px 0' }} />
            <button
              onClick={handleMenuDelete}
              style={{
                display:      'flex',
                alignItems:   'center',
                gap:          8,
                width:        '100%',
                padding:      '6px 9px',
                borderRadius: 5,
                background:   'transparent',
                border:       'none',
                cursor:       'pointer',
                fontSize:     11,
                color:        'rgba(229,57,53,0.8)',
                textAlign:    'left',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(229,57,53,0.08)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
            >
              <Trash2 style={{ width: 13, height: 13, flexShrink: 0 }} />
              Delete
            </button>
          </div>
        )}
      </div>

      {/* ── Rename hint bar (only while editing) ── */}
      {editing && (
        <div
          style={{
            padding:    '3px 12px 7px',
            fontSize:   10,
            color:      'rgba(255,255,255,0.2)',
            fontFamily: "'JetBrains Mono', monospace",
            display:    'flex',
            gap:        10,
            background: 'rgba(229,57,53,0.04)',
          }}
        >
          {(['↵ confirm', 'Esc cancel'] as const).map((label) => (
            <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  fontSize:     9,
                  background:   'rgba(255,255,255,0.07)',
                  border:       '0.5px solid rgba(255,255,255,0.12)',
                  borderRadius: 3,
                  padding:      '1px 4px',
                  color:        'rgba(255,255,255,0.35)',
                  fontFamily:   "'JetBrains Mono', monospace",
                }}
              >
                {label.split(' ')[0]}
              </span>
              {label.split(' ')[1]}
            </span>
          ))}
        </div>
      )}

      {/* ── Inline delete confirm strip (state 6) ── */}
      {confirmDelete && (
        <div
          style={{
            background:   '#151209',
            border:       '0.5px solid rgba(229,57,53,0.25)',
            borderTop:    'none',
            borderRadius: '0 0 6px 6px',
            padding:      '7px 10px',
          }}
        >
          <p
            style={{
              fontSize:   11,
              color:      'rgba(255,255,255,0.4)',
              lineHeight: 1.5,
              margin:     '0 0 6px',
            }}
          >
            Delete{' '}
            <span style={{ color: 'rgba(255,255,255,0.7)', fontWeight: 500 }}>
              &ldquo;{chat.title}&rdquo;
            </span>
            ? This can&apos;t be undone.
          </p>
          <div style={{ display: 'flex', gap: 5 }}>
            <button
              onClick={handleCancelDelete}
              style={{
                flex:         1,
                padding:      '4px 0',
                borderRadius: 5,
                fontSize:     10,
                fontWeight:   500,
                textAlign:    'center',
                background:   'rgba(255,255,255,0.04)',
                border:       '0.5px solid rgba(255,255,255,0.1)',
                color:        'rgba(255,255,255,0.35)',
                cursor:       'pointer',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmDelete}
              style={{
                flex:         1,
                padding:      '4px 0',
                borderRadius: 5,
                fontSize:     10,
                fontWeight:   500,
                textAlign:    'center',
                background:   'rgba(229,57,53,0.12)',
                border:       '0.5px solid rgba(229,57,53,0.35)',
                color:        'rgba(229,57,53,0.8)',
                cursor:       'pointer',
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// ChatGroup
// ----------------------------------------------------------------
function ChatGroup({
  label, chats, activeChatId, onSelect, onDelete, onRename, onStar,
}: {
  label:        string
  chats:        Chat[]
  activeChatId: string | null
  onSelect:     (id: string) => void
  onDelete:     (id: string) => void
  onRename:     (id: string, title: string) => void
  onStar:       (id: string, starred: boolean) => void
}) {
  return (
    <div style={{ marginBottom: 4 }}>
      <p
        style={{
          padding:       '14px 12px 4px',
          fontSize:      10,
          fontWeight:    400,
          color:         'rgba(255,255,255,0.18)',
          letterSpacing: '0.02em',
          margin:        0,
        }}
      >
        {label}
      </p>
      <div>
        {chats.map((chat) => (
          <ChatItem
            key={chat.id}
            chat={chat}
            isActive={chat.id === activeChatId}
            onSelect={onSelect}
            onDelete={onDelete}
            onRename={onRename}
            onStar={onStar}
          />
        ))}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------
// Sidebar component
// ----------------------------------------------------------------
interface SidebarProps {
  panelOpen:      boolean
  onTogglePanel:  () => void
  chats:          Chat[]
  activeChatId:   string | null
  onSelectChat:   (chatId: string) => void
  onNewChat:      () => void
  onDeleteChat:   (chatId: string) => void
  onRenameChat:   (chatId: string, title: string) => void
  onStarChat:     (chatId: string, starred: boolean) => void
  onOpenSettings: () => void
}

const PANEL_WIDTH = 264

export function Sidebar({
  panelOpen,
  onTogglePanel,
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onRenameChat,
  onStarChat,
  onOpenSettings,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('')

  const filteredChats = searchQuery.trim()
    ? chats.filter((c) => c.title.toLowerCase().includes(searchQuery.toLowerCase()))
    : chats

  const groups = groupChats(filteredChats)

  return (
    <div className="flex h-full flex-shrink-0">

      {/* ── Permanent Rail (44px, always visible) ── */}
      <div
        className="flex-shrink-0 flex flex-col items-center"
        style={{
          width:       44,
          background:  '#0a0a0a',
          borderRight: '0.5px solid rgba(255,255,255,0.05)',
        }}
      >
        {/* Drag region — covers macOS traffic lights (52px = TopBar height) */}
        <div className="drag-region w-full flex-shrink-0" style={{ height: 52 }} />

        {/* Chat panel toggle */}
        <RailButton
          active={panelOpen}
          onClick={onTogglePanel}
          title={panelOpen ? 'Close chats' : 'Open chats'}
        >
          <MessageSquare style={{ width: 15, height: 15 }} />
        </RailButton>

        {/* Multi-agent rail button — hidden until orchestration is implemented
        <div style={{ height: 4 }} />
        <RailButton disabled title="Multi-agent (coming soon)">
          <Network style={{ width: 15, height: 15 }} />
        </RailButton>
        */}

        {/* Settings gear — pushed to bottom */}
        <div className="flex-1" />
        <RailButton onClick={onOpenSettings} title="Settings">
          <Settings style={{ width: 15, height: 15 }} />
        </RailButton>
        <div style={{ height: 12 }} />
      </div>

      {/* ── Expandable Chats Panel ── */}
      <div
        className="flex-shrink-0 h-full overflow-hidden"
        style={{
          width:      panelOpen ? PANEL_WIDTH : 0,
          transition: 'width 220ms cubic-bezier(0.4, 0, 0.2, 1)',
          background:  '#141414',
          borderRight: '0.5px solid rgba(255,255,255,0.05)',
        }}
      >
        {/* Inner container — fixed width so content doesn't reflow during animation */}
        <div
          className="flex flex-col h-full"
          style={{
            width:      PANEL_WIDTH,
            opacity:    panelOpen ? 1 : 0,
            transition: 'opacity 180ms ease',
          }}
        >
          {/* ── Panel header ── */}
          <div
            className="drag-region flex-shrink-0 flex items-center justify-between"
            style={{
              height:       52,
              background:   '#0a0a0a',
              borderBottom: '0.5px solid rgba(255,255,255,0.04)',
              paddingLeft:  80,
              paddingRight: 12,
            }}
          >
            <span
              className="no-drag select-none"
              style={{
                fontSize:      13,
                fontWeight:    600,
                color:         'rgba(255,255,255,0.55)',
                letterSpacing: '0.01em',
              }}
            >
              Chats
            </span>

            <button
              onClick={onNewChat}
              className="no-drag flex items-center"
              style={{
                gap:          5,
                fontSize:     12,
                background:   'rgba(229,57,53,0.12)',
                border:       '0.5px solid rgba(229,57,53,0.25)',
                color:        'rgba(229,57,53,0.7)',
                borderRadius: 5,
                padding:      '4px 10px',
                cursor:       'pointer',
                lineHeight:   1,
                fontWeight:   500,
              }}
            >
              <span style={{ fontSize: 14, lineHeight: 1 }}>+</span>
              <span>New</span>
            </button>
          </div>

          {/* ── Chat list (scrollable) ── */}
          <div className="flex-1 overflow-y-auto no-drag" style={{ paddingTop: 4, paddingBottom: 4 }}>
            {groups.length > 0
              ? groups.map((g) => (
                  <ChatGroup
                    key={g.label}
                    label={g.label}
                    chats={g.items}
                    activeChatId={activeChatId}
                    onSelect={onSelectChat}
                    onDelete={onDeleteChat}
                    onRename={onRenameChat}
                    onStar={onStarChat}
                  />
                ))
              : (
                <p
                  className="px-3 py-6 text-center text-content-muted"
                  style={{ fontSize: 11 }}
                >
                  {searchQuery.trim() ? 'no results' : 'No chats yet'}
                </p>
              )
            }
          </div>

          {/* ── Panel footer: search ── */}
          <div
            className="flex-shrink-0 px-3"
            style={{ borderTop: '0.5px solid rgba(255,255,255,0.04)', height: 52, display: 'flex', alignItems: 'center' }}
          >
            <div className="relative no-drag" style={{ width: '100%' }}>
              <Search
                style={{
                  position:  'absolute',
                  left:      8,
                  top:       '50%',
                  transform: 'translateY(-50%)',
                  width:     14,
                  height:    14,
                  color:     'rgba(255,255,255,0.25)',
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                placeholder="Search…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full selectable focus:outline-none"
                style={{
                  height:      28,
                  fontSize:    11,
                  background:  'rgba(255,255,255,0.04)',
                  border:      '0.5px solid rgba(255,255,255,0.07)',
                  borderRadius: 6,
                  paddingLeft:  28,
                  paddingRight: 8,
                  color:        'rgba(255,255,255,0.7)',
                  transition:   'border-color 100ms ease',
                }}
                onFocus={(e)  => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)' }}
                onBlur={(e)   => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.07)' }}
              />
            </div>
          </div>
        </div>
      </div>

    </div>
  )
}
