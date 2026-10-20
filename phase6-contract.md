# dsh-cast Phase 6 — Verified API Contract Note

**Status:** recon complete. Every claim below was read from the installed checkout, not inferred.
**DSH checkout (only source of truth):** `C:\Users\AlAr\AppData\Local\Author Software\nvm\installs\v22.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
All `file:line` citations below are relative to that directory unless they start with `dsh-cast/` (workspace-relative).
**Version:** `@deepseek-ai/dsh-session-format` reports `0.2.0-rc.2` (`dsh-session-format/package.json`).
**Baseline:** `node dsh-cast\test\host.test.mjs` → `ALL HOST TESTS PASSED` (exit 0), Node v22.19.0.

Shorthand prefixes used below:
`AP = dsh-agent\lib`, `AL = dsh-agent-loop\lib`, `LLM = dsh-llm\lib`, `SES = dsh-session\lib`,
`SP = dsh-system-prompt\lib`, `TM = dsh-token-meter\lib`, `CONV = dsh-client-ui-conversation\lib`,
`SLOTS = dsh-client-ui-slots\lib`, `UISES = dsh-client-ui-session\lib`.

---

## 1. `agent.inject(message)` — exact contract

**VERDICT: REAL and confirmed.** `inject` takes a `UserMessage`, never wakes an idle driver, and a running driver claims it at the next step boundary. Pending injected context is discarded by cancellation and by disposal.

**EVIDENCE**

- Declaration — `AP\types\runtime-types.d.ts:201-209`:
  ```
  /** Queue model-facing context for the next pre-step without waking the driver. A running driver
   * claims it at the nearest later step boundary; idle drivers leave it pending until follow-up or
   * steering wakes them. It may miss a request whose pre-step already claimed its batch.
   * Cancellation or disposal may discard pending context. */
  inject(message: UserMessage): void;
  ```
  Parameter is `UserMessage` (`AP\types\runtime-types.d.ts:209`). Note it is a **`void`, fire-and-forget** call — no promise, no ack, no per-message settlement.
- Implementation — `AL\index.js:812-814`:
  ```js
  inject(input) { this.send(input, "next-step", false); }
  ```
  Compare the siblings at `AL\index.js:806-811`: `followup` → `send(input, "next-turn", true)`; `steer` → `send(input, "next-step", true)`. **`inject` is exactly `steer` with `wakeup: false`.** This is the whole semantic difference.
- `send` — `AL\index.js:800-805`: splices into the resolved target list and calls `this.wakeDriver(...)` **only when `wakeup` is true**. With `false`, no driver work is scheduled. Idle driver → no `agent/status` transition, message simply sits in the inbox.
- Claim point — `AL\index.js:906`: `preStep` calls `this.inbox.claim(target, position.turn)`, and `claim` (`AL\index.js:103-111`) drains the **entire** `next-step` list (`this.nextStep.length`, not 1) before optionally taking one `next-turn` message. So injected messages are batched with any same-boundary steering, in inbox order.
- Injected messages become **durable `user/message` event data** — `AL\index.js:1061`: `for (const message of decision.messages) this.session.append("user/message", message, { surfaceOp: "append" })`. At `user/message` the appended `data` **is** the message itself (`SES\index.js:242`).

**Lifecycle precisely stated (all from `AL\index.js`)**

| Event | What happens to the pending injected message |
|---|---|
| **Step boundary, running driver** | Claimed by `inbox.claim(target, …)` at `AL\index.js:906` during the next `preStep`. It becomes part of `decision.messages` and is appended as `user/message` at `AL\index.js:1061`. |
| **Step boundary, idle driver** | Nothing. It waits in `next-step` (inbox is a projection, not a timer). Docs `AP\types\runtime-types.d.ts:203-205`: stays pending "until follow-up or steering wakes them". |
| **Turn close** | A pending `next-step` message **prevents the turn from closing**: `AL\index.js:998` and `AL\index.js:1005` both guard on `this.inbox.nextStep.length === 0`. Non-empty ⇒ loop does not break, `target = "next-step"` (`AL\index.js:1006`), another step runs. Caveat: `agent/turn-stopping` (`AL\index.js:999`) is only dispatched when `nextStep` is empty, so **injecting from inside a `turn-stopping` listener cannot itself extend the turn at that boundary** — it is claimed at the next step instead. |
| **Cancellation** | Discarded. `cancel` at `AL\index.js:815-821`: unless `options.keepInbox`, it calls `this.inbox.clear()`, which (`AL\index.js:93-96`) splices `next-step` to empty **first**, then `next-turn`. `inject` always targets `next-step`, so injected context is the first thing cleared. |
| **Agent disposal** | Discarded. Disposal runs `machine.cancel({ kind: "disposed" })` with **no** `keepInbox` (`AL\index.js:1688`) → `inbox.clear()` → `next-step` dropped. |
| **`disposed` + `keepInbox: true`** | Only reachable via the fork/continuation path (`AL\index.js:1906`), not via ordinary disposal. Do not rely on it. |
| **`agent/pre-step` returns `reject`** | `AL\index.js:958-961` — the turn ends `blocked`; claimed messages are **not** re-emitted and **not** restored to the inbox (`AP\types\runtime-types.d.ts:268-270`). The injected message is effectively consumed and lost. |
| **Observability** | `agent/inbox/inserted`, `agent/inbox/claimed`, `agent/inbox/discarded` all emit with the exact `message` (`AP\types\runtime-types.d.ts:263-292`). These are the only way to observe inject delivery; `inject()` itself returns nothing. |

**IMPLICATION for the memory workstream**
- `agent.inject(...)` is the sanctioned, durable injection path and is **safe to call on an idle agent** — it will not spuriously start a turn. That is the desired property for "deliver retrieved memory without hijacking the user's turn".
- **But**: because it does not wake, an injected memory delivered while the session is idle **may never reach the model** if the user never sends another message. There is no delivery receipt and no `await`. A "delivery path bounded by a token budget" must therefore be **fire-and-observe**, not fire-and-confirm: record the injection attempt, and surface it in the UI as *queued* rather than *delivered*.
- Do **not** `await` anything from `inject`. Do **not** promise the caller that the model saw it. If the feature needs a guarantee, it needs `steer` (wakes) — which changes user-visible behaviour and must be a deliberate, separate decision.
- Budget must be enforced **before** the call (there is no post-hoc correction) and the pending queue should be treated as **volatile**: cancellation/disposal silently drops injected context, so never persist "injected" as if it were "shown".
- Remember the claim is a **batch drain**: injecting N messages yields N durable `user/message` events at one step. Cap N, not just total tokens.

---

## 2. `createUserMessage({content, source})` and whether an UNKNOWN `source.kind` is accepted

**VERDICT: REAL — an unknown `source.kind` is accepted at all three layers.** `dsh-cast` may legitimately use its own source kind (e.g. `{ kind: 'dsh-cast' }`). The only two rejected values are a **non-string / empty-string** `kind`, and the **retired literal `'plugin'`**.

**EVIDENCE — (a) `createUserMessage`**

- `LLM\types\message.js:53-58` is a pure pass-through; there is no validation, no switch, no allowlist:
  ```js
  export function createUserMessage(input) {
      return createMessage({ ...input, role: 'user' });
  }
  ```
- `createMessage` (`LLM\types\message.js:34-39`) only adds `id` and deep-freezes. **No `source` inspection at all.**
- Type level — `LLM\types\message.d.ts:144-146` (`UserMessage`) plus `MessageBase` at `:124-133` constrain `source` only to `MessageSource` = `MessageSourceMap[keyof MessageSourceMap]` (`:122`). The designer's stated intent is explicit at `LLM\types\message.d.ts:94-100`:
  > *"Where a message (or injected content) came from … **Merge-extensible sum type — each producer declares its own `kind` in its own module; there is no shared catch-all `plugin` kind.** Model and tool sources answer their role messages; **user messages carry any producer's kind, and consumers fall through unknown kinds.**"*
- `MessageSourceMap['user']` is declared as `{ kind: 'user' }` (`:102-104`) but is **not enforced** — the runtime never checks it.

**EVIDENCE — (b) the session append path**

- `AL\index.js:1061` appends the message object verbatim as the `user/message` event data.
- `Session.append` (`SES\index.js:1441-1481`) snapshots the payload, deep-freezes it, and calls `validateSessionEventData` (`SES\index.js:1460`).
- `validateSessionEventData` (`SES\index.js:239-274`) is **deliberately minimal** — its own doc at `:233-238` says *"This does not validate complete event payloads"*. For surface types it only checks role/tool-change-block consistency (`:241-258`); the **only** per-role `source.kind` assertions are for `developer/message`, `assistant/message` (`must be 'model'`) and `tool/result` (`must be 'tool'`) — see `SES\index.js:244-257`. **`user/message` has no `source.kind` check whatsoever.** A `user/message` only needs array `content` and a consistent role.
- `surfaceOpOf` (`SES\index.js:295-303`) governs whether `surfaceOp` may be carried — `user/message` is surface-eligible (`SURFACE_EVENT_TYPES`, `SES\index.js:154-160`), so `{ surfaceOp: 'append' }` is correct and required for model visibility.

**EVIDENCE — (c) session-format validation on replay**

- The **current format (v4)** admission is `dsh-session-format-v3-to-v4\lib\index.js:122-127`:
  ```js
  function source(message) {
      const value = message["source"];
      if (!isSessionFormatJsonObject(value) || typeof value["kind"] !== "string"
          || value["kind"].length === 0 || value["kind"] === "plugin")
          throw new SessionFormatError("format v4 message requires a producer-owned source kind");
  }
  ```
  This is an **admission** check, not an allowlist: any non-empty string except `'plugin'` passes. Its doc at `:123` says exactly that: *"Native source admission preserves unknown attribution and refuses retired plugin wrappers."* Applied by `assertV4MessageSources` (`:132-137`) and `assertV4SourceRowAdmission` (`:142-152`), which covers `user/message` data directly (`:145`).
- Sibling validators repeat the same contract: `:300` (developer message), `:117` (`rewriteV3MessageSource`: *"requires a nonempty kind"*, and preserves every unknown kind unchanged at `:118-119`).
- **In-tree precedent — this is the decisive proof.** `dsh-session-title-llm` declares and uses its own kind, declared by module augmentation and **registered in `SessionEventMap`**:
  - `dsh-session-title-llm\lib\types\index.d.ts:9-15`:
    ```ts
    declare module '@deepseek-ai/dsh-llm' {
        interface MessageSourceMap {
            'dsh-session-title-llm': { kind: 'dsh-session-title-llm' } & ContextFormed;
        }
    }
    ```
  - Runtime use: `dsh-session-title-llm\lib\index.js:202` — `source: { kind: "dsh-session-title-llm" }`.
  - Format validator refers to it by name at `dsh-session-format-v3-to-v4\lib\index.js:851`.
- Other in-tree producer kinds, for shape reference: `runtime-context` (`AL\index.js:218`, `:343-346`, with `sections`), `user-approval` (`dsh-user-approval\lib\index.js:102-108`).

**IMPLICATION for both workstreams**
- **`dsh-cast` may use `source: { kind: 'dsh-cast' }` (or `'dsh-cast-memory'`) and it will survive creation, append, persistence and replay.** No forking, no patching, no shell trick required.
- **Use `{ kind: 'dsh-cast', form: 'recall' }`** — `ContextForm` already has a `'recall'` member whose meaning is *"Material lifted out of another session's log, possibly reduced on the way in"* (`LLM\types\message.d.ts:57-58`). This is the closest semantic match for retrieved memory and costs no extra field. Do **not** claim `'snapshot'` (requires `sections`, `:82-84`) or `'notice'` (requires `summary`, `:85-88`) unless you supply those fields.
- **Never use `kind: 'plugin'`** — hard-rejected by every format validator (`:126`, `:150`, `:117`).
- Because `MessageSourceMap` is merge-extensible but `dsh-cast` is plain JS with no `.d.ts`, the augmentation is **optional for runtime** and only needed for downstream TS consumers. If it is added, put it in a `.d.ts` companion, not `index.js`.
- **Do not confuse this with item 11.** A producer *source kind* is free-form; an *event type* is a closed set. See item 11.

---

## 3. Whether the existing test mock can reach an `Agent` with `.inject`

**VERDICT: NO — the current mock is structurally incapable of exercising injection.** It must be extended.

**EVIDENCE**

- `dsh-cast\test\host.test.mjs:31`:
  ```js
  agents: { get() { return undefined; }, currentInitiator() { return undefined; } },
  ```
  Both stubs return `undefined`, so every `this.ctx.agents?.get(...)` / `currentInitiator()` call site in the plugin yields `undefined`.
- Affected plugin call sites: `dsh-cast\index.js:610` (`reload` → `agents.get(id)`), `:1439` (`set_persona` tool), `:1458` (`list_personas` tool), `:1568` (`/api/dsh-cast/activate` → `agents.get(body.sessionId)`).
- The activation route is the critical one — `index.js:1566-1570`:
  ```js
  const agent = this.ctx.agents?.get(body.sessionId);
  if (!agent) return json({ error: 'no agent for sessionId' }, 400);
  ```
  With the current stub this route **always** returns 400. It is currently **untested**.
- Production returns a real `Agent`: `dsh-agent\lib\index.js:594-596` — `get(id) { return this.store.get(id)?.agent; }`; `:368-371` — `currentInitiator()` returns the initiator `Agent`. That `Agent` carries `inject` via the augmentation at `AP\types\runtime-types.d.ts:139-210`.
- The existing `mockAgent` helper (`host.test.mjs:44-55`) is a **bare object** with only `id` and `ctx.effect`/`ctx.systemPrompt.section`. It has **no `inject`**, and is passed directly to `service.activateGroup(...)` / `service.handoff(...)` rather than through `agents.get`, so no test currently proves the real registry path either.

**What the mock must add (minimum, concrete)**

1. A mock agent factory returning an object that also carries `inject(message)` — and it must **record** calls, e.g. `inject(msg) { injected.push(msg); }`. Add `session` too if any new code reads `agent.session`.
2. `agents.get(id)` must return that mock for at least one known id, instead of `undefined`. Keep a `Map` so a specific `sessionId` can be addressed and a missing id still returns `undefined` (preserving the 400 path as a testable case).
3. `agents.currentInitiator()` should return the same mock so the tool paths (`set_persona`, `list_personas`) can be exercised.
4. Because `mockAgent.ctx.effect` (`:48-51`) returns a no-op disposer and `ctx.systemPrompt.section` (`:52`) is a stub, `service.activate()` keeps working unchanged — new agent fields are additive and safe.
5. The mock's `inject` must **not** be silently callable-but-unasserted. Add assertions that record `message.source.kind`, `message.role === 'user'`, and the joined text length, so the token budget can be verified against what was actually handed to `inject`.

**Caveat the implementer must not paper over:** the mock cannot reproduce the *timing* semantics of item 1 (wake/claim/discard). A unit test can only assert *"the right message was passed to `inject`"*. Claims about step boundaries must be stated as untested-at-unit-level or covered by a live host check.

---

## 4. `ctx.tokenMeter` — exact API for estimating messages

**VERDICT: REAL, but `ctx.tokenMeter` is NOT currently in `dsh-cast`'s `inject` list, and it is a different service from the plugin's home-grown estimator.**

**EVIDENCE**

- Service registration — `TM\types\index.d.ts:14-18`: `declare module '@deepseek-ai/cordis' { interface Context { tokenMeter: TokenMeter } }`. Class `TokenMeter extends Service` (`:20`), `static inject: string[]` (`:22`).
- **`measure(session, requestHeader?)` → `TokenMeasurement`** — `TM\types\index.d.ts:46`. Replays the session's durable tail; optional `EpochHeader` replaces the latest logged envelope. Returns a detached, deeply immutable measurement.
- **`estimateMessage(message)` → `number`** — `TM\types\index.d.ts:57`. This is the *instance face* of the pure `estimateMessage` export. This is the one to use for pricing a candidate memory message.
- Pure estimator exports (usable without the service) — `TM\types\estimate.d.ts`:
  - `estimateMessage(message: Message): number` — `:42`
  - `estimateContent(blocks: readonly ContentBlock[]): number` — `:26`
  - `estimateStructuralBlock(block: ContentBlock): number` — `:20`
  - `estimateSystemMessage(message: Message): number` — `:35`
  - `estimateToolsTokens(header: EpochHeader | undefined): number` — `:49`
  - `ROLE_OVERHEAD = 4` — `:11`
- `TokenMeasurement` shape — `TM\types\types.d.ts:24-37`: `logRevision`, `baseline` (`'none' | 'estimated' | 'usage'`), `surfaceDeltaTokens`, **`totalTokens`**, **`surfaceTokens`**, **`nodes: readonly TokenSurfaceNode[]`** (positional head→tail).
- `TokenSurfaceNode` — `TM\types\types.d.ts:39-55`: `{ seq, tokens, heuristicTokens }` — one node per surface event, so **you can read the exact price of the `user/message` you injected** if you know its seq.

**Where the assembled system-prompt size is actually observable — two distinct answers**

- **Heuristic / compositional (server-side, no session needed): not directly exposed as a scalar.** `estimateSystemMessage(message)` prices a *rendered system-role message*. To price a *composed* prompt you must first render it, then price it: `renderPrompt(assembly)` (`SP\types\index.d.ts:199`) → `createSystemMessage(text)` (`LLM\types\message.js:80-86`) → `estimateSystemMessage(...)`.
- **Live / authoritative: `ctx.tokenMeter.measure(session).surfaceTokens` and `.nodes`.** The system prompt is a surface node (surface node 0 per `AL\index.js:232-234`), so its price is one of the `nodes[].tokens` entries. There is a purpose-built projection for exactly this decomposition — `dsh-token-meter\lib\types\breakdown-projection.d.ts:8-12` registers `SessionProjectionStateMap.contextBreakdown` with `{ systemTokens, toolsTokens, messageTokens }` (`:20-25`). **This is the supported "how many tokens is the system prompt" answer on the client side**, and it is a session projection, so the UI can read it via `useProjection`.
- Client-safe surface: `TM\types\client.d.ts:6-8` re-exports `./projection.ts` plus `deriveTurnTokenUsage`. Importable as `@deepseek-ai/dsh-token-meter/client`.

**IMPLICATION**

- **Do not invent a second token estimator.** `dsh-cast` currently has `estimateTokens` at `dsh-cast\index.js:430-440` (naive `chars/4`) and `tokensToChars` at `:34` (and `budget()` at `:36-40`). These are **home-grown and inconsistent with the harness heuristic**. For a "real token budget" claim, the memory workstream should price candidates with `estimateMessage`/`estimateContent` so the number means the same thing as the meter the UI shows.
- If `ctx.tokenMeter` is used directly, **add `'tokenMeter'` to `dsh-cast\index.js:457`** (`export const inject = [...]`) or guard with `this.ctx.tokenMeter?` like the existing optional `agents` usage — an unguarded access to an uninjected service is exactly the kind of thing that fails a profile without the meter mounted.
- For the UI inspector's token readout, prefer the **`contextBreakdown` projection** (`systemTokens`/`toolsTokens`/`messageTokens`) over recomputing anything client-side; it is authoritative and already wired.
- Note the estimator's own framing: it is a *"Fixed-density heuristic"* (`TM\types\estimate.d.ts:1-7`), not a real tokenizer. Presenting it as exact would be wrong; label it as an estimate.

---

## 5. `getSectionOrder(name)` / `getContextOrder(name)` and the REAL numeric table

**VERDICT: REAL. Both are unguarded property reads and return `undefined` for an unknown name.** Every literal `dsh-cast` currently hardcodes is listed below with its real number.

**EVIDENCE — signatures**

- `SP\types\index.d.ts:245` — `getSectionOrder(name: PromptSectionOrderName): number;`
- `SP\types\index.d.ts:251` — `getContextOrder(name: PromptContextOrderName): number;`
- Implementation — `SP\index.js:249-251`:
  ```js
  getSectionOrder(name) { return SECTION_ORDERS[name]; }
  ```
  and `SP\index.js:257-259`: `getContextOrder(name) { return CONTEXT_ORDERS[name]; }`
- **Known name → its number. Unknown name → `undefined`** (plain object index; no throw, no guard). The declared return type `number` is a **lie at the type level** for unknown names — JS will hand back `undefined`.
- Consequence: `section()` validates `Number.isFinite(section.order)` and **throws** if the order is not finite — `SP\index.js:241`:
  ```js
  if (!Number.isFinite(section.order)) throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
  ```
  Same guard for `context()` at `SP\index.js:267`. So **`order: getSectionOrder('TYPO')` → `TypeError` at registration time** (loud, which is good). This is the failure mode to rely on.

**EVIDENCE — the REAL numeric table (`SP\index.js:10-43`, mirrored as literal types at `SP\types\index.d.ts:113-146`)**

| Name | Value |
|---|---|
| `HARNESS_IDENTITY` | `-1000` |
| `DEPLOYMENT_PERSONA_PREFIX` | `0` |
| `PLAN_POLICY` | `500` |
| `TEAM_POLICY` | `600` |
| `PTC_ONLY` | `800` |
| `FILE_REFERENCE` | `900` |
| `TOOL_BASH` | `1000` |
| `TOOL_PWSH` | `1010` |
| `TOOL_READ` | `1100` |
| `TOOL_WRITE` | `1200` |
| `TOOL_EDIT` | `1300` |
| `TOOL_GLOB` | `1400` |
| `TOOL_GREP` | `1500` |
| `TOOL_JOBS` | `1600` |
| `TOOL_PTY` | `1700` |
| `TOOL_WEB_SEARCH` | `2000` |
| `TOOL_WEB_FETCH` | `2100` |
| `TOOL_LSP` | `2200` |
| `TOOL_SESSION_QUERY` | `2300` |
| `TOOL_GOAL` | `2400` |
| `TOOL_WORKFLOW` | `2600` |
| `TOOL_RALPH` | `2700` |
| `TOOL_SUBAGENT` | `2800` |
| `TOOL_REPORT` | `2900` |
| `TOOL_COMPUTER_USE` | `3000` |
| `MCP_SERVERS` | `3100` |
| `TOOLS_SDK` | `5000` |
| `DELIVERABLE_FILE_REFERENCES` | `9000` |
| `STRUCTURED_OUTPUT` | `9900` |
| `HARNESS_SOURCE` | `10000` |
| `WEB_SURFACE` | `10100` |
| `DEPLOYMENT_PERSONA_SUFFIX` | `10200` |

Context orders (`SP\index.js:44-48`): `SANDBOX_POLICY` = `110`, `APPROVAL_POLICY` = `115`, `SUBAGENT_DELEGATION` = `120`.

**The literals `dsh-cast` currently hardcodes — mapped to real names**

From `dsh-cast\index.js:248-261` (the `compose()` layer table):

| dsh-cast layer | hardcoded `order` | site | nearest real name + value | verdict |
|---|---|---|---|---|
| `deployment:persona-prefix` | `0` | `index.js:249` | `DEPLOYMENT_PERSONA_PREFIX` = **0** | ✅ **exact match** — this is deliberate: it deliberately reuses the reserved section name `deployment:persona-prefix` (`SP\index.js:55`, `PERSONA_PREFIX_SECTION`) so it *shadows* the deployment persona. Correct, but see caveat. |
| `dsh-cast:voice` | `250` | `index.js:250` | between `DEPLOYMENT_PERSONA_PREFIX` (0) and `PLAN_POLICY` (500) | ⚠️ **no real name**; a magic literal. |
| `dsh-cast:behavior` | `450` | `index.js:251` | between 0 and `PLAN_POLICY` (500) | ⚠️ magic literal. |
| `dsh-cast:state` | `455` | `index.js:254` | — | ⚠️ magic literal. |
| `dsh-cast:memory` | `460` | `index.js:256` | — | ⚠️ magic literal. |
| `dsh-cast:examples` | `465` | `index.js:259` | — | ⚠️ magic literal. |
| `dsh-cast:spike` (spike only) | `200` | `dsh-cast-spike\index.js:36` | — | ⚠️ magic literal. |

**Section names are NOT the same namespace as order names.** `getSectionOrder` takes a *placement name* (`'PLAN_POLICY'`), not a section name (`'dsh-cast:voice'`). Passing a section name returns `undefined`. The section name is free-form and only must be unique per layer; the **reserved** exceptions are `deployment:persona-prefix` and `deployment:persona-suffix` (`SP\index.js:55`, `:57`, exported as `PERSONA_PREFIX_SECTION`/`PERSONA_SUFFIX_SECTION`, `SP\types\index.d.ts:162-164`).

**IMPLICATION**

- **Nothing in phase 6 should pass a literal to `getSectionOrder`.** With no matching real name, `getSectionOrder` is the wrong tool and would yield `undefined` → `TypeError`. The correct split is: use `getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')` (= 0) for the one real anchor, and keep explicit named numerics for the dsh-cast band, ideally as named constants in one table rather than inline literals so the UI can render the order.
- **Order-band collision risk is real and must be respected.** The entire dsh-cast block (250/450/455/460/465) sits below `PLAN_POLICY` (500) and above `DEPLOYMENT_PERSONA_PREFIX` (0). The spike's live evidence (`dsh-cast-spike\evidence.json`, e.g. `at 2026-10-07T10:38:36.149Z`) confirms the assembled order it actually produced: `harness:identity, deployment:persona-prefix, dsh-cast:spike, plan:policy, context:file-reference, tool:pwsh, …`. A new memory section must slot inside that same band or deliberately choose its position — do not blindly append a large order.
- **Caveat on shadowing `deployment:persona-prefix`:** because `dsh-cast` registers a *scoped* section with the reserved name, it replaces the deployment persona for that scope. That is intended (`index.js:632-640` uses `agent.ctx.effect` → agent-scoped). Any new UI "composed prompt inspector" that shows sections must therefore show **the shadowed result**, not the global registration, or it will misreport what the model sees. Use `ctx.systemPrompt.assemble({ agent, scope: agent })` (see item 6/inspector note) to get the truth.
- Note the `section()` **duplicate-name throw** within one layer (`SP\types\index.d.ts:48-49`: *"Unique name — a duplicate registration throws"*). `activate()` disposes prior layers first (`index.js:630`), which is what keeps re-activation from throwing.

