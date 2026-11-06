# Exa API verification (Phase 0)

Date: 2026-11-06. Real key from the `EXA_API_KEY` environment variable, called with `curl` against `POST https://api.exa.ai/search`. The key is not recorded anywhere. Fixtures (request ids removed) are in `src/main/services/search/__tests__/fixtures/`.

Query used for the shape checks: `What did the James Webb Space Telescope discover in 2025?`, `numResults: 5`.

## 1. Four types with `contents.highlights: true`

| type | HTTP | wall time | `searchTime` (ms) | `costDollars` |
|---|---|---|---|---|
| `lite` | 200 | 0.76 s | 358.6 | `{ total: 0.004, search: { neural: 0.004 } }` |
| `auto` | 200 | 0.69 s | 308.4 | `{ total: 0.007, search: { neural: 0.007 } }` |
| `deep-lite` | 200 | 2.97 s | 2709.2 | `{ total: 0.012 }` |
| `deep` | 200 | 5.74 s | 5505.8 | `{ total: 0.012 }` |

Top-level keys on every success: `requestId`, `resolvedSearchType`, `results`, `searchTime`, `costDollars` (plus `output` when `outputSchema` is sent, `warnings` when there are any). `resolvedSearchType` was the empty string for every type, so DI does not rely on it; the effective type is the one DI sent.

Each result: `id`, `title`, `url`, `publishedDate` (ISO string or `null`), `image`, `highlights` (array), `author` (deep only, sometimes). No `highlightScores` came back. Each result had exactly one highlight string, 970 to 6,430 characters (fixture `search-auto-highlights.json`). Highlights are already multi-paragraph extracts, so DI uses them as the body directly.

## 2. Same with `contents.text.maxCharacters: 3000`

All four 200. Results carry `text` (exactly 3,000 characters for long pages) instead of `highlights`. Same cost as highlights. Fixture `search-lite-text.json`.

`lite` returned 5 of 5 results for this query in both content modes (cache hit).

## 3. `lite` rejections

All return `400` with `tag: "INVALID_REQUEST_BODY"` and an `error` naming the field (fixture `error-400-lite-outputschema.json`):

- `outputSchema` → `Invalid request body | Not supported with type "lite": outputSchema. Use type "auto" for other parameters.`
- `contents.maxAgeHours` (both `24` and `0`) → `... "lite": contents.maxAgeHours ...`
- `systemPrompt`, `additionalQueries`, `contents.summary`, `contents.livecrawl` → same message pattern.

`auto` accepts `maxAgeHours: 24` (1.3 s) and `maxAgeHours: 0` (3.5 s, livecrawl every result) at the normal `auto` price.

## 4. `deep` and `deep-lite` with `outputSchema: { type: "text", description }`

`output` is `{ content: string, grounding: [{ field: "content", citations: [{ url, title }], confidence: "high" }] }`. Fixture `search-deep-synthesis.json` (`deep`: 3,727 characters, 16 citations; `deep-lite`: 711 characters, 5 citations). Same price as without the schema.

**Differs from the spec:** the `[1][2]` markers inside `output.content` index `grounding[0].citations`, not the `results` list, and `deep` cites more pages (16) than it returns as results (5). DI therefore lists the brief's own citations under the brief (`Brief sources: [1] title url`) so the model does not read `[1]` as result 1.

No extra planning fields came back for deep types (section 8a item 6): the response shows results, the brief and its grounding only.

## 5. `notices` and `warnings`

`notices` never appeared (legacy types `fast`, `instant`, `neural`, `keyword`, `deep-reasoning` and `livecrawl: "always"` all returned 200 with no notice). `warnings` appears for an ignored field (fixture `search-auto-warnings.json`):

```json
"warnings": [{ "code": "IGNORED_FIELD", "path": "/useAutoprompt", "message": "useAutoprompt is no longer supported and is ignored. Remove it from the request." }]
```

DI logs `warnings` and passes `notices` (if one ever appears, as string or `{ message }`) to the model.

## 6. Error bodies

Error JSON is `{ requestId, error: string, tag: string }`.

- Bad key → `401`, `tag: "INVALID_API_KEY"`, `error: "Invalid API key. Provide a valid key using 'Authorization: Bearer <key>' or 'x-api-key: <key>'. ..."` (fixture `error-401-invalid-key.json`).
- **No key** → `402`, `tag: "X402_PAYMENT_REQUIRED"`, `error: "Payment required to access this resource"`, plus an x402 crypto payment offer (fixture keeps only `error`, `tag`, `x402Version`). Exhausted credits could not be triggered with this account; 402 is mapped to "add credits or check the key's budget" either way, and DI never sends a request without a key.
- Unknown type (`deep-research`) → `400 INVALID_REQUEST_BODY` listing the accepted types: `neural, keyword, auto, hybrid, fast, blue, deep-reasoning, deep-lite, magic, deep, instant, lite, image`.
- `numResults: 0` → `400` "Must be at least 1". `numResults: 11` on `auto` → 200 with 10 results (silently capped). DI clamps to 3–10.
- 429 could not be triggered at single-user rates.

## 7. Auth header

`x-api-key: <key>` and `Authorization: Bearer <key>` both return 200. DI uses `x-api-key`.

## 8. Phase 2 (Agent API)

Not run; Phase 2 is out of scope for this change.

## 9. `objective`

`objective` (the optional tool argument from section 5) is accepted on `lite`, `auto` and `deep-lite` with no error or warning. A made-up field (`zzUnknownField`) is also accepted silently, so these calls cannot prove Exa uses `objective`; DI sends it as the spec and mockup show.
