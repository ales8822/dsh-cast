# dsh-cast persona file — canonical JSON structure

The single reference for "what should a `<name>.json` in a personas directory look
like?". Written after comparing the files that actually exist on this machine:

| Where | Files | Shape found |
|---|---|---|
| `dsh-cast/personas/` (shipped built-ins) | 10 | **legacy**: `identity` + `traits` + `voice` + `behavior` + `boundaries` + `examples` (strings) + `parameters` + `composition`; **no `definition`**, no `schemaVersion` |
| `dsh-cast-personas/` (user dir, written by Settings → Personas) | `Silas.json` | **v2**: `name` + the empty legacy skeleton left by `create` + `definition` (six fields) + `schemaVersion: 2` |

Both load. Only the **v2** shape drives the prompt; the legacy shape is migrated in
memory on every read. This document defines the one shape worth authoring by hand,
and records exactly what the plugin accepts (proved by
[`test/persona-file-acceptance.test.mjs`](../dsh-cast/test/persona-file-acceptance.test.mjs)).

---

## The canonical file

```jsonc
{
  "name": "Silas",                 // REQUIRED. Must equal the filename (see rule 1).
  "identity": { "role": "…" },     // one-line role; used by mix / markdown / card export
  "traits": {                      // six 0-10 dimensions; used by the auto-router, mix, tune
    "formality": 6, "warmth": 2, "humor": 8,
    "verbosity": 4, "directness": 7, "chaos": 3
  },
  "parameters": {                  // OPTIONAL: sampling, injected on every request
    "temperature": 0.7, "maxTokens": 700, "stop": []
  },
  "composition": { "archetype": null, "mixins": [] },   // OPTIONAL: layering
  "schemaVersion": 2,              // marker; added automatically on save
  "definition": {                  // THE PROMPT. Authoritative when present, even if empty.
    "identity": "You are …",       // -> deployment:persona-prefix  (budget 400)
    "communication": "Tone: …",    // -> dsh-cast:voice            (budget 300)
    "behavior": "How you …",       // -> dsh-cast:behavior         (budget 300)
    "expertise": "Deep knowledge…",// -> dsh-cast:expertise        (budget 300)
    "rules": "Always …",           // -> dsh-cast:rules            (budget 300)
    "examples": [                  // -> dsh-cast:examples         (budget 300)
      { "user": "…", "assistant": "…" }
    ]
  }
}
```

Everything after `name` is optional; an absent or empty field simply produces no
prompt section. Key order is cosmetic — the plugin rewrites files in its own
`normalize()` order on the next save.

### A minimal, fully valid file

`schemaVersion` is optional, but keep it: it is the human-readable marker that the
file is the definition-first format and not a legacy file that happens to be empty.

```json
{
  "name": "terse",
  "schemaVersion": 2,
  "definition": { "identity": "You are a terse senior systems engineer.", "rules": "Never pad or apologize." }
}
```

---

## Who reads what (the part that decides "best")

| Key | Read by | Affects the prompt? |
|---|---|---|
| `definition.*` | `resolveDefinition` → `composeDefinition` | **yes — this is the prompt** |
| `identity.*` | legacy fallback, `mix`, markdown / character-card export | only when `definition` is absent |
| `traits.*` | `routePersona` (auto-router), `mix`, `tune`, export | only when `definition` is absent |
| `voice.*`, `behavior.*`, `boundaries.*`, `examples` (strings) | `mix`, export | only when `definition` is absent |
| `parameters.*` | `agent/request` injection | no — sampling (`temperature`, `maxTokens`, `stop`) |
| `composition.*` | `resolvePersona` layering (archetype → mixins → persona) | indirectly — decides which definition wins |
| `schemaVersion` | `normalize` round-trip only | no |

Consequence: once a persona has `definition`, the legacy fields are **metadata**,
not content. Fill in `identity.role` and `traits` anyway — they are what the
auto-router, `mix` and the export formats actually use, and an empty `traits`
silently means "average on every axis" (the `DEFAULT_TRAITS`).

---

## Rules the plugin enforces (each one is tested)

1. **`name` must equal the filename.** The store keys personas by the `name`
   field, not the file path. A file `foo.json` containing `"name": "bar"` is
   registered as `bar`; the next save writes `bar.json` and the original `foo.json`
   is left behind as a ghost (two files, one persona). On a name collision between
   the two directories the **user dir shadows the shipped built-ins** (`get()`
   checks the user store first), and `create` refuses to shadow a built-in unless a
   user persona of that name already exists.
2. **The `definition` key's PRESENCE is the schema marker.** Not its content.
   `"definition": {}` or `"definition": null` is an authoritative *empty* persona
   (identity falls back to `You are <name>.`); an *absent* key means legacy and is
   migrated from `traits`/`voice`/`behavior`/`boundaries`.
3. **`schemaVersion` is metadata, not a gate.** `99` loads, `3` loads, absent
   loads. It is never validated.