---

## 6. `dsh-cast\client.js` — the exact `ctx.slots.inject` / `ctx.slots.register` pattern

**VERDICT: the existing pattern is correct and must be matched exactly.** The component receives its props from the framework (owner share + session standard kit + inject face); it is **not** called with options.

**EVIDENCE — the pattern as written**

- Bundle wrapper + factory — `dsh-cast\client.js:5-10`:
  ```js
  window.__ModuleLoader__.load({
    id: '@local/dsh-cast',
    factory(require) {
      const React = require('react');
      const h = React.createElement;
      const { useState, useEffect } = React;
  ```
- The export face — `dsh-cast\client.js:184-201`:
  ```js
  return {
    inject: ['slots'],
    apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-cast-personas',
        order: 50,
        label: 'Personas',
      }, PersonaPanel));
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'dsh-cast-switcher',
        order: 0,
        label: 'Persona',
      }, PersonaSwitcher));
    },
  };
  ```
- Options shape actually in use: `{ name, id, order, label }` + component as the **second argument** to `register`. Only `name` is structurally required (`name` is the slot key); `id` is the list-cell id, `order` the ascending display order, `label` a display label.
- Cross-check against an in-tree first-party registration into a header slot, which is the exact shape phase 6 needs — `dsh-client-ui-jobs\lib\client.js:610-621`:
  ```js
  ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
      name: "conversation.session.header.actions",
      id: "job-list",
      order: 20,
      locale: "job",
      inject: () => ({ hooks: { jobs: ctx.jobs.state }, ... })
  }, JobListAction));
  ```
  and `dsh-client-ui-schedule\lib\client.js:6829-6847`, which is the **direct precedent for obtaining `sessionId`**:
  ```js
  ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
      name: "conversation.session.header.utilities",
      id: "schedule-catalog",
      order: -5,
      locale: NS,
      inject: (sessionId) => { const source = createSource(sessionId); return { ...source, ... }; }
  }, ScheduleCatalogAction));
  ```
