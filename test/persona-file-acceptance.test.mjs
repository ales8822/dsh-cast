// PERSONA-FILE ACCEPTANCE — which JSON SHAPES the real plugin accepts, and what
// it does with each.
//
// Why this file exists: a persona file can arrive from four directions with four
// different shapes —
//   1. a shipped built-in (dsh-cast/personas/*.json, legacy: no `definition`),
//   2. a persona created from the Settings UI (the `Silas.json` shape: `definition`
//      + `schemaVersion: 2` + an empty legacy skeleton left over from create),
//   3. a hand-written minimal file (`{ name, schemaVersion, definition }`),
//   4. a hand-edited / malformed file (wrong types, unknown keys, bad JSON).
//
// The plugin's READ path is deliberately permissive (a bad file must never take
// the store down) while the WRITE path is strict (an invalid edit must never
// overwrite the last good definition). This suite pins BOTH halves against the
// real `index.js`, so "is this file accepted?" has a tested answer instead of a
// reading of the code.
//
// It also proves the canonicalization is PROMPT-PRESERVING: adding a migrated
// `definition` to a legacy file produces byte-identical prompt layers.
import { mkdtemp, rm, writeFile, readFile, readdir, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, '..');
const builtinsDir = path.join(pluginDir, 'personas');
// The live user-persona dir configured in cordis.patch.yml. Read only.
const liveUserDir = 'C:\\Users\\AlAr\\my_progs\\dsh_plugins_folder\\dsh-cast-personas';

function makeMockCtx() {
  const reg = { commands: [], tools: [], routes: [], events: {}, provided: {}, agents: new Map() };
  const ctx = {
    effect(fn) {
      const d = fn();
      return () => (typeof d === 'function' ? d() : undefined);
    },
    on(name, listener) {
      (reg.events[name] ??= []).push(listener);
      return () => {};
    },
    provide(name, value) {
      reg.provided[name] = value;
      return () => {};
    },
    get(name) {
      return reg.provided[name];
    },
    commands: { register(def) { reg.commands.push(def); return () => {}; } },
    tools: { register(def) { reg.tools.push(def); return () => {}; } },
    agents: {
      get(id) { return reg.agents.get(String(id ?? ''))?.agent; },
      currentInitiator() { return reg.initiator ?? [...reg.agents.values()].at(-1)?.agent; },
    },
    connection: { fetch: { register(route) { reg.routes.push(route); return async () => {}; } } },
    systemPrompt: { section() { return () => {}; }, getSectionOrder() { return 0; } },
    sessions: { get() { return { deriveMessages() { return []; } }; } },
    llm: {
      listProviders() { return [{ id: 'mock' }]; },
      async listModels() { return [{ id: 'mock-model' }]; },
      async *stream() { yield { type: 'text-delta', text: 'MOCK' }; },
    },
  };
  return { ctx, reg };
}

const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cast-accept-'));

// A file whose JSON cannot be parsed at all.
const writeRaw = (name, text) => writeFile(path.join(dir, name), text, 'utf8');
const writeJson = (name, obj) => writeRaw(name, JSON.stringify(obj, null, 2));

