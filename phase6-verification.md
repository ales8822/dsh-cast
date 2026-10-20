# dsh-cast Phase 6 — Independent Adversarial Verification (t4)

**Author:** `verifier` (team member), task `t4`
**Role:** independent verification. I did not write the t2 (memory) or t3 (UI) code and did not repair it.
**Workspace root:** `C:\Users\AlAr\my_progs\dsh_plugins_folder`
**Revisions covered:** attempt 1 (pinned `DEC773F7568A3BF0`), attempt 2 (`F221321125D0E01F`),
attempt 3 (`533E4BF3FE6050ED`), attempt 3b (`C0C54BEC7C4B36D1`), and **§0.0 — the CURRENT revision**,
on which V6 and H5 are verified closed.

## §0.0 RE-PIN (supplement 2) — CURRENT REVISION, V6 + H5 CLOSED

The captain repaired **V6** and closed the **H5** gap I named, and invited re-verification. Hashes
below match his stated values exactly (sizes too), and the tree had settled when I measured.

| File | SHA-256 (first 16) | Size |
|---|---|---|
| `dsh-cast/index.js` | `B89488055F300BBC` | 109502 |
| `dsh-cast/client.js` | `648D01CBA0C5F200` | 28107 |
| `dsh-cast/test/host.test.mjs` | `B9676C50DE0CE79D` | 73658 |
| `dsh-cast/test/v6-watch-error.test.mjs` | `2D214E4EAC4BBE35` | 4158 |

Note `client.js` **moved for the first time** across all five pins (`5E804F5250714E71` → `648D01CBA0C5F200`),
because H5 added the `HealthNotice` surface. §11 is therefore re-derived on this revision: the client
still requires **only** `react` and still adds no dependency (re-grepped: `const React = require('react')`
is the sole `require`). The F1 read-path findings were re-confirmed, not assumed (see below).

**All six checks green:** `index.js --check` 0, `client.js --check` 0, `host.test.mjs` 0
(`ALL HOST TESTS PASSED`), `client.smoke.mjs` 0, `client-shape.mjs` 0, `v5-startup-fatal.mjs` 0,
`v6-watch-error.mjs` 0 (`V6: OK — async watch errors have a landing site and are non-fatal`).

### V6 — CLOSED (independently re-verified, 8 checks)

The fix attaches the handler to the **emitter** rather than wrapping its construction
(`index.js:875-877`), which is the correct seam. My probe `probe-v6-h5.mjs` = **12 PASS / 0 FAIL**,
with **0 unhandled rejections and 0 uncaught exceptions** across the whole run:
```
PASS  V6.1.real_emitter_reachable                 _watcherHandle type=function
PASS  V6.1.listener_attached_to_real_emitter      listenerCount('error')=1
PASS  V6.2.emit_on_live_emitter_does_not_throw    emitThrew=null newUncaught=0
PASS  V6.3.error_is_logged_not_swallowed          logs=["personas dir watch error … EPERM: async watch failure"]
PASS  V6.4.control_bare_fswatch_has_no_listener   bare fs.watch listenerCount('error')=0
```
**V6.2 is the decisive one.** "A listener exists" is a weak assertion — it would pass even if the
handler were attached to the wrong object. So I **emitted the real `EPERM` shape on the live emitter**
and confirmed the process survives. V6.3 then confirms the handler *logs* rather than silently
swallowing, which V6.2 alone would not catch. V6.4 independently reproduces the captain's control: a
bare `fs.watch` has `listenerCount('error') === 0`, so the listener under test is a real addition to a
real channel, not a synthetic one.

### The `_watcherHandle` exposure — my judgement (he asked me to judge it)

**I endorse it, and I think it is the strongest design decision in this repair.** Reasoning:

- The handler guards an **asynchronous** event. Without a reachable handle, the only possible test is
  "a listener is registered" — which is exactly the class of assertion this whole verification pass
  has repeatedly shown to be worthless (V1, F1, V5, V6 all had *true* local assertions). Reachability
  is what converts a structural claim into a behavioural one.
- It is scoped on the **service, not module scope** (`index.js:882`), so two service instances cannot
  share one watcher — the instance-scoping objection does not apply.
- It is a test seam on a private-ish field (`_`-prefixed), so it is clearly not API surface.

**One caveat, stated so it is on the record:** exposing an emitter that tests can `emit()` on means a
test can now fabricate an error that the real watcher might never produce. That is a real risk of
over-reach — a future test could "prove" survivability for an error shape Node never emits. My V6.2
avoids it by emitting the *actual* `EPERM` code from the real failure, and I would hold future tests
to that. Net: the benefit clearly outweighs it, and the alternative (untestable async guard) is worse.

### H5 — CLOSED (the gap I named; independently re-verified)

`healthStatus()` (`index.js:2614-2623`) is surfaced as a `health` block on `GET /api/dsh-cast/list`
(`index.js:1872-1875`) — the route the client already fetches — and `client.js` renders `HealthNotice`.
My probe confirms the **caller-side consequence**, not just the field's existence:
```
PASS  H5.1.list_route_carries_health       status=200 health={"ok":true,"lastReportAt":…,"reportStale":false,…}
PASS  H5.2.personas_field_unchanged        personas=10 (additive, not replaced)
PASS  H5.3.healthy_service_reports_ok      ok=true reportStale=false lastReportError=null
PASS  H5.4.degraded_service_flips_health   ok=false reportStale=true msg=EISDIR: illegal operation on a directory…
PASS  H5.5.degraded_route_still_serves_personas  personas=10 — degraded, not broken
```
**H5.4 is the one that matters:** I forced a *real* report-write failure and re-read the route. The
block genuinely flips to `ok:false, reportStale:true` — a health block that always said `ok:true` would
have passed H5.1–H5.3 while being useless. H5.5 confirms the degraded service still serves personas
(additive, not broken).

**The client contract for a missing field is correct** (`client.js:55-61,112-115`):
`if (!health || !health.reportStale) return null;` — an absent `health` renders nothing and is never
treated as an error, so an older host degrades safely. The health read is also kept separate from the
persona list (`client.js:496-502`) so a health-read failure cannot blank the picker.

**VERDICT: H5 CLOSED.**

### F1 re-confirmation on the moved client.js

Because `client.js` changed, I re-ran the read-path probe rather than assuming F1 still holds:
**11 PASS / 0 FAIL**, including `readActive uses GET /active (pure read)` with
`uses POST /activate: false`, `GET /active is idempotent (25x, no state change)`, and
`GET /active leaves an OFF session OFF`. F1's fix survived the H5 addition.

## §0.1 RE-PIN (attempt 3b) — superseded by §0.0

> **⚠ The tree moved during attempt 3.** After the captain reported "I have stopped editing
> `index.js`", `index.js` and `host.test.mjs` changed again at **21:14:59–21:15:18**, with a new
> `h5-degraded` case appearing in the suite. The revision I worked for the V5/V6 analysis was
> `533E4BF3FE6050ED` / `9E1E2945BE8FB157`. That revision's state was:

| File | SHA-256 (first 16) | Size |
|---|---|---|
| `dsh-cast/index.js` | `C0C54BEC7C4B36D1` | 108323 |
| `dsh-cast/client.js` | `5E804F5250714E71` | 26588 |
| `dsh-cast/test/host.test.mjs` | `B9676C50DE0CE79D` | 73658 |
| `dsh-cast/test/client.smoke.mjs` | `53C63D6684B8C027` | 23699 |
| `dsh-cast/test/client-shape.mjs` | `0057F4EF57E77063` | 3700 |
| `dsh-cast/test/v5-startup-fatal.test.mjs` | `06BE11C2F6E2B420` | 2810 |

