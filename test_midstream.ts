function parseRawToolCall(content: string): { name: string; args: Record<string, string> } | null {
  const match = content.match(/<tool_call>([\s\S]*?)<\/tool_call>/)
  if (!match) return null

  const inner = match[1].trim()

  const funcMatch = inner.match(/<function=([^>]+)>([\s\S]*?)(?:<\/function>|$)/)
  if (funcMatch) {
    const name = funcMatch[1].trim()
    const argsContent = funcMatch[2]
    const args: Record<string, string> = {}
    const paramRegex = /<parameter=([^>]+)>([\s\S]*?)(?:<\/parameter>|$)/g
    let pm: RegExpExecArray | null
    while ((pm = paramRegex.exec(argsContent)) !== null) {
      args[pm[1].trim()] = pm[2].trim()
    }
    if (Object.keys(args).length > 0) return { name, args }
  }

  const nameMatch = inner.match(/^(\w+)/)
  if (!nameMatch) return null
  const name = nameMatch[1]
  const rest = inner.slice(name.length).trim()

  const args: Record<string, string> = {}
  let m: RegExpExecArray | null

  const xmlPattern = /<arg_key>(.*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g
  while ((m = xmlPattern.exec(rest)) !== null) args[m[1]] = m[2].trim()
  if (Object.keys(args).length > 0) return { name, args }

  const quotedPattern = /(\w+)="([^"]*)"/g
  while ((m = quotedPattern.exec(rest)) !== null) args[m[1]] = m[2]
  if (Object.keys(args).length > 0) return { name, args }

  const unquotedPattern = /(\w+)=([^=\s"]+(?:\s+(?!\w+=)[^=\s"]+)*)/g
  while ((m = unquotedPattern.exec(rest)) !== null) args[m[1]] = m[2].trim()
  if (Object.keys(args).length > 0) return { name, args }

  try {
    const parsed = JSON.parse(rest)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) args[k] = String(v)
      if (Object.keys(args).length > 0) return { name, args }
    }
  } catch { /* not JSON */ }

  return { name, args }
}

function detectMidStreamToolCall(buffer: string): { query: string; cleanedBuffer: string } | null {
  if (buffer.includes('</tool_call>')) {
    const raw = parseRawToolCall(buffer)
    const q = raw?.args?.['query']
    if (q) {
      return { query: q, cleanedBuffer: buffer.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '').trim() }
    }
  }

  const unclosedMatch = buffer.match(/<tool_call>([\s\S]+)$/i)
  if (unclosedMatch) {
    const inner = unclosedMatch[1].trim()
    if (inner.endsWith('}') || inner.includes('="') || inner.includes('</parameter>')) {
      const fakeClosed = buffer + '</tool_call>'
      const raw = parseRawToolCall(fakeClosed)
      const q = raw?.args?.['query']
      if (q) {
        return { query: q, cleanedBuffer: buffer.replace(/<tool_call>[\s\S]*$/i, '').trim() }
      }
    }
  }
  return null
}

const buf = `Let me search for current information to ensure I'm not providing outdated or incorrect information.
<think>the current date (April 2, 2026), I'll check what TurboQuant models are available for macOS.

<tool_call>brave_web_search {"query": "TurboQuant models available 2026 macOS Mac"}`

console.log(detectMidStreamToolCall(buf))
