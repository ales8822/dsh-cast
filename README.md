# dsh-cast

A persona engine for DeepSeek Harness, built as a Cordis plugin with host and client halves. Give any session a distinct, composable, memory-bearing persona.

## Install

Published to GitHub at [`ales8822/dsh-cast`](https://github.com/ales8822/dsh-cast).

```sh
dsh plugin --profile web add github:ales8822/dsh-cast
```

Built-in personas ship in `personas/`; user personas live in the configured
`personasDir` (default `$DSH_HOME/dsh-cast-personas`), one JSON file per persona.
Because user personas and state live under `$DSH_HOME`, they survive a DSH
uninstall.

## Use

In a session:

- `/persona list` — list personas (`*` = active).
- `/persona use <name>` — activate a persona for this session.
- `/persona off` — deactivate.
- `/persona show <name>` — inspect a persona.
- `/persona create <name>` · `/persona edit <name> <json>` · `/persona delete <name>`.
- `/persona memory <name> add <text> | show | clear` — persona-scoped memory.
- `/persona mix <a> <b> [name]` — blend two personas.
- `/persona tune <name> "<phrase>"` — e.g. "make them warmer, less chatty".
- `/persona export <name> [json|markdown|card]` · `/persona import <json>` · `/persona pack export <names…> | import <json>`.
- `/persona history <name>` · `/persona rollback <name> <index>`.
- `/persona route <message>` — recommend a persona for a task.
- `/persona rate <name> <1-5> [note]` · `/persona ratings [name]` — fidelity scoring.
- `/persona summarize [persona]` — summarize the session into conversation memory.
- `/persona compare <a> <b> <prompt>` — A/B two personas on one prompt.
- `/persona group create <name> <p1> <p2> [...] | use <name> | list` — multi-persona group chat (round-robin director).
- `/persona handoff <name>` — hand the conversation to another persona.

Agent tools: `set_persona`, `list_personas`, `create_persona`. A "Personas" page under Settings provides list/create/delete.

## Session-header persona surface (Phase 6, workstream A)

The header of every session carries a persona picker (🎭). Opening it shows the full persona list, which one is active, and an inline identity preview of the active persona (`identity.role` plus its six resolved traits). Activating from the picker is the same action as `/persona use <name>`, and "Off" is the same as `/persona off`. The composer also carries the same switcher; both share one picker body. The header entry is registered into the `conversation.session.header.actions` slot (`id: dsh-cast-persona-picker`) and receives its `sessionId` from the standard session kit.

Two more views live in the same popover:

- **"What the model actually sees"** — the composed persona prompt split into its named layers (`deployment:persona-prefix`, `dsh-cast:voice`, `dsh-cast:behavior`, `dsh-cast:state`, `dsh-cast:memory`, `dsh-cast:examples`), each with its own character and token count, the budget it is measured against, and a bar showing how much of that budget it consumes. A layer that exceeds its cap is flagged `OVER BUDGET`, so it is visible which layer is eating the prompt. It is produced by the *same* `compose()` call the live prompt uses, so the inspector cannot drift from what is really registered.
- **One-click A/B** — pick persona A, pick persona B, type a prompt, and run: both responses come back side by side. The LLM call is slow, so the panel shows an explicit pending state and a visible error state. This wires the pre-existing `compare()`; it is not a second implementation.

Counts in the inspector are a **chars/4 estimate**, not a real tokenizer, and cover only the dsh-cast layers — the full request prompt also carries harness sections and the tool catalog. The panel says so.

## Ranked scoped-memory retrieval (Phase 6, workstream B)

Memory records are ranked before they enter the prompt, by an explicit formula:

```
relevance   = |queryTerms ∩ recordTerms| / |queryTerms|
recency     = 0.5 ^ (ageMs / 7-day half-life)
scopeBonus  = scopePriority / 5      (conversation 5 > persona 4 > user 3 > episodic 2 > global 1)
score       = 0.7*relevance + 0.2*recency + 0.15*scopeBonus
```

Ties break deterministically on `(score, createdAt, id)`. A per-scope quota guarantees that a scope with records cannot be starved out of the selection by a newer scope. The selection is bounded by a **real token budget**: records are priced individually and an oversized record is dropped **whole** (never cut mid-record), with each drop reported and its token cost accounted. Ranking scores are internal telemetry — they are available in the structured retrieval result for the inspector, and are deliberately **not** rendered into the model-visible prompt.

Delivery uses `agent.inject()`, which is a **non-waking** path: it queues a `user/message` for the next step boundary and never starts a turn on its own. Injected messages carry the producer-owned source `{ kind: 'dsh-cast', form: 'recall' }`. Delivery is suppressed when no persona is active, when the agent has no `inject`, and when the agent is idle — so it cannot wake a sleeping session. Because `inject()` has no acknowledgement and pending context is discarded by cancellation and by disposal, the plugin reports injections as **queued**, never as "shown". The batch is capped by message count as well as by tokens.

Set `memoryInjection: false` in the plugin config to turn delivery off entirely (default is on). The context-budget pass is configurable via `tokenBudget` and `contextBudget`; a per-injection cap is available as `memoryInjectBudget`.

## Startup failures degrade, they do not crash

Startup loads cached state (personas, memory, history, ratings, groups) and writes a side report. If any of that fails — a transient `EISDIR`/`EPERM` on the report file, a corrupt side file — the plugin **logs loudly and keeps running**. It does not take the host down.

This is deliberate and is worth knowing because the failure mode is easy to get wrong in both directions:

- The report write **throws on failure** rather than being swallowed, and records `lastReportError` with a timestamp. A swallowed write would leave the *previous* report on disk with nothing marking it stale, so a failed write could be misread as a current, healthy one.
- That throw is then **caught at the `apply()` boundary**, because `apply()` is synchronous and cannot await `start()`. An un-awaited promise that rejects becomes an `unhandledRejection`, which is **process-fatal** on Node 20+ by default — so without the boundary catch, a single failed write during startup would kill the host instead of being reported.

The consequence in practice: if startup partially fails, expect a `[dsh-cast]` log line and possibly missing cached state. The service is still published and usable — the routes and the prompt layers read live state rather than the report. Regression test: `test\v5-startup-fatal.test.mjs`.

## HTTP routes

The client reaches the host over the authenticated `/api/dsh-cast/*` fetch channel. Read the **`active` vs `activate`** distinction carefully — it is not cosmetic:

| Route | Method | Mutates session state? | Purpose |
|---|---|---|---|
| `/api/dsh-cast/active?sessionId=` | **GET** | **No — pure read** | Reports the active persona for a session. Returns `{ active: 'name' }`, or `{ active: null }` for "no persona active"; an unknown session is a 4xx error. Three distinguishable states: named persona / off / error. |
| `/api/dsh-cast/activate` | **POST** | **YES** | Activates (or, with `name: "off"`, deactivates) a persona. This disposes and re-registers the session's prompt sections. |
| `/api/dsh-cast/list` · `/get?name=` | GET | No | List personas / fetch one. |
| `/api/dsh-cast/preview?name=&sessionId=` | GET | No | The composed-prompt inspector payload: named sections with per-section counts, budgets, source fields, and warnings. |
| `/api/dsh-cast/compare` | POST | No (calls the model) | One-click A/B. Body `{ a, b, prompt }`. |
| `/api/dsh-cast/try` | POST | No (calls the model; never activates or writes memory) | Isolated single-persona test run. Body `{ name, prompt }`; returns the response and the exact system prompt used. |
| `/api/dsh-cast/create` · `/edit` · `/delete` | POST | No | Persona CRUD. |

> **Why the distinction is called out.** The UI originally discovered the active persona by POSTing `/activate` with a guessed name and reading the result back. Because that route mutates, the "read" clobbered whatever the user had actually chosen and could silently activate a persona in a session where it was turned off. That was a release-blocking defect, fixed by adding the pure-read `GET /active`. **Never use `/activate` to read state.** The regression test for this is a mutation-safety test, not a happy-path test: it asserts that reading leaves the active persona unchanged and registers no prompt sections.

## Persona file

A persona is described by six **natural-language fields**. Five are free text; `examples` is an ordered list of user/assistant pairs. These fields are the primary persona definition and are what the prompt is assembled from:

```json
{
  "name": "terse",
  "schemaVersion": 2,
  "definition": {
    "identity": "You are a terse senior systems engineer. Decades of on-call experience burned away every unnecessary word.",
    "expertise": "Systems, on-call, and debugging. Prefer the correct answer in the fewest tokens.",
    "behavior": "Start with the answer; skip greetings. Correct plainly, say 'Unknown' instead of hedging.",
    "communication": "Terse, one point per line, no filler.",
    "rules": "Never pad, apologize, or repeat the question. Always show commands, not prose.",
    "examples": [
      { "user": "what's 2+2", "assistant": "4." },
      { "user": "why did the deploy fail?", "assistant": "Missing env var. Export it, redeploy." }
    ]
  }
}
```

The six fields mean:

| Field | Meaning |
|---|---|
| `identity` | Who the persona is — role, background, defining characteristics. |
| `expertise` | Subject areas, capabilities, and preferred problem-solving approach. |
| `behavior` | How it thinks, reacts, challenges assumptions, and interacts. |
| `communication` | Tone, conciseness, formatting, and how answers are structured. |
| `rules` | Explicit preferences, constraints, and recurring behavioral instructions. |
| `examples` | Representative user/assistant exchanges demonstrating the desired behavior. |

All fields are optional and may be empty; an empty field simply produces no prompt section for it. The Settings → Personas editor exposes all six fields (collapsible), plus **Preview effective prompt** (the exact resolved prompt, with per-section source and counts) and **Try persona** (an isolated single-message test run that never changes your active session or writes memory).

> **Canonical structure + acceptance:** see [`persona-schema.md`](persona-schema.md) for the one recommended file shape, the rules the plugin enforces (name must equal the filename, `definition` key presence is the schema marker, reads are permissive while writes are strict, unknown keys are dropped), and the evidence that the shape the Settings UI writes is accepted. Every shape a persona file can take is pinned by `test/persona-file-acceptance.test.mjs`; `tools/canonicalize-personas.mjs` upgrades legacy files in place, prompt-preservingly (the 10 shipped personas were converted with it).

### Legacy fields (still preserved)

The pre-structured-schema fields are **kept**, not deleted, because other features still read them (trait-based routing, `mix`, `tune`, mixins, markdown / character-card export):

```json
{
  "name": "terse",
  "identity": { "role": "a terse senior systems engineer", "backstory": "…", "values": ["…"], "goals": ["…"] },
  "traits": { "formality": 6, "warmth": 2, "humor": 1, "verbosity": 1, "directness": 9, "chaos": 2 },
  "voice": { "catchphrases": ["Done."], "taboo": ["apologies"] },
  "behavior": { "greeting": "Skip greetings.", "disagreement": "…", "uncertainty": "…", "errorHandling": "…" },
  "boundaries": { "always": ["…"], "never": ["…"] },
  "examples": ["Q: …\nA: …"],
  "parameters": { "temperature": 0.2, "maxTokens": 300 },
  "composition": { "archetype": null, "mixins": [] }
}
```

### Migration

A persona that has no `definition` key is a **legacy** persona. It is migrated **in memory, on the fly**, by the resolver — it is never rewritten to disk just because it was loaded. Migration is deterministic and idempotent:

- `identity` ← `identity.role` / `backstory` / `values` / `goals` (reusing the existing wording).
- `communication` ← the trait directives (`traitDirective` wording) plus `voice.catchphrases` / `voice.taboo`.
- `behavior` ← `behavior.greeting` / `disagreement` / `uncertainty` / `errorHandling`.
- `rules` ← `boundaries.always` / `boundaries.never`.
- `examples` ← legacy `examples` strings parsed into `{ user, assistant }` pairs.
- `expertise` ← empty (no legacy source; the user fills it in).

The migration is persisted only on an **explicit save** from the editor (which writes a `definition` and `schemaVersion: 2`). Until then the original file and its legacy fields stay byte-for-byte intact, so rollback is just "restore the file from the pre-change backup". A validation error on edit is rejected before any write, so the last valid saved definition is never corrupted.

## Memory scopes

`global`, `user`, `persona`, `conversation`, `episodic`. A persona sees only global/user, its own persona+episodic scopes, and the current conversation — never another persona's scopes. This isolation is preserved by construction in the ranked retrieval path: ranking is applied to the output of the same visibility filter, so scoring cannot widen what a persona can see.

## Security note

Persona names are validated against a whitelist (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`) and resolved through a single path-construction sink, so a crafted name cannot escape `personasDir`. This closes a pre-existing path-traversal defect that was reachable from the HTTP routes, the `/persona` commands, and the `create_persona` tool.

## Architecture

The six definition fields are resolved by a single canonical resolver into the ordered, token-budgeted prompt layers the live prompt registers and the preview shows. Each field maps to exactly ONE section with its OWN budget, so no field can truncate another:

| Definition field | Prompt layer | Budget band |
|---|---|---|
| `identity` | `deployment:persona-prefix` | `identity` |
| `communication` | `dsh-cast:voice` | `voice` |
| `behavior` | `dsh-cast:behavior` | `behavior` |
| `expertise` | `dsh-cast:expertise` | `expertise` |
| `rules` | `dsh-cast:rules` | `rules` |
| `examples` | `dsh-cast:examples` | `examples` |

A field that is empty produces no section at all. (`behavior`, `expertise`, and `rules` were briefly combined into a single section; a single shared 300-token budget truncated realistically-written personas mid-record and dropped the tail of `rules`, so they were split into three independently-budgeted sections.)

Prompt fragments enter through `agent.ctx.systemPrompt.section()` (per-session scope). `state` and `memory` are runtime data, not character definition, and remain their own layers. State (mood/energy/trust/familiarity) drifts per turn; LLM parameters inject via the `agent/request` waterfall; retrieved memory is delivered through the `agent/pre-step` waterfall. A context-budget pass allocates the total budget across the layers, measuring what each layer actually costs and returning the slack to the memory layer. Client UI reaches the host over the authenticated `/api/dsh-cast/*` fetch routes.

Isolated model calls (A/B compare, "Try persona", and conversation summarization) use the harness's **configured default model** (`ctx.agentDefaultModel.currentSelection()`), the same selection the agent loop uses — not `llm.listProviders()[0]`, whose registration order is arbitrary. A stream that ends in an error/abort with no text is reported as an error rather than as an empty success.

See `phase0-feasibility.md`, `phase1-status.md` … `phase5-status.md` for the build history, `phase6-status.md` for the phase-6 verification status, and `structured-persona-status.md` for the structured-persona refactor. `persona-schema.md` is the canonical persona-file reference. `phase6-contract.md` is the verified API-contract note the phase-6 work was built against; `phase6-review-round2.md` is the final review.