- How the component receives props — `SLOTS\lib\types\index.d.ts:474`:
  ```ts
  export type ComposedProps<K, EntryKey, S, H, I, M = never, N = undefined> =
      PropsRuntime<K, EntryKey> & PropsRenderSlots<S> & PropsRenderFactories
      & PropsStore<H> & InjectFace<I> & MatchedShare<...> & PropsLocale<N>;
  ```
  `PropsRuntime` (`:222`) = `OwnerOf<K> & KeyPropsOf<K, EntryKey> & SlotInjectFace<...> & ScopeStandardProps<ScopeOf<K>>`.
- The `inject` factory on registration — `SLOTS\lib\types\index.d.ts:483` (`InjectParams`): for a `scope: 'session'` slot the single positional parameter is a **definite `sessionId`**. Doc at `:480-481`: *"Business data access happens through the apply closure's ctx — no binding object parameter exists."* And `InjectFace` (`:459-465`): a declared `hooks` compartment is **converted into `use<Name>` selector hooks** on the component props; other members pass through verbatim.
- The existing `PersonaSwitcher` reads `sessionId` straight off props — `dsh-cast\client.js:24`: `const { sessionId } = props;`. This works because `conversation.input.left` is a session-scope slot.

**IMPLICATION**

- **New registrations must use the identical `ctx.slots.inject(key, () => ctx.slots.register({ name, id, order, label, [locale], [inject] }, Component))` shape.** `inject` is optional and is the mechanism for getting `sessionId` into the component.
- For the header slots, `ctx.slots.register(...)` **must** be nested inside `ctx.slots.inject('conversation.session.header.actions', …)` — the inject call is what waits for the owning plugin to declare the slot. Registering without it is not the established pattern.
- **No `props.renderSlot` for a `list`-kind slot** — `PropsRenderSlots` only adds what the entry *declares* as `children` (`:313-337`). A leaf action entry declares none.
- `settings.section` and `conversation.input.left` are already taken by `id`; reuse `id` values only for replacing an existing entry (`SLOTS` keyed-cell semantics) — **use fresh ids** for the new phase-6 entries.
- The `label` is a plain string here. `dsh-client-ui-jobs` also passes `locale: 'job'` which synthesizes a `t` prop; `dsh-cast` has no dictionary registered, so **do not pass `locale`** — declaring it without an installed dictionary fails loud (`SLOTS\lib\types\index.d.ts:604-610`).

---

## 7. Slot contracts for the two session-header slots

