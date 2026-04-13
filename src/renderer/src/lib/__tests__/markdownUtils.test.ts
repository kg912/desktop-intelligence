/**
 * markdownUtils unit tests
 *
 * These tests protect the core pure-function logic that drives the chat renderer.
 * No React, no DOM — all functions are plain string → value transforms.
 *
 * Critical invariants guarded here:
 *
 *  parseThinkBlocks:
 *   1. Fully closed <think> blocks split correctly into thought + answer
 *   2. Open (streaming) <think> blocks set isThinking=true and answer=''
 *   3. Plain responses (no think tags) are returned unmodified as answer
 *   4. Whitespace handling — leading/trailing whitespace in thought is trimmed
 *   5. Multi-line thought content is preserved
 *   6. Answer text after </think> is preserved exactly (no trimming)
 *   7. Edge cases: empty think block, think block with no answer
 *
 *  classifyCodeBlock:
 *   8. undefined language → 'inline'
 *   9. empty string language → 'inline'
 *  10. 'mermaid' (exact) → 'mermaid'
 *  11. 'MERMAID' (uppercase) → 'mermaid'   (case-insensitive)
 *  12. 'Mermaid' (mixed case) → 'mermaid'
 *  13. 'python' → 'code'
 *  14. 'typescript', 'javascript', 'bash', 'text' → 'code'
 *  15. 'mermaid-extra' (prefix but not exact) → 'code'
 *
 *  isValidMermaidSyntax:
 *  16. Empty string → false
 *  17. Whitespace-only → false
 *  18. 'graph TD' → true
 *  19. 'flowchart LR' → true
 *  20. 'sequenceDiagram' → true   (case-insensitive keyword match)
 *  21. 'FLOWCHART TD' → true      (uppercase)
 *  22. 'pie title Pets' → true
 *  23. 'gantt ...' → true
 *  24. Plain text ('hello world') → false
 *  25. Python code ('def foo():') → false
 *  26. Leading whitespace before keyword → true (trimmed)
 *  27. Multi-line input — only first line checked
 */

import { describe, it, expect } from 'vitest'
import {
  parseThinkBlocks,
  classifyCodeBlock,
  isValidMermaidSyntax,
  MERMAID_START_KEYWORDS,
  escapeCurrencyDollars,
  prepareUserContent,
} from '../markdownUtils'

// ── Suite: parseThinkBlocks ───────────────────────────────────────────────────

