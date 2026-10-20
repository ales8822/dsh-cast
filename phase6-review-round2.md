# Phase 6 — Independent Review, Round 2

**Reviewer:** reviewer (AgentTeams member), task **t8**, attempt `4e10d204-1d9b-49cf-8d14-a28824fa0ab2`
**Reviewed:** repair task **t7**, plus four post-integration hardening fixes (H1–H3) made directly by the captain
**Scope reviewed:** `dsh-cast/index.js`, `dsh-cast/client.js`, `dsh-cast/test/host.test.mjs`, `dsh-cast/test/client.smoke.mjs`
**Method:** every claim re-derived from the current files and the DSH checkout. I did not accept t7's or the captain's summary as evidence. All mutation testing was performed on an isolated copy under `.rev2/mut/`; the real tree was never edited.

## VERDICT: **PASS**

Round 1's six findings are all **CLOSED** and each fix is **load-bearing** (mutation-proven). The captain's four post-integration hardening fixes are **correct**, and the one test-quality concern I raised mid-review turned out to be **my own misreading — retracted below**. Residual uncertainty about the client half is stated rather than resolved in the implementation's favour.

---

## 1. Round-1 findings — individual re-verification

| ID | Round-1 finding | Status | How I re-verified |
|---|---|---|---|
| F1 | Read of active persona POSTed the mutating `/activate` route | **CLOSED** | New pure `GET /api/dsh-cast/active`; client `readActive()`; live probe shows no mutation; mutation-proven |
| F2 | Double `next()` in the `agent/pre-step` hook | **CLOSED** | Exactly one `return next()` on every path; terminal invoked once; mutation-proven |
| F3 | `(score N.NN)` telemetry in the model-visible prompt | **CLOSED** | Prompt is score-free; scores retained in the structured return; mutation-proven |
| F4 | Token-pricing envelope overcharge (+2/message) | **CLOSED** | Now exactly `ceil(len/4) + 4 + 4`; matches harness formula across len 0–300 |
| F5 | Dead `safeIdleDelayMs` / fabricated `idleDelay` signal | **CLOSED** | Function removed; `idleDelay` verified absent from the whole checkout; removal pinned by test |
| F6 | Client smoke test locked in F1's defect | **CLOSED** | Test now asserts read-only GET + no POST on mount, and uses a **stateful** mock so a wrong persona is detectable |

### F1 — read-path safety (round 1's blocker)

The new route calls only `this.active(agent)`; it never touches `activate()`, `deactivate()`, or `this.activations`:

```js
route('/api/dsh-cast/active', ['GET'], (request) => {
  const sessionId = (new URL(request.url).searchParams.get('sessionId') ?? '').trim();
  if (!sessionId) return Promise.resolve(json({ error: 'sessionId is required' }, 400));
  const agent = this.ctx.agents?.get(sessionId);
  if (!agent) return Promise.resolve(json({ error: `no agent for sessionId "${sessionId}"` }, 404));
  try {
    return Promise.resolve(json({ sessionId, active: this.active(agent) ?? null }));
  } catch (err) { return Promise.resolve(json({ error: err.message }, 400)); }
});
```

**Exact probe** (`node .rev2\acceptance.mjs`) — the three-state contract and mutation safety:

```
=== F1: GET /api/dsh-cast/active must be a PURE read ===
   route registered: true methods=["GET"]
   chose 'warm' -> read returned {"sessionId":"f1-a","active":"warm"} -> still 'warm' : PASS (not mutated)
   off session: sections registered before = none
   read returned {"sessionId":"f1-b","active":null} -> active still null : PASS (stayed off)
   unknown session -> 404 {"error":"no agent for sessionId \"nobody\""}
   missing param   -> 400 {"error":"sessionId is required"}
```

**Read-path safety property: SATISFIED.** Reading never mutates, and **an OFF session is not silently activated** — the round-1 failure mode is gone. The route also distinguishes *off* (`200 {active:null}`) from *error* (`404`), so the client never infers off-state from an error.

### F2 — exactly one `next()`