**VERDICT: both are `kind: 'list'`, `scope: 'session'`, owner props `ConversationHeaderActionOwnerProps`. A session-scope component gets `sessionId` as a **prop** (declared by `ui-session`'s merge). It calls the host over the same-origin `/api` fetch routes (item 9).**

**EVIDENCE**

- `CONV\lib\types\client\contract\slots.d.ts:154-165`:
  ```ts
  /** Title-adjacent Session actions in ascending order. */
  'conversation.session.header.actions': {
      kind: 'list';
      scope: 'session';
      owner: ConversationHeaderActionOwnerProps;
  };
  /** Right-aligned Session utilities in ascending order. */
  'conversation.session.header.utilities': {
      kind: 'list';
      scope: 'session';
      owner: ConversationHeaderActionOwnerProps;
  };
  ```
  Both are `list` (ascending `order`) and `session` scope. The neighbouring `'conversation.session.header'` (`:140-147`) is `single`/`session` with an owner `hideChrome: boolean` — that is the **parent**, not the target.
- Owner props interface — `CONV\lib\types\client\contract\slots.d.ts:354-358`:
  ```ts
  /** Header actions derive their state from standard Session props. */
  export interface ConversationHeaderActionOwnerProps {
      /** Marker field: entries receive no owner-specific values. */
      children?: never;
  }
  ```
  **`children?: never` is a marker: the header passes NO owner-specific props.** All component state must come from the standard session kit or the entry's own `inject` face.
- **How the component obtains `sessionId`** (this is the item the task asks to name precisely):
  - The base package declares the standard kit **empty** — `SLOTS\lib\types\index.d.ts:191-192`: `export interface SessionStandardProps { }`, with the comment at `:186-190` explaining that `ui-session` merges the concrete members.
  - **The merge is in `dsh-client-ui-session`** — `UISES\lib\types\client\index.d.ts:77-84`:
    ```ts
    interface SessionStandardProps {
        /** Current Session lifecycle and control state. */
        useSession: SessionSnapshotSelector;
        /** Current Session identity. */
        sessionId: SessionId;
        /** Host-computed projection values addressed by projection key. */
        useProjection: UseProjection;
    }
    ```
    and the session-maybe variant at `:85-92` (same members, `sessionId` possibly `undefined`).
  - `ScopeStandardProps<S>` selects it by scope — `SLOTS\lib\types\index.d.ts:217`; `PropsRuntime` folds it in — `:222`. So a `session`-scope entry receives **`sessionId: SessionId` (definite, branded)**, plus `useSession` and `useProjection`.
  - The **name to use**: `sessionId` (a prop), backed by the hook `useSession`. In the `inject` factory the same value arrives as the first positional parameter (`SLOTS\lib\types\index.d.ts:477-483`).
  - `SessionId` is branded — `SLOTS\lib\types\index.d.ts:213-215`: `SessionIdOf` resolves from the merged `SessionStandardProps`, falling back to `string` without the merge.
  - Runtime precedent for the prop: `dsh-cast\client.js:24` destructures `sessionId` from props today.

- **Also exposed on the same session kit (useful for the inspector):**
  - `useProjection` — `UISES\lib\types\client\index.d.ts:83`, typed `UseProjection`. This is how the UI reads host-computed projection values by key, including the token `contextBreakdown` projection (item 4) and the `requestInspection` data (below).
  - Global kit merged at `UISES\lib\types\client\index.d.ts:71-76`: `useSessions`, `useSessionStatus`, `useSessionRetainInfo`.
- `ConversationSessionHeaderSlotProps` — `CONV\...\slots.d.ts:534` — is the **header owner's** composed props (it renders the children). The child entries themselves get `PropsRuntime<'conversation.session.header.actions'>`, which is `ConversationHeaderActionOwnerProps` + session standard kit + their own inject face.

**How it calls the host** — there is no RPC service in the standard kit; all first-party client code talks to the host over the authenticated `/api` channel via browser `fetch`. `dsh-cast` already does exactly this (`dsh-cast\client.js:14-20`, item 9).

**Bonus for workstream A — "what the model actually sees" already has a first-class client contract.** This is the single most important find for the inspector, and it means the composed prompt does **not** need to be reinvented:

- `CONV\lib\types\client\contract\request-inspection.d.ts:5-21`:
  ```ts
  export interface ConversationPromptSnapshot {
      /** Provider/model and sampling configuration from the effective request header. */
      config: AssistantRequestConfig;
      /** Rendered text of the `system/message` surface node in force for the request; empty when the
       * surface has no system prompt or the node lies outside the loaded history window. */
      system: string;
      /** Complete tool catalog sent with the request, including tools that were never called. */
      tools: readonly ToolSchema[];
  }
  ```
  **`system` is literally "the rendered system prompt the model sees"** — including every `dsh-cast` section, post-shadowing. And `tools` is the *complete* catalog, including never-called tools. Paired with `AssistantRequestConfig` (`config`), this is a full "what the model sees" triple.
- `RequestPromptInspection` (`:57-62`) and `RequestPromptChange` (`:42-55`) exist to classify **how the prompt changed** between requests (`kind: 'initial' | 'system' | 'tools' | 'system-and-tools'`, with `previous`). This is directly reusable for a **persona A/B diff** — the A/B workstream should diff `ConversationPromptSnapshot.system` before/after a persona switch rather than string-diffing its own composer output.
- `SystemPromptNode` (`:23-40`) carries `{ seq, time, turn, step, text, update }` — durable, positioned prompt facts.
- `RequestPromptInspection` is attached to the request view: `AssistantRequestView.prompt` / `.promptChange` (`:102-104`), and `prompt` is documented as *"Effective ordinary request input, inherited until a later header changes it"*.
- A sibling system-only fold — `CONV\lib\types\client\contract\system-prompt.d.ts:9-24` — returns `SystemPromptState` with `effective: SystemPromptNode | undefined` (the prompt in force) and per-position `nodes`.
- **Consumption note (important):** these are *pure functions supplied through the service seam*, not value-importable modules. `request-inspection.d.ts:63-68` states: *"The `inspectRequestPrompt` signature as a value seam … **Definitions receive it from the uiConversation service because a client bundle cannot value-import another plugin's module**."* The service face is `ctx.uiConversation` (`CONV\lib\types\client\index.d.ts:36`, `conversation/assembly.d.ts`). So the inspector reads prompt state **from `ctx.uiConversation` (or via `useProjection`)**, never by `require`-ing `@deepseek-ai/dsh-client-ui-conversation`.

**IMPLICATION**

- Register both new entries with `kind`-appropriate options, **fresh `id`s**, and an `inject: (sessionId) => ({...})` face if you need per-session data resolved at mount.
- The component signature is `(props) => ReactNode` (`SLOTS\lib\types\index.d.ts:343`: `export type SlotComponent<P> = (props: P) => ReactNode`). Read `props.sessionId`; do not invent a context or a global.
- `children?: never` means **the header gives you nothing but the standard kit** — all persona/prompt data must be fetched over `/api` or pulled from `useProjection`.
- **Build the "what the model sees" inspector on `ConversationPromptSnapshot.system` + `.tools` + `.config` via `ctx.uiConversation`/`useProjection`** rather than re-rendering `dsh-cast`'s own `compose()` output. `compose()` (`index.js:244-262`) shows what dsh-cast *contributed*; the snapshot shows what the model *actually reads*, including harness sections and the shadowing result. Showing `compose()` output as "what the model sees" would be materially misleading.
- The client build must resolve these services through `ctx.inject([...])`/`dsh.client.inject` — see item 8.

---

## 8. Can the client bundle import anything beyond `react`? What does `require()` resolve?

**VERDICT: `require()` resolves a fixed module table, NOT npm `node_modules`. `react` is available. Nothing else is unless it is in the baseline table or explicitly declared in `dsh.client.external`. The `"no dependency"` constraint for the client half is REAL.**

**EVIDENCE**

- The factory receives a `require` whose contract is a **module-table lookup**, not Node resolution — `dsh-client-modules\lib\types\client\manifest.d.ts:169-175`:
  ```ts
  /** Module resolver passed into a registered Client bundle factory. */
  export interface ClientBundleRequire {
      /** Resolve a module-table dependency synchronously. */
      (specifier: string): unknown;
      /** Load and resolve a package-local dynamic chunk asynchronously. */
      async(specifier: string): Promise<unknown>;
  }
  ```
  Note it is `require(specifier)` **plus** `require.async(...)` — a custom function object, not Node's `require`.
- The bundle registration — `manifest.d.ts:176-188`: `{ id, chunk?, factory }`, where `id` is *"Plugin id (package name) — the registration key; **must match the graph row being executed**."* `dsh-cast\client.js:5-7` supplies `id: '@local/dsh-cast'`, matching `package.json` `name` (`dsh-cast\package.json:2`).
- The module system's own doc, `dsh-client-modules\lib\index.js:17-31`, describes the contract: *"every module body … lives inside the factory closure … (factory(require) → exports) happens on first import/require and is memoized in `ClientModuleLoader.loadCache`; a factory that requires another registered-but-unmaterialized module materializes it recursively … registered factory → materialize; **anything else → throw (loud)**."* And `:29-31`: the synchronous `require` *"walks the same order minus …"* the async chunk op.
- **The baseline table is defined by the shell.** `dsh-web-frontend\dist\assets\index-5SrrfWpU.js:126` contains the browser entry's `staticModules` literal (function `rM()`):
  ```js
  { react: Ef, "react/jsx-runtime": If, "react-dom": Rf, "react-dom/client": Df,
    "@deepseek-ai/cordis": sf, "@deepseek-ai/dsh-client-store": lh,
    "@deepseek-ai/dsh-client-ui-slots": hh, "@deepseek-ai/dsh-client-ui-primitives": sE,
    "@deepseek-ai/dsh-client-ui-dockkit": XS }
  ```
  These nine specifiers are the *implicit client baseline*. `react` is among them, so `dsh-cast\client.js:8` (`require('react')`) resolves.
- Everything else must be **declared** — `dsh-package-manifest\lib\types\types.d.ts:83-88`:
  ```ts
  /**
   * Exact module-table requests beyond the implicit client baseline, including
   * subpaths such as `<pkg>/client`; absent means baseline externals only.
   * Type-only imports are erased and create no module request.
   */
  external?: string[];
  ```
  The declared externals become **graph edges with ordering** — `dsh-client-modules\lib\index.js:405-437` (`orderByModuleGraph`), with `:426-429` walking `entry.external` and `:428` throwing when a row requests a module it answers itself. `:400-403` shows only `inject`, `immediately`, `external` survive onto the row.
- **`dsh-cast`'s own declaration** — `dsh-cast\package.json:7-14`:
  ```json
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
  ```
  There is **no `external` field**, and `dsh.client.inject` is documented as **informational** — `dsh-package-manifest\lib\types\types.d.ts:79-80`: *"Informational package-name dependencies, **not** Cordis service injection."* So the two listed UI packages are ordering hints, **not** importable modules.
- `immediately: true` (`package.json:11`) is documented at `types.d.ts:81-82`: *"Boot phase-one registration barrier; absent means the shared application batch."*
- Runtime confirmation of the graph semantics: `dsh-client-modules\lib\index.js:466-468` shows the pre-boot `require` **throws** with `client-modules: … requested external "…" before the module system existed`; `:424` throws on graph cycles because *"factory-form CJS cannot deliver partial exports"*.

**IMPLICATION**

- **`dsh-cast\client.js` may `require('react')` and nothing else today.** Importing `@deepseek-ai/dsh-client-ui-conversation` would throw at materialization.
- **To consume `ConversationPromptSnapshot`/`ctx.uiConversation`, do NOT add an import.** Read them through `ctx.inject(['uiConversation'], …)` / the slot standard kit, exactly as `dsh-client-ui-jobs` does for `ctx.jobs` (`dsh-client-ui-jobs\lib\client.js:596-600` lists `inject = ['jobs','slots','locale']`). Service injection on the client is the sanctioned seam; imports are not.
- If a real module import is ever genuinely required, add the exact specifier to `dsh.client.external` (`package.json:12`) **and** to `dsh.client.inject` ordering. The doc at `types.d.ts:84-86` is explicit that absent `external` means baseline-only. For phase 6 this should **not** be necessary.
- `react-dom` and `react-dom/client` **are** in the baseline despite not appearing in `dsh.client.inject` — so rendering via a portal is technically possible without a declaration. Prefer composing through slots.
- Type-only imports are erased (`types.d.ts:86`) — so the contract `.d.ts` files are safe to reference in comments/typing but produce no module request. **`dsh-cast` client.js is plain JS and imports nothing; keep it that way.**

---

## 9. `registerHttpApi()` and how the client's `api()` maps a path

**VERDICT: pattern REAL and confirmed correct against the route validator. New routes must follow it exactly. The `api('/x')` → `'api/x'` mapping works because the browser resolves it relative to the page URL — it is NOT an absolute path.**

**EVIDENCE — the host helper**

- `dsh-cast\index.js:1511-1526`:
  ```js
  registerHttpApi() {
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
    const readBody = async (request) => {
      try { return await request.json(); } catch { return {}; }
    };
    const route = (path, methods, fetch) => this.ctx.effect(
      () => this.ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }),
      `dsh-cast.http${path}`,
    );
  ```
- `route` args are `(path, methods, fetch)` and it is `ctx.effect`-wrapped, so the route unregisters with the plugin fiber. `requestBody: 'buffered'` is required by the registration type.
- Call sites — `index.js:1528` (`/api/dsh-cast/list`, `['GET']`), `:1530` (`/get`, `['GET']`), `:1536` (`/create`, `['POST']`), `:1546` (`/edit`), `:1556` (`/delete`), `:1566` (`/activate`). Handlers return `Response`; errors use `json({ error }, 400/404)`.
- Query params read via `new URL(request.url).searchParams.get('name')` — `index.js:1531`. **Use this form for new GET routes.**

**EVIDENCE — the route contract (`dsh-client-connection`)**

- `dsh-client-connection\lib\types\rpc.d.ts:110-120`:
  ```ts
  export interface ConnectionFetchRoute {
      /** Absolute path below `/api`; query parameters remain available on the request URL. */
      readonly path: string;
      /** Methods this route owns. Other methods continue through normal shared-channel dispatch. */
      readonly methods: readonly ConnectionFetchMethod[];
      /** Buffered requests obey the configured JSON cap; streaming requests arrive with backpressure and no aggregate cap. */
      readonly requestBody: ConnectionRequestBodyMode;
      /** Handle one request after the physical carrier has applied its trust and authentication policy. */
      readonly fetch: (request: Request) => Promise<Response>;
  }
  ```
- Methods are the closed union `'GET' | 'HEAD' | 'POST'` — `rpc.d.ts:107`. **No `PUT`, `PATCH`, or `DELETE`.**
- `register` returns an **async** disposer — `rpc.d.ts:128`: `register(route: ConnectionFetchRoute): () => Promise<void>;`
- Validation — `dsh-client-connection\lib\index.js:758-762` (`assertFetchRoute`): the path must satisfy `endpointFromPath('/api', route.path) !== undefined`, must declare ≥1 method, and must not repeat a method.
- `endpointFromPath` — `dsh-client-connection\lib\index.js:711-716`:
  ```js
  function endpointFromPath(channel, pathname) {
      if (!pathname.startsWith(`${channel}/`)) return void 0;
      const endpoint = pathname.slice(channel.length + 1);
      if (endpoint.split("/").some((segment) => segment === "" || segment === "." || segment === ".."
          || !ENDPOINT_SEGMENT_PATTERN.test(segment))) return;
      return endpoint;
  }
  ```
  So the path must start with `/api/`, and every segment after it must be non-empty, not `.`/`..`, and match `ENDPOINT_SEGMENT_PATTERN`. `'/api/dsh-cast/list'` → segments `['dsh-cast','list']` → **passes**. (Confirmed by the fact that the route list assertion at `host.test.mjs:89-96` passes and the plugin loads.)
- Dispatch is an **exact `url.pathname` match** — `dsh-client-connection\lib\index.js:611` (`this.fetchRoutes.get(url.pathname)`) and `:615-617`:
  ```js
  const pathname = new URL(request.url).pathname;
  const route = this.fetchRoutes.get(pathname);
  if (route?.methods.has(request.method) === true) return route.fetch(request);
  ```
  **No prefix or parameter matching.** Query strings are not part of `pathname`, so `/api/dsh-cast/get?name=x` matches the route registered for `/api/dsh-cast/get`.
- **Duplicate path throws** — `dsh-client-connection\lib\index.js:633`: `throw new Error(\`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered\`);` Route paths must be globally unique across all plugins. Because the map is keyed by **path only**, two plugins cannot register the same path with different methods.
- Auth/trust is applied by the carrier before the handler — `rpc.d.ts:118`, and the header comment at `:100-102`: *"`peer` is the Peer the request was admitted as: the operator."* This is why `dsh-cast\client.js` needs no credentials in its `fetch`.

**EVIDENCE — the client's `api()` mapping**

- `dsh-cast\client.js:14-20`:
  ```js
  function api(path, options) {
    return fetch('api' + path, options).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
      return data;
    });
  }
  ```
- Call sites pass `'/dsh-cast/list'`, `'/dsh-cast/activate'`, `'/dsh-cast/get?name=…'` etc. (`client.js:30, 34, 84, 93, 109, 122, 131`). So the final URL is the **relative** `'api/dsh-cast/list'`, resolved by the browser against the page URL.
- **The mapping is a relative-URL join, not a string prefix rule.** `'api' + '/dsh-cast/list'` = `'api/dsh-cast/list'` → resolved relative to the current document → `<origin>/<dir>/api/dsh-cast/list`. On the GUI root (`http://127.0.0.1:3080`) this is `/api/dsh-cast/list`, matching the exact-`pathname` lookup. A sub-path page URL would break it — this is an existing latent fragility, not a phase-6 problem, but **new routes must be called the same way** to stay consistent.
- Error contract the client relies on: non-2xx → `{ error: string }` → thrown as `Error(data.error)`. Every handler already complies (`index.js:1533, 1542, 1552, 1562, 1569, 1578`). **New routes must return `json({ error: msg }, 4xx)` on failure**, never a bare status.

**IMPLICATION**

- New routes: `route('/api/dsh-cast/<name>', ['GET'|'POST'], handler)`. Only `GET`/`HEAD`/`POST`. Exact path, globally unique, must start with `/api/`. Use `readBody(request)` for POST and `new URL(request.url).searchParams` for GET.
- Client side: `api('/dsh-cast/<name>')` for GET, and the `{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(...) }` shape already used at `client.js:34-38` for POST. Always surface `data.error`.
- **The `/api/dsh-cast/activate` route currently returns 400 unconditionally under the test mock** (`index.js:1568-1569` + `host.test.mjs:31`). Any new test must supply a mock `agents.get` (item 3) to exercise it.
- Adding routes **breaks the existing test** — see item 12.

---

## 10. The host half must keep ZERO npm dependencies

**VERDICT: REAL — and currently satisfied.** The constraint is real (the bundle is loaded by the DSH loader like any other plugin and resolves `index.js` directly), and `dsh-cast` complies today.

**EVIDENCE**

- `dsh-cast\package.json` (all 15 lines) has **no `dependencies`, no `devDependencies`, no `peerDependencies`.** The only keys are `name`, `version`, `private`, `type`, `exports`, `dsh`.
- Imports are built-ins only — `dsh-cast\index.js:14-17`:
  ```js
  import { watch } from 'node:fs';
  import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
  import { fileURLToPath } from 'node:url';
  import path from 'node:path';
  ```
  All four are `node:`-prefixed built-ins. Grep for third-party imports across `dsh-cast\index.js` returns nothing else.
- The plugin declares its coupling via Cordis service injection rather than imports — `dsh-cast\index.js:457`:
  ```js
  export const inject = ['llm', 'sessions', 'tools', 'systemPrompt', 'commands', 'agents', 'connection'];
  ```
  Every service it uses (`this.ctx.llm`, `ctx.sessions`, `ctx.tools`, `ctx.systemPrompt`, `ctx.commands`, `ctx.agents`, `ctx.connection`) arrives through the context, never an import. The self-documenting comment at `index.js:8-12` states this intent explicitly:
  > *"This bundle intentionally imports only Node built-ins and reads everything else from the Cordis context, so it needs no dependencies and resolves in any profile."*
- The same is true of `dsh-cast\client.js:5-10`: only `require('react')`, which is baseline (item 8) — the client half carries no npm dependency either.
- This matches how the harness itself reasons: `dsh-client-modules\lib\types\client\index.d.ts:147-150` notes a subpath must stay free of `node:` imports to be browser-safe — i.e. module-availability is a real, enforced property, not a convention.

**IMPLICATION**

- **Do not add `dependencies` to `dsh-cast\package.json`, and do not add any import that is not `node:*`.** This is the invariant that keeps the plugin profile-independent.
- Corollary — **any new capability must be reached via `ctx.*` or `node:*`.** Concretely for phase 6:
  - token metering → `ctx.tokenMeter` (add `'tokenMeter'` to the `inject` array, or access it optionally), **not** an import of `@deepseek-ai/dsh-token-meter`;
  - prompt assembly → `ctx.systemPrompt` (already injected), **not** an import of `@deepseek-ai/dsh-system-prompt`;
  - message construction → `createUserMessage` lives in `@deepseek-ai/dsh-llm`. **This is the one real risk in phase 6**: there is currently **no** `llm`-service method that constructs a `UserMessage`. `LLM\types\message.js:53-58` is a module-local function, and `dsh-cast` already uses `this.ctx.llm` (`index.js:1273-1286`) only for `listProviders`/`listModels`/`stream`.
  - **Therefore: build the injected message with a local, dependency-free literal.** `createUserMessage` does nothing but `{ ...input, role: 'user', id: randomUUID(), deepFreeze }` (`LLM\types\message.js:34-39, 53-58`) — and the session's own validation requires only `id` (non-empty string), `role: 'user'`, array `content`, and a `source.kind` non-empty string (item 2). A hand-built object satisfying that shape is **contract-equivalent** and keeps the zero-dependency invariant. Mirror the helper's semantics (fresh UUID via `node:crypto`'s `randomUUID`) rather than importing it. Flag this explicitly in the implementation so the reviewer does not mistake it for a shortcut.
- If importing `@deepseek-ai/dsh-llm` is ever genuinely preferred, it must be declared as a real dependency **and** it inverts the plugin's stated design — that is a captain-level decision, not an implementation detail.

---

## 11. The plugin registers NO `SessionEventMap` types

**VERDICT: REAL. `dsh-cast` cannot append its own event types. Any model-visible content must ride an existing logged channel.**

**EVIDENCE**

- Grep of `dsh-cast\index.js` for `SessionEventMap`, `declare module`, `session.append`, and `inject(` returns **no matches** — the plugin never touches the event map or the session log directly.
- The event vocabulary is a **closed runtime set**. `dsh-session\lib\index.js:120-138` is `KNOWN_SESSION_EVENT_TYPES`, a literal `Set` of ~40 type strings (`"user/message"`, `"system/message"`, `"turn/start"`, `"turn/end"`, `"tool/result"`, `"agent/inbox/spliced"`, …). It is a hard-coded list in shipped JS, not derived from any registry the plugin could extend at runtime.
- `surfaceOpOf` — `dsh-session\lib\index.js:295-303` — enforces membership for surface writes:
  ```js
  if (!isSurfaceEligibleType(event.type)) {
      if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable === true) return;
      if (raw.surfaceOp !== void 0) throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry surfaceOp`);
      if (raw.sourceEventSeqs !== void 0) throw new Error(`session event "${event.type}" is not surface-eligible and cannot carry sourceEventSeqs`);
      return;
  }
  ```
  A type outside the set cannot carry `surfaceOp` — i.e. **cannot be model-visible** — and would have to be marked `ignorable`.
- The TypeScript side is explicitly merge-extensible but the runtime set is not — `dsh-session\lib\types\types.d.ts:250-255` (`interface SessionEventMap`) and `:434-435` (`export type SessionEventType = keyof SessionEventMap`). The in-tree example of a plugin adding a type is `dsh-session-title-llm\lib\types\index.d.ts:35-40`:
  ```ts
  declare module '@deepseek-ai/dsh-session/types' {
      interface SessionEventMap {
          /** Log-only pre-dispatch record of one session-title model request. */
          'session/title-llm-request': SessionTitleLlmRequestEventData;
      }
  }
  ```
  **However** — that type (`session/title-llm-request`) *is* present in `KNOWN_SESSION_EVENT_TYPES` (`dsh-session\lib\index.js:114`), because it ships with the harness. Its `d.ts` augmentation is a **typing** convenience for a type that was already admitted at runtime. A third-party plugin cannot add to that runtime `Set`.
- The **surface-eligible** set is only five types — `dsh-session\lib\index.js:154-160`:
  ```js
  const SURFACE_EVENT_TYPES = new Set(["system/message","developer/message","user/message","assistant/message","tool/result"]);
  ```
  These are the only channels that produce model-visible messages.

**IMPLICATION**

- **The memory workstream must deliver through `user/message`** — i.e. `agent.inject(createUserMessage(...))` (items 1+2). That is the intended path and it is fully supported. There is no separate "memory event".
- Do **not** try to invent an event type, and do not call `session.append` with a novel type — it cannot carry `surfaceOp` and so cannot reach the model (and may be persisted as junk).
- For **non**-model-visible side records (injection attempts, budget decisions, retrieval telemetry), do **not** use the session log at all. Use the plugin's existing file-backed stores, which already follow this shape: `.dsh-cast-memory.json` (`index.js:1626-1628, 1700-1706`), `.dsh-cast-state.json` (`:1622-1624`), `.dsh-cast-ratings.json` (`:1226-1228`), `.dsh-cast-comparisons.json` (`:1320-1322`), `.dsh-cast-groups.json` (`:1342-1344`), `.dsh-cast-history.json` (`:1135-1137`), and the report `.dsh-cast-report.json` (`:1611-1615`).
- All of these live under `personasDir` and are dot-prefixed, which is why `loadUser`'s filter (`index.js:546`: `.endsWith('.json') && !f.startsWith('.')`) keeps them out of the persona set. **Any new side file must be dot-prefixed** or it will be parsed as a persona.
- Note that the plugin already observes real events read-only: `agent/created` (`index.js:671`), `agent/request` (`:682`), `agent/disposed` (`:696`), `agent/turn-stopping` (`:1412`, `:1683`), `tools/pre-execute` (`:1497`). Listening is unrestricted; **writing** is what is closed.

---

## 12. Every exact-count assertion in `test\host.test.mjs`

**VERDICT: REAL — two `deepEqual` assertions will fail the moment routes or tools are added.** Full list of exact-count / exact-list assertions with line numbers:

| Line(s) | Assertion | Exact form | Breaks on new route? | Breaks on new tool? |
|---|---|---|---|---|
| **83** | tool list | `assert.deepEqual(toolNames, ['create_persona', 'list_personas', 'set_persona'], '3 tools registered')` | no | **YES — `deepEqual`, order-insensitive but set-exact** |
| **89-96** | route list | `assert.deepEqual(routes, ['GET /api/dsh-cast/get', 'GET /api/dsh-cast/list', 'POST /api/dsh-cast/activate', 'POST /api/dsh-cast/create', 'POST /api/dsh-cast/delete', 'POST /api/dsh-cast/edit'], '6 HTTP routes registered …')` | **YES — `deepEqual`, set-exact** | no |
| 78 | command count | `assert.equal(reg.commands.length, 1, 'one command registered')` | no | no (new command only) |
| 79 | command name | `assert.equal(reg.commands[0].name, 'persona')` | no | no |
| 72 | built-in count | `assert.ok(service.list().length >= 10, …)` — `>=`, **tolerant** | no | no |
| 100 | listener count | `assert.ok(confirmListeners.length >= 1, …)` — `>=`, **tolerant** | no | no |
| 119 | report persona count | `assert.ok(report && report.personas.length === 10, 'report has all personas')` — **strict `=== 10`** | no | no — **but breaks if a persona is added to `personas/`** |
| 120-121 | identity distinctness | `new Set(report.personas.map(…'deployment:persona-prefix'…)).size === 10` — **strict `10`** | no | no — same caveat as 119 |
| 122-129 | layer name list | `assert.deepEqual(p.layers.map(l => l.name), ['deployment:persona-prefix','dsh-cast:voice','dsh-cast:behavior','dsh-cast:examples'], …)` — **exact layer set per persona** | no | **YES if a new prompt layer is added to `compose()`** |
| 197 | `mx.composition.mixins.length === 0` | strict count | no | no |
| 246 | `packObj.personas.length === 2` | strict count | no | no |
| 254 | `getHistory('versioned').length === 1` | strict count | no | no |
| 275 | `getRatings('terse').length === 2` | strict count | no | no |
| 277 | `fidelity.length === 2` | strict count | no | no |
| 299 | `service.comparisons.length === 1` | strict count | no | no |

Also relevant (not counts, but shape-exact and easy to break): `:83`/`:84-85` `setPersona.parameters.required.includes('persona')`; `:102-105` the confirm listener's `kind` returns.

**The two that matter for phase 6:**
- **`host.test.mjs:89-96`** — adding **any** `/api/dsh-cast/*` route fails this `deepEqual`. Routes planned for phase 6: composed-prompt inspection, memory retrieval, A/B — **each one must be added to this literal array**.
- **`host.test.mjs:83`** — adding **any** tool breaks it. (The task does not currently require new tools, but a memory-retrieval tool would.)
- **`host.test.mjs:122-129`** — adding a new prompt layer to `compose()` (e.g. a re-ranked memory layer beyond `dsh-cast:memory`, or a new budget section) breaks the per-persona layer list. If phase 6 changes the layer set, this literal must be updated too.

**IMPLICATION**

- **Update the assertions in the same change as the code.** Do not delete them — they are the only guard on the public registration surface. Extend the literals to the new full set.
- Adding an assertion is cheap; a failing suite at hand-off is not. Recommended order: implement route → update `:89-96` → re-run → then the next route.
- `mockCtx` also needs the item-3 `agents` upgrade **before** the new `/api/dsh-cast/*` route tests can assert anything meaningful, because the mock currently makes `agents.get` always `undefined`.
- Note `assert.deepEqual` from `node:assert/strict` (`host.test.mjs:8`) is order-sensitive for arrays — the existing code sorts both (`:82` `toolNames.sort()`, `:88` `routes.sort()`), so keep the sorted-literal convention or the comparison order will surprise you.

---

## 13. Persona name → file path: path-traversal exposure

**VERDICT: REAL and confirmed.** `_writePersonaFile` interpolates an unsanitized persona name into a filename. Two callers. It is reachable from both the HTTP API and the `/persona` command.

**EVIDENCE — the defect**

- `dsh-cast\index.js:576-579`:
  ```js
  async _writePersonaFile(p) {
    await mkdir(this.personasDir, { recursive: true });
    await writeFile(path.join(this.personasDir, `${p.name}.json`), JSON.stringify(p, null, 2), 'utf8');
  }
  ```
  `p.name` is interpolated with **no sanitization** — no whitelist, no `path.basename`, no rejection of `/`, `\`, `..`, or a drive/UNC prefix.
- **The only guard on a name is truthiness / a literal sentinel** — `normalize` at `index.js:442-455`:
  ```js
  name: String(p.name ?? 'unnamed'),
  ```
  That is the *entire* normalization. `save()`'s check at `index.js:565` is only `if (!p.name || p.name === 'unnamed') throw new Error('persona requires a "name"')`.
- **`path.join` does not neutralize traversal.** `path.join(base, '../../x.json')` resolves upward out of `base`. Confirmed by use: `index.js:584` (`remove`) uses the same `path.join(this.personasDir, \`${name}.json\`)` pattern with a raw `name`, and `personasDir` is itself resolved at `index.js:468-470`.
- Note the write *target* is always `<name>.json`. So escaping requires the name to contain a separator (or `..` segments); a name like `../../evil` yields `<base>/../../evil.json` — an arbitrary-path write of attacker-influenced JSON.

**EVIDENCE — callers (exactly two, as required)**

`grep _writePersonaFile` over `dsh-cast\index.js` → 3 matches, one of which is the definition:

1. **`index.js:571`** — inside `save(persona)` (`index.js:561-574`):
   ```js
   async save(persona) {
     return this._serialize(async () => {
       if (!this.personasDir) throw new Error('personasDir is not configured');
       const p = normalize(persona);
       if (!p.name || p.name === 'unnamed') throw new Error('persona requires a "name"');
       const existing = this.get(p.name);
       ...
       await this._writePersonaFile(p);
       await this.loadUser();
     });
   }
   ```
2. **`index.js:1165`** — inside `rollback(name, index)` (`index.js:1160-1169`):
   ```js
   await this._writePersonaFile(snap.persona);
   ```
   Here the name comes from a **snapshot** previously captured into `this.history`, i.e. transitively from an earlier `save`.

**EVIDENCE — reachability (the important part)**

`save()` is reached from:
- **HTTP `POST /api/dsh-cast/create`** → `index.js:1536-1544` → `createPersona(name, …)` (`:1539`) → `save` (`:1024`). `name` is `String(body.name ?? '').trim()` — **no sanitization, and the route takes a JSON body from the authenticated `/api` channel.**
- **HTTP `POST /api/dsh-cast/edit`** → `index.js:1546-1554` → `editPersona` → `save`. Note `editPersona` forces `name: existing.name` (`index.js:1045`), so edit cannot *introduce* a traversal name, but it will faithfully re-save an existing one.
- **`/persona create <name>` command** → `index.js:713-714` → `createCommand` → `createPersona` → `save`. Command input is user text.
- **`/persona import <json>`** → `index.js:733-734` → `importCommand` → `importPersona` (`:1056-1069`) → `save`. **`importPersona` explicitly only rejects `'unnamed'`** (`:1066`) — it does not reject separators.
- **`/persona pack import <json>`** → `:837` → `importPack` (`:1208-1219`), which `continue`s only on empty/`'unnamed'` names (`:1214`).
- **`/persona mix <a> <b> [name]`** → `:983-993` → `mixPersona(a, b, { name })` → `save`. **The optional third argument flows straight into `merged.name`** (`index.js:1089`: `name: options.name ?? \`${a.name}-${b.name}\``).
- **/persona tune / naturalEdit** → `:995` → `naturalEdit` → `save` (`:1130`) — name is pre-existing, not attacker-controlled.
- **The `create_persona` tool** → `index.js:1467-1492` → `createPersona(name, …)` where `name = String(args?.name ?? '').trim()` (`:1488`) — **model-supplied, unsanitized.** This is the most interesting vector: the *model* can be induced to write outside `personasDir`.