describe('parseThinkBlocks — fully closed block', () => {
  it('returns the thought text inside the tags', () => {
    const result = parseThinkBlocks('<think>I should consider x and y</think>answer here')
    expect(result.thought).toBe('I should consider x and y')
  })

  it('returns the text after </think> as the answer', () => {
    const result = parseThinkBlocks('<think>reasoning</think>final answer')
    expect(result.answer).toBe('final answer')
  })

  it('sets isThinking to false for a closed block', () => {
    const result = parseThinkBlocks('<think>...</think>done')
    expect(result.isThinking).toBe(false)
  })

  it('trims leading/trailing whitespace from the thought', () => {
    const result = parseThinkBlocks('<think>  \n  reasoning here  \n  </think>ok')
    expect(result.thought).toBe('reasoning here')
  })

  it('preserves the answer text exactly — no trimming of content', () => {
    const result = parseThinkBlocks('<think>t</think>  answer with leading space')
    expect(result.answer).toContain('answer with leading space')
  })

  it('handles multi-line thought content', () => {
    const raw = '<think>\nLine one\nLine two\nLine three\n</think>conclusion'
    const result = parseThinkBlocks(raw)
    expect(result.thought).toContain('Line one')
    expect(result.thought).toContain('Line three')
  })

  it('handles multi-line answer content', () => {
    const raw = '<think>thought</think>\n## Heading\n\nParagraph text'
    const result = parseThinkBlocks(raw)
    expect(result.answer).toContain('## Heading')
    expect(result.answer).toContain('Paragraph text')
  })

  it('handles an empty think block (no thought content)', () => {
    const result = parseThinkBlocks('<think></think>answer')
    expect(result.thought).toBe('')
    expect(result.answer).toBe('answer')
    expect(result.isThinking).toBe(false)
  })

  it('handles a think block with no answer after it', () => {
    const result = parseThinkBlocks('<think>some thought</think>')
    expect(result.thought).toBe('some thought')
    expect(result.answer).toBe('')
    expect(result.isThinking).toBe(false)
  })

  it('handles whitespace-only text between </think> and content', () => {
    const result = parseThinkBlocks('<think>thought</think>   \n\nreal answer')
    // The answer should contain the real content (whitespace before is kept)
    expect(result.answer).toContain('real answer')
  })

  // ── Regression: greedy (last </think>) matching ────────────────
  //
  // Qwen models sometimes mention `</think>` INSIDE their thought while
  // reasoning about how to format the output, e.g.:
  //   "The format is: <think>...</think>answer. I'll suppress the think block."
  // With NON-GREEDY matching the FIRST `</think>` was treated as the closing
  // tag, causing the rest of the thought to leak into the answer area and the
  // real closing `</think>` to appear as literal rendered text.
  // The fix is GREEDY matching (lastIndexOf) so we always split at the LAST
  // `</think>` in the output.

  it('REGRESSION: thought that mentions </think> mid-content — split at the LAST one', () => {
    // Simulates a Qwen thought that discusses the think-block format itself.
    const raw =
      '<think>' +
      'I should not include an explicit </think> tag mid-thought. ' +
      'The format works like: <think>...</think>then answer. ' +
      'Okay, let\'s assemble.' +
      '</think>' +
      'Here is the real answer.'

    const result = parseThinkBlocks(raw)

    // The answer must be ONLY the text after the final </think>
    expect(result.answer).toBe('Here is the real answer.')
    // The leaked thought content must NOT appear in the answer
    expect(result.answer).not.toContain('I should not include')
    expect(result.answer).not.toContain('The format works like')
    expect(result.answer).not.toContain('</think>')
  })

  it('REGRESSION: thought contains multiple </think> occurrences — answer is after the last', () => {
    const raw =
      '<think>' +
      'First mention of </think> inside thought. ' +
      'Second mention: </think> again. ' +
      'Done thinking.' +
      '</think>' +
      'Actual answer text.'

    const result = parseThinkBlocks(raw)

    expect(result.answer).toBe('Actual answer text.')
    expect(result.thought).toContain('First mention of </think>')
    expect(result.thought).toContain('Second mention: </think>')
    expect(result.thought).toContain('Done thinking.')
    expect(result.isThinking).toBe(false)
  })

  it('REGRESSION: leaked thought text must NOT appear as rendered answer', () => {
    // Exact pattern seen in the wild: model discusses /no_think inside its thought
    const raw =
      '<think>' +
      'Constraint: The user added `/no_think`. This means output without an explicit ' +
      'thought header, just the content. The </think> tag ends my thinking. ' +
      'I will just generate the response. Goal: Summarize.' +
      '</think>' +
      '\n\n## Summary\n\nHere is what the document covers.'

    const result = parseThinkBlocks(raw)

    expect(result.thought).toContain('Constraint: The user added')
    expect(result.thought).toContain('I will just generate the response')
    // None of the thought should leak into the answer
    expect(result.answer).not.toContain('Constraint')
    expect(result.answer).not.toContain('I will just generate')
    expect(result.answer).toContain('## Summary')
  })

  // ── Regression: Qwen3.5 verbatim echo (cleanAnswerEcho) ──────────────────
  //
  // Qwen3 in search-augmented mode often puts P1 (internal reasoning) + P2 (draft
  // answer) inside <think>, then repeats both P1+P2 verbatim after </think>.
  // The visible chat should show ONLY P2. P1 is internal monologue.

  it('REGRESSION: strips IMO paragraph from answer when thought and answer share same start', () => {
    const P1 = 'The user is asking about MSFT stock performance. I found some information ' +
               'from the search results indicating recent price movements. However, since ' +
               'the current date is April 1, 2026, I should use yfinance to get the most ' +
               'current stock data and create a proper visualization showing recent performance.'
    const P2 = 'Based on the latest available data, Microsoft (MSFT) stock has been trading ' +
               'in a range of approximately **$363.07 to $368.15** as of March 31, 2026.'

    // Model puts P1+P2 in <think>, then repeats P1+P2 verbatim after </think>
    const raw = `<think>${P1}\n\n${P2}</think>\n\n${P1}\n\n${P2}`
    const result = parseThinkBlocks(raw)

    // The IMO paragraph (P1) must NOT appear in the answer
    expect(result.answer).not.toContain('The user is asking about MSFT')
    expect(result.answer).not.toContain('I found some information')
    expect(result.answer).not.toContain('I should use yfinance')
    // The user-facing answer (P2) must appear in the answer
    expect(result.answer).toContain('Based on the latest available data')
    expect(result.answer).toContain('$363.07 to $368.15')
    // The thought accordion keeps everything (useful for the user to inspect)
    expect(result.thought).toContain(P1)
    expect(result.thought).toContain(P2)
  })

  it('REGRESSION: does NOT strip when answer starts differently from thought (Agentic AI pattern)', () => {
    // Thought: starts with numbered reasoning list
    // Answer:  starts with prose — different start → cleanAnswerEcho must NOT fire
    const thought =
      '1. Multi-agent systems replacing single agents\n' +
      '2. Microservices revolution in AI architecture\n' +
      '8. Agentic Ops moving to enterprise production\n\n' +
      'I should create a mermaid mindmap for this taxonomy.'
    const answer =
      'Based on the latest search results, here are the key Agentic AI trends for 2025-2026:\n\n' +
      '## Core Trends in Agentic AI\n\n' +
      '**1. Multi-Agent Systems Over Single Agents**\n' +
      'Single all-purpose agents are being replaced by orchestrated teams.'

    const raw = `<think>${thought}</think>\n\n${answer}`
    const result = parseThinkBlocks(raw)

    // Answer must be untouched — thought and answer have different starts
    expect(result.answer).toContain('Based on the latest search results')
    expect(result.answer).toContain('## Core Trends')
    expect(result.answer).toContain('Multi-Agent Systems')
  })

  it('REGRESSION: normal non-echo response is untouched (thought ≠ answer prefix)', () => {
    // Thought = pure reasoning; answer = clean reply — no shared start
    const raw =
      '<think>This is a coding question about Python inheritance. I should explain super().</think>' +
      'In Python, `super()` is used to call a method from a parent class.\n\n' +
      '```python\nclass Child(Parent):\n    def method(self):\n        super().method()\n```'
    const result = parseThinkBlocks(raw)

    expect(result.answer).toContain('`super()` is used')
    expect(result.answer).toContain('```python')
    expect(result.thought).toContain('Python inheritance')
  })
})

