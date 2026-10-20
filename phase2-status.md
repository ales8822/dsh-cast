# dsh-cast — Phase 2 Status (Client UI + Commands)

**Code-complete; live verification blocked on a host restart + browser refresh.**

## What shipped this round

### Host half (`index.js`)
- **Extended `/persona` command** — `list | use <name> | off | show <name> | create <name> | delete <name> | edit <name> <json> | export <name> | import <json> | reload`, with `createPersona`/`deletePersona`/`editPersona`/`exportPersona`/`importPersona`.
- **Agent tools** — `set_persona`, `list_personas`, `create_persona` via `ctx.tools.register`; confirmation mode via `tools/pre-execute` → `{ kind: 'ask' }` when `setPersonaConfirm` is true.
- **Client-facing HTTP JSON API** (`ctx.connection.fetch.register`, authenticated `/api` channel):
  - `GET  /api/dsh-cast/list` → persona names
  - `GET  /api/dsh-cast/get?name=` → one persona
  - `POST /api/dsh-cast/create` {name, traits?, identity?}
  - `POST /api/dsh-cast/delete` {name}
  - `POST /api/dsh-cast/activate` {sessionId, name|'off'} — `name: 'off'` deactivates

### Client half (`client.js` + `package.json` `dsh.client`)
A **"Personas" page under Settings** (`settings.section` slot, id `dsh-cast-personas`): lists personas, creates (name + role) and deletes them through the HTTP API. Activation is surfaced as `/persona use <name>` guidance; a session-scoped composer control is the remaining piece.

## RPC mechanism — resolved (key finding)

The bundle client half has **no `host.call`** (that is the dynamic `cordis_run` path). The correct bundle client→host channel is:

- Host: `ctx.connection.fetch.register({ path: '/api/…', methods, requestBody: 'buffered', fetch: (req) => Response.json(…) })` (pattern verified from `dsh-client-ui-deliverables` / `dsh-client-file-upload`).
- Client: plain `fetch('api/…')` (browser-relative, no leading slash; pattern `PRESENT_*_PATH.slice(1)`).

## Slot contract (verified via inspection)

`settings.section` registration = `{ id, order, label }`. The panel component receives owner prop `close` and standard props incl. `useSessions`, `usePanelInfo`, `useSessionStatus` — these are the hook into "which session is active" for wiring activation next round.

## Deployment constraint (critical, unchanged)

- **Host JS changes** require a **host restart** (module cached by package identity; verified: `Tool.listTools` never showed the new tools, the Phase 1 `fs.watch` fix never applied, and an entry-file rename didn't help).
- **Client JS changes** require a **browser refresh** (or `pnpm run dev:web`); the connected page keeps its boot module graph until then.
- **Config** changes *do* apply on remove+install (verified earlier).

I cannot restart the host or refresh the browser from inside this session, so the Phase 2 code is **syntax-checked + installed + slot-contract-verified, but not visually/behaviorally live-verified**.

## Verification status

- [x] RPC mechanism resolved (connection.fetch + client fetch).
- [x] `settings.section` slot contract confirmed.
- [x] Host + client code syntax-checked (`node --check`).
- [x] Bundle installs cleanly (`application: applied`, no warnings).
- [x] **Host half unit-tested** (`test/host.test.mjs`, mock Cordis ctx): registrations (command/tools/HTTP routes), store, composer distinctness, CRUD, export/import, and confirmation mode all asserted; exits 0.
- [ ] Live verification — blocked on host restart + browser refresh.

### Bugs the unit test caught and fixed
1. `loadUser` aborted the whole scan when one file vanished mid-read — now skips per-file errors.
2. Infinite watcher→`writeReport`→watcher loop — the report file is a dotfile, now ignored by the watcher.
3. Overlapping watcher reloads vs CRUD raced (mid-write/mid-unlink reads) — store mutations and reloads are now serialized through one promise chain.

## After restart/refresh (re-verify checklist)

1. `Tool.listTools` should list `set_persona`/`list_personas`/`create_persona`.
2. `/persona create|edit|delete|export|import` should work.
3. `curl`-style `GET /api/dsh-cast/list` should return the 3 built-ins + user personas.
4. Settings → "Personas" should render the panel; create/delete should round-trip to the host.
5. Phase 1 `fs.watch` hot-reload fix should be live (drop a `.json` into `personasDir` → appears).

## Next round

1. Session-scoped **composer persona switcher** (uses `useSessions`/slot props to get the session, then `POST /api/dsh-cast/activate`).
2. Trait sliders + edit UI in the panel.
3. Re-verify everything after a host restart/browser refresh when one is available.