The read-side has the same shape and is likewise unsanitized: `remove(name)` at `index.js:581-587` (`unlink(path.join(this.personasDir, \`${name}.json\`))`) and `_historyPath()`/`_ratingsPath()`/etc. are fixed-name and safe.

**IMPLICATION**

- **This is pre-existing, not introduced by phase 6 — but phase 6 makes it strictly worse**, because the new UI workstream adds one-click persona creation/editing from the browser and a memory workstream adds new persona-adjacent write paths. A UI that exposes `create` turns a command-line-only quirk into a clickable arbitrary-file-write.
- **Minimum fix, one place:** sanitize inside `_writePersonaFile` (and `remove`) so **both** callers are covered — e.g. reject any name containing `/`, `\`, a NUL, or equal to `'.'`/`'..'`, and/or assert `path.resolve(dir, name + '.json')` still starts with `path.resolve(dir) + path.sep`. Defense at the sink is required because `create_persona`, `import`, `pack import`, `mix`, `/persona create`, and both HTTP routes all reach it.
- Prefer a **whitelist** (e.g. `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) applied in `normalize` (`index.js:442-455`) **as well as** the sink check — `normalize` is the single funnel every persona object passes through (`save`, `createPersona`, `editPersona`, `importPersona`, `importPack`, `loadUser`, `loadBuiltins`, `markdownToPersona`, `characterCardToPersona`).
- Keep the existing `'.'`-prefix rule in mind: side files are dot-prefixed and `loadUser` skips them (`index.js:546`). A whitelist that permits a leading `.` would let a persona shadow or clobber `.dsh-cast-memory.json`. **Disallow a leading dot.**
- **Scope note for the implementer:** this is a security fix, so it must not be silently bundled into a feature change. Report it, fix it at the sink, and add a negative test (traversal name rejected by `save`) even though it is not in the phase-6 feature list.