```js
try {
  this.injectMemory(payload?.agent, payload?.messages);
} catch (err) {
  this.log(`memory injection failed, turn continues: ${err.message}`);
}
// EXACTLY ONE next() on every path. The Cordis waterfall is CONSUMING ...
return next();
```

```
=== F2: the pre-step hook must call next() exactly ONCE ===
   delivery happened: inject() calls = 1
   terminal invocations for ONE pre-step = 1 : PASS (single next)
   failure path: next() calls = 1, decision = {"kind":"enter"} : PASS
```

### F3 — score-free prompt

```
F3 — score telemetry in the model-visible prompt? ABSENT (fixed)
   memory line as the model sees it: "- kubernetes rollout rollback strategy"
   memory text still reaches the prompt: true
F3 — scores still available for the inspector: true = 1.02
```

The memory content still reaches the prompt (the feature is not broken); only the telemetry is gone, and it remains available in `retrieveMemories()`'s structured return for the UI inspector.

### F4 — token accounting vs the harness formula

```
=== Token accounting: price === ceil(len/4) + 4 + 4 ===
   _measureText matches ceil(len/4)+8 across len 0..300: PASS
   usedTokens <= budget across 9 budgets: PASS
   no mid-record cut anywhere: PASS
   usedTokens === sum(selected tokens): PASS
```

`usedTokens <= budget` held across budgets `[1, 3, 10, 25, 60, 150, 400, 1200, 5000]`, and **no mid-record truncation** occurred: every oversized record was dropped whole, never sliced. The F4 test at `host.test.mjs:657` compares against `Math.ceil(len/4) + 4 + 4` written out longhand — an independent re-derivation, not a call into the code under test — and includes `len=0` and `len=23` (the value that exposed the old 23-char-envelope bug).

### F5 — the fabricated signal

I verified the justification independently: `idleDelay` **appears nowhere in the DSH checkout**. `agentIsBusy()` now consults only real fields, and the test pins the removal (`agentIsBusy({ idleDelay: 60000 }) === false`).

### F6 — test integrity

`client.smoke.mjs` now asserts that merely reading issues **no** `POST /activate` (`:396-401`) and that a wrong active persona is detectable via a **stateful** mock (`:403-430`). This is the assertion that locked in the defect in round 1; it is now inverted to pin the fix.

---

## 2. Mutation testing (fixes proven load-bearing)

