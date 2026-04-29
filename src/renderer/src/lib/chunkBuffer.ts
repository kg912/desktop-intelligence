/**
 * chunkBuffer — pure buffer state-machine extracted from useChat.ts
 *
 * Zero React imports. Operates only on plain objects and strings so these
 * functions can be unit-tested in a plain Node / Vitest environment.
 *
 * Design: all functions return new values (immutable) instead of mutating refs.
 * useChat.ts wraps these functions and writes the returned values back to refs.
 */

// ── State shapes ──────────────────────────────────────────────────────────────

export interface BlockState {
  id:          string
  type:        'thinking' | 'answer'
  content:     string
  isStreaming?: boolean
}

export interface BufferContext {
  blocks:        BlockState[]
  activeBlockId: string | null
  inThinkBlock:  boolean
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Returns how many chars at the end of `buf` could be the start of `tag`.
 *
 * Used to hold back incomplete tag sequences at SSE chunk boundaries so the
 * caller never accidentally routes a partial tag to an answer block.
 *
 * Examples (tag = "<think>"):
 *   partialTagSuffix("hello <t", "<think>") → 2  ("<t" could start "<think>")
 *   partialTagSuffix("hello",    "<think>") → 0
 *   partialTagSuffix("",         "<think>") → 0
 *
 * The safe slice to flush is: buf.slice(0, buf.length - partialLen)
 */
export function partialTagSuffix(buf: string, tag: string): number {
  for (let len = Math.min(tag.length - 1, buf.length); len > 0; len--) {
    if (buf.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

/**
 * Appends `text` to the block with the given id.
 * Returns a new blocks array (immutable — input array is never mutated).
 *
 * - thinking blocks: content += text
 * - answer   blocks: content += text, isStreaming = true
 * - unknown  blockId: returns input array unchanged
 */
export function appendToBlock(
  blocks:  BlockState[],
  blockId: string,
  text:    string,
): BlockState[] {
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx === -1) return blocks;
  const b = blocks[idx];
  const updated: BlockState =
    b.type === 'thinking'
      ? { ...b, content: b.content + text }
      : { ...b, content: b.content + text, isStreaming: true };
  const next = [...blocks];
  next[idx] = updated;
  return next;
}

/**
 * Routes `text` to the active answer block, creating one if needed.
 * Returns an updated BufferContext (immutable).
 *
 * - If ctx.activeBlockId points to an existing answer block: appends to it.
 * - Otherwise: creates a new AnswerBlock (isStreaming: true) and sets activeBlockId.
 */
export function ensureAnswerAndAppend(
  ctx:   BufferContext,
  text:  string,
  genId: () => string,
): BufferContext {
  if (ctx.activeBlockId) {
    const existing = ctx.blocks.find((b) => b.id === ctx.activeBlockId);
    if (existing?.type === 'answer') {
      return { ...ctx, blocks: appendToBlock(ctx.blocks, ctx.activeBlockId, text) };
    }
  }
  // No active answer block — create one
  const newId = genId();
  return {
    ...ctx,
    blocks: [
      ...ctx.blocks,
      { id: newId, type: 'answer', content: text, isStreaming: true },
    ],
    activeBlockId: newId,
  };
}

/**
 * Marks the answer block with the given id as isStreaming: false.
 * Returns a new blocks array (immutable).
 * Non-answer blocks and unknown ids are no-ops.
 */
export function closeAnswerBlock(
  blocks:  BlockState[],
  blockId: string,
): BlockState[] {
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx === -1) return blocks;
  const b = blocks[idx];
  if (b.type !== 'answer') return blocks;
  const next = [...blocks];
  next[idx] = { ...b, isStreaming: false };
  return next;
}

/**
 * Main entry point: processes `buf` against the current context.
 *
 * Scans for `<think>` / `</think>` boundaries and routes tokens to the correct
 * block type. Text before a boundary is flushed; any partial tag at the end of
 * `buf` is held back in `remaining` for the next call.
 *
 * Returns:
 *   ctx      — updated context (blocks, activeBlockId, inThinkBlock)
 *   remaining — unconsumed text (partial tag suffix) to prepend to next chunk
 *   mutated  — true when at least one block was written (triggers a state flush)
 */
export function processBuffer(
  buf:   string,
  ctx:   BufferContext,
  genId: () => string,
): { ctx: BufferContext; remaining: string; mutated: boolean } {
  let cur     = ctx;
  let mutated = false;

  while (buf.length > 0) {
    if (cur.inThinkBlock) {
      // ── Inside a think block — scan for </think> ──────────────────────────
      const CLOSE = '</think>';
      const closeIdx = buf.indexOf(CLOSE);

      if (closeIdx === -1) {
        // No close tag yet — hold back any partial closing-tag suffix
        const partialLen = partialTagSuffix(buf, CLOSE);
        const safe = buf.slice(0, buf.length - partialLen);
        if (safe && cur.activeBlockId) {
          cur = { ...cur, blocks: appendToBlock(cur.blocks, cur.activeBlockId, safe) };
          mutated = true;
        }
        buf = partialLen > 0 ? buf.slice(buf.length - partialLen) : '';
        break;
      } else {
        // Close tag found — commit text before it, exit think mode
        const before = buf.slice(0, closeIdx);
        if (before && cur.activeBlockId) {
          cur = { ...cur, blocks: appendToBlock(cur.blocks, cur.activeBlockId, before) };
          mutated = true;
        }
        cur = { ...cur, inThinkBlock: false, activeBlockId: null };
        buf = buf.slice(closeIdx + CLOSE.length);
        mutated = true;
      }
    } else {
      // ── In answer mode — scan for <think> ────────────────────────────────
      const OPEN = '<think>';
      const openIdx = buf.indexOf(OPEN);

      if (openIdx === -1) {
        // No open tag — hold back any partial opening-tag suffix
        const partialLen = partialTagSuffix(buf, OPEN);
        const safe = buf.slice(0, buf.length - partialLen);
        if (safe) {
          cur = ensureAnswerAndAppend(cur, safe, genId);
          mutated = true;
        }
        buf = partialLen > 0 ? buf.slice(buf.length - partialLen) : '';
        break;
      } else {
        // Open tag found — flush answer text before it, enter think mode
        const before = buf.slice(0, openIdx);
        if (before) {
          cur = ensureAnswerAndAppend(cur, before, genId);
          mutated = true;
        }
        // Close the active answer block before switching to think mode
        if (cur.activeBlockId) {
          cur = {
            ...cur,
            blocks:        closeAnswerBlock(cur.blocks, cur.activeBlockId),
            activeBlockId: null,
          };
        }
        // Create a new ThinkingBlock
        const newThinkId = genId();
        cur = {
          ...cur,
          blocks:       [...cur.blocks, { id: newThinkId, type: 'thinking', content: '' }],
          inThinkBlock: true,
          activeBlockId: newThinkId,
        };
        buf = buf.slice(openIdx + OPEN.length);
        mutated = true;
      }
    }
  }

  return { ctx: cur, remaining: buf, mutated };
}