describe('parseThinkBlocks — streaming (open block)', () => {
  it('sets isThinking to true when <think> is not yet closed', () => {
    const result = parseThinkBlocks('<think>still reasoning...')
    expect(result.isThinking).toBe(true)
  })

  it('returns everything after <think> as the thought', () => {
    const result = parseThinkBlocks('<think>partial thought so far')
    expect(result.thought).toBe('partial thought so far')
  })

  it('returns an empty string for answer during streaming', () => {
    const result = parseThinkBlocks('<think>thinking')
    expect(result.answer).toBe('')
  })

  it('handles an empty open tag — just "<think>"', () => {
    const result = parseThinkBlocks('<think>')
    expect(result.isThinking).toBe(true)
    expect(result.thought).toBe('')
    expect(result.answer).toBe('')
  })

  it('preserves multi-line partial thought content', () => {
    const raw = '<think>\nStep 1: consider the data\nStep 2: apply Bayes rule'
    const result = parseThinkBlocks(raw)
    expect(result.isThinking).toBe(true)
    expect(result.thought).toContain('Step 1')
    expect(result.thought).toContain('Step 2')
  })
})

describe('parseThinkBlocks — plain responses (no think tags)', () => {
  it('returns the full string as answer', () => {
    const result = parseThinkBlocks('Just a plain response')
    expect(result.answer).toBe('Just a plain response')
  })

  it('returns empty strings for thought', () => {
    expect(parseThinkBlocks('hello').thought).toBe('')
  })

  it('sets isThinking to false', () => {
    expect(parseThinkBlocks('hello').isThinking).toBe(false)
  })

  it('handles empty input', () => {
    const result = parseThinkBlocks('')
    expect(result.thought).toBe('')
    expect(result.answer).toBe('')
    expect(result.isThinking).toBe(false)
  })

  it('handles markdown content without think tags', () => {
    const md = '## Heading\n\nSome **bold** text\n\n```python\nprint("hello")\n```'
    const result = parseThinkBlocks(md)
    expect(result.answer).toBe(md)
    expect(result.thought).toBe('')
  })

  it('does not treat <thinking> (wrong tag) as a think block', () => {
    const result = parseThinkBlocks('<thinking>not a think block</thinking>answer')
    expect(result.thought).toBe('')
    expect(result.answer).toBe('<thinking>not a think block</thinking>answer')
  })
})

