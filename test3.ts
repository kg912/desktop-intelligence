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

  try {
    const parsed = JSON.parse(rest)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) args[k] = String(v)
      if (Object.keys(args).length > 0) return { name, args }
    }
  } catch { /* not JSON */ }

  return { name, args }
}

const unclosedMatch = `<tool_call>brave_web_search\n{"query": "TurboQuant models available 2026 macOS Mac"}`.match(/<tool_call>([\s\S]+)$/i)
if (unclosedMatch) {
  const inner = unclosedMatch[1].trim()
  console.log("inner:", inner)
  if (inner.endsWith('}')) {
    const fakeClosed = `<tool_call>brave_web_search\n{"query": "TurboQuant models available 2026 macOS Mac"} </tool_call>`
    console.log(parseRawToolCall(fakeClosed))
  }
}
