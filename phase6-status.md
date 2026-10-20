# dsh-cast Phase 6 — Status

**Scope:** two workstreams added to `@local/dsh-cast` — (A) a session-header persona surface, and (B) ranked scoped-memory retrieval delivered through `agent.inject()` under a real token budget.

**State:** complete and integrated. Both suites green. Review round 2 verdict **PASS**.

**Pre-change snapshot (rollback point):** `dsh-cast-backups/pre-ui-memory-20261008-130214` — 27 files, verified intact.

| Snapshot file | SHA-256 (first 16) |
|---|---|
| `dsh-cast/index.js` | `6D881D177CE2E13C` |
| `dsh-cast/client.js` | `FAA6D005E34C2636` |

To roll back, restore those two files from the snapshot and restart the host. No migration is needed: phase 6 added no new side files and changed no on-disk format. Persona JSON stays in the same shape, and every persisted side file (`.dsh-cast-*.json`) keeps its existing format.

---

## What was built

### Workstream A — session-header persona surface

Delivered in `client.js` (UI) plus two new routes in `index.js`.

- **Persona picker with identity preview.** A new entry in the `conversation.session.header.actions` slot (`id: dsh-cast-persona-picker`, order 15), registered through the same `ctx.slots.inject(...) => ctx.slots.register(...)` pattern the existing entries use, and deliberately without `locale` because dsh-cast ships no dictionary. It receives `sessionId` from the standard session kit. The popover shows the persona list, which one is active, and the active persona's `identity.role` plus all six resolved traits. The composer switcher was reworked to share one picker body, so both surfaces gained the preview. Activation reuses the existing `POST /api/dsh-cast/activate` — no duplicate route was added.
- **"What the model actually sees" composed-prompt inspector.** `GET /api/dsh-cast/preview?name=&sessionId=` returns the composed prompt split into its named layers with per-layer `chars`, `tokens`, `budgetTokens`, `capChars`, `overBudget`, and `truncated` flags, plus `totals` and the effective `budgets` table. It is produced by the **same `compose()` call the live prompt uses** — asserted equal to `composePersonaSystem()` in the suite — so the inspector cannot drift from what is actually registered. Rendered as `<pre>` blocks with a per-layer budget bar and an `OVER BUDGET` flag.
- **One-click A/B.** `POST /api/dsh-cast/compare` wires the pre-existing `compare()` to the browser; `compare()` is not reimplemented. The panel has a controlled persona-A/persona-B selector and prompt input, a Run control disabled until valid, an explicit pending state (the call is slow — it hits the model twice), and a visible error state rendering the host's message.

### Workstream B — ranked scoped-memory retrieval and injection delivery

Delivered in the host half only.

- **Ranked retrieval.** `retrieveMemories(personaName, sessionId, {query, budgetTokens})` scores every visible candidate as `0.7*relevance + 0.2*recency + 0.15*scopeBonus`, documented in code along with the exact term definitions, the tie-break order `(score, createdAt, id)`, and a named limitation (the per-scope quota picks the best record *within* a scope, not by global rank). Isolation is preserved **by construction**: scoring is applied to the output of the untouched `listMemories()` filter, so ranking cannot widen what a persona can see.
- **Real token budget.** Candidates are priced individually with a fallback that matches the harness `estimateMessage()` formula exactly (`ceil(len/4) + 4 per block + 4 role framing`), preferring `ctx.tokenMeter.estimateMessage` when a meter is mounted. An oversized record is dropped **whole** — never cut mid-record — and every drop is reported with its token cost and reason.
- **Delivery via `agent.inject()`.** `registerMemoryInjection()` hooks the real `agent/pre-step` waterfall and calls `next()` exactly once on every path. Injection is fire-and-forget (`void`), never awaited. The injected message is a locally built `user/message` (`node:crypto` `randomUUID`, so the zero-dependency rule holds) carrying the producer-owned source `{ kind: 'dsh-cast', form: 'recall' }`. Delivery is suppressed when there is no active persona, no `inject`, or the agent is idle, so it cannot wake a sleeping driver. Batches are capped by message count (3) as well as by tokens.
- **Context-budget pass.** `contextBudgetPass()` measures each composed layer, allocates the total budget with the memory reserve taken first, and hands back measured slack to the memory band.

### Post-integration hardening (H1–H3)

Landed by the captain after integration and independently reviewed:

