/**
 * WebSearchService unit tests — detectSearchIntent only
 *
 * detectSearchIntent() is a pure function with zero side-effects.
 * No mocks, no network access, no Electron dependencies required.
 *
 * Coverage goals:
 *   ✓ Every individual trigger phrase in all three INTENT_PATTERNS fires
 *   ✓ Prefix stripping: the exact returned query string is asserted for each strip path
 *   ✓ Pattern 2 trigger phrases absent from stripPrefix return the full trimmed text
 *   ✓ stripPrefix is anchored (^): mid-sentence trigger does not produce a stripped query
 *   ✓ Bare keyword with no following query: function never returns null or empty string
 *   ✓ Case-insensitive detection and case-insensitive prefix stripping
 *   ✓ Leading/trailing/tab whitespace in input is normalised before matching
 *   ✓ Pattern 3 distance limit: second keyword >40 chars from find/check → null
 *   ✓ 10 realistic false-positive inputs each return null
 *
 * Architecture note — pattern evaluation order:
 *   Pattern 1 (explicit: search/google/look)  — checked first
 *   Pattern 2 (question/info: what's/latest…) — checked second
 *   Pattern 3 (contextual: find/check…web)    — checked third
 * Because "latest" and "current" appear in Pattern 2's `re`, any input
 * containing those words is intercepted by Pattern 2 before Pattern 3 is
 * reached — even if the sentence also has "find" or "check".  Tests that
 * target Pattern 3 in isolation therefore use "online/web/internet/news".
 */

import { describe, it, expect } from 'vitest'
import { detectSearchIntent } from '../WebSearchService'

// ─── Pattern 1 — Explicit search commands ────────────────────────────────────
//
// re:          /\b(search the web|search online|google|look up|look for|search for)\b/i
// stripPrefix: /^(search (the web |online )?for|search (the web|online)|look up|look for|google)\s+/i

describe('Pattern 1 — explicit search commands', () => {
  describe('trigger detection — every phrase fires independently', () => {
    it('"search the web" trigger returns non-null', () => {
      expect(detectSearchIntent('search the web for AI trends')).not.toBeNull()
    })

    it('"search online" trigger returns non-null', () => {
      expect(detectSearchIntent('search online for recipes')).not.toBeNull()
    })

    it('"google" trigger returns non-null', () => {
      expect(detectSearchIntent('google Python tutorial')).not.toBeNull()
    })

    it('"look up" trigger returns non-null', () => {
      expect(detectSearchIntent('look up the capital of Japan')).not.toBeNull()
    })

    it('"look for" trigger returns non-null', () => {
      expect(detectSearchIntent('look for coffee shops nearby')).not.toBeNull()
    })

    it('"search for" trigger returns non-null', () => {
      expect(detectSearchIntent('search for JavaScript best practices')).not.toBeNull()
    })
  })

  describe('prefix stripping — exact returned query string', () => {
    it('strips "search the web for " prefix, returning only the topic', () => {
      // stripPrefix alt-1: /^search (the web )?for\s+/i matches "search the web for "
      expect(detectSearchIntent('search the web for latest news')).toBe('latest news')
    })

    it('strips "search online for " prefix, returning only the topic', () => {
      // stripPrefix alt-1: /^search (online )?for\s+/i matches "search online for "
      expect(detectSearchIntent('search online for breaking news')).toBe('breaking news')
    })

    it('strips "search for " prefix (no "the web"/"online" qualifier), returning only the topic', () => {
      // stripPrefix alt-1 with optional group absent: "search for " stripped
      expect(detectSearchIntent('search for TypeScript tutorials')).toBe('TypeScript tutorials')
    })

    it('strips "search the web " prefix when "for" is absent', () => {
      // stripPrefix alt-2: /^search (the web)\s+/i matches "search the web "
      expect(detectSearchIntent('search the web stock market update')).toBe('stock market update')
    })

    it('strips "search online " prefix when "for" is absent', () => {
      // stripPrefix alt-2: /^search (online)\s+/i matches "search online "
      expect(detectSearchIntent('search online new AI models')).toBe('new AI models')
    })

    it('strips "google " prefix, returning only the topic', () => {
      expect(detectSearchIntent('google deepmind research')).toBe('deepmind research')
    })

    it('strips "look up " prefix, returning only the topic', () => {
      expect(detectSearchIntent('look up the best restaurants in Tokyo')).toBe(
        'the best restaurants in Tokyo'
      )
    })

    it('strips "look for " prefix, returning only the topic', () => {
      expect(detectSearchIntent('look for a JavaScript framework')).toBe('a JavaScript framework')
    })
  })
})

