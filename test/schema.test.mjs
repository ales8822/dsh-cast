// Standalone test for the structured natural-language persona schema, migration,
// and canonical prompt resolution (the "sliders -> six fields" refactor).
//
// Runs the REAL index.js through apply() against a mock Cordis context, exactly
// like host.test.mjs, but focuses on what changed: the six-field `definition`,
// legacy migration (idempotent, non-destructive), the deterministic resolver, and
// the prompt-layer mapping with source attribution.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

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

function mockAgent(id) {
  const sectionNames = [];
  return {
    id,
    sectionNames,
    ctx: {
      effect(fn) {
        const d = fn();
        return () => (typeof d === 'function' ? d() : undefined);
      },
      systemPrompt: { section(def) { sectionNames.push(def?.name); return () => {}; } },
    },
  };
}

const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cast-schema-'));

try {
  const { ctx, reg } = makeMockCtx();
  apply(ctx, { personasDir: dir, autoActivate: '', tokenBudget: { identity: 400 } });
  const service = reg.provided.personas;
  assert.ok(service, 'ctx.personas is provided');

  const deadline = Date.now() + 5000;
  while (service.list().length < 10 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }

  // ---------------------------------------------------------------------------
  // 1. New persona with all six fields round-trips through the store.
  // ---------------------------------------------------------------------------
  const six = {
    identity: 'a meticulous database engineer',
    expertise: 'Postgres internals and query tuning',
    behavior: 'Probes assumptions with Socratic questions',
    communication: 'Concise, structured, bullet points',
    rules: 'Never guess about schema migrations; always show the SQL',
    examples: [{ user: 'why is this query slow?', assistant: 'Run EXPLAIN and check the row estimate.' }],
  };
  await service.createPersona('full', { definition: six });
  const full = service.get('full');
  assert.equal(full.name, 'full', 'name preserved');
  assert.deepEqual(full.definition, six, 'all six fields round-trip through the store');
  assert.equal(full.schemaVersion, 2, 'a persona with a definition is schema version 2');

  // ---------------------------------------------------------------------------
  // 2. Every field maps to its intended prompt section, with source metadata.
  // ---------------------------------------------------------------------------
  const insp = service.promptInspection('full');
  const layer = Object.fromEntries(insp.layers.map((l) => [l.name, l]));
  assert.deepEqual(layer['deployment:persona-prefix'].sources, ['identity'], 'identity -> persona-prefix');
  assert.deepEqual(layer['dsh-cast:voice'].sources, ['communication'], 'communication -> voice');
  assert.deepEqual(layer['dsh-cast:behavior'].sources, ['behavior'], 'behavior -> its own section');
  assert.deepEqual(layer['dsh-cast:expertise'].sources, ['expertise'], 'expertise -> its own section');
  assert.deepEqual(layer['dsh-cast:rules'].sources, ['rules'], 'rules -> its own section');
  assert.deepEqual(layer['dsh-cast:examples'].sources, ['examples'], 'examples -> examples');
  assert.ok(layer['deployment:persona-prefix'].text.includes('a meticulous database engineer'), 'identity text reaches the prefix');
  assert.ok(layer['dsh-cast:voice'].text.includes('Concise, structured, bullet points'), 'communication text reaches the voice layer');
  assert.ok(layer['dsh-cast:behavior'].text.includes('Socratic questions'), 'behavior text reaches the behavior layer');
  assert.ok(layer['dsh-cast:expertise'].text.includes('Postgres internals'), 'expertise text reaches its own layer');
  assert.ok(layer['dsh-cast:rules'].text.includes('Never guess'), 'rules text reaches its own layer');
  assert.ok(layer['dsh-cast:examples'].text.includes('why is this query slow?'), 'example user text reaches the examples layer');
  assert.ok(layer['dsh-cast:examples'].text.includes('Run EXPLAIN'), 'example assistant text reaches the examples layer');
  // The three "how it behaves" fields are three sections, each with its own
  // budget, so one field can never truncate another.
  assert.equal(layer['dsh-cast:behavior'].budgetTokens, 300, 'behavior reports its own budget');
  assert.equal(layer['dsh-cast:expertise'].budgetTokens, 300, 'expertise reports its own budget');
  assert.equal(layer['dsh-cast:rules'].budgetTokens, 300, 'rules reports its own budget');
  assert.equal(insp.migrated, false, 'a defined persona is not reported as migrated');
  assert.equal(insp.source, 'definition', 'the resolver reports source "definition"');

  // ---------------------------------------------------------------------------
  // 3. Empty optional fields do not create misleading or duplicated sections.
  // ---------------------------------------------------------------------------
  await service.createPersona('sparse', { definition: { identity: 'a sparse persona', rules: 'Only answer with code.' } });
  const sparse = service.promptInspection('sparse');
  const sparseRules = sparse.layers.find((l) => l.name === 'dsh-cast:rules');
  assert.ok(sparseRules, 'a populated rules field produces its own section');
  assert.deepEqual(sparseRules.sources, ['rules'], 'the rules section is sourced only from rules');
  assert.ok(sparseRules.text.includes('Only answer with code.'), 'rules content is present');
  assert.equal(sparse.layers.find((l) => l.name === 'dsh-cast:behavior'), undefined, 'no behavior section when behavior is empty');
  assert.equal(sparse.layers.find((l) => l.name === 'dsh-cast:expertise'), undefined, 'no expertise section when expertise is empty');
  assert.equal(sparse.layers.find((l) => l.name === 'dsh-cast:voice'), undefined, 'no voice layer when communication is empty');
  assert.equal(sparse.layers.find((l) => l.name === 'dsh-cast:examples'), undefined, 'no examples layer when examples is empty');
  assert.ok(sparse.layers.find((l) => l.name === 'deployment:persona-prefix').text.includes('a sparse persona'),
    'identity still present for a sparse persona');

  // A persona with an entirely empty definition still gets an identity anchor.
  await service.createPersona('blank', { definition: {} });
  const blank = service.promptInspection('blank');
  assert.ok(blank.layers.find((l) => l.name === 'deployment:persona-prefix').text.includes('You are blank.'),
    'an empty definition falls back to "You are <name>"');

  // ---------------------------------------------------------------------------
  // 4. Legacy migration: non-destructive, idempotent, deterministic.
  // ---------------------------------------------------------------------------
  await service.createPersona('legacy', {
    identity: { role: 'a terse systems engineer', backstory: 'on-call since 2004' },
    traits: { formality: 6, warmth: 2, humor: 1, verbosity: 1, directness: 9, chaos: 2 },
    voice: { catchphrases: ['Done.'], taboo: ['apologies'] },
    behavior: { greeting: 'Skip greetings.' },
    boundaries: { always: ['answer the question'], never: ['ramble'] },
    examples: ['Q: 2+2\nA: 4.'],
  });
  const legacy = service.get('legacy');
  // The legacy fields survive migration untouched.
  assert.equal(legacy.traits.verbosity, 1, 'legacy traits are preserved (not deleted)');
  assert.equal(legacy.identity.role, 'a terse systems engineer', 'legacy identity is preserved');
  assert.equal(legacy.schemaVersion, undefined, 'a legacy persona carries no schemaVersion marker');
  assert.equal(legacy.definition, undefined, 'a legacy persona is NOT rewritten with a definition just by loading');

  const r1 = service.resolvePrompt(service.get('legacy'));
  const r2 = service.resolvePrompt(service.get('legacy'));
  assert.deepEqual(r1, r2, 'repeated resolution is deterministic (idempotent)');
  assert.equal(r1.migrated, true, 'a legacy persona reports migrated: true');
  assert.equal(r1.source, 'legacy', 'the resolver reports source "legacy"');
  assert.ok(r1.definition.identity.includes('a terse systems engineer'), 'migration reuses the legacy role in identity');
  assert.ok(r1.definition.communication.includes('Voice and style'), 'migration maps traits+voice into communication');
  assert.ok(r1.definition.communication.includes('verbosity: be terse'), 'migration maps the verbosity trait via the documented wording');
  assert.ok(r1.definition.behavior.includes('Skip greetings.'), 'migration maps behavior into behavior');
  assert.ok(r1.definition.rules.includes('Always: answer the question'), 'migration maps boundaries into rules');
  assert.deepEqual(r1.definition.examples, [{ user: '2+2', assistant: '4.' }], 'migration parses legacy examples into pairs');

  // Loading again must not duplicate or lose anything.
  await service.loadUser();
  const r3 = service.resolvePrompt(service.get('legacy'));
  assert.deepEqual(r3.definition, r1.definition, 'a reload produces the identical migrated definition');

  // ---------------------------------------------------------------------------
  // 5. Missing legacy fields / malformed legacy records degrade safely.
  // ---------------------------------------------------------------------------
  // Writing persona files directly while the directory watcher is live can race
  // with an automatic reload, so poll for the loaded record (same pattern the
  // startup wait above uses) rather than assuming a single loadUser() wins.
  const waitForPersona = async (name) => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const p = service.get(name);
      if (p) return p;
      await new Promise((r) => setTimeout(r, 25));
    }
    return service.get(name);
  };

  await writeFile(path.join(dir, 'bare.json'), JSON.stringify({ name: 'bare' }), 'utf8');
  await service.loadUser();
  const barePersona = await waitForPersona('bare');
  assert.ok(barePersona, 'a bare legacy record loads');
  const bare = service.resolvePrompt(barePersona);
  assert.equal(bare.migrated, true, 'a bare legacy record is migrated');
  assert.equal(bare.definition.identity, 'You are bare.', 'a role-less legacy record falls back to its name');

  await writeFile(path.join(dir, 'weird.json'), JSON.stringify({
    name: 'weird',
    examples: [123, 'not-a-pair'],
    traits: { formality: 'not-a-number' },
  }), 'utf8');
  await service.loadUser();
  const weirdPersona = await waitForPersona('weird');
  assert.ok(weirdPersona, 'a malformed legacy record still loads');
  const weird = service.resolvePrompt(weirdPersona);
  assert.equal(weird.migrated, true, 'a malformed legacy record still migrates');
  assert.ok(Array.isArray(weird.definition.examples) && weird.definition.examples.length === 2,
    'malformed legacy examples are coerced, not dropped or thrown');
  await service.remove('bare');
  await service.remove('weird');

  // Directly exercising the resolver on a raw minimal object (what the loader
  // produces for a `{ name }` file) proves migration is total, not load-dependent.
  const rawMigrated = service.resolvePrompt({ name: 'raw', identity: {}, traits: {}, voice: {}, behavior: {}, boundaries: {}, examples: [], parameters: {}, composition: {} });
  assert.equal(rawMigrated.migrated, true, 'a raw minimal object migrates');
  assert.equal(rawMigrated.definition.identity, 'You are raw.', 'raw migration falls back to the name');

  // ---------------------------------------------------------------------------
  // 6. Invalid edits leave the last valid definition intact.
  // ---------------------------------------------------------------------------
  await service.createPersona('valid', { definition: { identity: 'ok', examples: [{ user: 'u', assistant: 'a' }] } });
  const before = JSON.stringify(service.get('valid').definition);
  await assert.rejects(
    () => service.editPersona('valid', JSON.stringify({ definition: { examples: 'not-an-array' } })),
    /invalid persona definition/,
    'a non-array examples field is rejected',
  );
  await assert.rejects(
    () => service.editPersona('valid', JSON.stringify({ definition: { examples: [{ user: 'missing assistant' }] } })),
    /examples\[0\]/,
    'a malformed example pair is rejected with a field-specific error',
  );
  await assert.rejects(
    () => service.editPersona('valid', JSON.stringify({ definition: { identity: 'x'.repeat(9000) } })),
    /too long/,
    'an over-long text field is rejected',
  );
  assert.equal(JSON.stringify(service.get('valid').definition), before, 'invalid edits leave the stored definition intact');

  // ---------------------------------------------------------------------------
  // 7. Preview and activation use the same resolver; preview is side-effect-free.
  // ---------------------------------------------------------------------------
  const agent = mockAgent('schema-act');
  reg.agents.set('schema-act', { agent });
  service.activate(agent, 'full');
  assert.equal(service.active(agent), 'full', 'activation succeeded');
  assert.deepEqual(agent.sectionNames, [
    'deployment:persona-prefix', 'dsh-cast:voice', 'dsh-cast:behavior',
    'dsh-cast:expertise', 'dsh-cast:rules', 'dsh-cast:examples',
  ], 'activation registers the same ordered layers the resolver produces');

  const joined = service.promptInspection('full').layers.map((l) => l.text).join('\n\n');
  assert.equal(joined, service.composePersonaSystem(service.get('full')),
    'preview and composePersonaSystem() agree — no drift between preview and the live prompt');

  const sectionsAfter = agent.sectionNames.length;
  service.promptInspection('sparse'); // pure read of another persona
  assert.equal(service.active(agent), 'full', 'previewing a different persona did not change the active persona');
  assert.equal(agent.sectionNames.length, sectionsAfter, 'previewing registered no prompt sections');

  // ---------------------------------------------------------------------------
  // 8. Budget reporting + truncation still work for definition-sourced layers.
  // ---------------------------------------------------------------------------
  await service.createPersona('huge', { definition: { identity: 'x'.repeat(3000) } });
  const huge = service.promptInspection('huge');
  const ident = huge.layers.find((l) => l.name === 'deployment:persona-prefix');
  assert.equal(ident.truncated, true, 'an over-long identity layer is marked truncated');
  assert.equal(ident.overBudget, true, 'an over-long identity layer is over budget');
  assert.ok(huge.totals.overBudgetLayers.includes('deployment:persona-prefix'), 'totals list the over-budget layer');
  assert.equal(ident.budgetTokens, 400, 'the identity layer reports its configured budget');

  // ---------------------------------------------------------------------------
  // 9. Isolated model calls use the CONFIGURED default model, not the first
  //    registered provider, and surface a failed stream instead of ''.
  //
  // This is the regression for "Try persona is not working": the old helper called
  // `llm.listProviders()[0]`, whose route is arbitrary and was not the configured
  // one, so the stream produced no text and the helper returned an empty string
  // (HTTP 200, blank response). It now reads ctx.agentDefaultModel.
  // ---------------------------------------------------------------------------
  {
    const calls = [];
    const modelCtx = {
      ...ctx,
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' }),
      },
      llm: {
        listProviders: () => [{ id: 'wrong-first-route' }],
        listModels: async () => [{ id: 'wrong-model' }],
        stream: (options) => {
          calls.push(options);
          return (async function* yieldText() {
            yield { type: 'text-delta', index: 0, text: 'OK' };
            yield { type: 'finish', reason: { kind: 'stop' } };
          })();
        },
      },
    };
    const svc = new (Object.getPrototypeOf(service).constructor)(modelCtx, { personasDir: dir });
    await svc.start();
    const out = await svc.tryPersona('terse', 'hi');
    assert.equal(out.response, 'OK', 'the isolated call returns the streamed text');
    assert.equal(calls.length, 1, 'exactly one model call is made');
    assert.equal(calls[0].provider, 'deepseek-official', 'uses the configured provider, not listProviders()[0]');
    assert.equal(calls[0].model, 'deepseek-flash', 'uses the configured model');
    assert.equal(calls[0].reasoningEffort, 'high', 'passes the configured reasoning effort');
    assert.ok(calls[0].system.includes('You are'), 'passes the composed persona system prompt');
    // RequestMessage.content must be a ContentBlock[] — a bare string throws inside
    // the provider adapter (`content.flatMap is not a function`) and surfaces only as
    // "DeepSeek Messages transport failed".
    assert.deepEqual(calls[0].messages[0].content, [{ type: 'text', text: 'hi' }],
      'the sample message is normalized to a text content block, not a bare string');

    // A stream that fails with no text must THROW, not silently return ''.
    const failCtx = {
      ...modelCtx,
      llm: {
        ...modelCtx.llm,
        stream: () => (async function* yieldFail() {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'bad key' } } };
        })(),
      },
    };
    const failSvc = new (Object.getPrototypeOf(service).constructor)(failCtx, { personasDir: dir });
    await failSvc.start();
    await assert.rejects(
      () => failSvc.tryPersona('terse', 'hi'),
      /bad key/,
      'a failed stream surfaces an error instead of an empty response',
    );

    // With no agentDefaultModel service, provider discovery still works.
    const fbCtx = {
      ...ctx,
      llm: {
        listProviders: () => [{ id: 'only' }],
        listModels: async () => [{ id: 'only-model' }],
        stream: () => (async function* yieldFb() { yield { type: 'text-delta', index: 0, text: 'FB' }; })(),
      },
    };
    const fbSvc = new (Object.getPrototypeOf(service).constructor)(fbCtx, { personasDir: dir });
    await fbSvc.start();
    assert.equal((await fbSvc.tryPersona('terse', 'hi')).response, 'FB', 'provider discovery remains the fallback');
  }

  console.log('ALL SCHEMA TESTS PASSED');
  process.exit(0);
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
