import { useState, useCallback, useRef, useEffect } from 'react'
import {
  MessageSquare,
  Network,
  Settings,
  Search,
  Trash2,
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
  const today: Chat[]     = []
  const yesterday: Chat[] = []
  const earlier: Chat[]   = []

  for (const c of chats) {
    const age = now - c.updatedAt
    if (age < DAY)         today.push(c)
    else if (age < 2 * DAY) yesterday.push(c)
    else                    earlier.push(c)
  }

  const groups: { label: string; items: Chat[] }[] = []
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
}

function ChatItem({ chat, isActive, onSelect, onDelete, onRename }: ChatItemProps) {
  const [hovered,   setHovered]   = useState(false)
  const [editing,   setEditing]   = useState(false)
  const [draftTitle, setDraftTitle] = useState(chat.title)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync draft when the prop changes (e.g. optimistic update resolves)
  useEffect(() => {
    if (!editing) setDraftTitle(chat.title)
  }, [chat.title, editing])

  // Auto-focus and select-all when entering edit mode
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commitRename = useCallback(() => {
    const trimmed = draftTitle.trim()
    if (trimmed && trimmed !== chat.title) {
      onRename(chat.id, trimmed)
    } else {
      // Revert draft if empty or unchanged
      setDraftTitle(chat.title)
    }
    setEditing(false)
  }, [chat.id, chat.title, draftTitle, onRename])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setDraftTitle(chat.title)
    setEditing(true)
  }, [chat.title])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      setDraftTitle(chat.title)
      setEditing(false)
    }
  }, [commitRename, chat.title])

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(chat.id)
  }, [chat.id, onDelete])

  return (
    <div
      onClick={() => !editing && onSelect(chat.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display:         'flex',
        alignItems:      'stretch',
        borderBottom:    '0.5px solid rgba(255,255,255,0.03)',
        cursor:          editing ? 'default' : 'pointer',
        background:      editing ? 'rgba(229,57,53,0.04)' : 'transparent',
        transition:      'background 120ms ease',
      }}
    >
      {/* Left accent bar */}
      <div
        style={{
          width:      2,
          flexShrink: 0,
          background: editing
            ? 'rgba(229,57,53,0.5)'
            : isActive
            ? 'rgba(229,57,53,0.6)'
            : hovered
            ? 'rgba(255,255,255,0.1)'
            : 'transparent',
          transition: 'background 120ms ease',
        }}
      />

      {/* Content */}
      <div
        style={{
          flex:      1,
          minWidth:  0,
          padding:   '9px 10px',
        }}
      >
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
          <p
            onDoubleClick={handleDoubleClick}
            title="Double-click to rename"
            style={{
              fontFamily:   'inherit',
              fontSize:     12,
              fontWeight:   isActive ? 500 : 400,
              color:        isActive
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
        )}
        {!editing && (
          <p
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize:   9,
              color:      isActive
                ? 'rgba(229,57,53,0.4)'
                : 'rgba(255,255,255,0.15)',
              marginTop:  2,
              transition: 'color 120ms ease',
            }}
          >
            {timeAgo(chat.updatedAt)}
          </p>
        )}
      </div>

      {/* Delete button — only on hover, hidden while editing */}
      {hovered && !editing && (
        <button
          onClick={handleDelete}
          title="Delete chat"
          style={{
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            background:     'transparent',
            border:         'none',
            cursor:         'pointer',
            paddingRight:   10,
            paddingLeft:    4,
            color:          'rgba(229,57,53,0.45)',
            flexShrink:     0,
            fontSize:       11,
            lineHeight:     1,
          }}
        >
          <Trash2 style={{ width: 12, height: 12 }} />
        </button>
      )}
    </div>
  )
}

// ----------------------------------------------------------------
// ChatGroup
// ----------------------------------------------------------------
function ChatGroup({
  label, chats, activeChatId, onSelect, onDelete, onRename,
}: {
  label:        string
  chats:        Chat[]
  activeChatId: string | null
  onSelect:     (id: string) => void
  onDelete:     (id: string) => void
  onRename:     (id: string, title: string) => void
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