Performed on an isolated copy (`.rev2\mut\`), seeded byte-identical to the real tree (hash-compared). Each defect was reintroduced by an explicit source edit, the suite run, then the file restored and the suite re-run.

| Defect reintroduced | Suite | Mutated exit | Observed failure (quoted) | Restored exit |
|---|---|---|---|---|
| **F1** — `readActive()` back to `POST /activate` | client.smoke | **1** | `AssertionError: header popover reports the off state explicitly` | **0** (`ALL CLIENT SMOKE TESTS PASSED`) |
| **F2** — `if (q > 0) void next();` restored | host.test | **1** | `AssertionError: F2: the terminal ran EXACTLY once per step (got 2)` | **0** (`ALL HOST TESTS PASSED`) |
| **F3** — `(score N.NN)` back in `memoryText()` | host.test | **1** | `AssertionError: F3: no "(score N.NN)" telemetry in the composed system prompt` | **0** |
| **H1** — persona-name guard removed | host.test | **1** | `AssertionError: Missing expected exception: H1: name "../escaped-persona" must be rejected by the sink` | **0** |
| **H2** — `writeReport` catch made silent again | host.test | **1** | `AssertionError: Missing expected rejection: H2: writeReport propagates a failure of the report write itself, not just of mkdir` | **0** |

Baseline on the unmutated copy: exit **0** (`ALL HOST TESTS PASSED`). All five tests are therefore genuinely load-bearing — none would pass with its defect present.

---

## 3. The captain's post-integration fixes (H1–H3)

### H1 — path traversal: **CORRECT, and I could not bypass it**

The guard is a module-level `PERSONA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` enforced at a single sink, `personaPathFor()`, which both writers (`_writePersonaFile`, `remove`) call. It **throws** rather than sanitising, which is the right call: a silently-renamed persona would let the caller believe it wrote `../../evil` when it wrote elsewhere.

I attacked it directly (`node .rev2\h1-traversal.mjs`). Every vector was blocked:

```
blocked "../../evil" | "..\\..\\evil" | "C:\\Windows\\Temp\\evil" | "/etc/passwd"
blocked "a/b" | ".hidden" | "" | 65-char name | "has space" | "nul\u0000byte"
accepts: "terse" -> ...\personas\terse.json
blocked save("../../OUTSIDE") | save("C:\\Windows\\Temp\\pwned")
outside file created? no
```

**On the captain's specific question — does not putting the check in `normalize()` leave a reachable path?** I traced it rather than assuming. `normalize()` (`index.js:658`) does not validate the name, and `loadUser()` (`:776`) will admit a hostile name from a planted file into memory — I confirmed that empirically (`loadUser() admitted the planted name into memory? YES`). **But every write path still funnels through the sink**, and the planted name is stopped there:

```
loadUser() admitted the planted name into memory? YES
   blocked at the sink: invalid persona name "../../PLANTED"
   rollback(planted): invalid persona name "../../PLANTED"
   blocked remove(): invalid persona name "../../PLANTED"
   blocked ".dsh-cast-state": invalid persona name ".dsh-cast-state"
```

So the gap is in the *load* stage, not the *write* stage, and it is not reachable for writes. The captain's judgement (sink, not `normalize()`) is sound. The regex also disallows a leading dot and any dot at all, which independently prevents persona names from colliding with the dot-prefixed side files (`.dsh-cast-state.json` etc.) — I verified `.dsh-cast-state` is rejected.

*Minor residual (not a finding): a persona file planted on disk whose `name` field traverses will still appear in the in-memory list, so `/api/dsh-cast/list` could echo a name that can never be saved or removed. That is a cosmetic/unreachable-write issue, and it is strictly better than the pre-fix state.*

### H2 — silent report failure: **CORRECT and load-bearing**

The catch now records `this.lastReportError`, logs loudly, and **re-throws**; success stamps `writtenAt` and clears the error. I verified the staleness is genuinely observable end-to-end (`node .rev2\h2-staleness.mjs`):

```
1. success: writtenAt=number phase=phase6 lastReportError=null
2. failure: threw=EISDIR lastReportError=set
3. the failed service exposes the staleness: YES -> EISDIR: illegal operation on a directory
   => a reader can distinguish fresh from stale: YES (fixed)
4. the healthy dir's report is untouched and still fresh: writtenAt=true
```

**On the captain's self-criticism about the fixture** — I attacked it as invited, and it holds up. The EISDIR fixture does reach the intended line:

```
fixture: personasDir is a REAL directory -> mkdir(recursive) is a no-op
mkdir(recursive) on the fixture: SUCCEEDED (good — not the failure point)
direct writeFile to the blocked path: FAILED as intended: EISDIR
writeReport() threw: EISDIR
lastReportError recorded: {"at":...,"message":"EISDIR: illegal operation on a directory, open 'C..."}
=> the assertion fails at the report write, not at mkdir: YES
```

And I confirmed it is not passing incidentally — simulating the old silent catch makes the assertion unable to pass:

```
with the old silent catch: writeReport threw = false; lastReportError = null
=> test CANNOT pass with the silent catch (load-bearing)
```

The captain's corrected understanding of their own test is accurate. The earlier version (parent-is-a-file, failing at `mkdir`) would indeed have been a weaker test; the current one is not.

### H3 — report `phase` label: **CORRECT** (`index.js:1965` → `'phase6'`).

---

## 4. Withdrawn mid-review concern (my error)

While reading the H1 test I suspected the on-disk assertion at `host.test.mjs:1110-1112` was **vacuous** — it checks `path.join(escapeRoot, '..', 'escaped-persona.json')`, and `escapeRoot` is never any service's `personasDir`. I was **wrong**, and I tested it instead of reporting it from reasoning alone.

Because the test's `personasDir` (`dsh-cast-test-…`) and `escapeRoot` (`dsh-cast-escape-…`) are both direct children of the same temp root, the checked path and the real escape destination **coincide**:

```
path the TEST checks        = <TMP>\escaped-persona.json
path a real ../ escape hits = <TMP>\escaped-persona.json
same path? YES
mutated write threw: no (traversal executed)
file at checked path : EXISTS      <-- with the guard removed
```

So the assertion **is** meaningful: had the guard been absent, the traversal would land exactly there and the assertion would fire. **Concern retracted.** (This is recorded because round 1's value came from checking rather than assuming, and I would rather show the check than hide the dead end.)

---

## 5. Workstream B — isolation invariant (independently re-derived)

Re-checked with fresh records and its own session ids (`node .rev2\acceptance.mjs`):

```
=== Isolation invariant (re-derived independently) ===
   own persona scope visible     : yes (correct)
   OTHER persona scope hidden    : yes (correct)
   other persona EPISODIC hidden : yes (correct)
   own conversation visible      : yes (correct)
   other conversation hidden     : yes (correct)
   user scope visible            : yes (correct)
   global scope visible          : yes (correct)
   ranked set === listMemories() set: PASS
```

**Satisfied**: a persona sees only global + user + its own persona/episodic scopes + the current conversation; another persona's `persona` **and** `episodic` scopes are both hidden; another conversation's records are hidden. The ranked visible set is still exactly the `listMemories()` set, so ranking adds no new visibility.

---

## 6. Other dimensions

- **Contracts / DSH API surface:** unchanged from round 1 and still faithful. `agent.inject` remains the sanctioned non-waking delivery path; `{kind:'dsh-cast', form:'recall'}` is admitted at create/append/replay; the `agent/pre-step` hook's single `next()` matches the consuming Cordis waterfall (verified against `cordis/lib/index.js:317-325`).
- **Zero-dependency:** still satisfied. Host imports only `node:fs`, `node:fs/promises`, `node:crypto`, `node:url`, `node:path`; client `require`s only `'react'`; `package.json` has no dependencies.
- **Route registry:** 9 registered routes match the test's expected list exactly — no drift, no duplicate paths.
- **Test integrity (H2 aside):** the pre-existing suite is intact; the new assertions test behaviour rather than restating implementation. `F4`'s test in particular compares against an independent longhand re-derivation.
- **Scope discipline:** the real tree contains only the expected changes; all my mutation work was confined to `.rev2\`, and I verified the real `index.js`/`client.js`/`host.test.mjs` bytes are unchanged (hash-compared against the isolated copy after restoration, `True` for all three). Both suites pass on the real tree: host exit **0**, client exit **0**.

---

## 7. Residual uncertainty (stated, not resolved in the implementation's favour)

1. **The client half is still NOT runtime-verified.** `client.smoke.mjs` proves bundle shape, registration, and hook-driven rendering against a **stand-in React shim** — it is not real-shell rendering. Nothing I did this round changes that: no Web bundle was rebuilt and no page was refreshed, so the session-header picker, identity preview, prompt inspector, and A/B panel have **not** been observed in the actual DSH Web GUI. A green smoke suite must not be read as proof that the UI works in the browser. `phase6-verification.md:552` records this limitation correctly, and I endorse it.
2. **Inject timing is still unverified at unit level.** The mock cannot reproduce real wake/claim/discard step semantics (contract item 3's caveat). The tests prove *which message* was passed to `inject()` and the plugin-side decision logic — not that the harness claims it at the expected boundary.
3. **The B3 context-budget pass has a named limitation** carried from round 1: per-scope quota selects by score *within* a scope, so a strong record in a heavy scope can lose its place to a weaker record that is its scope's best. This is documented in the code and remains a deliberate design choice, not a defect.
4. **H1 load-stage gap (informational):** `normalize()` does not validate names, so a hostile name planted on disk is admitted to the in-memory list (it cannot be written or removed). Call it closed for write-safety; if the team wants list-level hygiene too, validating in `normalize()` would be the place.

---

## 8. Findings

**None.** No blocker, high, medium, or low findings remain open. The round-1 findings are all closed and mutation-proven, and the captain's four hardening fixes are correct.

The only follow-up worth doing is **not a code defect**: verify the UI in the real Web GUI (rebuild + refresh) before presenting the feature as user-visible working, since the client half has never run in the actual shell.
