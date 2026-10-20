# dsh-cast — Structured Persona Refactor (sliders → six natural-language fields)

**State:** complete. All six suites green. Real-browser client acceptance is **not** run (see "Unverified" below — the environment has no Web rebuild path).

---

## Round 2 — live defects reported by the user, fixed

All were reproduced against the running host before being changed.

### D1 — "Try persona is not working" (A/B too)

**Reproduced:** `POST /api/dsh-cast/try` returned `200` with `{"response":""}` — an empty success, not an error.

**Cause:** `_llmComplete()` resolved the model with `llm.listProviders()[0]`. Provider registration order is arbitrary and the first route is **not** the configured one; that call streamed no text, and the helper returned `''`. The real selection lives in `ctx.agentDefaultModel` — this profile configures `provider: deepseek-official, model: deepseek-flash, reasoningEffort: high`.

**Fix:** `_llmComplete()` now reads `ctx.get('agentDefaultModel').currentSelection()` (optional lookup — not added to `inject`, so a profile without it still loads), passes `reasoningEffort`, and falls back to provider discovery only when that service is absent. A stream that ends `error`/`aborted` with no text now **throws** with the provider/model and failure detail instead of returning an empty string. Affects Try, A/B compare, and summarization.

### D3 — `model call error (deepseek-official/deepseek-flash): DeepSeek Messages transport failed`

**Reproduced (after D1 landed):** D1's error surfacing revealed the next failure in the same path — an opaque provider `TRANSPORT` error.

**Cause:** `compare()` and `tryPersona()` passed a **bare string** as message content (`[{ role: 'user', content: prompt }]`), but harness `RequestMessage.content` is `readonly ContentBlock[]`. The DeepSeek adapter's `serialize()` calls `message.content.flatMap(...)` / `.some(...)`, so a string throws `content.flatMap is not a function` *inside* the adapter — reported only as `"DeepSeek Messages transport failed"`, with no hint of the real cause.

**Fix:** `_llmComplete()` normalizes every request through `normalizeRequestMessages()`, converting string content to `[{ type: 'text', text }]` blocks. One change covers all three isolated callers (Try, A/B compare, summarization), which all funnel through `_llmComplete()`. Regression-pinned in `test/schema.test.mjs` (asserts the adapter receives a content **block**, not a string).

### D2 — "Personas do not behave as expected"

**Reproduced:** the preview for the user's `Silas` persona showed `dsh-cast:behavior` **truncated and over budget**, with the tail of the `rules` field cut off mid-sentence (`… Keep It Brief: Use short, sharp sentences. Avoid` + truncation marker) — so instructions the persona depends on ("Avoid Internet Sarcasm") never reached the model.

**Cause:** `behavior` + `expertise` + `rules` had been merged into ONE `dsh-cast:behavior` section with a single 300-token band. A realistically-written persona exceeded it, and one field truncated the others.

**Fix:** each of the three fields now has its **own section and its own budget** — `dsh-cast:behavior`, `dsh-cast:expertise`, `dsh-cast:rules` (orders 450 / 452 / 454, bands `behavior` / `expertise` / `rules`, default 300 tokens each). No field can truncate another. New bands were added to `DEFAULT_BUDGET`, `BUDGETED_LAYERS`, `LAYER_NAME_BY_BAND`, `CONTEXT_LAYERS`, the client `LAYER_BUDGETS`, and `cordis.patch.yml`.

**Applying D1/D2/D3 needs a host restart** (a fresh restart per round of host edits). The client half is served fresh from `client.js` (a page refresh is enough); the host half is loaded at startup and this profile has HMR source-watching off, so the running host keeps the previous revision until restarted.

---

## What changed

The persona editor no longer uses six numeric personality sliders. A persona is now described by **six natural-language fields** — `identity`, `expertise`, `behavior`, `communication`, `rules`, `examples` (user/assistant pairs) — stored under a `definition` key, validated on write, migrated from legacy data, and assembled into the prompt by a single canonical resolver.

### Files changed