// ─── Pattern 2 — Question and info patterns ───────────────────────────────────
//
// re:          /\b(what('s| is)|who('s| is)|tell me about|latest|current|
//                  recent news (about|on)|news about)\b/i
// stripPrefix: /^(what('s| is)|who('s| is)|tell me about)\s+/i
//
// "latest", "current", "recent news about/on", and "news about" match `re`
// but are NOT in stripPrefix — those triggers return the full trimmed text.

describe('Pattern 2 — question and info patterns', () => {
  describe('trigger detection — every phrase fires independently', () => {
    it('"what\'s" contraction trigger returns non-null', () => {
      expect(detectSearchIntent("what's the weather in New York")).not.toBeNull()
    })

    it('"what is" (two words) trigger returns non-null', () => {
      expect(detectSearchIntent('what is the speed of light')).not.toBeNull()
    })

    it('"who\'s" contraction trigger returns non-null', () => {
      expect(detectSearchIntent("who's the prime minister of the UK")).not.toBeNull()
    })

    it('"who is" (two words) trigger returns non-null', () => {
      expect(detectSearchIntent('who is the CEO of OpenAI')).not.toBeNull()
    })

    it('"tell me about" trigger returns non-null', () => {
      expect(detectSearchIntent('tell me about the history of Rome')).not.toBeNull()
    })

    it('"latest" trigger returns non-null', () => {
      expect(detectSearchIntent('latest developments in quantum computing')).not.toBeNull()
    })

    it('"current" trigger returns non-null', () => {
      expect(detectSearchIntent('current inflation rate in the EU')).not.toBeNull()
    })

    it('"recent news about" phrase trigger returns non-null', () => {
      expect(detectSearchIntent('recent news about the Olympics')).not.toBeNull()
    })

    it('"recent news on" phrase trigger returns non-null', () => {
      expect(detectSearchIntent('recent news on the presidential election')).not.toBeNull()
    })

    it('"news about" phrase trigger returns non-null', () => {
      expect(detectSearchIntent('news about AI regulation')).not.toBeNull()
    })
  })

  describe('prefix stripping — exact returned query string', () => {
    it('strips "what\'s " prefix leaving only the topic', () => {
      expect(detectSearchIntent("what's the population of Tokyo")).toBe('the population of Tokyo')
    })

    it('strips "what is " prefix leaving only the topic', () => {
      expect(detectSearchIntent('what is machine learning')).toBe('machine learning')
    })

    it('strips "who\'s " prefix leaving only the topic', () => {
      expect(detectSearchIntent("who's the richest person alive")).toBe('the richest person alive')
    })

    it('strips "who is " prefix leaving only the topic', () => {
      expect(detectSearchIntent('who is Elon Musk')).toBe('Elon Musk')
    })

    it('strips "tell me about " prefix leaving only the topic', () => {
      expect(detectSearchIntent('tell me about JavaScript frameworks')).toBe(
        'JavaScript frameworks'
      )
    })

    it('"latest" trigger is NOT in stripPrefix — full text returned unchanged', () => {
      // "latest" fires the re but the stripPrefix has no entry for it,
      // so trimmed.replace(stripPrefix, '') returns the string unchanged.
      expect(detectSearchIntent('latest iPhone release')).toBe('latest iPhone release')
    })

    it('"current" trigger is NOT in stripPrefix — full text returned unchanged', () => {
      expect(detectSearchIntent('current gold price')).toBe('current gold price')
    })

    it('"recent news about" trigger is NOT in stripPrefix — full text returned unchanged', () => {
      expect(detectSearchIntent('recent news about the stock market')).toBe(
        'recent news about the stock market'
      )
    })

    it('"recent news on" trigger is NOT in stripPrefix — full text returned unchanged', () => {
      expect(detectSearchIntent('recent news on the Ukraine conflict')).toBe(
        'recent news on the Ukraine conflict'
      )
    })

    it('"news about" trigger is NOT in stripPrefix — full text returned unchanged', () => {
      expect(detectSearchIntent('news about AI regulations')).toBe('news about AI regulations')
    })
  })
})

// ─── Pattern 3 — Contextual web phrases ──────────────────────────────────────
//
// re:          /\b(find|check)\b.{0,40}\b(online|web|internet|news|latest|current)\b/i
// stripPrefix: /^(find|check)\s+/i
//
// For pure pattern-3 exercise the secondary keyword must be "online/web/internet/news"
// because "latest" and "current" also appear in pattern 2's re and fire that pattern
// first.  Tests for "find/check…latest/current" are still included but carry an
// explicit note that they are intercepted by pattern 2.

