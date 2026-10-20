# dsh-cast — Phase 3 Status (State & Memory)

**Implemented + unit-tested (host-side).** Live verification still awaits a host restart.

## What shipped

### Relationship state (`StateManager`-equivalent)
- `getState` / `setState` / `advanceState(name, { error? })`, file-backed at `personasDir/.dsh-cast-state.json`.
- Drift rules: `familiarity +1` per turn; `energy -1` per turn but `+3/hour` recovery over idle; `trust +0.5` per turn, `-1` on error; `mood` derived from energy/trust/familiarity. Values clamped 0–10, rounded to 2 decimals.
- Wired to `agent/turn-stopping`: an active persona's state advances at the end of every turn.
- Injected into the composer as a `dsh-cast:state` layer (order 455, budget 80).

### Scoped memory (`MemoryManager`-equivalent)
- `addMemory` / `listMemories` / `clearMemory`, file-backed at `personasDir/.dsh-cast-memory.json`.
- Five scopes: `global`, `user`, `persona`, `conversation`, `episodic`.
- Retrieval for persona P in session S = `global` + `user` + `persona:P` + `episodic:P` + `conversation:S`. **A persona never sees another persona's `persona`/`episodic` scopes** (isolation).
- Injected as a `dsh-cast:memory` layer (order 460, budget 200).
- Command: `/persona memory <name> add <text> | show | clear`.

## Storage note (deviation from plan)

The plan said "state and memory live in DSH's session storage". `ctx.storageDomain` requires zod (`schemastery`) schemas, which a no-deps profile-installed bundle cannot import. State/memory therefore live as dotfiles in the data root (ignored by the watcher and the persona loader), keyed by persona and scope — functionally equivalent, and documented here.

## Verification

`test/host.test.mjs` (mock Cordis ctx) now also asserts:
- state drift (familiarity/energy/trust/mood) incl. error penalty;
- memory isolation (terse can't see warm's persona memory and vice-versa; conversation scope is session-bound);
- the `/persona memory` add/show/clear round-trip.

Result: `ALL HOST TESTS PASSED` (exit 0). Two unit-test-caught fixes landed: state-value float rounding, and (earlier round) the store/reload serialization + dotfile watcher filter.

## Still to do (Phases 3–5)

- Live re-verify everything after a host restart (Phase 1–3 together).
- Phase 3 tail: summarization for long conversations (retrieval is done; summarization not yet).
- Phase 4: mixins/inheritance/mix/natural-language edit, group chat, director, auto-router, handoff.
- Phase 5: fidelity rating, A/B, version history, import/export formats, packs, docs, 10–15 examples.