- **H1** — persona names are validated against `PERSONA_NAME_RE` (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`) and resolved through a single path sink (`personaFileName()` / `personaPathFor()`), closing the pre-existing path-traversal defect that was reachable from the HTTP routes, the `/persona` commands, and the `create_persona` tool.
- **H2** — `writeReport()` no longer swallows failures: it records `this.lastReportError`, logs loudly, and re-throws. `writtenAt` is stamped on success.
- **H3** — the report's phase label is `phase6` (was `phase1`).
- **H4 (finding V5, found by the verifier)** — H2's re-throw had nowhere to land. `writeReport()` throws, `start()` awaits it, and `apply()` called `start()` un-awaited and uncaught, so a single transient report-write failure during startup became an **unhandled rejection and killed the host process** on Node 20+ instead of being logged. Confirmed by probe, not assumed: an un-awaited rejecting promise exits 1 and a 500 ms timer never fires. Fixed at the `apply()` boundary by catching, logging, and continuing — startup is best-effort by design, since the routes and prompt layers read live state rather than the report. The `throw` inside `writeReport()` is deliberately **unchanged**: it is the honesty mechanism H2 exists to provide. Regression test: `test\v5-startup-fatal.test.mjs`, mutation-proven (reverting the boundary → exit 1, dying before its success line; restoring → exit 0).
- **H5 (follow-up raised by the reviewer)** — H2/H4 made a failed report write survivable but **invisible**: the service set `lastReportError` and nothing could read it — no route exposed it, so the UI had no way to show a degraded state. That is an honesty mechanism with no reader, which is barely better than the silent catch it replaced. Now surfaced through `healthStatus()` and the `health` block on `GET /api/dsh-cast/list` (the route the client already fetches), reporting `ok`, `reportStale`, `lastReportAt` and the timestamped error. The field is **additive** — `personas` is unchanged, so existing readers keep working — and the test asserts the caller-side consequence (the route actually carries the block), not the private field, because a test of the field alone would pass while the failure stayed unreachable. The client renders a degraded banner and treats a missing `health` field as "nothing to report", never as an error.
- **H6 (finding V6, found by the verifier)** — `watchUserDir` wrapped `fs.watch` in `try/catch`, which covers only the **synchronous** throw. An `FSWatcher` is an `EventEmitter`, and emitting `'error'` with **no listener** is re-thrown by Node as an uncaught exception — process death. No `'error'` listener existed anywhere in `index.js`, so the `try/catch` *looked* like it handled watch failures while the asynchronous channel escaped it entirely. Fixed by attaching `watcher.on('error', …)`, which logs and leaves the watcher inert. The exposure is **latent** — it needs `personasDir` misconfigured to a file path whose parent is then removed — and the verifier graded it accordingly rather than overstating it. Regression test: `test\v6-watch-error.test.mjs`, which emits on the plugin's **real** watcher (exposed as `_watcherHandle` for reachability) and asserts survival, a logged message, and a control proving a bare `fs.watch` has **no** error listener.

> **Two defects in this workstream shipped past a green suite** (F1: a read that mutated; V5: a throw whose rejection had no landing site). Both were correct-looking *local* behaviour with a bad **caller** or **blast radius**, and both were found by an independent pass that asked about the call site rather than the function. Neither was caught by the test that covered the function itself.

---

## What is verified

Both suites are runnable and green, and every fix from repair round 1 is **mutation-proven** — the defect was reintroduced and the suite confirmed to fail, then the fix restored and the suite confirmed to pass.

| Suite | Assertions | Command |
|---|---|---|
| Host | 321 | `cd dsh-cast; node test\host.test.mjs` |
| Client (structural) | 78 | `cd dsh-cast; node test\client.smoke.mjs` |
| Client (bundle/manifest shape) | 13 | `cd dsh-cast; node test\client-shape.mjs` |
| Startup-failure survivability | 4 | `cd dsh-cast; node test\v5-startup-fatal.test.mjs` |

**Host half — verified at runtime against the real module.** The suite imports and runs the real `index.js`. Covered: the exact 9-route roster, the exact 3-tool roster, the store/composer, CRUD, state drift, memory scoping and isolation, ranked retrieval (formula recomputed independently, isolation re-derived, budget honoured across many budgets), the context-budget pass, and the injection decision logic.

**Client half — verified structurally.** `client.smoke.mjs` loads and executes the real `client.js` factory against a stand-in React and a **stateful** mock host. It asserts the bundle wrapper and factory shape, that the factory requires **only** `react`, the exact `slots.inject` → `register` pattern with fresh ids and no `locale`, that the picker renders the list / active marker / identity role / resolved traits, that the inspector renders layer names with their counts and budgets, that activating updates visible state, and that the client only ever calls routes the host actually registers.

**Mutation proofs on record** (each: mutant → suite exit 1 → restored → exit 0):

| Defect reintroduced | Fails with |
|---|---|
| F1 — client reads active persona via the mutating route | `header popover reports the off state explicitly` |
| F2 — double `next()` in the pre-step hook | `F2: the terminal ran EXACTLY once per step (got 2)` |
| F3 — `(score N.NN)` rendered into the prompt | `F3: no "(score N.NN)" telemetry in the composed system prompt` |
| F4 — the 2-token-per-message overcharge | `F4: an empty text costs exactly the 4+4 overhead` |
| F5 — the invented `idleDelay` busy-check | `F5: idleDelay is NOT a real signal` |
| H1 — path-traversal sink | `H1: name "../escaped-persona" must be rejected by the sink` |
| H2 — report failure swallowed | `H2: writeReport propagates a failure of the report write itself` |
| H4/V5 — unhandled rejection from un-awaited `start()` | process exits 1 before `V5: OK` prints (defect is fatal, so the test dies rather than asserting) |
| H5 — report health not surfaced to any caller | `H5: the list route reports a health block` |
| H6/V6 — no `'error'` listener on the fs.watch emitter | process never settles: no output at all, not even the success line |

The F1 test is a **mutation-safety** test, not a happy-path test: it activates a persona, reads, and asserts the persona is unchanged *and* that no prompt section was registered. A control asserts the mutating route really does activate, so the test cannot pass vacuously.

---

## What is NOT verified

Stating these plainly, because they are the residual risk in this phase:

1. **The client half is NOT runtime-verified.** It has never been rendered inside the real Web shell. Doing so requires a dsh-cast Web rebuild **plus a page refresh** (and `pnpm run dev:web` running for automatic reload). `client.smoke.mjs` is structural and behavioural evidence against a stand-in React — it proves the bundle shape, the registration pattern, the data flow, and the route usage — but it is **not** proof that the panel renders correctly in the browser. Layout, styling, slot placement, and the header popover's positioning are all unverified. Treat A1–A3's UI as unconfirmed live until that rebuild happens.
2. **`inject()` *timing* is unverified at unit level.** A unit test can only assert *which* message was handed to `inject()`. The real semantics — claim at the next step boundary, batching with same-boundary steering, discard on cancellation and on disposal, and the fact that a pending next-step message prevents turn close — all come from the harness (`dsh-agent-loop`) and are **not** reproducible in the mock. Any claim that a delivered memory was actually *seen* by the model is unsupported: `inject()` has no acknowledgement, and pending context can be discarded. The plugin therefore reports **queued**, never "shown".
3. **Token counts are estimates, not tokenizer output.** The fallback is the harness's own fixed-density heuristic (chars/4 plus overhead), so it agrees with `estimateMessage()`; it is not a real tokenizer, and the UI labels it as an estimate. The inspector covers only the dsh-cast layers — not harness sections or the tool catalog.
4. **The A/B panel's live model call is unexercised.** The suite stubs `llm.stream`. The route, the pending state, and the error path are tested; a real streaming response through the UI is not.
5. **`/api/dsh-cast/activate`'s success path is exercised only through a mock agent**, per the contract's own caveat — the real registry path (`agents.get(sessionId)` returning a live agent) is unverified outside a running host.

---

## Reproduce

```bash
# all six suites
cd dsh-cast; node test\host.test.mjs               # -> ALL HOST TESTS PASSED (exit 0)
cd dsh-cast; node test\client.smoke.mjs            # -> ALL CLIENT SMOKE TESTS PASSED (exit 0)
cd dsh-cast; node test\client-shape.mjs            # -> client-shape: OK (exit 0)
cd dsh-cast; node test\v5-startup-fatal.test.mjs   # -> V5: OK (exit 0)
cd dsh-cast; node test\v6-watch-error.test.mjs     # -> V6: OK (exit 0)

# syntax
cd dsh-cast; node --check index.js          # -> exit 0
cd dsh-cast; node --check client.js         # -> exit 0
```

Current revision hashes (SHA-256, first 16) — re-hash before trusting any verdict in this repo, since these files moved several times during the phase and at least one document pins an older revision:

| File | SHA-256 (first 16) | Size |
|---|---|---|
| `index.js` | `B89488055F300BBC` | 109502 |
| `client.js` | `648D01CBA0C5F200` | 28107 |
| `test/host.test.mjs` | `B9676C50DE0CE79D` | 73658 |

Route roster (9 routes, asserted exactly by the host suite):

```
GET  /api/dsh-cast/active     GET  /api/dsh-cast/get      GET  /api/dsh-cast/list
GET  /api/dsh-cast/preview    POST /api/dsh-cast/activate POST /api/dsh-cast/compare
POST /api/dsh-cast/create     POST /api/dsh-cast/delete   POST /api/dsh-cast/edit
```

To verify the client half in a browser, the four steps are: run `pnpm run dev:web` from the DSH checkout, rebuild the dsh-cast Web bundle, refresh the page at `http://127.0.0.1:3080`, and open the 🎭 picker in a session header.

---

## Constraints honoured

- **Zero npm dependencies.** `package.json` declares none, and it was not modified. The host half imports only `node:fs`, `node:fs/promises`, `node:crypto`, `node:url`, and `node:path`. The client factory requires only `react`.
- **No new `SessionEventMap` types** and no `session.append` of novel event types. Model-visible memory rides the existing `user/message` channel.
- **No new side files.** Injection telemetry lives in memory, not on disk.

## Related documents

- `phase6-contract.md` — the verified API-contract note phase 6 was built against (13 items + addenda).
- `phase6-verification.md` — independent adversarial verification (t4), pinned by file hash.
- `phase6-review-round2.md` — independent review round 2 (t8), verdict **PASS**.
- `README.md` — user-facing capabilities, including the `active` vs `activate` distinction.