describe('Pattern 3 — contextual web phrases (find/check … second keyword)', () => {
  describe('trigger detection — every individual secondary keyword fires', () => {
    it('detects "find ... online" and returns non-null', () => {
      expect(detectSearchIntent('find the best deals online')).not.toBeNull()
    })

    it('detects "find ... web" and returns non-null', () => {
      expect(detectSearchIntent('find product reviews on the web')).not.toBeNull()
    })

    it('detects "find ... internet" and returns non-null', () => {
      expect(detectSearchIntent('find resources on the internet')).not.toBeNull()
    })

    it('detects "find ... news" and returns non-null', () => {
      // "news" (without "about") does not match pattern 2 — pattern 3 fires.
      expect(detectSearchIntent('find breaking news on AI')).not.toBeNull()
    })

    it('detects "find ... latest" — intercepted by pattern 2 "latest" trigger, still non-null', () => {
      // Pattern 2 fires first via "latest"; the invariant is that intent is still detected.
      expect(detectSearchIntent('find the latest tech deals')).not.toBeNull()
    })

    it('detects "find ... current" — intercepted by pattern 2 "current" trigger, still non-null', () => {
      expect(detectSearchIntent('find current flight prices')).not.toBeNull()
    })

    it('detects "check ... online" and returns non-null', () => {
      expect(detectSearchIntent('check flight availability online')).not.toBeNull()
    })

    it('detects "check ... latest" — intercepted by pattern 2 "latest" trigger, still non-null', () => {
      expect(detectSearchIntent('check the latest iPhone reviews')).not.toBeNull()
    })

    it('detects "check ... current" — intercepted by pattern 2 "current" trigger, still non-null', () => {
      expect(detectSearchIntent('check current gold prices')).not.toBeNull()
    })
  })

  describe('prefix stripping — exact returned query string', () => {
    it('strips "find " prefix, returning the rest of the text for an "online" input', () => {
      expect(detectSearchIntent('find the best deals online')).toBe('the best deals online')
    })

    it('strips "find " prefix with "web" as secondary keyword', () => {
      expect(detectSearchIntent('find product reviews on the web')).toBe(
        'product reviews on the web'
      )
    })

    it('strips "find " prefix with "internet" as secondary keyword', () => {
      expect(detectSearchIntent('find resources on the internet')).toBe(
        'resources on the internet'
      )
    })

    it('strips "find " prefix with "news" as secondary keyword', () => {
      expect(detectSearchIntent('find breaking news on AI')).toBe('breaking news on AI')
    })

    it('strips "check " prefix, returning the rest of the text for an "online" input', () => {
      expect(detectSearchIntent('check flight availability online')).toBe(
        'flight availability online'
      )
    })
  })

  describe('distance limit — second keyword beyond 40 chars from find/check → null', () => {
    it('returns null when the second keyword is more than 40 chars away from "find"', () => {
      // Gap between end of "find" and start of "online" is ~68 characters,
      // exceeding the .{0,40} maximum.  Patterns 1 and 2 also do not match
      // this string, so the function must return null.
      const longGap =
        'find a text string that is way too long for this pattern to still match online'
      expect(detectSearchIntent(longGap)).toBeNull()
    })
  })
})

// ─── stripPrefix anchor (^) and defensive fallback ───────────────────────────

describe('stripPrefix anchor — mid-sentence trigger does not spuriously strip', () => {
  it('returns the full trimmed text when the trigger keyword appears mid-sentence', () => {
    // "google" fires pattern 1, but stripPrefix is anchored with ^ so "I want you to"
    // at the start prevents the prefix from being stripped.
    expect(detectSearchIntent('I want you to google the latest news')).toBe(
      'I want you to google the latest news'
    )
  })

  it('still returns non-null when the trigger is mid-sentence (intent IS detected)', () => {
    // The function correctly flags search intent; it just cannot strip a mid-sentence prefix.
    expect(detectSearchIntent('maybe we should look up the answer')).not.toBeNull()
  })
})