**What I re-verified on `C0C54BEC7C4B36D1`** (rather than assume my attempt-3 verdicts carried over):
my 4-case V5 probe re-run **PASSES unchanged** (A/A/A/B/C/C, zero unhandled rejections), so the
**V5 CLOSED verdict holds on the newest revision**. `client.js` is still byte-identical across all
pins, so §11 and F1 bind. `v5-startup-fatal.mjs` is byte-identical, so my mutation result stands.

**A transient failure I witnessed and must report honestly.** During this window I caught
`host.test.mjs` mid-edit and ran it at a moment when it **failed (exit 1)** while the file was
partially written; seconds later, on the completed file, it passed (exit 0, `ALL HOST TESTS PASSED`).
I am recording this because it is exactly the hazard my own §0 warns about: **I cannot certify a
revision that is being written while I test it.** I am *not* claiming the suite was ever broken in a
committed state — only that I observed a failure during a concurrent edit, and that the failure was
not reproducible on the settled bytes. Anyone acting on this document should re-hash first.

**All four suites green on `C0C54BEC7C4B36D1`:** host exit 0, client.smoke exit 0, client-shape
exit 0, v5-startup-fatal exit 0.

### Superseded attempt-3 pin (`533E4BF3FE6050ED`)

The revision on which I performed the detailed V5/F1/H1–H3/V6 analysis:

| File | SHA-256 (first 16) | Size | vs attempt 2 |
|---|---|---|---|
| `dsh-cast/index.js` | `533E4BF3FE6050ED` | 106760 | **CHANGED** — V5 repair only |
| `dsh-cast/client.js` | `5E804F5250714E71` | 26588 | **UNCHANGED** across all pins |
| `dsh-cast/test/host.test.mjs` | `9E1E2945BE8FB157` | 71252 | **UNCHANGED** |
| `dsh-cast/test/v5-startup-fatal.test.mjs` | `06BE11C2F6E2B420` | 2810 | **NEW** |

On that revision the only `index.js` change was at the `apply()` boundary plus the `promise_fail_soft`
helper (`index.js:672-701`); `writeReport()`'s throw was untouched, so the H2 mutation result stands.


## §0.2 RE-PIN (attempt 2) — superseded by §0.1

The captain landed post-integration hardening fixes **after** my attempt-1 pin, so `index.js` and
`test/host.test.mjs` moved.

| File | SHA-256 (first 16) | Size | State vs attempt 1 |
|---|---|---|---|
| `dsh-cast/index.js` | `F221321125D0E01F` | 105203 | **CHANGED** — re-measured |
| `dsh-cast/client.js` | `5E804F5250714E71` | 26588 | **UNCHANGED** — attempt-1 verdicts still bind |
| `dsh-cast/test/host.test.mjs` | `9E1E2945BE8FB157` | 71252 | **CHANGED** — re-measured |

**What I re-measured on the attempt-2 revision (all probes re-run from scratch):**

| Item | Re-measured on `F221321125D0E01F` | Result |
|---|---|---|
| 1 host suite | yes | `ALL HOST TESTS PASSED`, exit 0 |
| 2–7 memory/ranking/budget/injection | yes, full probe suite | **25 PASS / 0 FAIL** |
| 7 waterfall double-`next()` | yes | `PASS next() called once (inner ran 1x)` |
| 8 HTTP routes (incl. `/active`) | yes | **35 PASS / 0 FAIL** |
| 8 409 guard | yes | PASS, blocks + releases |
| 9 inspector counts | yes | PASS (byte-equal, 1365 chars / 342 tokens) |
| 10 duplicate compare logic | yes, re-grepped | PASS — one `compare()` at `index.js:1598` |
| 11 client requires | yes (client unchanged) | PASS — one `require('react')` |
| 12 writes/traversal | yes | PASS |
| 13 assertion-set diff | yes | baseline 95 → 309, **0 deleted, 0 weakened** |

**Which verdicts stand on the OLD revision only:** item 11's client half is byte-identical
(`5E804F5250714E71`), so §11 and the client-read-path findings (R1–R7, F1) stand unchanged and were
not re-derived. Everything else was re-measured.

**New in attempt 2:** the H1–H3 hardening review, which produced **a new blocker (V5)** — see
READ-PATH/HARDENING section and Falsified claims. The blockers V1–V4 were found in attempt 1.


## Ground truth

`dsh-cast/phase6-contract.md` (t1) was read first. Checkout:
`C:\Users\AlAr\AppData\Local\Author Software\nvm\installs\v22.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`

## Probe harness

All probes are my own, written from scratch, and live **outside the repo** in
`dsh-cast-verify-probe/` (scratch dir, not part of the deliverable, not imported by the plugin):

