# dsh-cast — Phase 0 Feasibility Memo

**Status:** G0 PASSED. The prompt-injection hook exists at exactly the granularity needed, and a spike proved a static fragment reaches the model.

**Pinned version:** DSH `0.2.0-rc.2` (read from the installed checkout's `package.json`). All findings below are against this version.

---

## 1. Verdict

GO. Phases 1–2 do **not** need to change shape on account of the hook. The architecture the plan assumed is available, with two corrections:

1. **There is no `dsh-soul` / `dsh-ai-soul` in this DSH version.** The "soul" (core-identity) mechanism is the **`deployment:persona-prefix` / `deployment:persona-suffix`** prompt sections owned by `@deepseek-ai/dsh-system-prompt`, plus the **`@deepseek-ai/dsh-persona`** composable row that shadows them per-agent from a preset.
2. **`requireToolConfirmation` does not exist** (that was a dsh-soul concept). The equivalent is a `ctx.tools.guard()` / the `tools/pre-execute` waterfall.

`@deepseek-ai/dsh-persona` is **not** a runtime persona engine: it is a *static, config-driven, per-agent preset row* (a fixed `prefix`/`suffix` string, optional `complete`, optional runtime-context suppression). It has no switching, no trait model, no UI, no memory, no state. **dsh-cast is a distinct, richer engine** that can interoperate with it by shadowing the same section names.

---

## 2. The prompt hook (Open Question 1) — RESOLVED

This is the plan's **preference order #1** (a first-class prompt-assembly registry + a waterfall event over it). Both exist.

### 2.1 `ctx.systemPrompt` service

- `section(section: PromptSection): () => void` — register an ordered prompt section in the calling context's scope.
- `context(context: PromptContext): () => void` — ordered dynamic runtime context.
- `variable(name, provider): () => void` — `{{var}}` interpolation values.
- `tools(provider): () => void` — tool-schema provider for the assembled tool list.
- `getSectionOrder(name)` / `getContextOrder(name)` — resolve centrally owned placement.
- `assemble(context = {}): Promise<PromptAssembly>` — the assembly entry point run **before each model step**.

```ts
interface PromptSection { name: string; order: number;
  text: string | ((ctx: AssembleContext) => string);
  interpolate?: boolean; complete?: boolean }
interface PromptAssembly { sections: AssembledSection[]; contexts: AssembledContext[];
  tools: ToolSchema[]; variables: Record<string, string | undefined> }
```

### 2.2 Events

- **`system-prompt/assemble`** — `waterfall`, scope-filtered. `(assembly, context, next) => Promise<PromptAssembly>`. The returned assembly is authoritative. A `complete` section is re-imposed after the waterfall, so listeners cannot override it.
- **`system-prompt/change`** — `emit`, fires on any registration change.
- **`agent/request`** — `waterfall`. Replaces the frozen `LlmCallConfig` before each request.
- **`llm/stream`** — `waterfall` around every streaming model call; sees the final `GenerateOptions`.

### 2.3 Ordering (the composition order the plan wants already exists)

`SECTION_ORDERS` (from `dsh-system-prompt/lib/index.js`):

| Order | Name | Meaning |
|---|---|---|
| -1000 | `HARNESS_IDENTITY` | "You are an AI agent powered by DeepSeek Harness." |
| **0** | `DEPLOYMENT_PERSONA_PREFIX` | the deployment/agent persona ("soul" slot) |
| 500 | `PLAN_POLICY` | plan-mode policy |
| 600 | `TEAM_POLICY` | team policy |
| 800 | `PTC_ONLY` | PTC-only section |
| 900 | `FILE_REFERENCE` | file-reference guidance |
| 1000–2900 | `TOOL_*` | per-tool guidance |
| 3100 | `MCP_SERVERS` | MCP servers |
| 5000 | `TOOLS_SDK` | SDK tools |
| 9000 | `DELIVERABLE_FILE_REFERENCES` | deliverables |
| 9900 | `STRUCTURED_OUTPUT` | structured output |
| 10000 | `HARNESS_SOURCE` | harness source guidance |
| 10100 | `WEB_SURFACE` | web-surface guidance |
| **10200** | `DEPLOYMENT_PERSONA_SUFFIX` | persona suffix ("soul" tail) |

`CONTEXT_ORDERS`: `SANDBOX_POLICY` 110, `APPROVAL_POLICY` 115, `SUBAGENT_DELEGATION` 120.

Sections render in `order` ascending (tie → name), joined by `\n\n`, empty sections dropped. A `complete: true` section suppresses every other section and becomes the sole prompt.

### 2.4 Per-session activation point — RESOLVED

The `Agent` interface exposes **`readonly ctx: Context`** — "Agent-scoped context; its contributions are agent-local, unwind on disposal." To scope a persona to one agent, register through `agent.ctx`:

```js
agent.ctx.effect(() =>
  agent.ctx.systemPrompt.section({ name, order, text }), 'dsh-cast.persona.identity');
```

This is the same mechanism `dsh-persona` uses (its row is scope-only; mounting it unscoped collides with the global `deployment:persona-prefix` and "fails loud"). Agents are reachable via `ctx.agents.get(sessionId)` or the `agent/created` serial event.

---

## 3. Host/client communication (Open Question 2) — RESOLVED

**Remote controller.** The mechanism is DSH's typed Remote layer:

- Host service methods annotated **`@Remote`** (or `@Remote('name')`) generate a client-facing `ctx.remote.<namespace>` surface. Example from the registry: `ctx.remote.credentials`, `ctx.remote.workspace`, `ctx.remote.directoryPicker`.
- **`ctx.connection.rpc`** (`HostConnectionRpc`) is the transport-independent host side.
- **`typertGateway`** (`invoke`/`stream`) resolves and carries remote invocations.
- **`clientModules`** service drives the web plugin table: incremental `dsh.client` scan → wire composition → bundle route → index injection.

Client half shape (from the skill's `references/ui-plugin.md` + `templates/decoration`):
- `package.json` adds `dsh.client: { platform: 'web', immediately, inject: [...] }` and a `./client` export.
- `client.js` registers `window.__ModuleLoader__.load({ id, factory(require) {...} })`, gets React from the browser module table, and returns `{ inject: ['slots'], apply(ctx) {...} }`.
- UI is composed by registering into **slots** (`ctx.slots.inject` / `ctx.slots.register`); a panel uses slots under the settings/right-sidebar surfaces.

So the dsh-cast host half exposes `@Remote` methods (list/CRUD/active-persona/test-stream/memory), and the client half calls them through the generated remote namespace and renders into slots. **Prompt composition, memory retrieval, LLM injection, and storage stay host-only** — exactly the plan's contract table.

---

## 4. Storage (Open Question 3) — RESOLVED

DSH has a first-class durable storage facility. **Use `ctx.storageDomain`** for state and memory; **use files (`ctx.fs`)** for persona definitions (matches the plan's layout and keeps personas shareable/git-able).

- `ctx.storageDomain.open(spec): Promise<Domain<S>>` — `DomainSpec { name, version, tables, global?, layout? }`, tables are zod-validated.
- `Domain` → `global` (singleton) + `table(name): KvTable` with `get/put/delete/update/entries/keys`.
- Backed by `ctx.storage` hub (backends mounted; `dsh-storage-json` is the JSON backend). Emits `domain/changed`.
- Persona files: `ctx.fs` (abstract FS service: `resolve`, `readText`, `writeText`, `editText`, `listDir`, `watch`) writes to a `personas/` directory under the plugin's data root.

This directly supports Phase 3's scoped memory: a `dsh-cast-memory` domain with tables keyed by `<persona>:<scope>` enforces isolation at the key level, plus an explicit guard.

---

## 5. Remaining open questions — RESOLVED

- **Q4 — reversible scoped listeners as effects?** Yes. Every registration returns a disposer; `ctx.effect(setup, label)` owns it for fiber-scoped teardown; `ctx.on(...)` auto-manages listeners. Verified: `dsh-persona` registers sections with `ctx.effect(() => ctx.systemPrompt.section({...}), 'persona.section()')` and returns nothing from `apply`. Deactivating a persona = disposing its effect → sections removed → `system-prompt/change` emitted.
- **Q5 — token budget location?** There is **no single global system-prompt budget**. The budget is per-contributor: `dsh-agent-instructions` owns its own `maxBytes` and truncates. `ctx.tokenMeter.estimateMessage` is available for measurement. **dsh-cast must own its per-layer budget** and truncate/retrieve accordingly.
- **Q6 — per-request LLM overrides?** `agent/request` waterfall replaces `LlmCallConfig { provider, model, reasoningEffort, temperature, maxTokens, stop }`. **`top_p` and `penalties` are NOT exposed** — drop them from the persona "Parameters" field group. `temperature`, `maxTokens`, `stop` are supported.

---

## 6. Chosen hook point (decision)

- **Prompt fragments:** `ctx.systemPrompt.section()` registered **through `agent.ctx`** (per-session scope), one named section per persona layer, at computed orders. "Persona identity" shadows `deployment:persona-prefix` (order 0) via the shared section name; voice/behavior/social/cognitive layers use their own `dsh-cast:*` names at orders between 0 and 500 (or above the suffix for trailing rules). Immutable base (harness identity, safety, tool rules) is untouched because our sections only *add* named sections at our chosen orders and never set `complete`.
- **LLM parameters:** `agent/request` waterfall, returning a merged `LlmCallConfig`.
- **Retrieved memory / few-shot / task context (Phases 3+):** either additional `dsh-cast:*` sections (prompt side) or sourced durable `user/message` injections at `agent/pre-step` (the pattern `dsh-agent-instructions` uses for workspace context).
- **Fallbacks (if a scoped-registration edge ever blocks):** the `system-prompt/assemble` waterfall can rewrite the assembly; `llm/stream` can observe/rewrite the final request.

---

## 7. Spike result (G0 evidence)

Throwaway bundle `@local/dsh-cast-spike` (host-only; `apply(ctx)` + `inject: ['systemPrompt']`) registered one static section `dsh-cast:spike` (order 200) and recorded three proofs to `dsh-cast-spike/evidence.json`:

1. `startup-assemble` → `hasSentinel: true` (section present in `assemble()` output; rendered preview shows it after the persona prefix).
2. `system-prompt/assemble` (multiple) → `hasSentinel: true`, `dsh-cast:spike` correctly ordered between `deployment:persona-prefix` and `plan:policy`.
3. `llm/stream` (multiple) → `hasSentinel: true` — the sentinel is present in the **actual outgoing model request**.

Notable runtime fact captured by the spike: on this deployment the assembled prompt is delivered as a **`system` role message inside `messages`** (`GenerateOptions.system` was empty; `systemRoleMessageCount ≥ 1`), consistent with `SystemPromptUpdate = 'in-history'`. Persona fragments therefore ride the system message, not the `system` field.

The spike bundle has been removed after verification; its source remains in `dsh-cast-spike/` as the deliverable, alongside `evidence.json`.

---

## 8. Impact on Phases 1–2

- **No shape change** to Phase 1 (host engine) or Phase 2 (UI + commands), since the hook is exactly what was assumed.
- **Adjustments:**
  - Replace "wrap dsh-ai-soul" with "shadow `deployment:persona-prefix`/`-suffix` per agent" (or simply add named `dsh-cast:*` sections).
  - Drop `top_p`/`penalties` from the `Parameters` layer.
  - Confirmation mode for `set_persona` = `ctx.tools.guard()` (return a string to deny) or a `tools/pre-execute` listener that asks via `ctx.userQuestions`.
- **Phase 1 activation recipe:** resolve the `Agent` (`ctx.agents.get(sessionId)` / `agent/created`), then `agent.ctx.effect(() => agent.ctx.systemPrompt.section(...))` per persona layer; keep the disposers in a per-agent activation record so `/persona off` tears them down cleanly.

---

## 9. Risk register (updated)

| Risk | Phase 0 finding |
|---|---|
| No suitable prompt hook | **Retired** — `systemPrompt.section` + `system-prompt/assemble` + `agent/request` all present. |
| Client/host contract unclear | **Retired** — Remote controller (`@Remote` + `typertGateway` + `clientModules` + slots). |
| Memory leakage across personas | Enforced by `storageDomain` keys + an explicit scope guard (Phase 3 test). |
| Prompt bloat | dsh-cast owns per-layer budgets; no global budget exists to lean on. |
| Persona overrides safety rules | Immutable base untouched: we never set `complete`, only add named sections. |
| DSH version churn | Pinned `0.2.0-rc.2`; hook surface is small and stable; abstract behind one `PersonaComposer`. |
| Assumption drift (dsh-soul) | Corrected here; plan's soul references map to `dsh-persona` + `dsh-system-prompt`. |

---

## 10. Phase 1 entry conditions (all met)

- [x] Spike injects a fragment and it reaches the model (G0).
- [x] Exact entry point for fragments: `agent.ctx.systemPrompt.section()`.
- [x] Client→host path: `@Remote` methods + slot UI.
- [x] Storage: `storageDomain` (state/memory) + `ctx.fs` (persona files).
- [x] Reversible effects confirmed (`ctx.effect`/`ctx.on` disposers).