describe('bare keyword with no query — function never returns null or empty string', () => {
  it('returns "google" when the bare word "google" is the entire input', () => {
    // stripPrefix requires \s+ after "google"; bare "google" has none, so
    // replace() leaves the string unchanged.  The `return query || trimmed`
    // guard ensures "" never escapes — the original text is returned instead.
    expect(detectSearchIntent('google')).toBe('google')
  })

  it('returns "look for" when the bare phrase "look for" is the entire input', () => {
    // Same defensive path: stripPrefix needs trailing \s+ which is absent.
    expect(detectSearchIntent('look for')).toBe('look for')
  })

  it('returns "latest" when the bare word "latest" is the entire input', () => {
    // Pattern 2 fires; stripPrefix has no entry for "latest" so query = "latest".
    expect(detectSearchIntent('latest')).toBe('latest')
  })
})

// ─── Case insensitivity ───────────────────────────────────────────────────────

describe('case insensitivity — detection and stripping both use the /i flag', () => {
  it('detects all-caps "GOOGLE" and strips the prefix correctly', () => {
    expect(detectSearchIntent('GOOGLE apple stock price')).toBe('apple stock price')
  })

  it('detects all-caps "WHAT IS" and strips the prefix correctly', () => {
    expect(detectSearchIntent('WHAT IS quantum computing')).toBe('quantum computing')
  })

  it('detects all-caps "TELL ME ABOUT" and strips the prefix correctly', () => {
    expect(detectSearchIntent('TELL ME ABOUT the universe')).toBe('the universe')
  })

  it('detects mixed-case "Look Up" and strips the prefix correctly', () => {
    expect(detectSearchIntent('Look Up the weather forecast')).toBe('the weather forecast')
  })

  it('detects mixed-case "Search For" and strips the prefix correctly', () => {
    expect(detectSearchIntent('Search For Node.js tutorials')).toBe('Node.js tutorials')
  })
})

// ─── Whitespace handling ──────────────────────────────────────────────────────

describe('whitespace handling — input is trimmed before matching and stripping', () => {
  it('strips leading and trailing spaces, then returns a clean stripped query', () => {
    expect(detectSearchIntent('  search for Python tutorials  ')).toBe('Python tutorials')
  })

  it('strips a leading tab and trailing newline, then returns a clean stripped query', () => {
    expect(detectSearchIntent('\tgoogle typescript best practices\n')).toBe(
      'typescript best practices'
    )
  })

  it('strips mixed leading and trailing whitespace, then returns a clean stripped query', () => {
    expect(detectSearchIntent('  look up the latest MacBook Pro  ')).toBe(
      'the latest MacBook Pro'
    )
  })

  it('returns null for a whitespace-only string after trimming', () => {
    expect(detectSearchIntent('   ')).toBeNull()
  })
})

// ─── Plain conversation — false positives must return null ────────────────────

describe('plain conversation — no trigger phrase present returns null', () => {
  it('returns null for an empty string', () => {
    expect(detectSearchIntent('')).toBeNull()
  })

  it('returns null for a simple greeting', () => {
    expect(detectSearchIntent('Hello, how are you today?')).toBeNull()
  })

  it('returns null for an arithmetic expression', () => {
    expect(detectSearchIntent('2 + 2 equals 4')).toBeNull()
  })

  it('returns null for a coding how-do-I question (no trigger phrase)', () => {
    // "How do I" does not match any of the three patterns.
    expect(detectSearchIntent('How do I reverse a string in Python?')).toBeNull()
  })

  it('returns null for an "explain X" request', () => {
    expect(detectSearchIntent('Explain the concept of recursion')).toBeNull()
  })

  it('returns null for a "summarise" request', () => {
    expect(detectSearchIntent('Summarise this article for me')).toBeNull()
  })

  it('returns null for a debugging help request', () => {
    expect(detectSearchIntent('Can you help me debug this code?')).toBeNull()
  })

  it('returns null for "looking for" — word boundary prevents matching "look for"', () => {
    // "looking for" is the substring l-o-o-k-i-n-g-<space>-f-o-r.
    // "look for" (l-o-o-k-<space>-f-o-r) is NOT a substring of "looking for"
    // so the pattern \b(look for)\b never matches.
    expect(detectSearchIntent('I am looking for a good movie')).toBeNull()
  })

  it('returns null for "Tell me a story" — only "tell me about" is a trigger, not "tell me a"', () => {
    // The phrase "tell me about" does not appear as a contiguous substring.
    expect(detectSearchIntent('Tell me a story about dragons')).toBeNull()
  })

  it('returns null for a casual request with no search trigger words', () => {
    expect(detectSearchIntent('Can you write me a sorting algorithm?')).toBeNull()
  })
})