// ── Suite: parseThinkBlocks — streamEnded recovery ───────────────────────────

describe('parseThinkBlocks — streamEnded=true recovery', () => {
  it('when stream ended and think block is still open: surfaces thought as answer', () => {
    const raw = '<think>I was reasoning about this when tokens ran out'
    const result = parseThinkBlocks(raw, true)
    expect(result.isThinking).toBe(false)
    expect(result.answer).toContain('I was reasoning about this when tokens ran out')
  })

  it('when stream ended and think block is still open: thought field also populated', () => {
    const raw = '<think>partial reasoning content'
    const result = parseThinkBlocks(raw, true)
    expect(result.thought).toBe('partial reasoning content')
  })

  it('when stream still in progress (streamEnded=false): open block stays as isThinking', () => {
    const raw = '<think>still reasoning...'
    const result = parseThinkBlocks(raw, false)
    expect(result.isThinking).toBe(true)
    expect(result.answer).toBe('')
  })

  it('fully closed block is unaffected by streamEnded flag', () => {
    const raw = '<think>thought</think>real answer'
    const result = parseThinkBlocks(raw, true)
    expect(result.answer).toBe('real answer')
    expect(result.thought).toBe('thought')
    expect(result.isThinking).toBe(false)
  })

  it('plain response unaffected by streamEnded flag', () => {
    const raw = 'Here is a plain answer with no think tags'
    const result = parseThinkBlocks(raw, true)
    expect(result.answer).toBe(raw)
    expect(result.thought).toBe('')
    expect(result.isThinking).toBe(false)
  })

  it('default streamEnded=false preserves existing behaviour for open blocks', () => {
    // Calling with no second arg should behave identically to false
    const raw = '<think>reasoning in progress'
    const withDefault  = parseThinkBlocks(raw)
    const withExplicit = parseThinkBlocks(raw, false)
    expect(withDefault).toEqual(withExplicit)
  })
})

// ── Suite: parseThinkBlocks — Gemma 4 channel-block format ───────────────────