4. **`definition.examples` is an array of `{ "user", "assistant" }` objects.**
   The top-level legacy `examples` is an array of `"Q: …\nA: …"` *strings*. The two
   are not interchangeable — see rule 5.
5. **Reads are permissive, writes are strict.** A hand-edited file with a wrong
   type (a number in `identity`, a string array in `examples`) loads, and the bad
   value quietly degrades (no section, name fallback). The same content is
   **rejected** by `create`/`edit` with a field-specific error, so the last valid
   definition on disk is never overwritten. Prefer `{ "user", "assistant" }` pairs.
6. **Unknown keys are dropped** (top-level and inside `definition`) on load *and*
   on write. Unknown keys *inside an example pair* survive, because examples pass
   through unnormalized.
7. **A file that cannot be parsed is skipped, logged, and never takes the store
   down.** The other personas still load.
8. **Names are filename-safe**: `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. A `.`-prefixed
   file is never loaded (side files: `.dsh-cast-state.json`, `.dsh-cast-report.json`,
   `.dsh-cast-memory.json`, … — these are runtime data, not personas).
9. **Limits**: 8000 chars per definition text field, ≤ 50 examples, ≤ 4000 chars per
   example part. Prompt sections are additionally truncated by the per-layer token
   budgets (`identity` 400, everything else 300 by default).

---

## Is the Settings-UI-created shape accepted? Yes — verified

`dsh-cast-personas/Silas.json` (the file created from Settings → Personas) is
accepted, and its definition is used verbatim:

* **Offline, through the real `index.js`**: `test/persona-file-acceptance.test.mjs`
  copies the live `Silas.json`, loads it, and asserts `migrated: false`,
  `source: "definition"`, a byte-identical definition round-trip, all six layers
  present, and no truncated/over-budget layer. The same suite also proves every
  other shape (minimal, empty, unknown keys, wrong types, `schemaVersion: 99`,
  `definition: null`, `name`/filename mismatch, broken JSON, and both legacy shapes).
* **Live, against the running host** (authenticated `GET` from the Web GUI session):

  ```
  GET /api/dsh-cast/get?name=Silas      -> 200, migrated: false, definition intact
  GET /api/dsh-cast/preview?name=Silas  -> 6 layers, truncatedLayers: [], overBudgetLayers: []
  GET /api/dsh-cast/list                -> 11 personas, health.ok: true
  ```

  Editing `Silas.json` on disk was also hot-reloaded by the profile's directory
  watcher, which is how the canonical edit below was confirmed prompt-neutral.

The one wart of the UI-created shape is not the `definition` — it is the **stub
skeleton** `create` leaves behind: `"identity": { "role": "a persona named Silas" }`
and `"traits": {}`. Those are not prompt input, but they *are* what `mix`,
the auto-router and the markdown / character-card export read, so a persona that
looks fully described in the editor can export as "a persona named Silas" and route
as average-on-every-axis. Fill them in (as done for `Silas.json`).

---

## Converting an existing file

```powershell
# dry run — shows what would change, writes nothing
node dsh-cast\tools\canonicalize-personas.mjs --dir dsh-cast\personas
# apply — backs the directory up first, then rewrites in place
node dsh-cast\tools\canonicalize-personas.mjs --dir dsh-cast\personas --write
```

The tool is **prompt-preserving by construction**: it adds only
`schemaVersion: 2` + the resolver's own migration output, leaves every existing key
byte-identical (so trait routing, `mix`, `tune`, export and `parameters` keep
working), refuses to write if the composed prompt would change, and refuses a file
whose `name` does not match its filename. All 10 shipped personas were converted
with it; a backup of the pre-conversion files is under
`dsh-cast-backups/pre-canonical-<timestamp>/`.

### Known cosmetic artifacts of the migration path

Persisting the runtime migration preserves its wording exactly, including:

* a doubled period wherever a legacy `behavior` value already ended in `.`
  (`"Acknowledge the situation with faint amusement.."`);
* `expertise` left **empty** for every converted persona (there is no legacy
  source for it) — this is the field most worth writing by hand;
* a `communication` field that reads like a spec sheet of trait directives
  (`"Voice and style:\n- formality: use neutral, everyday prose.\n…"`) rather than
  character voice.

These are content improvements, not structural ones; the converter deliberately
does not make them (that would change the prompt). Edit the definition fields in
Settings → Personas, or in the file, when you want to upgrade the prose.

### One structural wart worth knowing

`normalize()` always emits the full legacy skeleton (`identity`, `traits`, `voice`,
`behavior`, `boundaries`, `examples`, `parameters`, `composition`), so a file
hand-trimmed to only the meaningful keys **regains the empty `{}` / `[]` stubs on
the next save**. That is why the canonical file above lists them: the empty-key
noise is produced by the plugin, not authored. Removing it for good would mean
changing `normalize()` (a host change with test fallout) — out of scope here.
