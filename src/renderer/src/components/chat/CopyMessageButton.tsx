/**
 * CopyMessageButton — icon-only copy control shown under a finished
 * assistant message. Same clipboard logic as MarkdownRenderer's CopyButton.
 */

import { useState, memo } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '../../lib/utils'

export const CopyMessageButton = memo(function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Fallback for environments without clipboard API
      try {
        const el = document.createElement('textarea')
        el.value = text
        document.body.appendChild(el)
        el.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(el)
        if (!ok) return
      } catch {
        return
      }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      title="Copy"
      aria-label="Copy response"
      className={cn(
        'flex items-center justify-center w-6 h-6 rounded-md bg-transparent transition-colors duration-150',
        copied ? 'text-accent-500' : 'text-content-muted hover:text-content-secondary'
      )}
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  )
})