describe('parseThinkBlocks — Gemma 4 channel-block format', () => {
  const GOPEN  = '<|channel>thought\n'
  const GCLOSE = '<channel|>'

  it('fully closed Gemma block: splits thought and answer correctly', () => {
    const raw = `${GOPEN}I should reason carefully here.${GCLOSE}Here is the answer.`
    const result = parseThinkBlocks(raw)
    expect(result.thought).toBe('I should reason carefully here.')
    expect(result.answer).toBe('Here is the answer.')
    expect(result.isThinking).toBe(false)
  })

  it('fully closed Gemma block: isThinking is false', () => {
    const raw = `${GOPEN}reasoning${GCLOSE}done`
    expect(parseThinkBlocks(raw).isThinking).toBe(false)
  })

  it('fully closed Gemma block: multi-line thought is preserved', () => {
    const raw = `${GOPEN}Step 1: analyse\nStep 2: conclude${GCLOSE}Result.`
    const result = parseThinkBlocks(raw)
    expect(result.thought).toContain('Step 1')
    expect(result.thought).toContain('Step 2')
    expect(result.answer).toBe('Result.')
  })

  it('fully closed Gemma block: uses lastIndexOf for close marker (greedy)', () => {
    // Model mentions <channel|> inside its own thought — must split at the LAST one
    const raw = `${GOPEN}The tag format is: ${GCLOSE}text. Done.${GCLOSE}Final answer.`
    const result = parseThinkBlocks(raw)
    expect(result.answer).toBe('Final answer.')
    expect(result.thought).toContain('The tag format is:')
  })

  it('still-open Gemma block during streaming: isThinking=true, answer empty', () => {
    const raw = `${GOPEN}still reasoning...`
    const result = parseThinkBlocks(raw, false)
    expect(result.isThinking).toBe(true)
    expect(result.answer).toBe('')
    expect(result.thought).toBe('still reasoning...')
  })

  it('still-open Gemma block after stream ended: surfaces thought as answer', () => {
    const raw = `${GOPEN}thinking when tokens ran out`
    const result = parseThinkBlocks(raw, true)
    expect(result.isThinking).toBe(false)
    expect(result.answer).toContain('thinking when tokens ran out')
    expect(result.thought).toContain('thinking when tokens ran out')
  })

  it('empty Gemma thought block (thinking disabled): no accordion, answer returned', () => {
    // When Gemma thinking is disabled the model emits an empty block
    const raw = `${GOPEN}${GCLOSE}The actual answer here.`
    const result = parseThinkBlocks(raw)
    expect(result.thought).toBe('')
    expect(result.answer).toBe('The actual answer here.')
    expect(result.isThinking).toBe(false)
  })

  it('whitespace-only Gemma thought block: treated as empty (no accordion)', () => {
    const raw = `${GOPEN}   \n   ${GCLOSE}The answer.`
    const result = parseThinkBlocks(raw)
    expect(result.thought).toBe('')
    expect(result.answer).toBe('The answer.')
    expect(result.isThinking).toBe(false)
  })

  it('plain response with no Gemma tags: falls through to normal handling', () => {
    const raw = 'Just a plain response with no channel tags.'
    const result = parseThinkBlocks(raw)
    expect(result.answer).toBe(raw)
    expect(result.thought).toBe('')
    expect(result.isThinking).toBe(false)
  })

  it('Qwen <think> tag is not confused with Gemma format', () => {
    const raw = '<think>Qwen reasoning</think>Qwen answer'
    const result = parseThinkBlocks(raw)
    expect(result.thought).toBe('Qwen reasoning')
    expect(result.answer).toBe('Qwen answer')
    expect(result.isThinking).toBe(false)
  })
})

// ── Suite: classifyCodeBlock ──────────────────────────────────────────────────

describe('classifyCodeBlock', () => {
  it('returns "inline" when lang is undefined', () => {
    expect(classifyCodeBlock(undefined)).toBe('inline')
  })

  it('returns "inline" when lang is an empty string', () => {
    expect(classifyCodeBlock('')).toBe('inline')
  })

  it('returns "mermaid" for the exact string "mermaid"', () => {
    expect(classifyCodeBlock('mermaid')).toBe('mermaid')
  })

  it('returns "mermaid" for uppercase "MERMAID" (case-insensitive)', () => {
    expect(classifyCodeBlock('MERMAID')).toBe('mermaid')
  })

  it('returns "mermaid" for mixed case "Mermaid"', () => {
    expect(classifyCodeBlock('Mermaid')).toBe('mermaid')
  })

  it('returns "code" for "python"', () => {
    expect(classifyCodeBlock('python')).toBe('code')
  })

  it('returns "code" for "typescript"', () => {
    expect(classifyCodeBlock('typescript')).toBe('code')
  })

  it('returns "code" for "javascript"', () => {
    expect(classifyCodeBlock('javascript')).toBe('code')
  })

  it('returns "code" for "bash"', () => {
    expect(classifyCodeBlock('bash')).toBe('code')
  })

  it('returns "code" for "text"', () => {
    expect(classifyCodeBlock('text')).toBe('code')
  })

  it('returns "code" for "sql"', () => {
    expect(classifyCodeBlock('sql')).toBe('code')
  })

  it('returns "code" for "json"', () => {
    expect(classifyCodeBlock('json')).toBe('code')
  })

  it('does NOT classify "mermaid-extra" as mermaid (exact match only)', () => {
    expect(classifyCodeBlock('mermaid-extra')).toBe('code')
  })

  it('does NOT classify "notmermaid" as mermaid', () => {
    expect(classifyCodeBlock('notmermaid')).toBe('code')
  })

  // ── ECharts / plot blocks ───────────────────────────────────────
  it('returns "echarts" for the exact string "echarts"', () => {
    expect(classifyCodeBlock('echarts')).toBe('echarts')
  })

  it('returns "echarts" for uppercase "ECHARTS" (case-insensitive)', () => {
    expect(classifyCodeBlock('ECHARTS')).toBe('echarts')
  })

  it('returns "echarts" for "plot" (alias)', () => {
    expect(classifyCodeBlock('plot')).toBe('echarts')
  })

  it('returns "echarts" for "PLOT" (alias, case-insensitive)', () => {
    expect(classifyCodeBlock('PLOT')).toBe('echarts')
  })

  it('does NOT classify "echarts-extra" as echarts', () => {
    expect(classifyCodeBlock('echarts-extra')).toBe('code')
  })

  // ── Matplotlib blocks ────────────────────────────────────────────────────────
  it('returns "matplotlib" for the exact string "matplotlib"', () => {
    expect(classifyCodeBlock('matplotlib')).toBe('matplotlib')
  })

  it('returns "matplotlib" for uppercase "MATPLOTLIB" (case-insensitive)', () => {
    expect(classifyCodeBlock('MATPLOTLIB')).toBe('matplotlib')
  })

  it('returns "matplotlib" for mixed case "Matplotlib"', () => {
    expect(classifyCodeBlock('Matplotlib')).toBe('matplotlib')
  })

  it('does NOT classify plain "python" as matplotlib (separate kind)', () => {
    expect(classifyCodeBlock('python')).toBe('code')
  })
})

