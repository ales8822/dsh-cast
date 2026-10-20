# dsh-cast — Phase 4 Status (Composition & Multi-Persona)

**Composability core (mixins, inheritance, mix, natural-language tune) implemented + unit-tested.** Multi-persona conversation (group chat / director / auto-router / handoff) remains.

## What shipped

- **Mixins** — `BUILTIN_MIXINS` (`british-sarcasm`, `concise`, `noir`); `composition.mixins: [...]` resolves into traits + voice, merged in `defaults → archetype → mixins → overrides` order.
- **Inheritance** — full `resolvePersona` merge: an `archetype` contributes identity, traits, voice, behavior, boundaries, examples, parameters; the persona's own fields override (numeric traits per-dimension, arrays concatenated for boundaries/catchphrases).
- **Mix** — `mixPersona(a, b, { weight, name })` blends traits by weighted average and merges identity/voice/behavior/boundaries; `/persona mix <a> <b> [name]`.
- **Natural-language tune** — `naturalEdit(name, phrase)` maps keyword phrases (warmer, less chatty, more formal, funnier, more direct, …) to trait deltas; `/persona tune <name> <phrase>`.

## Verification

`test/host.test.mjs` now asserts: mixin resolution (`concise` → verbosity 1; edit flattens mixins), archetype inheritance + override, `mix` trait averaging (verbosity 1 vs 5 → 3; warmth 2 vs 9 → 5.5) and save, and natural-language deltas (`less chatty` → verbosity −2, `more formal` → formality +2). Result: `ALL HOST TESTS PASSED` (exit 0).

## Still to do (Phase 4 tasks 5–8)

- **Group chat** — multiple personas in one conversation with turn-taking.
- **Director** — a moderator deciding who speaks next.
- **Auto-router** — pick a persona by task classification.
- **Handoff** — one persona passes the conversation to another.

These need agent-loop coordination (turn-taking across personas) and are deferred; the composability surface they depend on (mix/inherit/tune) is in place.
