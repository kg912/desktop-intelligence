// A unified diff with red / green line tints (file edits: approval dialog and pills).

const KIND = (line: string): 'add' | 'del' | 'hunk' | 'head' | 'ctx' =>
  line.startsWith('+++') || line.startsWith('---')
    ? 'head'
    : line.startsWith('@@')
      ? 'hunk'
      : line.startsWith('+')
        ? 'add'
        : line.startsWith('-')
          ? 'del'
          : 'ctx'

const STYLE: Record<ReturnType<typeof KIND>, string> = {
  add: 'bg-green-400/[0.08] text-green-200',
  del: 'bg-red-600/10 text-red-300',
  hunk: 'text-content-muted',
  head: 'text-content-muted',
  ctx: 'text-content-secondary',
}

export function DiffView({ diff, maxHeight = 190 }: { diff: string; maxHeight?: number }) {
  // The ---/+++ file header adds nothing next to the path shown above it.
  const lines = diff.split('\n').filter((l) => KIND(l) !== 'head')
  return (
    <div
      data-testid="diff-view"
      className="font-mono text-[11.5px] leading-[1.55] rounded-[7px] bg-black/40 py-2 overflow-y-auto overflow-x-hidden"
      style={{ maxHeight, border: '0.5px solid rgba(255,255,255,0.09)' }}
    >
      {lines.map((l, i) => (
        <div key={i} data-kind={KIND(l)} className={`px-2.5 whitespace-pre-wrap [overflow-wrap:anywhere] ${STYLE[KIND(l)]}`}>
          {l || ' '}
        </div>
      ))}
    </div>
  )
}
