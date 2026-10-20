// Shape/purity check for the client half. This is NOT a substitute for running the
// UI in the real browser — it only proves the module the shell will load is
// well-formed and depends on nothing but 'react', which is the zero-dependency
// constraint from phase6-contract.md item 10.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const src = await readFile(new URL('../client.js', import.meta.url), 'utf8');

assert.ok(src.length > 0, 'client.js is non-empty');

// 1. The client half is NOT an ES module. The shell loads it as a browser script
// that registers itself on window.__ModuleLoader__ with an id and a factory.
// (An earlier version of this check asserted `export default` and was simply
// wrong about the contract — the loader shape below is what the shell expects.)
assert.match(src, /window\.__ModuleLoader__\.load\(/, 'client.js must register via window.__ModuleLoader__.load({...})');
const loaderId = src.match(/id:\s*['"]([^'"]+)['"]/)?.[1];
assert.ok(loaderId, 'the loader registration must carry an id');
assert.match(src, /factory\s*\(\s*require\s*\)/, 'the loader registration must expose factory(require)');

// The three manifests must agree on identity, or the shell will look for one id
// while the bundle registers another — a mismatch that fails at load time with no
// obvious cause. Asserted here because nothing else in the tree checks it.
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(loaderId, pkg.name, `loader id ${loaderId} must equal package.json name ${pkg.name}`);
assert.equal(pkg.exports?.['./client'], './client.js', 'package.json must export the client half at ./client');
assert.ok(pkg.dsh?.client, 'package.json must declare a dsh.client block for the web half');
assert.equal(pkg.dsh.client.platform, 'web', 'the client half targets the web platform');
// The slots our registrations need must be supplied by packages we declare we inject.
const declaredInject = pkg.dsh.client.inject ?? [];
for (const needed of ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-settings']) {
  assert.ok(
    declaredInject.includes(needed),
    `pkg.dsh.client.inject must declare ${needed} (without it the slot provider never loads)`,
  );
}

// 2. Exactly one external dependency, and it is 'react'.
const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
const bareImports = [...src.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
const externals = [...new Set([...requires, ...bareImports])].filter((s) => !s.startsWith('node:'));
assert.deepEqual(externals, ['react'], `client half must require only 'react', saw: ${JSON.stringify(externals)}`);

// 4. The three slot registrations are the whole UI surface.
const slots = [...src.matchAll(/slots\.inject\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
assert.deepEqual(slots, [
  'conversation.input.left',
  'conversation.session.header.actions',
  'settings.section',
], `unexpected slot registrations: ${JSON.stringify(slots)}`);

// 5. F1 regression guard: the client must read the active persona over the PURE
// read route and must never reach for the MUTATING one on a render path.
assert.match(src, /\/dsh-cast\/active/, 'client must read the active persona via GET /dsh-cast/active');
const activateCalls = [...src.matchAll(/['"]\/dsh-cast\/activate['"]/g)].length;
assert.equal(activateCalls, 2, `POST /dsh-cast/activate must appear only at the two explicit action sites, saw ${activateCalls}`);

console.log('client-shape: OK (react-only, 3 slots, pure-read active lookup, 2 activate action sites)');