// ── Suite: isValidMermaidSyntax ───────────────────────────────────────────────

describe('isValidMermaidSyntax', () => {
  it('returns false for an empty string', () => {
    expect(isValidMermaidSyntax('')).toBe(false)
  })

  it('returns false for a whitespace-only string', () => {
    expect(isValidMermaidSyntax('   \n\t\n  ')).toBe(false)
  })

  it('accepts "graph TD" (directed top-down flowchart)', () => {
    expect(isValidMermaidSyntax('graph TD\n  A --> B')).toBe(true)
  })

  it('accepts "graph LR" (directed left-right flowchart)', () => {
    expect(isValidMermaidSyntax('graph LR\n  A --> B')).toBe(true)
  })

  it('accepts "flowchart TD"', () => {
    expect(isValidMermaidSyntax('flowchart TD\n  A --> B')).toBe(true)
  })

  it('accepts "flowchart LR"', () => {
    expect(isValidMermaidSyntax('flowchart LR\n  start --> end')).toBe(true)
  })

  it('accepts "sequenceDiagram" (mixed case)', () => {
    expect(isValidMermaidSyntax('sequenceDiagram\n  Alice->>Bob: Hello')).toBe(true)
  })

  it('accepts "FLOWCHART TD" (all uppercase)', () => {
    expect(isValidMermaidSyntax('FLOWCHART TD\n  A --> B')).toBe(true)
  })

  it('accepts "pie title Pets owned"', () => {
    expect(isValidMermaidSyntax('pie title Pets owned\n  "Dogs" : 386')).toBe(true)
  })

  it('accepts "gantt"', () => {
    expect(isValidMermaidSyntax('gantt\n  title A Gantt Diagram\n  dateFormat  YYYY-MM-DD')).toBe(true)
  })

  it('accepts "classDiagram"', () => {
    expect(isValidMermaidSyntax('classDiagram\n  Animal <|-- Duck')).toBe(true)
  })

  it('accepts "stateDiagram-v2"', () => {
    expect(isValidMermaidSyntax('stateDiagram-v2\n  [*] --> Still')).toBe(true)
  })

  it('accepts "erDiagram"', () => {
    expect(isValidMermaidSyntax('erDiagram\n  CUSTOMER ||--o{ ORDER : places')).toBe(true)
  })

  it('accepts "gitgraph"', () => {
    expect(isValidMermaidSyntax('gitgraph\n  commit')).toBe(true)
  })

  it('accepts "mindmap"', () => {
    expect(isValidMermaidSyntax('mindmap\n  root((mindmap))')).toBe(true)
  })

  it('accepts "timeline"', () => {
    expect(isValidMermaidSyntax('timeline\n  title History')).toBe(true)
  })

  it('accepts "journey"', () => {
    expect(isValidMermaidSyntax('journey\n  title My working day')).toBe(true)
  })

  it('rejects plain prose text', () => {
    expect(isValidMermaidSyntax('hello world')).toBe(false)
  })

  it('rejects Python code', () => {
    expect(isValidMermaidSyntax('def foo():\n    return 42')).toBe(false)
  })

  it('rejects TypeScript code', () => {
    expect(isValidMermaidSyntax('const x: number = 42')).toBe(false)
  })

  it('rejects text that happens to contain "graph" mid-sentence', () => {
    // "graph" only valid at the very start of the first line
    expect(isValidMermaidSyntax('The graph shows...')).toBe(false)
  })

  it('handles leading whitespace — trims before checking keyword', () => {
    expect(isValidMermaidSyntax('  graph TD\n  A --> B')).toBe(true)
  })

  it('only inspects the first line — ignores subsequent lines', () => {
    // Second line has "graph" but first line does not start with a keyword
    expect(isValidMermaidSyntax('This is not mermaid\ngraph TD')).toBe(false)
  })

  it('MERMAID_START_KEYWORDS contains at least the core diagram types', () => {
    // Guard: if someone shrinks the keyword list, this catches it
    const required = ['graph', 'flowchart', 'sequencediagram', 'pie', 'gantt']
    for (const kw of required) {
      expect(MERMAID_START_KEYWORDS.map((k) => k.toLowerCase())).toContain(kw)
    }
  })
})