---

## Summary — what the implementers can build against, and what they must not

**Green-lit (verified real)**
1. `agent.inject(UserMessage)` — durable, non-waking, next-step delivery; discarded on cancel/dispose. **The** memory delivery path.
2. `createUserMessage` shape + **unknown `source.kind` is accepted at create / append / replay**. `dsh-cast` may own `{ kind: 'dsh-cast', form: 'recall' }`.
3. The session-header slots exist exactly as needed: `conversation.session.header.actions` and `.utilities`, both `list`/`session`, both taking `ConversationHeaderActionOwnerProps` (`children?: never`), with `sessionId` delivered as a standard prop.
4. `getSectionOrder`/`getContextOrder` + the real numeric table (item 5); `order` must be finite or `section()` throws.
5. The client `slots.inject` → `slots.register({name,id,order,label,inject?}, Component)` pattern, confirmed against two in-tree registrations.
6. `ctx.systemPrompt.assemble({ agent, scope: agent })` for the true composed prompt, and `ConversationPromptSnapshot.system|tools|config` via `ctx.uiConversation`/`useProjection` for the client inspector.
7. `registerHttpApi`'s `route(path, methods, fetch)` + `json`/`readBody`, validated against `assertFetchRoute`/`endpointFromPath`/exact-pathname dispatch.

