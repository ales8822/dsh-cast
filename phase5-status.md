# dsh-cast — Phase 5 Status (Evaluation, Sharing, Polish)

**Sharing/polish host-side core implemented + unit-tested.** Fidelity rating + A/B (LLM-driven, UI) and full docs remain.

## What shipped

- **Import/export formats** — JSON (Phase 2), **Markdown** (`personaToMarkdown`/`markdownToPersona`), **Character Card V2** (`personaToCharacterCard`/`characterCardToPersona`, with a `dsh_cast` extension carrying traits/voice/boundaries). `/persona export <name> [json|markdown|card]`.
- **Persona packs** — `exportPack`/`importPack` (`{ format: 'dsh-cast-pack', personas: [...] }`); `/persona pack export <names…> | import <json>`; `import` auto-detects packs and cards.
- **Version history + rollback** — every `save` snapshots the prior version into `.dsh-cast-history.json`; `/persona history <name>` and `/persona rollback <name> <index>`.
- **10 example personas** — `terse`, `warm`, `chaotic`, `socratic`, `sardonic`, `professor`, `pirate`, `therapist`, `journalist`, `poet` (distinct trait profiles).

## Verification

`test/host.test.mjs` now also asserts: Markdown round-trip (role + traits), Character Card V2 round-trip (spec + role + traits via extension), pack export/import, and version history + rollback. Result: `ALL HOST TESTS PASSED` (exit 0). One test-caught fix landed: a `history` method/field name collision (renamed the accessor to `getHistory`).

## Still to do (Phase 5 tail + earlier tails)

- Fidelity rating ("sounds like them?" scores) and A/B comparison — need LLM generation + client UI.
- User-facing docs polished into a README (draft exists in `README.md`).
- Phase 3 summarization; Phase 4 group chat / director / auto-router / handoff; Phase 2 composer switcher + trait sliders.
- Live re-verification of everything after a host restart + browser refresh.