// ── Suite: escapeCurrencyDollars ──────────────────────────────────────────────

describe('escapeCurrencyDollars', () => {
  it('escapes a simple price — $164.65 → \\$164.65', () => {
    expect(escapeCurrencyDollars('$164.65')).toBe('\\$164.65')
  })

  it('escapes a price with comma separator — $1,200 → \\$1,200', () => {
    expect(escapeCurrencyDollars('$1,200')).toBe('\\$1,200')
  })

  it('escapes a zero-cents price — $0.99 → \\$0.99', () => {
    expect(escapeCurrencyDollars('$0.99')).toBe('\\$0.99')
  })

  it('escapes multiple currency amounts in one string', () => {
    const result = escapeCurrencyDollars('Price range: $164.65 to $174.63')
    expect(result).toBe('Price range: \\$164.65 to \\$174.63')
  })

  it('leaves math expression $K$ unchanged (followed by letter, not digit)', () => {
    expect(escapeCurrencyDollars('$K$')).toBe('$K$')
  })

  it('leaves math expression $\\pi$ unchanged (followed by backslash)', () => {
    expect(escapeCurrencyDollars('$\\pi$')).toBe('$\\pi$')
  })

  it('leaves math expression $\\mathbf{x}$ unchanged', () => {
    expect(escapeCurrencyDollars('$\\mathbf{x}$')).toBe('$\\mathbf{x}$')
  })

  it('leaves display math $$....$$ unchanged', () => {
    const md = '$$\\sum_{k=1}^{K} \\pi_k = 1$$'
    expect(escapeCurrencyDollars(md)).toBe(md)
  })

  it('handles mixed math and currency in the same string', () => {
    const input  = 'The cost is $42 and the variable is $x$.'
    const result = escapeCurrencyDollars(input)
    expect(result).toBe('The cost is \\$42 and the variable is $x$.')
  })

  it('returns plain text unchanged when no dollar signs present', () => {
    const plain = 'No dollar signs here at all.'
    expect(escapeCurrencyDollars(plain)).toBe(plain)
  })

  it('returns empty string unchanged', () => {
    expect(escapeCurrencyDollars('')).toBe('')
  })

  it('inserts newline before $$ when preceded by non-newline text', () => {
    // Model writes: "...the equation is $$A = B$$..."
    const result = escapeCurrencyDollars('the equation is $$A = B$$')
    expect(result).toContain('\n$$')
    // The $$ at the start of the block must be on its own line
    const lines = result.split('\n')
    expect(lines.some(l => l.startsWith('$$'))).toBe(true)
  })

  it('inserts newline after $$ when followed by non-newline text', () => {
    // Model writes: "$$A = B$$ is the formula"
    const result = escapeCurrencyDollars('$$A = B$$ is the formula')
    expect(result).toContain('$$\n')
    // The text after the closing $$ must be on a new line
    const lines = result.split('\n')
    expect(lines.some(l => l.startsWith('$$'))).toBe(true)
  })
})