**Red-lined (do not attempt)**
- Do **not** add npm dependencies or non-`node:*` host imports (item 10). Build the `UserMessage` locally rather than importing `@deepseek-ai/dsh-llm`.
- Do **not** add `SessionEventMap` types or call `session.append` with a novel type (item 11). Side records go in dot-prefixed JSON files under `personasDir`.
- Do **not** `require` anything but `react` in `client.js` (item 8). Use `ctx.inject([...])` for client services.
- Do **not** use `PUT`/`PATCH`/`DELETE`, prefix-matching paths, or a duplicate route path (item 9).
- Do **not** assume `inject()` delivered anything (item 1) — no ack, and it can be silently discarded.
- Do **not** forget `host.test.mjs:83` and `:89-96` (and `:122-129` if `compose()` gains a layer) — they will fail on any tool/route/layer addition (item 12).

**Carry-forward defects found during recon (not phase-6 features)**
- **Path traversal** in `_writePersonaFile` (`index.js:576-579`) and `remove` (`:584`), reachable from HTTP, commands and the `create_persona` tool (item 13). Sink-level sanitization required.
- **`/api/dsh-cast/activate` is untested and always 400s under the current mock** (`index.js:1568-1569`, `host.test.mjs:31`) — needs the mock upgrade (item 3).
- **`estimateTokens`/`tokensToChars` (`index.js:430-440`, `:34`) are home-grown `chars/4` and disagree with the harness heuristic** (`TM\types\estimate.d.ts`). Fine for a soft cap, wrong to present as a real token count (item 4).
- **The client's `api()` relative join (`'api' + path`)** depends on the document at the origin root (item 9). Consistent, but fragile.

---
---

# Addendum (captain-requested)

**Added after the sections above were already being built against. Additive only — no existing section was rewritten.**
This addendum carries two corrections from the captain. Both are authoritative contract content, not commentary.

> **Line-number caveat, read first.** The citations in sections 1–13 were captured when `dsh-cast\index.js` was **1784** lines. It is now **1888** lines and `test\host.test.mjs` is now **448** lines (was 321) — both files are being edited by `memory-engineer` and `ui-engineer` right now. Any `index.js` / `host.test.mjs` line number below **520** may therefore have drifted. **Anchor on the quoted code and the symbol name, not on the bare number.** Where I re-verified a location at addendum time, I give both the new and old numbers.

---

## A1. Correction to item 3 — the `/activate` gap is a CURRENT DEFECT, not a test-harness limitation

**Captain's correction, restated as contract:** `/api/dsh-cast/activate` retains the defect where **the HTTP activation path — the new UI picker's core action — has never been proven to work.** This is a correctness gap in shipped code. The mock upgrade must therefore make the **real handler execute its real success path**, not merely stop returning 400.

**VERDICT: REAL, and confirmed still present at addendum time.**

**EVIDENCE (re-verified now, not carried over)**

- The handler is unchanged in contract — `dsh-cast\index.js:1633-1647`:
  ```js
  route('/api/dsh-cast/activate', ['POST'], async (request) => {
    const body = await readBody(request);
    const agent = this.ctx.agents?.get(body.sessionId);
    if (!agent) return json({ error: 'no agent for sessionId' }, 400);
    try {
      if (body.name === 'off') {
        this.deactivate(agent);
        return json({ active: null });
      }
      this.activate(agent, String(body.name ?? ''));
      return json({ active: String(body.name ?? '') });
    } catch (err) {
      return json({ error: err.message }, 400);
    }
  });
  ```
  (Item 3 cited this as `index.js:1566-1580`; it now sits at `:1633-1647`. The `agents?.get` guard, which is the always-400 trigger, is at `:1635-1636`.)
- The mock is **still** the undefined stub — `dsh-cast\test\host.test.mjs:31`, unchanged:
  ```js
  agents: { get() { return undefined; }, currentInitiator() { return undefined; } },
  ```
  With `get()` → `undefined`, `:1636` fires on every call. **The success branch (`:1638-1643`) and the catch branch (`:1644-1646`) are both dead code under test today.**
- **The gap survived the UI workstream's arrival.** `ui-engineer` has added `/preview` and `/compare` and a `callRoute` helper, yet `host.test.mjs:321-322` states verbatim:
  ```
  // (A1's persona picker deliberately reuses the already-registered
  //  POST /api/dsh-cast/activate — no new route, nothing new to assert here.)
  ```
  So the *core action of the persona picker* is explicitly deferred as "nothing new to assert" while the two read-mostly routes are covered. The picker can therefore ship green with its primary button unproven. This is exactly the gap the captain flagged.

**What the handler's success path actually exercises (why it must be real, not stubbed).** Walking `activate()` on the success branch touches four real behaviours that no other test covers end-to-end:
1. `this.activate(agent, name)` → `get(name)` persona lookup, then `compose(...)` (`index.js:244-262`) → the layered prompt.
2. `agent.ctx.effect(() => agent.ctx.systemPrompt.section({...}))` — per-layer registration on the **agent-scoped** context (`index.js:631-641`), including the `deployment:persona-prefix` shadow.
3. `this.activations.set(agent.id, …)` — the per-session activation registry (`index.js:642`), i.e. the state every later read (`active()`, `list_personas`, `/preview`) depends on.
4. `deactivate(agent)` on `name === 'off'` → disposer invocation + registry delete (`index.js:646-651`), returning `{ active: null }`.

A mock that only stops 400ing proves none of these; it must let them actually run.

### A1.1 Exactly what the upgraded mock must expose

**Change 1 — `makeMockCtx()` at `host.test.mjs:11-42`: replace line 31.**
```js
// was: agents: { get() { return undefined; }, currentInitiator() { return undefined; } },
const agentsById = new Map();
agents: {
  get(id) { return agentsById.get(id); },          // real Agent or undefined
  currentInitiator() { return currentInitiatorAgent; },
  _registry: agentsById,                            // test-only handle
},
```
Requirements this must satisfy:
- **Keyed by session id.** `get(id)` is called with `body.sessionId` (`index.js:1635`) and with `agent.id` from `reload()` (`index.js:610`). A `Map` keeps one id resolvable and every other id `undefined` — **which preserves the 400 path as a deliberately testable case.** Do not make `get` return a mock unconditionally; that would delete the negative test.
- **`undefined` for an unknown id must remain reachable**, so `json({ error: 'no agent for sessionId' }, 400)` stays asserted.
- Return the **agent object itself** from `get` (production contract: `dsh-agent\lib\index.js:594-596` → `this.store.get(id)?.agent`).

**Change 2 — `mockAgent(id)` at `host.test.mjs:44-55`: add `inject` and `session`.**
Current shape has only `id` and `ctx.{effect, systemPrompt.section}`. It must additionally expose:
```js
inject(message) { injected.push({ agentId: id, message }); },   // records; does NOT deliver
session: { id },
```
- **`inject` must RECORD, not act.** A unit test cannot reproduce item 1's step-boundary timing (that caveat stands). Recording is what makes the *budget* verifiable — assert on `injected[i].message`.
- Because `mockAgent` is currently passed **directly** to `activateGroup` / `handoff` (`host.test.mjs:309`, `:314`), adding fields is safe and additive; but for the `/activate` route the agent must also be reachable via `agents.get(sessionId)`, i.e. registered in the map from Change 1. **Register the same object in both places** so a test can assert through either path.
- `agent.ctx.effect` and `agent.ctx.systemPrompt.section` already exist and return no-op disposers (`:47-53`) — `activate()`'s per-layer registration works unchanged. Do not remove them.