| File | Change |
|---|---|
| `index.js` | New `definition` schema + validation (`normalizeDefinition` / `validateDefinition` / `hasDefinitionKey`); legacy migration (`migrateLegacyDefinition` / `resolveDefinition`); canonical resolver (`resolvePrompt`, `composeDefinition`) with per-section `sources`; extended `promptInspection` (definition/migrated/warnings/sources); `createPersona`/`editPersona` validate before write; `/api/dsh-cast/get` returns the resolved definition + `migrated`; `create_persona` tool accepts `definition`; new `tryPersona()` + `POST /api/dsh-cast/try`. |
| `client.js` | Removed the six sliders and `DIMENSIONS`; new six-field editor (collapsible `<details>` sections, example add/remove, save + validation feedback, unsaved-change guard); "Preview effective prompt" (shared `PromptLayersView` with source + warnings + copy); "Try persona" (isolated test run); picker identity preview now shows the resolved identity text instead of numeric trait chips. |
| `test/host.test.mjs` | Route roster 9→10 (added `POST /api/dsh-cast/try`) + try-route tests (200/400/isolation). |
| `test/client.smoke.mjs` | `/get` mock returns a `definition`; editor tests (six sections, no range inputs, edit→dirty→save, example add/remove, preview purity, try isolation); picker preview asserts no trait chips. |
| `test/schema.test.mjs` | **New.** Schema round-trip, field→section mapping + `sources`, empty-field handling, legacy migration (non-destructive/idempotent/deterministic), malformed-record degradation, invalid-edit rejection, preview-vs-activation identity, preview side-effect freedom, budget/truncation. |
| `README.md` | New persona-file schema, six-field table, legacy-fields note, migration behavior, `/try` route, architecture mapping table. |

### Not changed (preserved)

- Legacy fields `identity` (object), `traits`, `voice`, `behavior` (object), `boundaries`, `examples` (strings), `parameters`, `composition` — still stored and still read by trait-based routing, `mix`, `tune`, mixins, and markdown/character-card export.
- Memory retrieval scoring, scope isolation, the `agent/pre-step` injection path, `agent/request` parameter injection, state drift, group chat, A/B `compare`, and all startup/watcher invariants.

---

## Schema

```json
{
  "name": "terse",
  "schemaVersion": 2,
  "definition": {
    "identity": "…", "expertise": "…", "behavior": "…",
    "communication": "…", "rules": "…",
    "examples": [ { "user": "…", "assistant": "…" } ]
  },
  "traits": { "…": 5 }, "voice": { "…": [] }, "…": "legacy fields preserved"
}
```

- The `definition` **key's presence** is the schema marker (`schemaVersion: 2` is written alongside it). A persona with no `definition` key is legacy.
- Validation: text fields must be strings (≤ 8000 chars); `examples` must be an array of `{user, assistant}` string pairs (≤ 50 pairs, ≤ 4000 chars/part). Invalid writes are rejected **before** any disk write, so the last valid saved definition is never corrupted.

---

## Migration

Legacy personas (no `definition`) are migrated **in memory, on the fly** by `resolveDefinition()` — never rewritten just because they were loaded. Mapping:

| New field | Legacy source |
|---|---|
| `identity` | `identity.role` / `backstory` / `values` / `goals` (existing wording) |
| `communication` | trait directives (`traitDirective`) + `voice.catchphrases` / `voice.taboo` |
| `behavior` | `behavior.greeting` / `disagreement` / `uncertainty` / `errorHandling` |
| `rules` | `boundaries.always` / `boundaries.never` |
| `examples` | legacy `examples` strings parsed into `{user, assistant}` pairs |
| `expertise` | empty (no legacy source) |

Migration persists only on an **explicit save** from the editor. Deterministic and idempotent (proven by test: repeated `resolvePrompt` and `loadUser` produce byte-identical results).

---

## Prompt mapping (canonical resolver)

One resolver (`resolvePrompt`) drives activation, preview, and `composePersonaSystem` — they cannot drift. Each field maps to exactly one section with its own budget (round 2 split `behavior`/`expertise`/`rules` apart; see D2 above):

