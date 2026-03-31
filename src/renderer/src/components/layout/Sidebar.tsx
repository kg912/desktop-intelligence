import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  MessageSquarePlus,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Trash2,
  Search,
  Settings,
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
// ChatItem
// ----------------------------------------------------------------
interface ChatItemProps {
  chat:         Chat
  isActive:     boolean
  onSelect:     (id: string) => void
  onDelete:     (id: string) => void
}

function ChatItem({ chat, isActive, onSelect, onDelete }: ChatItemProps) {
  const [hovered, setHovered] = useState(false)

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onDelete(chat.id)
  }, [chat.id, onDelete])

  return (
    <div
      onClick={() => onSelect(chat.id)}
      className={cn(
        'group relative flex items-start gap-2.5 px-3 py-2.5 rounded-lg cursor-pointer',
        'transition-colors duration-100',
        isActive
          ? 'bg-accent-950/60 border border-accent-900/40'
          : 'hover:bg-surface-hover border border-transparent'
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <MessageSquare
        className={cn(
          'mt-0.5 flex-shrink-0 w-3.5 h-3.5',
          isActive ? 'text-accent-500' : 'text-content-muted'
        )}
      />
      <div className="flex-1 min-w-0">
        <p className={cn(
          'text-sm truncate font-medium leading-tight',
          isActive ? 'text-content-primary' : 'text-content-secondary'
        )}>
          {chat.title}
        </p>
        <p className="text-xs text-content-muted truncate mt-0.5 leading-tight">
          {timeAgo(chat.updatedAt)}
        </p>
      </div>

      {/* Delete button — visible on hover */}
      <AnimatePresence>
        {hovered && (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.1 }}
            onClick={handleDelete}
            className="absolute right-2 top-1/2 -translate-y-1/2
                       p-1 rounded-md
                       text-content-muted hover:text-red-400
                       hover:bg-red-950/30
                       transition-colors duration-100"
            title="Delete chat"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

// ----------------------------------------------------------------
// ChatGroup
// ----------------------------------------------------------------
function ChatGroup({
  label, chats, activeChatId, onSelect, onDelete,
}: {
  label:        string
  chats:        Chat[]
  activeChatId: string | null
  onSelect:     (id: string) => void
  onDelete:     (id: string) => void
}) {
  return (
    <div className="mb-2">
      <p className="px-3 mb-1 text-[10px] font-semibold tracking-widest uppercase text-content-muted">
        {label}
      </p>
      <div className="space-y-0.5">
        {chats.map((chat) => (
          <ChatItem
            key={chat.id}
            chat={chat}
            isActive={chat.id === activeChatId}
            onSelect={onSelect}
            onDelete={onDelete}
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
  collapsed:      boolean
  onToggle:       () => void
  chats:          Chat[]
  activeChatId:   string | null
  onSelectChat:   (chatId: string) => void
  onNewChat:      () => void
  onDeleteChat:   (chatId: string) => void
  onOpenSettings: () => void
}

export function Sidebar({
  collapsed,
  onToggle,
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onOpenSettings,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('')

  const sidebarWidth = 260

  const filteredChats = searchQuery.trim()
    ? chats.filter((c) =>
        c.title.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : chats

  const groups = groupChats(filteredChats)

  return (
    <>
      {/* Sidebar panel */}
      <motion.aside
        initial={false}
        animate={{ width: collapsed ? 0 : sidebarWidth }}
        transition={{ type: 'spring', damping: 28, stiffness: 260 }}
        className="relative flex-shrink-0 h-full overflow-hidden"
        style={{ backgroundColor: '#141414' }}
      >
        <div
          className="flex flex-col h-full border-r border-surface-border"
          style={{ width: sidebarWidth }}
        >
          {/* ── Top: drag region + header ── */}
          <div className="drag-region flex items-center justify-between px-4 pt-[52px] pb-3 flex-shrink-0">
            <span className="no-drag text-[13px] font-semibold text-content-secondary tracking-wide">
              Chats
            </span>
            <button
              onClick={onToggle}
              className="no-drag p-1.5 rounded-lg text-content-tertiary
                         hover:text-content-secondary hover:bg-surface-hover
                         transition-colors duration-100"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>

          {/* ── New Chat button ── */}
          <div className="px-3 pb-3 flex-shrink-0">
            <button
              onClick={onNewChat}
              className="w-full flex items-center justify-center gap-2
                         px-3 py-2.5 rounded-xl
                         bg-accent-900/30 hover:bg-accent-800/40 active:bg-accent-900/50
                         border border-accent-800/40 hover:border-accent-700/50
                         text-accent-400 hover:text-accent-300
                         text-sm font-medium
                         transition-all duration-150
                         focus:outline-none focus:ring-1 focus:ring-accent-700/60
                         no-drag"
            >
              <MessageSquarePlus className="w-4 h-4" />
              New Chat
            </button>
          </div>

          {/* ── Search ── */}
          <div className="px-3 pb-3 flex-shrink-0">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-content-muted" />
              <input
                type="text"
                placeholder="Search chats…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-2 rounded-lg
                           bg-surface-DEFAULT border border-surface-border
                           text-xs text-content-secondary placeholder:text-content-muted
                           focus:outline-none focus:border-accent-900/60 focus:bg-surface-hover
                           transition-colors duration-100
                           no-drag selectable"
              />
            </div>
          </div>

          {/* ── Chat history (scrollable) ── */}
          <div className="flex-1 overflow-y-auto px-2 py-1 space-y-3 no-drag">
            {groups.length > 0
              ? groups.map((g) => (
                  <ChatGroup
                    key={g.label}
                    label={g.label}
                    chats={g.items}
                    activeChatId={activeChatId}
                    onSelect={onSelectChat}
                    onDelete={onDeleteChat}
                  />
                ))
              : (
                <p className="px-3 py-6 text-center text-[12px] text-content-muted">
                  {searchQuery ? 'No matching chats' : 'No chats yet'}
                </p>
              )
            }
          </div>

          {/* ── Bottom: settings cog ── */}
          <div className="flex-shrink-0 px-3 py-3 border-t border-surface-border">
            <button
              onClick={onOpenSettings}
              className="no-drag p-2 rounded-lg
                         text-content-muted hover:text-content-secondary
                         hover:bg-surface-hover
                         transition-colors duration-100"
              title="Settings"
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </motion.aside>

      {/* Collapsed toggle button — floats when sidebar is closed */}
      <AnimatePresence>
        {collapsed && (
          <motion.button
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -8 }}
            transition={{ duration: 0.2 }}
            onClick={onToggle}
            className="absolute left-3 top-[54px] z-10
                       p-1.5 rounded-lg
                       bg-surface-DEFAULT border border-surface-border
                       text-content-tertiary hover:text-content-secondary
                       hover:bg-surface-hover
                       transition-colors duration-100
                       no-drag"
          >
            <ChevronRight className="w-4 h-4" />
          </motion.button>
        )}
      </AnimatePresence>
    </>
  )
}