**Change 3 — assert the success path, using the `callRoute` helper that already exists.** `ui-engineer`'s helper (`host.test.mjs:323-332`) dispatches by exact path + method and builds a real `Request`, so no new harness is needed:
```js
const mockA = mockAgent('session-activate');
agentsById.set('session-activate', mockA);                     // enable the success path
const ok = await callRoute('POST', '/api/dsh-cast/activate',
  { body: { sessionId: 'session-activate', name: 'terse' } });
assert.equal(ok.status, 200, 'activate succeeds for a live agent');        // was unreachable
const okBody = await ok.json();
assert.equal(okBody.active, 'terse', 'activate reports the active persona'); // index.js:1643
assert.equal(service.active(mockA), 'terse', 'activate registered the persona'); // index.js:642
```
Required assertions, one per behaviour listed above:
1. **Success** → `status 200`, body `{ active: 'terse' }`, `service.active(mockAgent) === 'terse'`.
2. **The layer-disposer path actually ran** → capture the disposers returned by `mockAgent.ctx.systemPrompt.section` and assert **five** were registered for a persona with state+examples (matching `compose()`'s layer set; count depends on which layers are non-empty — assert `>= 3` and that `deployment:persona-prefix` is among the names, mirroring how `:339-342` asserts the preview layers). This is what proves the shadowing registration executed.
3. **`off` branch** → `callRoute('POST', '/api/dsh-cast/activate', { body: { sessionId: 'session-activate', name: 'off' } })` → `status 200`, body `{ active: null }`, `service.active(mockAgent) === null`. **This branch is also currently dead.**
4. **Unknown session still 400s** → `{ sessionId: 'no-such-session', name: 'terse' }` → `status 400`, body `{ error: 'no agent for sessionId' }`. Keep this: it is the guard `:1636`, and it is the only current behaviour that exists.
5. **Bad persona name 400s via the catch** → `{ sessionId: 'session-activate', name: 'no-such-persona' }` → `status 400` with the `no persona named "…"` message from `activate()` (`index.js:628`). This proves the `:1644-1646` catch, which is also dead today.

**IMPLICATION.** The mock upgrade is now a **correctness fix with its own acceptance criteria**, not test scaffolding. An implementation that only removes the 400 without asserting 1–5 above has not fixed the reported defect. When this lands, update the `host.test.mjs:321-322` comment — it currently asserts the opposite of the truth.

---

## A2. Correction to item 4 — which estimator B3 must use, stated plainly

**Captain's correction, restated as contract:** item 4's original "fine for a soft cap, wrong to present as a real token count" **understates the risk**. `memory-engineer` is building a **token budget** on these functions. If the measurement is wrong, the budget is wrong, and the acceptance criterion *"oversized memory trims to the budget"* would **pass against a false number**.

**VERDICT: REAL. Item 4's original IMPLICATION is hereby amended — treat the estimator as the budget's measurement basis, not as a cosmetic labelling concern.**

**Why the two disagree — the exact deltas (both are `chars/4` at the core, so the divergence is in overhead and framing, not density).**

- `dsh-cast`'s current estimator — `dsh-cast\index.js:440` (`estimateTokens(messages)`) plus `tokensToChars` at `:44`:
  - `tokensToChars(tokens) = Math.max(16, Math.floor(Number(tokens) * 4))` — a **chars-per-token constant of 4 used as a char CAP**, and it silently **floors at 16 chars**.
  - `estimateTokens` sums string lengths (or `block.text.length`) and returns `Math.ceil(chars / 4)` — **no role overhead, no per-block overhead, and it ignores text in any block lacking a `.text` string** (`:436-438` only counts `typeof b.text === 'string'`).
- The harness estimator — `dsh-token-meter\lib\types\estimate.js`:
  - `CHARS_PER_TOKEN = 4` (`:9`), `BLOCK_OVERHEAD = 4` (`:11`), `ROLE_OVERHEAD = 4` (`:13`).
  - `estimateContent(blocks)` (`:34-55`): text → `ceil(len/4) + 4` **per block**; tool-call blocks priced on `name` + `arguments`; unknown/merge-extended blocks (incl. images) priced from `JSON.stringify`. So **every block costs +4**, and non-text blocks are counted rather than dropped.
  - `estimateMessage(message)` (`:79-83`): `estimateContent(content) + ROLE_OVERHEAD` — **every message costs a further +4**.
  - `estimateSystemMessage` (`:64-72`): `ceil(chars/4) + ROLE_OVERHEAD`, and explicitly **no per-block overhead** (the prompt is serialized as a plain string).
  - `estimateToolsTokens(header)` (`:90-94`), `estimateStructuralBlock(block)` (`:22-28`), and `ROLE_OVERHEAD` are all exported for direct use.
- **Consequence in numbers.** For one single-text-block user message of N chars: dsh-cast returns `ceil(N/4)`; the harness returns `ceil(N/4) + 8`. The harness is **always ≥** dsh-cast for message-shaped input, so **a budget measured with dsh-cast's number will overshoot the real harness-measured size by `4 × (blocks + messages)`** — and for multi-block memory the gap grows linearly. A trim-to-budget test written against dsh-cast's estimator would pass while the delivered payload is over budget by the exact overhead it never counted.

### A2.1 What B3 must call — concretely, with file:line

**Use the harness heuristic. Do not use `estimateTokens` / `tokensToChars` as the budget's measurement basis.**

| Need | Call this | Definition |
|---|---|---|
| Price one candidate memory message (the primary need) | `estimateMessage(message)` | `dsh-token-meter\lib\types\estimate.js:79-83`; declared `dsh-token-meter\lib\types\estimate.d.ts:42` |
| Price content blocks you hold before building a message | `estimateContent(blocks)` | `estimate.js:34-55`; declared `estimate.d.ts:26` |
| Price one block in isolation | `estimateStructuralBlock(block)` | `estimate.js:22-28`; declared `estimate.d.ts:20` |
| Price a rendered system prompt | `estimateSystemMessage(message)` | `estimate.js:64-72`; declared `estimate.d.ts:35` |
| Price the tool-schema envelope | `estimateToolsTokens(header)` | `estimate.js:90-94`; declared `estimate.d.ts:49` |
| Role framing constant, if you budget arithmetic yourself | `ROLE_OVERHEAD` (= 4) | `estimate.js:13`; declared `estimate.d.ts:11` |

**How to reach these under the zero-dependency rule (item 10) — this is the binding constraint, so read carefully.**

- The **instance** face is already on the injected context and is the correct answer: `this.ctx.tokenMeter.estimateMessage(message)` — declared `dsh-token-meter\lib\types\index.d.ts:57` (*"instance face of the pure `estimateMessage` export from `estimate.ts`"*), service declared at `index.d.ts:14-18`.
- **`'tokenMeter'` is NOT in `dsh-cast`'s inject list** (`index.js:457`: `export const inject = ['llm', 'sessions', 'tools', 'systemPrompt', 'commands', 'agents', 'connection']`). Either **add `'tokenMeter'`** to that array, or access it optionally as `this.ctx.tokenMeter?.estimateMessage(...)`. **Prefer adding it** for a budget calculation: under item 10's no-import rule the service is the *only* sanctioned route to the harness heuristic — importing `@deepseek-ai/dsh-token-meter` directly would break the zero-dependency invariant that item 10 establishes as REAL. (Note the existing code already uses the optional-access idiom for `agents`: `this.ctx.agents?.get(...)` at `index.js:610`, `:1635`.)
- **If `tokenMeter` is absent**, do **not** silently fall back to `estimateTokens`. Either omit the memory layer, or use a local fallback that **mirrors the harness formula exactly** (`ceil(len/4) + 4` per block, `+ 4` role overhead) so the number keeps the same meaning. Silent-substitution-with-a-different-metric is precisely the failure the captain identified.
- For the **authoritative, post-hoc** number (what the harness itself believes the surface costs), use `ctx.tokenMeter.measure(session).surfaceTokens` / `.nodes` (`dsh-token-meter\lib\types\index.d.ts:46`, `types.d.ts:24-55`), or the `contextBreakdown` session projection `{ systemTokens, toolsTokens, messageTokens }` (`dsh-token-meter\lib\types\breakdown-projection.d.ts:8-25`) — **that** is the right source for any UI-visible token readout, per item 4. The two must not disagree in the UI.

**What to do about the existing functions (do not delete them blindly).**
- `budget(text, tokens)` (`index.js:46-47`) and `tokensToChars` (`:44`) operate on **raw text**, not messages, and they are used by `compose()` to cap each prompt layer (`:259-269`). The harness has **no** direct "cap this string to N tokens" primitive, so a string-level cap must remain local.
- But if that cap is to be **consistent with the budget**, its conversion must use the same density and overhead convention as the estimator. At minimum: **do not leave a second, differently-derived token number in the codebase.** Either (a) derive the char cap from the harness formula (noting `estimateSystemMessage` charges no per-block overhead, so for a text-only layer `ceil(chars/4) + 4` is the matching inverse), or (b) document in code that the layer cap is an approximation deliberately chosen for text and is *not* the budget's measurement basis.
- **The `Math.max(16, …)` floor at `index.js:44` is a latent trap for B3:** a budget below 4 tokens silently becomes 16 chars. If a test asserts "a 1-token budget trims to ≤1 token", it will fail or, worse, pass against the floor. State the floor explicitly in the budget's contract, or remove it.
- **`estimateTokens`'s block filter is a second latent trap** (`:436`: `if (b && typeof b.text === 'string')`): a memory message carrying a non-text block contributes **0**, so an oversized non-text payload would be judged free. `estimateContent` handles this correctly (`estimate.js:47-52` prices unknown blocks structurally). This is a concrete way the current acceptance criterion could pass falsely — worth a direct test.

**IMPLICATION for the acceptance criterion.** "Oversized memory trims to the budget" must be asserted **against the harness-measured number**, e.g. `assert.ok(ctx.tokenMeter.estimateMessage(injected.message) <= budget)` on what was actually handed to `inject` — **not** against `estimateTokens(...)`. The test must assert the number the harness would charge, or the criterion is not measuring what it claims. Recommend the mock also expose a `tokenMeter` stub carrying the real `estimateMessage` formula so this assertion is available in the unit test.

**Cross-reference.** This supersedes only item 4's IMPLICATION wording and the matching "Carry-forward defects" bullet. The *facts* recorded in item 4 (the API surface, where the assembled prompt size is observable, the `'tokenMeter'`-not-injected observation) remain correct and unchanged.

---

## A3. Status of the two carve-outs (captain's routing decision, recorded for the implementers)

- **Item 13 (path traversal) is HELD OUT of the running team.** It will be fixed in a dedicated follow-up pass after `t6` lands, with item 13 read as the spec. Reason: it edits `index.js` and `test\host.test.mjs`, which `memory-engineer` and `ui-engineer` are actively writing; two more concurrent writers would risk the clobbering that `t6` exists to detect. **Implementers: do not fix it opportunistically inside phase-6 feature work.** Item 13 stands as written and is sufficient as a spec.
- **Item 3 (mock upgrade) IS routed into the team**, with the A1 correction above binding: it is a correctness fix, and the `/activate` success path must actually execute.
- **Nothing in this addendum changes items 1, 2, 5–12.** Item 2's verdict (unknown `source.kind` accepted at all three layers) is unaffected, as is every green-lit/red-lined entry in the Summary.
