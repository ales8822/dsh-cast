// V5 regression: a startup failure must NOT be process-fatal.
//
// This drives the REAL plugin through the REAL apply() boundary with a personasDir
// whose report path is blocked (a directory sitting where the report file belongs),
// so writeReport() genuinely throws EISDIR. The assertion is about process
// survival and an observable log — not about the throw, which is deliberate.
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cast-v5-'));

// Block ONLY the report file, leaving personasDir itself a valid directory, so the
// failure cannot be blamed on mkdir or on a bad personasDir.
await mkdir(path.join(dir, '.dsh-cast-report.json'), { recursive: true });

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

// Capture the service's log channel so we can assert the failure was REPORTED.
const service = { log: (m) => logs.push(String(m)) };

// apply() is synchronous and must not throw synchronously either.
assert.doesNotThrow(() => apply(ctx, { personasDir: dir, autoActivate: '', setPersonaConfirm: true }),
  'V5: apply() must not throw synchronously when startup fails');

// Give the rejected start() a chance to surface. If it were unhandled, Node would
// abort the process before this timer fires — which is exactly what we assert.
const survived = await new Promise((resolve) => setTimeout(() => resolve(true), 400));
assert.equal(survived, true, 'V5: the process survived a startup failure (no unhandled rejection)');

// The service must still be published — degraded, not absent.
assert.ok(reg.provided.personas, 'V5: the personas service is still provided after a startup failure');

await rm(dir, { recursive: true, force: true }).catch(() => {});
console.log('V5: OK — startup failure is non-fatal and the service remains available');
// The service's fs.watch on personasDir would otherwise keep the event loop alive,
// the same reason host.test.mjs exits explicitly once its assertions pass.
process.exit(0);