| Definition field | Prompt layer | Order | Budget band |
|---|---|---|---|
| `identity` | `deployment:persona-prefix` | 0 | `identity` (400) |
| `communication` | `dsh-cast:voice` | 250 | `voice` (300) |
| `behavior` | `dsh-cast:behavior` | 450 | `behavior` (300) |
| `expertise` | `dsh-cast:expertise` | 452 | `expertise` (300) |
| `rules` | `dsh-cast:rules` | 454 | `rules` (300) |
| `examples` | `dsh-cast:examples` | 465 | `examples` (300) |

An empty field produces no section. `state` (455) and `memory` (460) remain runtime layers, not character definition. Each section carries `sources` (which field it came from), and the inspector reports `warnings`, `migrated`, and per-section `chars`/`tokens`/`budget`/`overBudget`/`truncated`.

---

## Test results

All green (real `index.js` is exercised; the client is exercised structurally against a stand-in React + a stateful host mock):

```
node test\host.test.mjs        -> ALL HOST TESTS PASSED       (exit 0)
node test\client.smoke.mjs     -> ALL CLIENT SMOKE TESTS PASSED (exit 0)
node test\client-shape.mjs     -> client-shape: OK            (exit 0)
node test\schema.test.mjs      -> ALL SCHEMA TESTS PASSED      (exit 0)
node test\v5-startup-fatal.test.mjs -> V5: OK                 (exit 0)
node test\v6-watch-error.test.mjs   -> V6: OK                 (exit 0)
node --check index.js && node --check client.js -> exit 0
```

Current revision hashes (SHA-256, first 16):

| File | SHA-256 (first 16) | Size |
|---|---|---|
| `index.js` | `EAAD04E0119965E1` | 128300 |
| `client.js` | `6F4AEC045ECC4279` | 41161 |
| `test/schema.test.mjs` | `9268352250C88012` | 15963 |

---

## Unverified (stated plainly)

1. **The client has NOT been runtime-verified in the real browser.** `client.smoke.mjs` proves bundle shape, registration, and data flow against a stand-in React, but the editor/layout/popover placement have not been observed in the actual DSH Web GUI. The running GUI at `http://127.0.0.1:3080` serves a **pre-built** client bundle; applying the client changes requires a Web rebuild + page refresh. This environment has no `pnpm run dev:web` watcher running and no DSH monorepo `apps/web` source checkout (only the installed `@deepseek-ai/*` npm packages are present), so the rebuild could not be performed here. Layout, scrolling, and popover placement are therefore unconfirmed.
2. **Host changes are unit-tested, not live-restarted.** `index.js` is symlinked into the live profile, but the running host loaded the previous revision at startup. A server restart is required to make the host changes live; this was not performed (it would interrupt the running session). The six suites exercise the real `index.js` against a mock Cordis context, so the host logic is verified, but the live-server path (`agents.get()` returning a real agent, real `systemPrompt.section` registration) is not re-verified in this run.
3. **Token counts remain a chars/4 estimate**, not a real tokenizer (unchanged from before; labelled as an estimate in the UI).

---

## Apply / rollback

### Apply

1. **Host:** restart the DSH host so it re-loads the symlinked `index.js`.
2. **Client:** rebuild the dsh-cast Web bundle (run `pnpm run dev:web` from the DSH source checkout, then rebuild the Web client), then **refresh** `http://127.0.0.1:3080`.
3. Open **Settings → Personas** and verify the six-field editor, preview, and try.

### Rollback

- **Persona store (pre-migration):** `dsh-cast-backups\pre-structured-persona-20261011-124259\` (copied before any migration persisted; migration is on-the-fly, so the live `dsh-cast-personas\` is still in legacy format).
- **Plugin source (pre-refactor):** the known-good phase-6 snapshot `dsh-cast-backups\pre-ui-memory-20261008-130214\` (`index.js` / `client.js`). Restore those two files and restart; no migration was persisted, so no data rollback is needed.
