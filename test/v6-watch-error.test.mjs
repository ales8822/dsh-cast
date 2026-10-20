// V6 regression: an asynchronous fs.watch 'error' must not kill the process.
//
// `watchUserDir` wrapped `watch()` in try/catch, which covers only the SYNCHRONOUS
// throw. An FSWatcher is an EventEmitter, and emitting 'error' with NO listener is
// re-thrown by Node as an uncaught exception — process death. So the guard LOOKED
// like it handled watch failures while the async channel escaped it entirely.
//
// This drives the REAL emitter the plugin built (service._watcherHandle) and asserts
// the CALLER-SIDE consequence: survival plus a logged message. It deliberately does
// not assert "a listener exists" — that would pass even if the handler were attached
// to the wrong object.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const mod = await import('../index.js');

const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cast-v6-'));
await writeFile(path.join(dir, 'keep.json'), '{}', 'utf8');

// Tripwire: if the error channel has no landing site, Node surfaces it here and the
// process dies before the assertions below run.
let tripped = null;
process.on('uncaughtException', (e) => { tripped = `uncaughtException: ${e && e.message}`; });
process.on('unhandledRejection', (e) => { tripped = `unhandledRejection: ${e && e.message}`; });

const logs = [];
const reg = { provided: {} };
const ctx = {
  effect: (fn) => { const d = fn(); return () => (typeof d === 'function' ? d() : undefined); },
  on: () => () => {},
  provide: (n, v) => { reg.provided[n] = v; return () => {}; },
  get: (n) => reg.provided[n],
  commands: { register: () => () => {} },
  tools: { register: () => () => {} },
  agents: { get: () => undefined, currentInitiator: () => undefined },
  connection: { fetch: { register: () => async () => {} } },
  systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
  sessions: { get: () => undefined },
  llm: { listProviders: () => [], listModels: async () => [], stream: async function* () {} },
};

mod.apply(ctx, { personasDir: dir, autoActivate: '', setPersonaConfirm: true });
const service = reg.provided.personas;
assert.ok(service, 'V6: the personas service is provided');

// Capture the plugin's own log channel (start() runs async, so wait for the watcher).
await new Promise((r) => setTimeout(r, 300));
const originalLog = service.log.bind(service);
service.log = (m) => { logs.push(String(m)); originalLog(m); };

const emitter = service._watcherHandle;
assert.ok(emitter, 'V6: watchUserDir exposed the FSWatcher it built');
assert.equal(typeof emitter.emit, 'function', 'V6: the watcher is an EventEmitter');

// THE HAZARD, asserted as a control: a bare fs.watch has no error listener, which is
// exactly why an unhandled async error was fatal. This proves the test is about a
// real channel rather than a synthetic one.
const { watch } = await import('node:fs');
const bare = watch(dir, () => {});
assert.equal(bare.listenerCount('error'), 0, 'V6 control: a bare fs.watch has NO error listener');
bare.close();

// THE FIX, exercised: emit on the plugin's real emitter. Without the handler this
// throws synchronously out of emit() and, for a genuine async emission, kills the
// process. Either way the assertions below would not be reached.
const before = logs.length;
assert.doesNotThrow(
  () => emitter.emit('error', new Error('EPERM (simulated async watch failure)')),
  'V6: emitting error on the plugin watcher must not throw',
);
assert.ok(logs.length > before, 'V6: the failure was REPORTED, not silently swallowed');
assert.ok(logs.some((l) => /watch error/i.test(l)), 'V6: the log line names the watch error');

// The process must still be healthy.
await new Promise((r) => setTimeout(r, 200));
assert.equal(tripped, null, `V6: nothing escaped as a process-level error (${tripped})`);
assert.ok(reg.provided.personas, 'V6: the service is still provided after the error channel fired');

await rm(dir, { recursive: true, force: true }).catch(() => {});
console.log('V6: OK — async watch errors have a landing site and are non-fatal');
process.exit(0);
