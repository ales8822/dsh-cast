# dsh-cast — Project Summary

## What it is
dsh-cast is a persona engine for DeepSeek Harness (DSH), built as a Cordis plugin with host and client halves. It gives any session a distinct, composable, memory-bearing persona — a "soul/character" system that changes how the assistant sounds and behaves per session. Pinned against DSH 0.2.0-rc.2.

## Architecture / key decisions
- **Prompt hook**: personas inject prompt fragments through `agent.ctx.systemPrompt.section()` (per-session scope), assembled as priority-ordered, token-budgeted layers: identity (shadows `deployment:persona-prefix`), voice, behavior, state, memory, examples.
- **Activation**: resolve the `Agent`, register sections through `agent.ctx.effect(...)` so deactivation and agent disposal both clean up.
- **LLM parameters**: injected via the `agent/request` waterfall (`temperature`, `maxTokens`, `stop`).
- **Host↔client**: the host exposes an authenticated JSON API via `ctx.connection.fetch.register` (`/api/dsh-cast/*`); the client bundle half calls `fetch('api/...')` and renders into slots — a `settings.section` management panel and a `conversation.input.left` composer switcher.
- **Storage**: personas are JSON files; state/memory/history/ratings/groups live as dotfile JSON in the data dir (files chosen over `storageDomain` because a no-deps bundle cannot import schemastery/zod).
- **No build step, no dependencies**: the bundle imports only Node built-ins and reads everything else from the Cordis context, so it installs in any profile.

## What's implemented (six phases)
1. **Core engine** — `PersonaService` (registered as `ctx.personas`), six numeric trait dimensions (formality/warmth/humor/verbosity/directness/chaos), a layered token-budgeted prompt composer, a persona store with hot reload, and built-in personas.
2. **UI + commands + tools** — a full `/persona` command (list/use/off/show/create/edit/delete/export/import/mix/tune/memory/summarize/compare/group/handoff/history/rollback/rate/ratings/route/reload); agent tools `set_persona`/`list_personas`/`create_persona` with a confirmation mode (`tools/pre-execute`); a Settings "Personas" panel with trait sliders and a 🎭 composer switcher.
3. **State & memory** — relationship state (mood/energy/trust/familiarity) with per-turn drift and time decay; five memory scopes (global/user/persona/conversation/episodic) with strict per-persona isolation; LLM-driven conversation summarization.
4. **Composition & multi-persona** — named mixins, archetype inheritance, `mix` (blend two personas), natural-language `tune` ("make them warmer, less chatty"), an auto-router (task classification → best-matching persona), and group chat with a round-robin director plus handoff.
5. **Evaluation, sharing, polish** — Markdown + Character Card V2 + persona-pack export/import, version history with rollback, fidelity ratings, A/B comparison, 10 example personas, and a README.

## Verification
- Host logic is covered by `test/host.test.mjs` (runs against a mock Cordis context) — passes with exit 0, exercising registrations, the composer, CRUD, state drift, memory isolation, composition, the router, ratings, summarization, A/B, and group chat.
- Live-verified: prompt injection reaches the model (spike); activation changes output (A/B and a tool-driven test); agent tools register; and both client slots register.

## Files (bundle root)
- `index.js` (host half), `client.js` (client half), `package.json`, `cordis.patch.yml`
- `personas/*.json` (10 built-in personas), `test/host.test.mjs`
- `README.md`, `phase0-feasibility.md` … `phase5-status.md`