try {
  // ---------------------------------------------------------------------------
  // Stage 1 — the SHIPPED built-ins, exactly as they are on disk (legacy shape),
  // copied into the temp personasDir so the service also sees them as user files.
  // ---------------------------------------------------------------------------
  const builtinFiles = (await readdir(builtinsDir)).filter((f) => f.endsWith('.json'));
  assert.ok(builtinFiles.length === 10, `expected 10 shipped personas, found ${builtinFiles.length}`);
  for (const f of builtinFiles) await cp(path.join(builtinsDir, f), path.join(dir, f));

  const shippedShapes = new Map();
  for (const f of builtinFiles) {
    const raw = JSON.parse(await readFile(path.join(builtinsDir, f), 'utf8'));
    shippedShapes.set(f, { name: raw.name, legacy: !('definition' in raw), schemaVersion: raw.schemaVersion });
  }
  // The shipped set may be all-legacy, all-canonical, or mixed (see
  // tools/canonicalize-personas.mjs). Either shape must load — that is the point.
  // The census is printed so a regression in the shipped shape is visible.
  const legacyShipped = [...shippedShapes.values()].filter((s) => s.legacy).map((s) => s.name);
  const canonicalShipped = [...shippedShapes.values()].filter((s) => !s.legacy).map((s) => s.name);
  console.log(`shipped persona shapes: ${canonicalShipped.length} canonical (v2), ${legacyShipped.length} legacy`);
  assert.ok([...shippedShapes.values()].every((s) => typeof s.name === 'string' && s.name.length > 0), 'every shipped persona has a name');

  // The live Silas.json (the Settings-UI-created shape). Skipped, not failed, if
  // the live dir is unavailable — the suite must not depend on the user's machine.
  let silas = null;
  try {
    silas = JSON.parse(await readFile(path.join(liveUserDir, 'Silas.json'), 'utf8'));
    await writeJson('Silas.json', silas);
  } catch {
    silas = null;
  }

  // ---------------------------------------------------------------------------
  // Stage 2 — synthetic files covering every other shape.
  // ---------------------------------------------------------------------------
  // The two SHIPPED legacy shapes (compact single-line objects, and the expanded
  // multi-line form), kept here as fixtures so this suite exercises legacy
  // acceptance even after the shipped personas are canonicalized.
  await writeJson('legacy-compact.json', {
    name: 'legacy-compact',
    identity: { role: 'a dry, sardonic wit', backstory: 'You have seen enough to find most things faintly ridiculous.', values: ['irony', 'clarity'], goals: ['say the uncomfortable thing with a straight face'] },
    traits: { formality: 5, warmth: 2, humor: 7, verbosity: 4, directness: 6, chaos: 4 },
    voice: { catchphrases: ['Delightful.'], taboo: ['sincerity about trivial things'] },
    behavior: { greeting: 'Acknowledge the situation with faint amusement.', disagreement: 'Understate the disagreement.', uncertainty: 'Treat uncertainty as the default, dryly.', errorHandling: 'Note the failure without alarm.' },
    boundaries: { always: ['be accurate under the sarcasm'], never: ['be cruel'] },
    examples: ["Q: How's the project going?\nA: Swimmingly, if by swimmingly you mean on fire, but slowly."],
    parameters: { temperature: 0.7, maxTokens: 400 },
    composition: { archetype: null },
  });
  await writeJson('legacy-expanded.json', {
    name: 'legacy-expanded',
    identity: { role: 'a terse senior systems engineer', backstory: 'Decades of on-call experience burned away every unnecessary word.', values: ['precision', 'brevity'], goals: ['give the correct answer in the fewest tokens'] },
    traits: { formality: 6, warmth: 2, humor: 1, verbosity: 1, directness: 9, chaos: 2 },
    voice: { catchphrases: ['Done.', 'Wrong. Next.'], taboo: ['filler words', 'apologies'] },
    behavior: { greeting: 'Skip greetings. Start with the answer.', disagreement: 'State the correction plainly and move on.', uncertainty: "Say 'Unknown.' instead of hedging.", errorHandling: 'Report the failure in one line, then the fix.' },
    boundaries: { always: ['answer the actual question'], never: ['pad', 'ramble'] },
    examples: ["Q: what's 2+2\nA: 4.", "Q: why did the deploy fail?\nA: Missing env var. Export it, redeploy."],
    parameters: { temperature: 0.2, maxTokens: 300, stop: [] },
    composition: { archetype: null },
  });

  await writeJson('v2-minimal.json', { name: 'v2-minimal', schemaVersion: 2, definition: { identity: 'a minimal but valid persona' } });
  await writeJson('v2-empty.json', { name: 'v2-empty', schemaVersion: 2, definition: {} });
  await writeJson('v2-unknown.json', {
    name: 'v2-unknown',
    schemaVersion: 2,
    favouriteColour: 'blue', // unknown TOP-LEVEL key
    definition: {
      identity: 'a persona with unknown keys',
      favouriteColour: 'also blue', // unknown DEFINITION key
      examples: [{ user: 'q', assistant: 'a', note: 'extra key kept' }],
    },
  });
  await writeJson('v2-wrongtypes.json', {
    name: 'v2-wrongtypes',
    schemaVersion: 2,
    definition: { identity: 12345, expertise: ['not', 'a', 'string'], examples: ['Q: hi\nA: hello'] },
  });
  await writeJson('v99-future.json', { name: 'v99-future', schemaVersion: 99, definition: { identity: 'from the future' } });
  await writeJson('v3-nodef.json', { name: 'v3-nodef', schemaVersion: 3 });
  // `schemaVersion` is OPTIONAL; the `definition` key alone is the schema marker.
  await writeJson('no-version.json', { name: 'no-version', definition: { identity: 'no version marker' } });
  // A definition key holding null is still a definition KEY (authoritative empty).
  await writeJson('null-def.json', { name: 'null-def', schemaVersion: 2, definition: null });
  await writeJson('name-mismatch.json', { name: 'ghostfile', schemaVersion: 2, definition: { identity: 'my filename lies' } });
  await writeRaw('broken.json', '{ this is not json ]');

  const { ctx, reg } = makeMockCtx();
  apply(ctx, { personasDir: dir, autoActivate: '' });
  const service = reg.provided.personas;
  assert.ok(service, 'ctx.personas is provided');

  const waitUntil = async (pred, ms = 4000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return pred();
  };
  const expectedNames = [
    ...[...shippedShapes.values()].map((s) => s.name),
    'legacy-compact', 'legacy-expanded', 'v2-minimal', 'v2-empty', 'v2-unknown', 'v2-wrongtypes',
    'v99-future', 'v3-nodef', 'no-version', 'null-def', 'ghostfile',
    ...(silas ? ['Silas'] : []),
  ];
  assert.ok(await waitUntil(() => expectedNames.every((n) => service.get(n))), 'every loadable file loaded');
  assert.equal(service.get('broken'), undefined, 'the unparseable file is never loaded');

  // This suite writes persona files DIRECTLY, so the directory watcher must not
  // reload underneath an assertion: without closing it, the store can be
  // mid-reload (service.get() momentarily undefined) and a later read throws.
  // Auto-reload is covered by host.test.mjs; here every reload is explicit.
  await waitUntil(() => typeof service._watcher === 'function', 2000);
  if (typeof service._watcher === 'function') service._watcher();

  // ---------------------------------------------------------------------------
  // 1. Every shipped persona is ACCEPTED and produces a real prompt section —
  //    through migration (legacy) or through its stored definition (canonical).
  // ---------------------------------------------------------------------------
  for (const { name, legacy } of shippedShapes.values()) {
    const p = service.get(name);
    assert.ok(p, `shipped persona "${name}" loaded`);
    const r = service.resolvePrompt(p);
    assert.equal(r.migrated, legacy, `"${name}" is ${legacy ? 'reported as migrated (legacy file)' : 'resolved from its definition'}`);
    assert.equal(r.source, legacy ? 'legacy' : 'definition', `"${name}" resolves from the ${legacy ? 'legacy' : 'definition'} path`);
    assert.ok(r.definition.identity.trim().length > 0, `"${name}" yields a non-empty identity`);
    assert.ok(r.definition.communication.trim().length > 0, `"${name}" yields a non-empty communication`);
    assert.equal(r.valid, true, `"${name}" resolves to a valid definition`);
  }

  // The two legacy shapes (the fixtures that used to be the shipped files).
  for (const name of ['legacy-compact', 'legacy-expanded']) {
    const r = service.resolvePrompt(service.get(name));
    assert.equal(r.migrated, true, `"${name}" (legacy) is migrated on read`);
    assert.equal(r.source, 'legacy', `"${name}" reports source legacy`);
    assert.ok(r.definition.behavior.includes('How you interact:'), `"${name}" migrates the behavior object`);
    assert.ok(r.definition.rules.includes('Always:'), `"${name}" migrates the boundaries`);
    assert.ok(r.definition.examples.length > 0 && typeof r.definition.examples[0].user === 'string',
      `"${name}" migrates "Q:/A:" strings into { user, assistant } pairs`);
  }

  // ---------------------------------------------------------------------------
  // 2. The Settings-UI shape (Silas) is ACCEPTED as an authoritative definition.
  // ---------------------------------------------------------------------------
  if (silas) {
    const p = service.get('Silas');
    assert.ok(p, 'Silas loaded');
    assert.equal(p.schemaVersion, 2, 'schemaVersion is preserved');
    assert.deepEqual(p.definition, silas.definition, 'the definition round-trips byte-for-byte');
    const r = service.resolvePrompt(p);
    assert.equal(r.migrated, false, 'a file with a definition key is NOT migrated');
    assert.equal(r.source, 'definition', 'it resolves from the definition');
    assert.equal(r.valid, true, 'the definition is valid');
    assert.deepEqual(r.warnings, [], 'no warnings');

    const insp = service.promptInspection('Silas');
    const names = insp.layers.map((l) => l.name);
    for (const layer of ['deployment:persona-prefix', 'dsh-cast:voice', 'dsh-cast:behavior', 'dsh-cast:expertise', 'dsh-cast:rules']) {
      assert.ok(names.includes(layer), `Silas produces the ${layer} layer`);
    }
    assert.deepEqual(insp.totals.truncatedLayers, [], 'no Silas layer is truncated');
    assert.deepEqual(insp.totals.overBudgetLayers, [], 'no Silas layer is over budget');

    // The HTTP surface agrees with the service (the exact call the Settings UI makes).
    const route = reg.routes.find((r) => r.path === '/api/dsh-cast/get');
    const res = await route.fetch(new Request('http://localhost/api/dsh-cast/get?name=Silas', { method: 'GET' }));
    assert.equal(res.status, 200, 'GET /api/dsh-cast/get?name=Silas returns 200');
    const body = await res.json();
    assert.equal(body.migrated, false, 'the route reports migrated: false');
    assert.deepEqual(body.persona.definition, silas.definition, 'the route returns the same definition');
  } else {
    console.log('note: live Silas.json not readable; skipped the Settings-UI-shape assertions');
  }

  // ---------------------------------------------------------------------------
  // 3. Minimal / empty definitions.
  // ---------------------------------------------------------------------------
  const minimal = service.resolvePrompt(service.get('v2-minimal'));
  assert.equal(minimal.migrated, false, 'a minimal definition-only file is authoritative');
  assert.equal(minimal.definition.identity, 'a minimal but valid persona', 'its identity is preserved');

  const empty = service.promptInspection('v2-empty');
  const emptyLayers = empty.layers.map((l) => l.name);
  assert.ok(emptyLayers.includes('deployment:persona-prefix'), 'an empty definition still anchors identity');
  for (const gone of ['dsh-cast:voice', 'dsh-cast:behavior', 'dsh-cast:expertise', 'dsh-cast:rules', 'dsh-cast:examples']) {
    assert.ok(!emptyLayers.includes(gone), `an empty definition produces no ${gone} layer`);
  }
  assert.match(empty.layers.find((l) => l.name === 'deployment:persona-prefix').text, /You are v2-empty\./,
    'an empty definition falls back to "You are <name>."');

  // ---------------------------------------------------------------------------
  // 4. Unknown keys are accepted and DROPPED (top-level and inside definition).
  // ---------------------------------------------------------------------------
  const unknown = service.get('v2-unknown');
  assert.equal(unknown.favouriteColour, undefined, 'an unknown top-level key is dropped on load');
  assert.equal(unknown.definition.favouriteColour, undefined, 'an unknown definition key is dropped');
  assert.equal(unknown.definition.identity, 'a persona with unknown keys', 'known fields survive alongside unknown ones');
  // Unknown keys inside an example pair are NOT stripped (examples pass through) —
  // pinned so the behaviour is a decision, not a surprise.
  assert.deepEqual(unknown.definition.examples, [{ user: 'q', assistant: 'a', note: 'extra key kept' }],
    'extra keys inside an example pair survive');
  assert.equal(service.resolvePrompt(unknown).valid, true, 'unknown keys do not invalidate the definition');

  // ---------------------------------------------------------------------------
  // 5. Wrong field TYPES are tolerated on read (a bad file degrades, never crashes).
  // ---------------------------------------------------------------------------
  const wrong = service.get('v2-wrongtypes');
  assert.ok(wrong, 'a file with wrong field types still loads');
  const wrongPrompt = service.promptInspection('v2-wrongtypes');
  const wrongNames = wrongPrompt.layers.map((l) => l.name);
  assert.match(wrongPrompt.layers.find((l) => l.name === 'deployment:persona-prefix').text, /You are v2-wrongtypes\./,
    'a non-string identity degrades to the name fallback instead of crashing');
  assert.ok(!wrongNames.includes('dsh-cast:expertise'), 'a non-string expertise produces no section');
  assert.ok(!wrongNames.includes('dsh-cast:examples'), 'string examples are ignored rather than mis-rendered');

  // ---------------------------------------------------------------------------
  // 6. schemaVersion is metadata, not a gate: unknown versions still load.
  // ---------------------------------------------------------------------------
  assert.equal(service.get('v99-future').schemaVersion, 99, 'a future schemaVersion is preserved, not rejected');
  assert.equal(service.resolvePrompt(service.get('v99-future')).migrated, false, 'a future version with a definition still resolves');
  const v3 = service.get('v3-nodef');
  assert.equal(v3.schemaVersion, 3, 'schemaVersion without a definition is preserved');
  assert.equal(service.resolvePrompt(v3).migrated, true, 'schemaVersion without a definition is still treated as legacy');
  // schemaVersion is optional: the definition key alone marks the v2 schema, and the
  // marker is added on the next save.
  const noVersion = service.get('no-version');
  assert.equal(noVersion.definition.identity, 'no version marker', 'a definition without schemaVersion is accepted');
  assert.equal(service.resolvePrompt(noVersion).migrated, false, 'it is still authoritative (not migrated)');
  await service.editPersona('no-version', JSON.stringify({ definition: noVersion.definition }));
  assert.equal(service.get('no-version').schemaVersion, 2, 'saving adds the schemaVersion marker');
  // A `definition` key holding null is still a definition KEY.
  const nullDef = service.get('null-def');
  assert.equal(service.resolvePrompt(nullDef).migrated, false, 'definition: null counts as "has a definition"');
  assert.match(service.promptInspection('null-def').layers.find((l) => l.name === 'deployment:persona-prefix').text,
    /You are null-def\./, 'definition: null degrades to the name anchor');

  // ---------------------------------------------------------------------------
  // 7. Identity is the `name` field, NOT the filename.
  // ---------------------------------------------------------------------------
  assert.ok(service.get('ghostfile'), 'the record is keyed by its `name` field');
  assert.equal(service.get('name-mismatch'), undefined, 'the filename is not used as a key');
  // ...and writing that record back creates a SECOND file, leaving the first as a
  // ghost. Pinned because "keep name === filename" is a real authoring rule.
  await service.editPersona('ghostfile', JSON.stringify({ definition: { identity: 'edited' } }));
  const filesAfterEdit = await readdir(dir);
  assert.ok(filesAfterEdit.includes('ghostfile.json'), 'the edit wrote <name>.json');
  assert.ok(filesAfterEdit.includes('name-mismatch.json'),
    'the original mismatched file is left behind as a ghost (two files, one persona)');

  // ---------------------------------------------------------------------------
  // 8. A single unparseable file never takes the store down.
  // ---------------------------------------------------------------------------
  assert.ok(service.get('v2-minimal'), 'the other personas still loaded despite broken.json');

  // ---------------------------------------------------------------------------
  // 9. WRITE path is strict where the READ path is permissive.
  // ---------------------------------------------------------------------------
  await service.createPersona('write-target', { definition: { identity: 'seed' } });
  const before = JSON.stringify(service.get('write-target').definition);
  await assert.rejects(
    () => service.editPersona('write-target', JSON.stringify({ definition: { examples: ['Q: a\nA: b'] } })),
    /invalid persona definition[\s\S]*examples/,
    'string examples are REJECTED on write (even though they are tolerated on read)',
  );
  await assert.rejects(
    () => service.editPersona('write-target', JSON.stringify({ definition: { identity: 42 } })),
    /must be a string/,
    'a non-string text field is REJECTED on write',
  );
  assert.equal(JSON.stringify(service.get('write-target').definition), before, 'rejected edits left the stored definition intact');
  // The accepted form of the same intent:
  await service.editPersona('write-target', JSON.stringify({ definition: { examples: [{ user: 'a', assistant: 'b' }] } }));
  assert.deepEqual(service.get('write-target').definition.examples, [{ user: 'a', assistant: 'b' }],
    'the { user, assistant } form of the same edit is accepted');
  // Unknown keys on a WRITE are accepted and dropped, never stored.
  await service.createPersona('write-unknown', { definition: { identity: 'ok', nonsense: true } });
  assert.equal(service.get('write-unknown').definition.nonsense, undefined, 'unknown keys are dropped on write too');

  // ---------------------------------------------------------------------------
  // 10. Canonicalization is PROMPT-PRESERVING.
  //     Adding `definition` + `schemaVersion: 2` to a legacy file (what
  //     tools/canonicalize-personas.mjs does) must not change one byte of prompt.
  //     Driven by the legacy fixtures, so this holds no matter what shape the
  //     shipped personas happen to be in.
  // ---------------------------------------------------------------------------
  const canonicalized = [];
  for (const name of ['legacy-compact', 'legacy-expanded']) {
    const legacyPrompt = service.composePersonaSystem(service.get(name));
    const migratedDefinition = service.resolvePrompt(service.get(name)).definition;
    // Exactly the canonical file the tool writes: original keys untouched, plus
    // schemaVersion + the resolver's own migration output.
    await writeJson(`${name}.json`, { ...service.get(name), schemaVersion: 2, definition: migratedDefinition });
    canonicalized.push({ name, legacyPrompt });
  }
  await service.loadUser(); // the write bypassed the service (and the watcher is off)
  for (const { name, legacyPrompt } of canonicalized) {
    const p = service.get(name);
    assert.ok(p, `"${name}" reloaded after canonicalization`);
    assert.equal(service.resolvePrompt(p).migrated, false, `"${name}" now resolves from its stored definition`);
    assert.equal(p.schemaVersion, 2, `"${name}" now carries schemaVersion 2`);
    assert.equal(service.composePersonaSystem(p), legacyPrompt,
      `canonicalizing "${name}" did not change a byte of the composed prompt`);
    // The legacy fields the other features read are still there, untouched.
    assert.equal(typeof p.traits.verbosity, 'number', `"${name}" keeps its legacy traits for routing/mix`);
    assert.ok(Array.isArray(p.voice.catchphrases), `"${name}" keeps its legacy voice for exports`);
    assert.equal(typeof p.parameters.temperature, 'number', `"${name}" keeps its sampling parameters`);
  }

  console.log('ALL PERSONA-FILE ACCEPTANCE TESTS PASSED');
  process.exit(0);
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
