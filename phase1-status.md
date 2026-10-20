# dsh-cast — Phase 1 Status (Core Engine, host-side)

**Gate G1: PASSED** — a persona file produces visibly distinct model output, and deactivation removes prompt fragments cleanly.

## What shipped

Bundle `@local/dsh-cast` (installed in the `web` profile, `autoActivate` off by default):

- `index.js` — `PersonaService` registered as `ctx.personas` via `ctx.provide` (no bare imports, so it resolves in any profile). Dependencies declared via `inject: ['llm','sessions','tools','systemPrompt','commands','agents']`.
- `personas/{terse,warm,chaotic}.json` — three built-in personas.
- `/persona` command — `list | use <name> | off | show <name> | reload`.

## Implemented

- **Data model** — identity / traits / voice / behavior / boundaries / examples / parameters / composition, normalized with defaults.
- **Trait engine** — six dimensions (formality, warmth, humor, verbosity, directness, chaos), 0–10, resolution `defaults → archetype → persona overrides`, clamped.
- **Prompt composer** — four priority-ordered layers (identity @0 shadows `deployment:persona-prefix`; voice @250; behavior @450; examples @460), each with an independent token budget; the identity layer declares itself authoritative so lower guidance can't override it.
- **Persona store** — load (built-ins + user dir), save, remove, list, hot-reload watcher; all Cordis registrations via `ctx.effect` (fiber-scoped teardown).
- **Activation** — `agent.ctx.effect(() => agent.ctx.systemPrompt.section(...))` per layer; `deactivate()` disposes those effects; `agent/disposed` drops stale records.
- **LLM parameter injection** — `agent/request` waterfall merges `temperature` / `maxTokens` / `stop` (no `top_p`/`penalties` in DSH).
- **auto-activate** — `agent/created` listener (config `autoActivate`), used to A/B-verify output change.

## Verification evidence

- `.dsh-cast-report.json` (in the data dir) dumps resolved traits + composed layers for every persona — three visibly distinct layered prompts.
- Live A/B via `autoActivate` + subagents:
  - `terse` → "I'm terse and direct: short sentences, no padding… skip small talk, apologies, and hedging…"
  - `warm` → "I'm warm, patient, and encouraging — I genuinely want you to feel heard and capable… You've got this."
- User-persona loading: dropping `curt.json` into the data dir and reinstalling surfaced it in the list (4 personas).

## Known limitations / follow-ups

- **Hot-reload watcher fix needs a host restart.** The first revision imported `watch` from `node:fs/promises` (async-iterator form, takes no callback); corrected to `node:fs` `watch`. The source is fixed, but the running host still holds the pre-fix module (DSH caches a module generation until restart), so runtime hot-reload wasn't re-verified live. Startup load works regardless.
- **`save`/`remove` are implemented but not command-wired** — Phase 2 adds `/persona create|edit|delete`.
- **No client half yet** — Phase 2.
- `/persona` command registration is code-verified (plugin applied cleanly, no activation errors); its slash-command invocation path is exercised by the human UI, which I can't drive from this session.
