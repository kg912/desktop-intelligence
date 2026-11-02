// Pill labels for the built-in file tools (spec 2.10, mockup 15 panel D).
// Pure: derived from the tool arguments and our own result formats
// (fs_read's fixed header, the unified diff, the broker's fixed sentences).

import { FS_TOOL_NAME_LIST, displayPath } from '../../../shared/fsAccess'

export type FsPillIcon = 'read' | 'edit' | 'search' | 'list' | 'access'

export interface FsPillLabel {
  icon: FsPillIcon
  text: string
  added?: number
  removed?: number
  status?: 'granted' | 'denied' | 'no answer'
}

const FS_NAMES = new Set(FS_TOOL_NAME_LIST)
export const isFsTool = (name: string | undefined): boolean => !!name && FS_NAMES.has(name)

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
function base(path: unknown, fallback: string): string {
  const p = str(path).replace(/\/+$/, '')
  if (str(path) === '/') return '/'
  return p.split('/').at(-1) || fallback
}

export function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue
    if (l.startsWith('+')) added++
    else if (l.startsWith('-')) removed++
  }
  return { added, removed }
}

// The broker's result sentences (FsAccessBroker.ts), matched by their fixed openings.
function accessStatus(text: string): FsPillLabel['status'] {
  if (!text) return undefined
  if (text.startsWith('Access granted') || text.includes(' is already accessible (')) return 'granted'
  if (text.startsWith('No answer from the user.')) return 'no answer'
  return 'denied'
}

export function fsToolLabel(
  toolName: string,
  args: Record<string, unknown> = {},
  result: { formattedContent?: string; toolDiff?: string } = {}
): FsPillLabel {
  const out = result.formattedContent ?? ''
  switch (toolName) {
    case 'fs_read': {
      const head = out.split('\n')[0]
      const range = head.match(/ — lines (\d+)–(\d+) of \d+\. /)
      const detail = range ? ` · lines ${range[1]}–${range[2]}` : head.includes(' — 0 lines. ') ? ' · empty' : ''
      return { icon: 'read', text: `Read ${base(args.path, 'file')}${detail}` }
    }
    case 'fs_edit':
    case 'fs_write': {
      const verb = toolName === 'fs_edit' ? 'Edited' : 'Wrote'
      if (!result.toolDiff) return { icon: 'edit', text: `${verb} ${base(args.path, 'file')}` }
      const { added, removed } = diffCounts(result.toolDiff)
      return { icon: 'edit', text: `${verb} ${base(args.path, 'file')} · +${added} −${removed}`, added, removed }
    }
    case 'fs_grep':
      return { icon: 'search', text: `Searched "${str(args.pattern)}" in ${base(args.path, 'folder')}/` }
    case 'fs_glob':
      return { icon: 'search', text: `Found ${str(args.pattern)} in ${base(args.path, 'folder')}/` }
    case 'fs_list': {
      const b = base(args.path, 'folder')
      return { icon: 'list', text: b === '/' ? 'Listed /' : `Listed ${b}/` }
    }
    default: {
      const p = str(args.path)
      return { icon: 'access', text: `Requested access to ${displayPath(p, '', 40)}`, status: accessStatus(out) }
    }
  }
}
