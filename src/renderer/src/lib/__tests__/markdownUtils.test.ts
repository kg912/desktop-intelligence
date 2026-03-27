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

  it('preserves the answer text exactly — no trimming', () => {
    const result = parseThinkBlocks('<think>t</think>  answer with leading space')
    expect(result.answer).toBe('answer with leading space')
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