// ── Suite: parseThinkBlocks — reasoning_content reconstruction ────────────────
//
// The app reconstructs a <think>...</think> block from the `reasoning_content`
// field of a non-streaming Step 1 LM Studio response, then passes the result
// through parseThinkBlocks. These tests verify the resulting shape is correct.

describe('parseThinkBlocks — reasoning_content reconstruction', () => {
  it('produces correct thought and answer from a reconstructed think block', () => {
    const result = parseThinkBlocks('<think>model decided to answer directly</think>The answer is 42', true)
    expect(result.thought).toBe('model decided to answer directly')
    expect(result.answer).toBe('The answer is 42')
    expect(result.isThinking).toBe(false)
  })

  it('thought is non-empty when there is no content after the close tag', () => {
    const result = parseThinkBlocks('<think>some reasoning</think>', true)
    expect(result.thought).toContain('some reasoning')
    // Answer should be empty or whitespace-only — no content after </think>
    expect(result.answer.trim()).toBe('')
    expect(result.isThinking).toBe(false)
  })

  it('returns empty thought and full answer when there is no think block', () => {
    const result = parseThinkBlocks('No think block at all', true)
    expect(result.thought).toBe('')
    expect(result.answer).toBe('No think block at all')
    expect(result.isThinking).toBe(false)
  })
})

// ── Suite: prepareUserContent ─────────────────────────────────────────────────

describe('prepareUserContent', () => {
  it('appends two trailing spaces to each line of plain multi-line text', () => {
    const result = prepareUserContent('a\nb\nc')
    expect(result).toBe('a  \nb  \nc  ')
  })

  it('injects blank line before opening fence so CommonMark recognises the block', () => {
    // Standalone code block: blank line is prepended before the opening ```
    const input = '```ts\nconst x = 1;\nconst y = 2;\n```'
    const lines = prepareUserContent(input).split('\n')
    const fenceIdx = lines.findIndex((l) => l.startsWith('```ts'))
    expect(lines[fenceIdx - 1]).toBe('')  // blank line immediately before opener
  })

  it('does not modify fence body lines (no trailing spaces added inside fence)', () => {
    const input = '```ts\nconst x = 1;\n```'
    const lines = prepareUserContent(input).split('\n')
    const bodyLine = lines.find((l) => l.includes('const x'))
    expect(bodyLine).toBe('const x = 1;')  // unchanged — no trailing spaces
  })

  it('does not modify the closing fence line', () => {
    const input = '```ts\ncode\n```'
    const lines = prepareUserContent(input).split('\n')
    const closingFence = lines[lines.length - 1]
    expect(closingFence).toBe('```')  // unchanged — no trailing spaces
  })

  it('adds trailing spaces to text after a closing fence', () => {
    const input = '```\ncode\n```\nworld'
    const lines = prepareUserContent(input).split('\n')
    const afterFence = lines[lines.length - 1]
    expect(afterFence).toBe('world  ')
  })

  it('prepends blank line before fence even when no text precedes it (standalone block)', () => {
    const result = prepareUserContent('```ts\ncode\n```')
    expect(result.startsWith('\n```')).toBe(true)
  })

  it('injects blank line before opening fence after paragraph text', () => {
    const input = 'hello\n```ts\nconst x = 1;\n```'
    const lines = prepareUserContent(input).split('\n')
    const fenceIdx = lines.findIndex((l) => l.startsWith('```ts'))
    expect(lines[fenceIdx - 1]).toBe('')  // blank line between text and fence
  })

  it('adds trailing spaces to non-fence lines in mixed content', () => {
    const input = 'hello\n```\ncode\n```\nworld'
    const result = prepareUserContent(input)
    // hello and world get trailing spaces; fence lines and code body do not
    expect(result).toBe('hello  \n\n```\ncode\n```\nworld  ')
  })

  it('does not double-space lines already ending with two spaces', () => {
    const result = prepareUserContent('line one  \nline two')
    expect(result).toBe('line one  \nline two  ')
  })

  it('returns empty string for empty input', () => {
    expect(prepareUserContent('')).toBe('')
  })
})