| Probe | Covers |
|---|---|
| `probe.mjs` | items 2, 3, 4, 5, 6, 7 |
| `probe-waterfall.mjs` | item 7 double-`next()`, against a faithful port of cordis' waterfall |
| `probe-http.mjs` | items 8, 9 |
| `probe-409.mjs` | item 8, 409 in-flight guard |
| `probe-readpath.mjs` | READ-PATH SAFETY (added on captain's instruction) |

I found and fixed **three bugs in my own probe suite** during this pass (an `addMemory` argument-order
mistake, a truncated-budget fixture that dropped everything, and a probe-classification error that
called a well-defined 200 "malformed"). Each is noted at the relevant item so the raw output is not
over-trusted.

---

## 1. Host test suite

**CLAIM:** `node test/host.test.mjs` prints `ALL HOST TESTS PASSED` and exits 0.

**METHOD:** `cd dsh-cast; node test/host.test.mjs`

**RAW OUTPUT (pinned revision):**
```
ALL HOST TESTS PASSED
EXIT=0
```
`client.smoke.mjs` likewise: `ALL CLIENT SMOKE TESTS PASSED`, exit 0.

**VERDICT: PASS**

**REVISION HISTORY:** on the *earlier* revision the suite **FAILED**, exit 1:
```
AssertionError [ERR_ASSERTION]: B2: an idle agent with no running test step is not injected
3 !== 0
    at host.test.mjs:786:10
```
Cause: `agentIsBusy()` consulted `agent.idleDelay` through a `safeIdleDelayMs()` helper. That field
**does not exist anywhere in the DSH checkout** (verified: a recursive `Select-String` for
`idleDelay` across all `.js`/`.ts` under the DSH install returned **no matches**). The test passed
`idleDelay: 60000`, so any positive value was classified "busy" and the idle guard was defeated — the
assertion caught it. The pinned revision removed the invented field; `agentIsBusy()`
(`index.js:2490-2502`) now returns `false` when there is no positive evidence of work, and the suite
is green.

---

## 2. Memory isolation invariant

**CLAIM:** persona X can never see persona Y's persona-scoped or episodic memory, nor another
session's conversation memory, through either `listMemories()` or the new `retrieveMemories()`.

**METHOD:** my own probe against a mock context, attempting to break it:
`cd dsh-cast-verify-probe; node probe.mjs`

**RAW OUTPUT:**
```
PASS  2.isolation  leak_to_other_persona=false leak_conv_cross_session=false
PASS  2.isolation_positive  own=true global=true user=true own_conv=true
PASS  2.isolation_ranked_set_equal  list=4 scored=4
PASS  2.no_wildcard_persona  no cross-persona via wildcard
```
Adversarial attempts, all of which **failed to break it**: (a) querying persona `terse` with the
literal string `PIRATE_SECRET treasure map` — the strongest relevance signal possible — did not
surface pirate's records; (b) session `sANOTHER` did not surface session `sA`'s conversation record;
(c) the ranked `scored[]` id set is byte-equal to the `listMemories()` id set, so ranking cannot
widen visibility; (d) `persona:'*'` wildcard records (global/user) are visible to all, as designed,
and do not leak persona-scoped records.

**VERDICT: PASS.** Isolation is preserved by construction — `retrieveMemories()` filters candidates
through the unchanged `listMemories()` (`index.js:1979-1987`) rather than reimplementing the filter.

> **My own probe bug (disclosed):** the first run reported `FAIL 2.isolation — threw: memory text is
> required`. That was **my** error: I called `addMemory(scope, personaName, text, sessionId)` as
> `addMemory('global', text, null)`, putting the text in the `personaName` slot. Fixed in my probe;
> not a defect in the plugin.

---

## 3. Ranking is real, not insertion order

**CLAIM:** retrieval order is driven by the scoring formula, not by insertion order.

**METHOD:** `node probe.mjs` — constructs memories where the top-scoring item is **not** the
first-inserted one.

**RAW OUTPUT:**
```
PASS  3.rank_not_insertion_order  insertion=[r1..r5] selection_order=["r5","r4","r3","r2","r1"] top=r5 score=1.02
PASS  3.relevance_beats_recency  order=["old_match","new_nomatch"] scores=[0.82,0.32]
PASS  3.scope_priority_matters  order=[["c1",1.05],["g1",0.93]]
PASS  3.deterministic  run1=[] run2=[]
```
Four adversarial angles: **(a)** the only query-matching record (`r5`) was inserted **last** and is
returned **first** — insertion order would invert this; **(b)** relevance beats recency — a 90-day-old
record outscores a brand-new one when only the old one matches the query (`0.82` vs `0.32`);
**(c)** scope priority is live — identical text and age, `conversation` (5) outranks `global` (1)
(`1.05` vs `0.93`); **(d)** two runs with a fixed `now` are byte-identical.

**VERDICT: PASS.** Ranking is genuinely computed, not cosmetic.

---

## 4. Token budget drops WHOLE records

**CLAIM:** a record that does not fit the budget is dropped entirely; no returned record is a
truncated prefix of a stored record.

**METHOD:** `node probe.mjs` — 4 small records that fit plus 6 oversized (400-char) records that
cannot, budget 60 tokens. Every returned `.text` is compared byte-wise against the stored set and
against all stored-prefix relationships.

**RAW OUTPUT:**
```
PASS  4.whole_records_only  budget=60 selected=3 used=54 dropped=7 midCut=null selLengths=[21,21,21]
PASS  4.selected_texts_are_exact_stored_records  exactMatches=3/3
PASS  4.budget_never_exceeded  used=54 <= budget=60
PASS  4.dropped_reported  dropped=7 sample=whole record dropped: 18 tokens + 54 used > 60 budget
PASS  4.zero_budget  selected=0
PASS  4.degenerate_budget  negative=0 NaN=0
```
`midCut=null` and `exactMatches=3/3` mean every selected text is byte-identical to a stored record —
there is **no mid-record cut**. Degenerate budgets are safe: `0`, negative, and `NaN` all select
nothing rather than everything.

> **My own probe bug (disclosed):** the first run reported `FAIL 4.whole_records_only selected=0`.
> My fixture made *every* record 400 chars (~115 tokens), so with a 60-token budget nothing could fit
> — a badly-designed test, not a defect. Rewritten with a small/large mix so partial selection is
> actually exercised.

**VERDICT: PASS.**

---

## 5. Injection suppression, and that it still injects

**CLAIM:** identical memory state across consecutive pre-steps injects **once**; a genuinely new
relevant memory causes a **new** injection.

**METHOD:** `node probe.mjs` — three consecutive `injectMemory` calls with identical state, then one
new record added.

**RAW OUTPUT:**
```
PASS  5.suppression  first=1 second=0 third=0 total_injected=1
PASS  5.injected_shape  role=user source={"kind":"dsh-cast","form":"recall"} content0=text
PASS  5.new_memory_injects  fourth=1 total_injected=2 ids=["i2"]
```
Both failure modes are excluded: a suppressor that never injects would fail the fourth call; a
non-suppressor would inject on the second. The injected message is a `user` message with a text block,
a non-empty `id`, and the producer-owned source `{kind:'dsh-cast', form:'recall'}` — matching contract
item 2 and never the retired `'plugin'` kind.

**VERDICT: PASS.**

---

## 6. No injection without an active persona

**CLAIM:** with no persona active the delivery path injects nothing, and never wakes an idle driver.

**METHOD:** `node probe.mjs`

**RAW OUTPUT:**
```
PASS  6.no_persona_no_inject  queued=0 injected=0
PASS  6.unknown_agent_safe  threw=null
PASS  6.no_inject_method_safe  queued=0 threw=null
PASS  6.idle_never_wakes  queued=0 injected=0
```
Also adversarial: an unregistered agent id, and an agent with **no** `inject` method at all, are both
clean no-ops rather than throws.

**VERDICT: PASS.**

---

## 7. A throwing `inject()` is caught — and the pre-step path is not double-run

**CLAIM:** `inject()` throwing never breaks the turn; the pre-step listener calls `next()` exactly once.

**METHOD:** `node probe-waterfall.mjs` drives the registered listener through a **faithful port of
cordis' real waterfall** (`cordis/lib/index.js:317-325`), counting how many times the built-in
terminal runs for ONE pre-step. Plus `node probe.mjs`.

**RAW OUTPUT (pinned revision):**
```
inner() invocations    : 1
inner() invocations    : 1
PASS  next() called once (inner ran 1x)
```
```
PASS  7.throwing_inject_direct  queued=0 propagated=null
PASS  7.throwing_inject_waterfall  nextCalls=1 decision={"kind":"allow"}
PASS  7.hostile_payload_safe  all hostile payloads deferred to next() exactly once
PASS  7.next_called_exactly_once  nextCalls=1
```
Hostile payloads (`undefined`, `{}`, `{agent:null}`, `{agent:{},messages:null}`, `{inject:5}`) all
defer to `next()` exactly once and never throw.

**VERDICT: PASS** (re-measured on `F221321125D0E01F`).

**REVISION HISTORY — this was a real BLOCKER I found, since repaired.** The earlier revision
(`index.js:2226`) read:
```js
const queued = this.injectMemory(payload?.agent, payload?.messages);
if (queued > 0) void next();      // <-- first call
...
return next();                    // <-- second call, same path
```
Cordis' `waterfall` is **consuming**: `const next = () => (cbs.shift() ?? inner)(...args)`
(`cordis/lib/index.js:320-322`). On the success path (a memory actually queued) that ran `next()`
**twice**, so the terminal ran **twice for one pre-step**. My probe measured it directly against the
real algorithm:
```
--- CASE A: memory SUCCESSFULLY queued ---
inner() invocations    : 2      <-- FAIL
--- CASE B: nothing to deliver (suppressed) ---
inner() invocations    : 1
```
Note the asymmetry: it only fired when memory was delivered, which is exactly the feature under test,
so a pass-only test could have missed it. The pinned revision calls `next()` on exactly one path and
documents the reason at `index.js:2295-2299`.

> **Note on my harness:** my first two runs of this probe crashed with `TypeError: next is not a
> function`. That was my port being wrong (I collected args into a rest array and never appended
> `next`); the real cordis pushes `next` onto the shared `args`. Corrected before drawing conclusions.

---

## 8. Every NEW HTTP route validates input and returns 4xx + `{error}`

**CLAIM:** malformed input yields 4xx with `{error}`; never 500, never 200.

**METHOD:** `node probe-http.mjs`, `node probe-409.mjs` — the handlers are **actually invoked** with
bad input via real `Request` objects; status codes recorded.

**RAW OUTPUT (35 checks, pinned revision):**
```
TOTAL 35  FAIL 0
```
Representative:
```
PASS  8.preview:no name param     status=400 body={"error":"name is required"}
PASS  8.preview:blank name        status=400 body={"error":"name is required"}
PASS  8.preview:whitespace name   status=400 body={"error":"name is required"}
PASS  8.preview:unknown persona   status=404 body={"error":"no persona named \"doesnotexist\""}
PASS  8.preview:traversal name    status=404 body={"error":"no persona named \"../../etc/passwd\""}
PASS  8.preview:proto pollution   status=404 body={"error":"no persona named \"__proto__\""}
PASS  8.compare:empty body        status=400 body={"error":"a, b and prompt are required"}
PASS  8.compare:non-json garbage  status=400 body={"error":"a, b and prompt are required"}
PASS  8.compare:wrong types nums  status=400 body={"error":"no persona named \"5\""}
PASS  8.compare:array body        status=400 body={"error":"a, b and prompt are required"}
PASS  8.compare:valid compare     status=200 body={"a":"pirate",...,"responseA":"MOCK_A_B",...}
```
The `/api/dsh-cast/active` route (added by the repair) was invoked too:
```
PASS  R6.active:no sessionId       status=400 body={"error":"sessionId is required"}
PASS  R6.active:blank sessionId    status=400 body={"error":"sessionId is required"}
PASS  R6.active:whitespace         status=400 body={"error":"sessionId is required"}
PASS  R6.active:unknown sessionId  status=404 body={"error":"no agent for sessionId \"nope\""}
```
409 in-flight guard (`probe-409.mjs`) — blocking a compare with a deterministic gate:
```
compareInFlight while first is blocked: 1
second request status=409 body={"error":"an A/B comparison is already running"}
third request (other pair) status=409
first request status=200
compareInFlight after release: 0
fourth request after release status=200
PASS  409 in-flight guard: blocks + releases correctly
```
The guard both blocks concurrent runs and is released by `finally`.

**VERDICT: PASS.** No route returned 500 on any malformed input, and none returned 200.

> **My own probe bugs (disclosed):** my first run reported two FAILs that were **my** classification
> errors, not code defects: (i) `?name=pirate&name=terse` is not malformed — `URLSearchParams.get`
> returns the first value, so `200` is correct and well-defined; (ii) `8.compare:valid compare`
> returned `400 {"error":"no LLM provider registered"}` because my mock's `listProviders()` returned
> `[]`. Both fixed in the probe.

---

## 9. Inspector counts match the composer

**CLAIM:** the inspector's named layers and counts match what the composer actually produces.

**METHOD:** `node probe-http.mjs` — recompute independently from `composePersonaSystem()` output and
compare against the route's response.

**RAW OUTPUT:**
```
PASS  9.joined_text_equals_live_prompt  inspector_joined_len=1365 live_len=1365
PASS  9.totals_chars_match  totals.chars=1365 live.length=1365
PASS  9.totals_tokens_match  totals.tokens=342 recomputed=342
PASS  9.per_layer_chars_match  layer chars=[339,523,321,176]
PASS  9.per_layer_tokens_match  layer tokens=[85,131,81,44]
PASS  9.layer_names_named  names=["deployment:persona-prefix","dsh-cast:voice","dsh-cast:behavior","dsh-cast:examples"]
PASS  9.truncation_flag_honest  truncatedLayers=[]
PASS  9.truncation_detected_under_tiny_budget  truncatedLayers=["deployment:persona-prefix","dsh-cast:voice","dsh-cast:behavior","dsh-cast:examples"]
```
The inspector's layers re-joined are **byte-identical** to `composePersonaSystem()` (1365 chars), and
the totals/per-layer counts recompute exactly. The truncation flag is not cosmetic: under a 20-token
budget the flag flips on for the layers that are genuinely cut — and `truncation_flag_honest` confirms
a layer marked `truncated` always carries the marker string.

**VERDICT: PASS.** The route calls the same `compose()` the live prompt uses, so it cannot drift.

> **One honest limitation I checked and want on the record:** `promptInspection()` passes a real
> `sessionId` to `compose()` (`index.js:1457`) whereas `composePersonaSystem()` passes `undefined`
> (`index.js:1511`). This is *correct* — the inspector must show the session-scoped memory layer —
> but it means a preview **with** a sessionId can legitimately differ from the session-less
> `composePersonaSystem()`. My equality assertion above used no sessionId, where they must agree, and
> it passed. I did **not** verify count-correctness for a sessionId that has conversation-scoped
> memory; that case is **NOT REPRODUCED** (no session-scoped fixture was constructed).

---

## 10. One-click A/B really calls the existing `compare()`

**CLAIM:** no second, divergent comparison implementation.

**METHOD:** grep for duplicate comparison logic.
`Select-String -Path dsh-cast\index.js -Pattern 'async compare\(|comparisons.push|responseA|responseB'`

**RAW OUTPUT:**
```
1589:   async compare(nameA, nameB, prompt) {
1595:     const responseA = await this._llmComplete(messages, this.composePersonaSystem(a));
1596:     const responseB = await this._llmComplete(messages, this.composePersonaSystem(b));
1597:     const record = { a: a.name, b: b.name, prompt, responseA, responseB, at: Date.now() };
1598:     this.comparisons.push(record);
```
Exactly **one** `compare()` definition. The route is `return json(await this.compare(nameA, nameB,
prompt))` (`index.js:1891`) — a direct delegation returning the record verbatim, and the observed 200
body carried the real `{a,b,prompt,responseA,responseB,at}` shape.

**VERDICT: PASS.**

---

## 11. Client half requires only `react`; no new dependency

**CLAIM:** `client.js` requires only `react`; `package.json` gains no dependency.

**METHOD:** grep `require(` in `client.js`; read `package.json`.

**RAW OUTPUT:**
```
10:     const React = require('react');
```
```json
{
  "name": "@local/dsh-cast", "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-settings","@deepseek-ai/dsh-client-ui-conversation"] } }
}
```
Exactly one `require`, for `react`. There is **no** `dependencies`/`devDependencies` block at all, so
no dependency was added. Styling is inline (no CSS import), consistent with the stated constraint.

**VERDICT: PASS.**

---

## 12. Writes outside the personas dir, and the path-traversal exposure

**CLAIM (a):** nothing writes outside the personas dir.
**CLAIM (b):** the persona-name path-traversal exposure noted in the contract is fixed or
still-present-and-reported.

**METHOD:** enumerate every write site; then adversarially attempt traversal through
`createPersona()`.

**RAW OUTPUT (a) — every write target:** `index.js` writes only to
`this.personasDir` (`:805`, `:811`, `:1377`, `:1468`, `:1618`, `:1640`, `:1963`, `:2006`, `:2062`).
`_memoryPath()`, `_statePath()`, `_historyPath()`, `_ratingsPath()`, `_comparisonsPath()`,
`_groupsPath()` all resolve to `path.join(this.personasDir, …)` (`index.js:1982-1988`). No write
escapes the personas dir.

**RAW OUTPUT (b) — traversal attempts:**
```
BLOCKED "../../evil"          invalid persona name: names must be 1-64 chars, start with a letter or digit…
BLOCKED "..\\..\\evil"        invalid persona name …
BLOCKED "/etc/passwd"         invalid persona name …
BLOCKED "C:\\Windows\\evil"   invalid persona name …
BLOCKED "a/b"                 invalid persona name …
BLOCKED ".hidden"             invalid persona name …
BLOCKED ""                    persona name is required
BLOCKED "   "                 invalid persona name …
BLOCKED "name with space"     invalid persona name …
BLOCKED "n"×65                invalid persona name …
ALLOWED "ok-name_1"
dir contents: .dsh-cast-report.json, ok-name_1.json
```
The traversal exposure is **FIXED**: `PERSONA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`
(`index.js:629`) is enforced in `personaFileName()` (`:631`) before any `path.join`, so `..`, `/`,
`\`, drive letters, leading dots, spaces and over-length names are all rejected and only the
sanitised file is created.

**VERDICT: PASS** on both (a) and (b) — the exposure does not pass silently; it is fixed and
demonstrated blocked.

---

## 13. No pre-existing test assertion deleted or weakened

**CLAIM:** the baseline assertion set is intact.

**METHOD:** compare assertion sets against
`dsh-cast-backups\pre-ui-memory-20261008-130214\dsh-cast\test\host.test.mjs` by extracting each
assertion's `assert.<kind>` and its message string.

**RAW OUTPUT:**
```
baseline assertion lines: 95      current assertion lines: 298
baseline lines: 321               current lines: 1070

--- Baseline assertions whose MESSAGE is absent from current file (deleted/renamed) ---
NONE — every baseline assertion message still present

--- Baseline assertions whose KIND changed (weakening check) ---
NONE — every retained assertion keeps its original assertion kind
```
All 95 baseline assertions are retained with their original kinds and messages; the suite grew
95 → 298 by pure addition. No `assert.equal` was relaxed to `assert.ok`, nothing was deleted, and no
`skip`/`todo` was introduced.

**VERDICT: PASS.**

---

# Post-integration hardening review (H1–H3) — attempt 2

The captain landed three hardening fixes and disclosed his own weak spot on H2. I verified the
current artifacts, not his description of them.

**METHOD:** `node probe-hardening.mjs` and `node probe-h2-blast.mjs`, plus an independent mutation run
against a **temp copy** of the plugin (never the repo file — hashes re-confirmed unchanged after).

## H1 — path traversal via the new `personaPathFor` sink

**CLAIM:** `personaPathFor()` is the single name→path sink and rejects (throws on) illegal names.

**RAW OUTPUT:**
```
PASS  H1.personaPathFor_rejects_all_traversal  payloads=14 violations=0
PASS  H1.remove_rejects_traversal              remove('../../evil') threw=true
PASS  H1.no_escapee_files_on_disk              dir entries=[".dsh-cast-report.json","ok-name_1.json"]
PASS  H1.no_escapee_in_parent                  parent has N entries, none named evil
```
I attacked it with 14 payloads (`../../evil`, `..\..\evil`, `/etc/passwd`, `C:\Windows\evil`, `a/b`,
`..`, `.`, `.hidden`, `''`, whitespace, embedded space, 65×`n`, a NUL byte, `con`) and confirmed both
(a) each is rejected, and (b) on disk nothing landed outside the personas dir. The legitimate
`ok-name_1` is still accepted, so the guard is not over-broad. `remove()` routes through the same sink.

**Design note endorsed:** the fix **throws** rather than sanitising. I agree with the captain's
reasoning — a silently-renamed persona would let a caller believe it wrote `../../evil`. Loud
rejection is the correct failure mode.

**VERDICT: PASS.** (This exposure was previously found-and-reported in attempt 1 §12; H1 hardens it
into a single sink.)

## H3 — report phase label

**RAW OUTPUT:** `PASS H3.report_phase_is_phase6 phase="phase6"` · `PASS H3.report_has_writtenAt writtenAt=1791572654495` · `PASS H3.lastReportError_cleared_on_success null`

**VERDICT: PASS.**

## H2 — the report-write failure is no longer silent

**CLAIM (as fixed):** a failed report write is recorded on the service, logged loudly, and re-thrown.

**RAW OUTPUT (my own fixture, not the captain's):**
```
PASS  H2.precondition_mkdir_succeeds              mkdir on fixture dir ok=true
PASS  H2.precondition_report_path_is_directory    isDirectory=true
PASS  H2.writeReport_propagates                   threw=EISDIR: EISDIR: illegal operation on a directory, open '…'
PASS  H2.lastReportError_recorded                 {"at":1791572654539,"message":"EISDIR: …"}
```
I rebuilt the fixture from scratch and **explicitly guarded against the exact trap the captain
disclosed**: I assert `mkdir` succeeds and that the blocked path is a real directory *before*
asserting the rejection, so the test cannot pass merely because `mkdir` failed first. The failure
provably lands in `writeFile` (index.js:1972), which is the line the old silent catch swallowed.

**Mutation test — I verified the test has teeth.** The captain warned his first attempt "would have
passed with the catch reverted"; I did not take that on trust. I copied the plugin to a temp dir,
reverted only H2's `throw err;` to a silent swallow, and re-ran the suite:
```
MUTATION applied: line 1986 'throw err;' -> 'void err;'   ('throw err;' count now: 0)
AssertionError [ERR_ASSERTION]: Missing expected rejection: H2: writeReport propagates a failure
of the report write itself, not just of mkdir
SUITE EXIT=1
```
The message is verbatim what the captain predicted, so the **current** H2 test genuinely catches a
regression. Temp copy deleted; repo hashes re-confirmed unchanged afterwards.

**VERDICT on the assertion: PASS.** **VERDICT on the fix as a whole: FAIL — see V5 below.**

### V5 — NEW BLOCKER: H2's re-throw escapes `start()` as an unhandled rejection

**This is the finding I most want the captain to act on.** H2 correctly makes `writeReport()` throw.
But `writeReport()` is awaited by `start()` (`index.js:1954`), and `apply()` calls
`service.start()` **without awaiting or catching it** (`index.js:606`). So the re-thrown error has
nowhere to land.

**METHOD:** `node probe-h2-blast.mjs` — an isolated fixture where `personasDir` is a perfectly valid
directory and *only* the report-file path is blocked, so the failure cannot be attributed to anything
else.

**RAW OUTPUT:**
```
calling apply() with a valid personasDir whose report path is a directory...
[dsh-cast] REPORT WRITE FAILED (report on disk is now stale): EISDIR: illegal operation on a directory, open '…'

svc.lastReportError        : {"at":1791572679623,"message":"EISDIR: …"}
svc.list().length          : 10
personas loaded anyway     : YES (personas still work)
personasDir still writable  : YES (1 entries)

unhandledRejection observed : YES -> EISDIR: EISDIR: illegal operation on a directory, open '…'

VERDICT: FAIL — the report-write error escapes start() (un-awaited in apply()) as an
UNHANDLED REJECTION.
```

**Why this is a blocker, not a nit — and I checked rather than assumed.** On this exact runtime,
Node **v22.19.0**, an unhandled rejection is process-fatal. Verified directly:
```
node -e "Promise.reject(new Error('boom')); setTimeout(()=>console.log('STILL ALIVE'),500);"
-> Error: boom ... exit code 1
```
The `STILL ALIVE` line **never prints**: the process dies. So the consequence is precise:

> **Before H2**, a transient report-write failure was silently swallowed — a stale-report hazard
> (bad, and worth fixing). **After H2**, that same transient failure is an **unhandled rejection
> that terminates the host process.** The fix traded a data-honesty bug for an availability bug.

**Severity assessment, stated honestly:** this is *not* a crash-on-startup in normal operation —
`writeReport` only fails if the personas dir is unwritable (full disk, permissions, a blocked file),
so it is a **transient-failure blast radius**, not a routine path. That is why the host suite is green.
But the captain's own description of the original incident was "a transient burst once swallowed 12+"
— i.e. **exactly this failure mode did occur repeatedly in practice**. Under H2, the first of those
12 would now kill the process instead of being logged. That is the regression.

**Suggested shape (repair is t7's job, not mine):** keep `writeReport()` throwing (the test depends on
it and the honesty is right), and make the *caller* resilient — e.g. `apply()` should
`service.start().catch((err) => ctx.log(...))`, or `start()` should catch-and-record around its
`writeReport()` call. The seam that must not change is the *unwatched* rejection, not the throw.

**VERDICT: FAIL (new blocker V5).** A single transient report-write failure is now an unhandled
rejection that terminates the host process on Node v22.19.0.

---

## V5 RE-VERIFICATION (attempt 3) — CLOSED

The captain repaired V5 at the `apply()` boundary and asked me to re-verify. **I reproduced his
scenario with my own fixture rather than accepting his probe or his test.**

**The fix (`index.js:672-701`):**
```js
export function apply(ctx, config) {
  const service = new PersonaService(ctx, config ?? {});
  ctx.provide('personas', service);
  promise_fail_soft(service.start(), `plugin start() failed: `, service);
}
function promise_fail_soft(promise, label, service) {
  return Promise.resolve(promise).catch((err) => {
    const message = err && err.message ? err.message : String(err);
    try { service.log(`${label}${message} (continuing; ...)`); }
    catch { console.error(`[dsh-cast] ${label}${message}`); }
  });
}
```
`writeReport()`'s throw is untouched, exactly as I asked, so H2's honesty guarantee is preserved.

**MY OWN PROBE (`probe-v5-reverify.mjs`) — four cases, not just the captain's one:**
```
PASS  V5.A.apply_does_not_throw_synchronously   syncThrew=null
PASS  V5.A.no_unhandled_rejection               unhandled=[]
PASS  V5.A.service_still_provided               provided=true
PASS  V5.B.log_throwing_is_survivable           threw=null newUnhandled=0
PASS  V5.C.other_startup_failure_non_fatal      syncThrew=null newUnhandled=0
PASS  V5.C.service_provided_even_when_dir_is_a_file  provided=true
```
Case A is the captain's scenario. **Case B and C are adversarial additions his test does not cover:**
B exercises the `log()`-throws fallback path; C forces a *different* startup failure (`personasDir`
pointing at a file, so `mkdir` throws rather than `writeFile`) to test the claim that "startup is
best-effort" holds generally and not just for the report write. Both survive. I also used a global
`process.on('unhandledRejection')` tripwire **in addition to** a timer, which is stricter than
inferring survival from a timer alone.

**I MUTATION-TESTED HIS NEW TEST rather than trusting it** (he flagged that an earlier H2 test of his
was broken, so this needed checking). Reverting the boundary to bare `service.start()` in a temp copy:
```
MUTATION: line 683 -> service.start(); // bare, uncaught
Error: EISDIR: illegal operation on a directory, open '…dsh-cast-v5-…/.dsh-cast-report.json'
MUTANT v5 EXIT=1
```
The test dies before it can print its success line. It has real teeth. Temp copy deleted; repo hashes
re-confirmed unchanged.

**VERDICT: CLOSED.** The fix is sufficient and correctly scoped.

### Is the fix the right *design*? (the captain asked me to argue this)

He chose to catch at `apply()` rather than make `writeReport()` non-throwing, and asked whether a
startup failure should surface somewhere the user sees, not just the log. **My position: his choice is
right for now, with one named gap.**

- **Catching at `apply()` is correct.** The throw is the honesty mechanism H2 exists to provide;
  removing it would re-create the silent-staleness bug. A rejection needs a landing site, and
  `apply()` is the only synchronous boundary that can hold one. Degrade-don't-die is the right policy
  for best-effort startup — the tool routes and prompt layers read live state, as the comment says.
- **The honest limitation:** `lastReportError` is recorded on the service but I could **not** find any
  route that exposes it. So the "user sees it" half of H2 is *not* satisfied today — the failure is
  observable to a log reader and to an in-process caller, not to the UI. That is a gap, not a defect:
  it is strictly better than the original silent swallow, and the data needed to surface it already
  exists. I would **not** block on it. A small read-only `GET /api/dsh-cast/health` (or folding
  `lastReportError` into the existing inspector response) would close it cheaply if the surface is
  wanted — but adding a route purely for this is a product decision, not a verification finding.

---

## V6 — LATENT GAP (new, attempt 3): no `'error'` listener on the FSWatcher

Found while re-verifying V5; initially surfaced as a stray process death in my own probe. I pursued it
rather than dismissing it as my fixture's fault, then **narrowed it to what I can actually prove.**

**CLAIM:** `watchUserDir()` (`index.js:850-864`) wraps `fs.watch()` in `try/catch`, which covers only
the **synchronous** throw. **No `'error'` listener is attached**, and an `EventEmitter` `'error'` with
no listener **throws**.

**RAW OUTPUT — mechanism (`probe-watch-definitive.mjs`):**
```
emitter_error_no_listener_throws: true
shape:watch a FILE, then delete it: error event = EPERM      <-- emits
shape:watch a DIR,  then delete it: error event = NONE       <-- does not
```
**RAW OUTPUT — dsh-cast attaches no listener:** a regex over the watch block and a whole-file search
for `on('error'` both return **nothing**.

**RAW OUTPUT — end-to-end against the LIVE plugin (`probe-v6-confirm.mjs` family):**
The trigger is narrow and I pinned it exactly. `personasDir` must be a **file** (legal to watch on
Windows, so the synchronous `try/catch` never fires), and then that file's **parent directory** must
be removed:
```
applied with file-as-personasDir
deleted the watched file
survived file deletion
deleted the PARENT dir
UNCAUGHT: EPERM watch
VERDICT: V6 CONFIRMED
```
**Control — the same sequence WITH an `'error'` listener survives:**
```
error listener invoked: EPERM
SURVIVED with an error listener attached (exit 0)
```
So the causal chain is complete and the remedy is proven: `watcher.on('error', …)` converts a
process-killing uncaught exception into a loggable event.

**Honest scoping — this is why I grade it LATENT, not BLOCKER.** I could **not** reproduce it with
`personasDir` as a normal re-watched **directory** (the only shape dsh-cast is designed to watch, and
the only shape its own tests exercise), nor in a bare `fs.watch` control — the parent-deletion timing
is what makes it fire. I also could not reproduce it when the file was deleted *without* removing the
parent. So the realistic exposure is: an operator misconfiguring `personasDir` to a file path and that
path then disappearing. That is unusual, which is exactly why it has gone unnoticed — **not** a reason
to leave it unguarded, since the guard is one line and the failure mode is process death.

**VERDICT: LATENT GAP (V6) — CLOSED in supplement 2.** At the time of writing it was OPEN,
low-to-moderate severity, one-line fix. The captain repaired it (`index.js:875-877`, handler attached
to the emitter), and I re-verified it independently — see §0.0 "V6 — CLOSED" above, where I emit the
real `EPERM` shape on the live emitter rather than merely asserting a listener exists.

---


# READ-PATH SAFETY (added on captain's instruction)

## Why this section exists — and why its absence was MY FAILURE

My original brief (item 8) said: *"for every NEW route … confirm it validates input and returns 4xx +
`{error}` on malformed input … ACTUALLY INVOKE the handlers with bad input."* I did exactly that, and
it passed. **But malformed-input testing is not read-path safety testing, and I did not draw that
distinction myself.** My suite contained **no coverage of `activeFor()`/the active-persona read at
all**, so a defect that destroyed user state (F1) sat in the shipped client half while my
verification reported green.

**I did not cover the read path in my first pass. That is an explicit FAIL of my verification scope,
and I own it.** The captain correctly notes this occurred in the same pass where I *did* find the
subtle mechanism-level double-`next()` defect — I found the subtle one and missed the blatant one.
A route being well-formed under malformed input says nothing about whether the client is *allowed*
to call it.

## Classification: every route the client calls, pure-read vs mutating

**METHOD:** `node probe-readpath.mjs` — enumerate every `api()` call site in `client.js`, then
determine mutation by **observation** (does plugin state change after the call?).

| Route | Method | Client call site | Class | Evidence |
|---|---|---|---|---|
| `/dsh-cast/list` | GET | `loadPersonaList()` (render path) | **pure read** | returns `this.list()`; no state change |
| `/dsh-cast/get` | GET | `loadPersonaDetail()` (render path) | **pure read** | returns `this.get(name)` |
| `/dsh-cast/preview` | GET | `loadPreview()` (render path) | **pure read** | composes only; explicit "never performs a write" |
| `/dsh-cast/active` | GET | `readActive()` (render path) | **pure read** | 25x calls, state unchanged (below) |
| `/dsh-cast/activate` | POST | `readActive()` **pre-fix** ⛔ / `activate()` (user action) | **MUTATING** | disposes + re-registers prompt sections |
| `/dsh-cast/compare` | POST | `runCompare()` (user action) | **mutating** (appends a comparison record) | `comparisons.push` + `saveComparisons()` |
| `/dsh-cast/create` | POST | settings page (user action) | **mutating** | writes a persona file |
| `/dsh-cast/edit` | POST | settings page (user action) | **mutating** | rewrites a persona file |
| `/dsh-cast/delete` | POST | settings page (user action) | **mutating** | unlinks a persona file |

**Exactly one misuse existed: POST `/activate` was used as a read.** In the pinned revision that is
corrected to `GET /active`.

## F1 — proof the defect was real, and proof the fix holds

**RAW OUTPUT (`probe-readpath.mjs`):**
```
PASS  R1.readActive uses GET /active (pure read)  uses GET terminator: true; uses POST /activate: false
PASS  R2.GET /active is idempotent (25x, no state change)  distinct_returned=["warm"] active_after="warm" stable=true
PASS  R3.POST /activate IS mutating (unsafe as a read) — proves F1 was real  status=200 active_after="chaotic" (was 'warm')
PASS  R4.POST /activate turns an OFF session ON (F1 consequence, proven)  active_after="warm" (was null)
PASS  R5.GET /active leaves an OFF session OFF (F1 fixed)  active_after_10_reads=null
TOTAL 11  FAIL 0
```
- **R2** — the read route is genuinely idempotent: 25 calls, identical return, state unchanged.
- **R3** — calls POST `/activate` with a *different* persona and observes a session on `warm` being
  **clobbered to `chaotic`**. This reproduces the captain's F1 consequence #1 and proves the route is
  genuinely mutating, i.e. structurally unsafe to call from a read.
- **R4** — a session with the persona **OFF** becomes **activated** merely by calling it. This
  reproduces F1 consequence #2 (silent activation).
- **R5** — after 10 reads through `GET /active`, an OFF session **stays off**.

**VERDICT (read-path safety, pinned revision): PASS** — the single read/mutate misuse is corrected and
provably non-mutating.

---

# The general check this pass earned (the captain asked me to name it)

F1, V5 and V6 are **the same defect class wearing three different costumes**, and every one of them
passed a green suite. They were not found by better local testing — each was found by following a
value *out of* the function that looked correct. The general check is:

> **Local correctness is not blast radius. For every path that can fail or mutate, ask where the
> effect LANDS — and test that, not the function.**

Three concrete questions that catch this class, in increasing order of how easy they are to skip:

1. **Follow every throw/rejection to its ultimate caller.** A function that throws correctly is only
   half-verified. Ask: *who awaits this, is that awaited, and what happens to the process if nobody
   is?* → This is exactly V5. `writeReport()` threw correctly, its own test was mutation-proven, and
   two review passes graded it green — because nobody walked one frame further up to `apply()`.
   The tell: a `throw` whose caller is fire-and-forget.
2. **Follow every mutation to its ultimate *reason for being called*.** Ask: *why is this invoked,
   and is that reason compatible with the effect?* → This is exactly F1. `POST /activate` was
   correct in every malformed-input sense; the defect was that a **render path** called it. The tell:
   a verb-named route invoked from code whose job is to read.
3. **Follow every async event source to its error channel.** Ask: *this can emit `'error'` — who is
   listening, and is the guard synchronous or async?* → This is exactly V6. A `try/catch` around
   `fs.watch()` looks like it handles errors, but it only sees the synchronous throw; the async
   `'error'` event bypasses it entirely. The tell: `try/catch` around anything that returns an
   `EventEmitter`.

**Why the suite could not catch any of the three.** In all three cases the *assertion was true* about
the unit under test. `writeReport` really did propagate; `activate` really did validate; `watch` really
was wrapped. The defect lived in the **relationship to the caller**, which no per-function test
observes. That is the structural reason a green suite is not evidence here — and it is the same reason
my own item-8 scope (which tested routes as units) missed F1 in attempt 1.

**The cheap mechanical version**, if this should not depend on reviewer intuition: for every function
that can throw, grep for its call sites and assert each one either awaits-and-catches or is explicitly
fire-and-forget-with-a-handler. V5 would have fallen out of that grep in seconds.

---

# What this verification structurally CANNOT establish

These are standing open gaps, not passes. Each is a limit of my *method*, and they generalize:

1. **Invoking a handler directly is not proof the client calls it correctly.** Every route verdict
   above proves the *server* behaves under a given request. Whether `client.js` issues the right
   request, from the right place, with the right arguments, is only argued by reading the source —
   not executed. This is precisely how F1 survived: `activate` was perfectly correct server-side.

2. **A mock that returns a fixed value cannot detect a wrong value.** Demonstrated:
   ```
   PASS  R7.mock-blindness demonstrated  a fixed mock says 'terse' while real state is "chaotic"
                                          -> a mock cannot catch a wrong active persona
   ```
   This is the reviewer's F6 point generalized: if a stub answers `{active:'terse'}` unconditionally,
   then *no* test in the suite can fail when the real active persona is something else. A mock that
   cannot produce a wrong answer cannot validate a right one. Any read-path claim resting on such a
   mock is **unverified** no matter how green it looks.

3. **Read-path safety is not input-validation.** A route can be impeccably validated and still be the
   wrong route to call. My original item-8 scope was drawn too narrowly around *malformed input*; the
   correct framing is *"for each route a render path calls, does calling it change state?"*

4. **The client half is still not runtime-verified.** It cannot be from here: it needs a Web-side
   rebuild plus a page refresh against the live GUI. `client.smoke.mjs` passes, but it executes the
   factory against a synthetic React + slots harness — it proves the registrations and component
   construction, **not** that any of it renders or behaves correctly in the real browser. **This is a
   standing open gap, not a pass.** No claim in this document asserts the client surface works in the
   browser.

5. **Behaviour under the real harness timing is untested at unit level.** Per contract item 3, the
   mock cannot reproduce `inject()`'s real wake/claim/discard timing. My item-5/6/7 results prove
   *which message was handed to `inject()`* and the plugin's own decision logic — not the harness step
   boundaries. Item 7's waterfall result is stronger (it ports the real cordis algorithm), but it is
   still a port, not the live loop.

6. **Session-scoped inspector counts are NOT REPRODUCED.** See item 9: I verified count-equality only
   for the session-less path, where the inspector and `composePersonaSystem()` must agree. The
   session-scoped memory layer was not exercised with a conversation-scoped fixture.

7. **Revision instability.** The files changed twice underneath me during this pass. Verdicts are
   bound to the SHA-256 hashes in the header and must be re-established if those change.

---

# Falsified claims

Claims found **false** during this verification (all were true of an earlier revision; the pinned
revision has since repaired them — they are recorded because they shipped, and because the manner of
their detection is the point):

| # | Falsified claim | Evidence | Status on pinned revision |
|---|---|---|---|
| **V1** | *"the pre-step hook always defers to `next()`"* — i.e. it is a well-behaved waterfall listener | `index.js:2226` (`if (queued>0) void next()`) + `:2230` (`return next()`) against consuming cordis `waterfall` (`cordis/lib/index.js:320-322`) → terminal ran **2×** per delivered pre-step. Reproduced in `probe-waterfall.mjs`: `inner() invocations: 2`. Fired **only when memory was actually delivered** — the feature's own success path | **REPAIRED** (`index.js:2295-2300`, exactly one `next()`); probe now shows `1` |
| **V2** | *"`node test/host.test.mjs` → ALL HOST TESTS PASSED"* (as reported by t2/t3) | Suite exited **1**: `assert.equal(idleQueued, 0)` got `3` at `host.test.mjs:786` | **REPAIRED**; suite green, exit 0 |
| **V3** | *"the idle guard uses `safeIdleDelayMs()` / `agent.idleDelay`"* implied a real harness field | `idleDelay` appears **nowhere** in the DSH checkout (recursive search: 0 matches). It was invented, and it defeated the idle guard (V2) | **REPAIRED** — field removed, `agentIsBusy()` now uses only real signals |

**Claim I falsified against my own work, not the plugin's:**

| # | Falsified claim | Evidence |
|---|---|---|
| **V4** | *"item 8's route testing establishes the client's read paths are safe"* — the implication of my first pass being green | False by construction: my suite had **zero** coverage of the active-persona read. F1 (state-clobbering + silent activation) shipped behind a green report. **My scope was too narrow; this section exists to close it.** |
| **V5** | *H2 hardening: "a failed report write is now recorded and re-thrown"* implying the hardening is safe | **NEW in attempt 2.** `writeReport()` throws (`index.js:1986`) and is awaited by `start()` (`:1954`), which `apply()` called un-awaited/uncaught (`:606`). Isolated probe `probe-h2-blast.mjs` observed the EISDIR escaping as an **unhandled rejection**; on Node v22.19.0 that is process-fatal (verified: `node -e "Promise.reject(...)"` → exit 1, never reaches its timer). | **CLOSED** in attempt 3. Repaired at the `apply()` boundary via `promise_fail_soft` (`index.js:672-701`); `writeReport()`'s throw left intact as I asked. I re-verified with my own 4-case probe (A/B/C/D) and mutation-tested the new regression test (revert → exit 1). |
| **V6** | *`watchUserDir()` handles watch errors* — implied by its `try/catch` around `fs.watch()` | **NEW in attempt 3.** `try/catch` covered only the synchronous throw; **no `'error'` listener was attached** (whole-file search for `on('error'` returned nothing). `fs.watch` on a **file** whose **parent dir** is then deleted emits an async `EPERM` `'error'`; with no listener that is an uncaught exception → process death. Reproduced against the live plugin; a control with a listener attached survives. | **CLOSED** (supplement 2). Handler now attached to the **emitter** (`index.js:875-877`). I re-verified by **emitting the real `EPERM` shape on the live emitter** — `probe-v6-h5.mjs` V6.2 survives with 0 uncaught exceptions, V6.3 confirms it logs rather than swallows, V6.4 independently reproduces the bare-`fs.watch` control (`listenerCount('error') === 0`). |
| **H5** | *H2's honesty mechanism reaches the user* | **My named gap, attempt 3.** `lastReportError` was written on the service but **no route exposed it**, so a report-write failure was log-visible only — H2's "user sees it" half was unmet. | **CLOSED** (supplement 2). `healthStatus()` (`index.js:2614`) surfaced as a `health` block on `GET /api/dsh-cast/list`; client renders `HealthNotice`. I forced a **real** report-write failure and confirmed the block flips to `ok:false, reportStale:true` (H5.4) while personas still serve (H5.5), and that a missing `health` field renders nothing rather than an error (`client.js:115`). |

---

# Summary

**All 13 briefed items were re-verified on the re-pinned revision `F221321125D0E01F` /
`5E804F5250714E71` / `9E1E2945BE8FB157`, with no failures** — the memory isolation, ranking, whole-record
budget, injection suppression/positive-delivery, no-persona, throwing-inject, route-validation,
inspector-count, compare-reuse, dependency, write-scope and assertion-integrity checks all pass.

**But the work is not clean, and the count of open defects is the headline:**

- **V1** (double-`next()` → terminal ran twice per delivered pre-step) — found attempt 1, **repaired**.
- **V2** (host suite failing on the idle-agent assertion) — found attempt 1, **repaired**.
- **V3** (invented `agent.idleDelay` field that defeated the idle guard) — found attempt 1, **repaired**.
- **V4** (my own verification-scope failure: no read-path coverage, so F1's state-destroying
  read shipped behind a green report) — **mine**, addressed by the READ-PATH SAFETY section.
- **V5** (H2 re-throw escaped as a process-fatal unhandled rejection) — found attempt 2,
  **CLOSED** in attempt 3: repaired at the `apply()` boundary, re-verified independently, and the
  new regression test mutation-proven to have teeth.
- **V6** (no `'error'` listener on the plugin's FSWatcher; async `EPERM` is process-fatal) — found
  attempt 3, **CLOSED** in supplement 2: handler attached to the emitter, re-verified by emitting the
  real `EPERM` shape on the live emitter (survives, 0 uncaught exceptions, and logs).
- **H5** (my named gap: `lastReportError` had no reader, so H2's honesty never reached the user) —
  found attempt 3, **CLOSED** in supplement 2: `healthStatus()` on `GET /list` + client `HealthNotice`,
  re-verified by forcing a real failure and watching the block flip.

**All findings from this pass are now closed. Nothing is open.** V1–V3, V5, V6 and H5 are repaired and
independently re-verified; V4 was my own scope failure and is documented as such.

**Three of the six defects (V1, V5, V6) were invisible to the green host suite**, and V1/V5/V6 share one
root cause: a value whose *local* behaviour was correct but whose *blast radius* was never followed to
the caller. See **"The general check this pass earned"** above — it is the most reusable output of this
verification, and the captain has adopted it.

On the current revision (`B89488055F300BBC` / `648D01CBA0C5F200` / `B9676C50DE0CE79D`), all six checks
are green and all 13 briefed items pass. Seven structural gaps remain recorded as open rather than
passed — most importantly that **the client half is not runtime-verified**, which no amount of
host-side probing in this workspace can change. That gap is deliberately left unsoftened.

### Standing items for the captain

1. **Nothing blocking.** Every finding I raised is closed and re-verified.
2. **Keep future V6 tests honest about the error shape.** `_watcherHandle` makes the emitter reachable,
   which is the right call — but it also means a test *could* fabricate an error Node never emits and
   "prove" survivability for it. I avoided that by emitting the real `EPERM` code; I would hold future
   tests to the same standard. This is the one risk the exposure introduces, and it is worth a comment
   more than a guard.
3. **The client half remains NOT runtime-verified** — unchanged, and I am not softening it. This is the
   single largest remaining gap in the phase, and it is structural: it needs a Web rebuild plus a page
   refresh against the live GUI, which cannot be done from this workspace.
4. **Session-scoped inspector counts** remain NOT REPRODUCED (only the session-less path, where the
   inspector and `composePersonaSystem()` must agree, was checked).
