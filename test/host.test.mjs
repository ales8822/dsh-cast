// Standalone unit test for the dsh-cast host half (Phase 1 + Phase 2).
// Runs `apply(ctx, config)` against a mock Cordis context and asserts the
// registrations, store, composer, CRUD, and confirmation logic — the parts that
// cannot be live-verified until a host restart.
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

function makeMockCtx() {
  const reg = { commands: [], tools: [], routes: [], events: {}, provided: {}, agents: new Map() };
  const ctx = {
    effect(fn, _label) {
      const disposer = fn();
      return () => (typeof disposer === 'function' ? disposer() : undefined);
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
    // === BEGIN memory-engineer (t2): inject-capable agent registry ===
    // phase6-contract.md item 3: the mock MUST be able to reach an Agent carrying
    // .inject. A `Map` keeps a MISSING id testable (`agents.get` -> undefined, so
    // /api/dsh-cast/activate still 400s, the case every existing test relies on).
    agents: {
      get(id) { return reg.agents.get(String(id ?? ''))?.agent; },
      // DETERMINISTIC: returns the most recently registered agent, and `reg`
      // exposes `initiator` so a test can pin it. Returning "whichever Map entry
      // happens to be first" made this assertion depend on the REGISTRATION ORDER
      // of every other test in the file, which silently broke when earlier tests
      // added agents (t7 repair round 1 hit exactly that).
      currentInitiator() { return reg.initiator ?? [...reg.agents.values()].at(-1)?.agent; },
    },
    // === END memory-engineer (t2) ===
    connection: { fetch: { register(route) { reg.routes.push(route); return async () => {}; } } },
    systemPrompt: { section() { return () => {}; }, getSectionOrder() { return 0; } },
    sessions: { get() { return { deriveMessages() { return [{ content: 'word '.repeat(120) }]; } }; } },
    llm: {
      listProviders() { return [{ id: 'mock' }]; },
      async listModels() { return [{ id: 'mock-model' }]; },
      async *stream() { yield { type: 'text-delta', text: 'MOCK_RESPONSE' }; },
    },
  };
  return { ctx, reg };
}

function mockAgent(id) {
  // Records every prompt section registered on this agent, so a test can prove
  // that merely READING the active persona performed NO activation. activate()
  // disposes and re-registers these; a pure read must add nothing. (F1)
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

// === BEGIN memory-engineer (t2): inject-recording agent ===
// phase6-contract.md item 3's minimum mock upgrade, extended for workstream B:
//   - `inject(message)` RECORDS every message, so the token budget can be checked
//     against what was actually handed to inject() (item 3, point 5).
//   - `inbox` / `idleDelay` let the batch-level re-delivery guard and the
//     "never wake an idle driver" rule be exercised.
//   - `throwingInject` exercises the failure path without changing the shape.
// CAVEAT the contract demands we not paper over (item 3): this mock cannot
// reproduce the real wake/claim/discard TIMING of agent.inject(). These tests
// prove WHICH message was passed to inject() and the plugin-side decision logic,
// not the harness step semantics.
function injectableAgent(id, options = {}) {
  const agent = mockAgent(String(id));
  agent.id = String(id);
  agent.injected = [];
  agent.inject = (message) => {
    if (options.throwingInject) throw new Error('inject exploded');
    agent.injected.push(message);
  };
  agent.inbox = options.inbox ?? { nextStep: [], nextTurn: [] };
  agent.idleDelay = options.idleDelay ?? 0;
  return agent;
}
// === END memory-engineer (t2) ===

const dir = await mkdtemp(path.join(tmpdir(), 'dsh-cast-test-'));

try {
  const { ctx, reg } = makeMockCtx();
  apply(ctx, { personasDir: dir, autoActivate: '', setPersonaConfirm: true, tokenBudget: { identity: 400 }, summaryThreshold: 50 });
  const service = reg.provided.personas;
  assert.ok(service, 'ctx.personas is provided');

  // wait for async start() to load built-ins and write the report
  const deadline = Date.now() + 5000;
  while (service.list().length < 10 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }

  // -- store: built-ins load -------------------------------------------------
  assert.ok(service.list().length >= 10, `10+ built-ins load (got ${service.list().length})`);
  for (const n of ['chaotic', 'terse', 'warm', 'socratic', 'pirate', 'professor']) {
    assert.ok(service.list().includes(n), `${n} loads`);
  }

  // -- command --------------------------------------------------------------
  assert.equal(reg.commands.length, 1, 'one command registered');
  assert.equal(reg.commands[0].name, 'persona');

  // -- tools ----------------------------------------------------------------
  const toolNames = reg.tools.map((t) => t.name).sort();
  assert.deepEqual(toolNames, ['create_persona', 'list_personas', 'set_persona'], '3 tools registered');
  const setPersona = reg.tools.find((t) => t.name === 'set_persona');
  assert.ok(setPersona.parameters.required.includes('persona'), 'set_persona requires persona');

  // -- HTTP API -------------------------------------------------------------
  const routes = reg.routes.map((r) => `${r.methods.join(',')} ${r.path}`).sort();
  assert.deepEqual(routes, [
    'GET /api/dsh-cast/active',
    'GET /api/dsh-cast/get',
    'GET /api/dsh-cast/list',
    'GET /api/dsh-cast/preview',
    'POST /api/dsh-cast/activate',
    'POST /api/dsh-cast/compare',
    'POST /api/dsh-cast/create',
    'POST /api/dsh-cast/delete',
    'POST /api/dsh-cast/edit',
    'POST /api/dsh-cast/try',
  ], '10 HTTP routes registered (activate handles "off" for deactivate; active is the read-only read; try is isolated)');

  // -- confirmation mode ----------------------------------------------------
  const confirmListeners = reg.events['tools/pre-execute'] ?? [];
  assert.ok(confirmListeners.length >= 1, 'tools/pre-execute listener registered');
  const confirm = confirmListeners[0];
  const ask = confirm({ name: 'set_persona', arguments: { persona: 'terse' } }, () => ({ kind: 'allow' }));
  assert.equal(ask.kind, 'ask', 'set_persona asks when confirmation is on');
  const allow = confirm({ name: 'list_personas', arguments: {} }, () => ({ kind: 'allow' }));
  assert.equal(allow.kind, 'allow', 'other tools pass through');

  // -- composer: 3 distinct layered prompts ---------------------------------
  let report = null;
  const reportDeadline = Date.now() + 5000;
  while (Date.now() < reportDeadline) {
    try {
      report = JSON.parse(await readFile(path.join(dir, '.dsh-cast-report.json'), 'utf8'));
      if (report && report.personas && report.personas.length >= 10) break;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(report && report.personas.length === 10, 'report has all personas');
  const identities = new Set(report.personas.map((p) => p.layers.find((l) => l.name === 'deployment:persona-prefix').text));
  assert.equal(identities.size, 10, 'identity layers are distinct per persona');
  for (const p of report.personas) {
    // Every built-in is a legacy persona with behavior + boundaries, so migration
    // fills behavior AND rules; none carries legacy expertise, so no expertise
    // layer is emitted. Each of the six fields that has content gets its OWN
    // section (the split that keeps one field from truncating another).
    assert.deepEqual(
      p.layers.map((l) => l.name),
      ['deployment:persona-prefix', 'dsh-cast:voice', 'dsh-cast:behavior', 'dsh-cast:rules', 'dsh-cast:examples'],
      `${p.name} layers in priority order`,
    );
    assert.ok(p.layers.every((l) => typeof l.text === 'string' && l.text.length > 0), `${p.name} layers non-empty`);
  }

  // -- CRUD round-trip ------------------------------------------------------
  await service.createPersona('testy', { traits: { verbosity: 1 } });
  assert.ok(service.list().includes('testy'), 'createPersona adds to list');
  assert.equal(service.get('testy').traits.verbosity, 1, 'createPersona stores traits');
  await service.editPersona('testy', JSON.stringify({ traits: { verbosity: 2, chaos: 5 } }));
  assert.equal(service.get('testy').traits.verbosity, 2, 'editPersona merges');
  await service.deletePersona('testy');
  assert.ok(!service.list().includes('testy'), 'deletePersona removes');

  // -- export / import ------------------------------------------------------
  const exported = JSON.parse(service.exportPersona('terse'));
  assert.equal(exported.name, 'terse', 'exportPersona returns JSON');
  await service.importPersona(JSON.stringify({ name: 'imported', identity: { role: 'x' } }));
  assert.ok(service.list().includes('imported'), 'importPersona adds');
  await service.deletePersona('imported');

  // -- Phase 3: state drift --------------------------------------------------
  assert.equal(service.getState('terse'), null, 'no state initially');
  const s1 = service.advanceState('terse');
  assert.equal(s1.familiarity, 1, 'familiarity increments per turn');
  assert.equal(s1.energy, 6, 'energy fatigues by 1 (from 7)');
  const s2 = service.advanceState('terse');
  assert.equal(s2.familiarity, 2, 'familiarity increments again');
  assert.equal(s2.energy, 5, 'energy fatigues again');
  assert.equal(typeof s2.mood, 'number', 'mood is derived');
  const s3 = service.advanceState('terse', { error: true });
  assert.ok(s3.trust < s2.trust, 'trust drops on error');

  // -- Phase 3: memory scoping + isolation -----------------------------------
  await service.addMemory('persona', 'terse', 'likes short answers');
  await service.addMemory('persona', 'warm', 'prefers encouragement');
  await service.addMemory('global', null, 'everyone knows this');
  await service.addMemory('conversation', '*', 'session note', 'session-1');
  const terseMemories = service.listMemories('terse', 'session-1').map((m) => m.text);
  assert.ok(terseMemories.includes('likes short answers'), 'terse sees its own persona memory');
  assert.ok(terseMemories.includes('everyone knows this'), 'terse sees global');
  assert.ok(terseMemories.includes('session note'), 'terse sees conversation for its session');
  assert.ok(!terseMemories.includes('prefers encouragement'), 'terse does NOT see warm memory (isolation)');
  const warmMemories = service.listMemories('warm', 'session-1').map((m) => m.text);
  assert.ok(!warmMemories.includes('likes short answers'), 'warm does NOT see terse memory (isolation)');
  assert.ok(warmMemories.includes('prefers encouragement'), 'warm sees its own');
  assert.ok(
    !service.listMemories('terse', 'other-session').map((m) => m.text).includes('session note'),
    'conversation memory is session-scoped',
  );

  // -- Phase 3: memory command ----------------------------------------------
  const agent = { id: 'session-1' };
  const addResult = service.memoryCommand(['terse', 'add', 'call me on Friday'], agent);
  assert.equal(addResult.kind, 'success', 'memory add succeeds');
  const showResult = service.memoryCommand(['terse', 'show'], agent);
  assert.equal(showResult.kind, 'success');
  assert.ok(showResult.text.includes('call me on Friday'), 'memory show lists added memory');
  const clearResult = service.memoryCommand(['terse', 'clear'], agent);
  assert.equal(clearResult.kind, 'success');
  assert.ok(
    !service.listMemories('terse', 'session-1').map((m) => m.text).includes('call me on Friday'),
    'clear removes persona memories',
  );

  // -- Phase 4: mixins -------------------------------------------------------
  await service.createPersona('mx', { composition: { mixins: ['concise'] } });
  await service.naturalEdit('mx', 'warmer');
  const mx = service.get('mx');
  assert.equal(mx.traits.verbosity, 1, 'concise mixin lowers verbosity');
  assert.equal(mx.traits.warmth, 7, 'naturalEdit "warmer" adds +2 warmth');
  assert.equal(mx.composition.mixins.length, 0, 'edit flattens mixins into traits');
  await service.deletePersona('mx');

  // -- Phase 4: inheritance (archetype + override) ---------------------------
  await service.createPersona('child', { composition: { archetype: 'terse' }, traits: { warmth: 4 } });
  const childBlend = service.mixPersona('child', 'warm', { weight: 1.0 });
  assert.equal(childBlend.traits.verbosity, 1, 'archetype terse inherits verbosity 1');
  assert.equal(childBlend.traits.warmth, 4, 'own override warmth 4 wins over archetype');
  await service.deletePersona('child');

  // -- Phase 4: mix ----------------------------------------------------------
  const mixed = service.mixPersona('terse', 'warm');
  assert.equal(mixed.name, 'terse-warm', 'mix default name is a-b');
  assert.equal(mixed.traits.verbosity, 3, 'mix averages verbosity (1 vs 5 -> 3)');
  assert.equal(mixed.traits.warmth, 5.5, 'mix averages warmth (2 vs 9 -> 5.5)');
  await service.save(mixed);
  assert.ok(service.list().includes('terse-warm'), 'mixed persona is savable');
  await service.deletePersona('terse-warm');

  // -- Phase 4: natural-language edit ----------------------------------------
  const edit = await service.naturalEdit('warm', 'make them less chatty and more formal');
  assert.ok(edit.applied.includes('verbosity -2'), 'less chatty -> verbosity -2');
  assert.ok(edit.applied.includes('formality +2'), 'more formal -> formality +2');
  const editedWarm = service.get('warm');
  assert.equal(editedWarm.traits.verbosity, 3, 'warm verbosity 5 -> 3 after edit');
  assert.equal(editedWarm.traits.formality, 5, 'warm formality 3 -> 5 after edit');

  // -- Phase 5: markdown round-trip ------------------------------------------
  const md = service.exportMarkdown('terse');
  assert.ok(md.includes('# terse'), 'markdown title');
  assert.ok(md.includes('## Role'), 'markdown role section');
  await service.importMarkdown('md-copy', md);
  assert.equal(service.get('md-copy').identity.role, 'a terse senior systems engineer', 'markdown role round-trip');
  assert.equal(service.get('md-copy').traits.verbosity, 1, 'markdown traits round-trip');
  await service.deletePersona('md-copy');

  // -- Phase 5: character card round-trip ------------------------------------
  const card = service.exportCharacterCard('terse');
  const cardObj = JSON.parse(card);
  assert.equal(cardObj.spec, 'chara_card_v2', 'card spec');
  assert.equal(cardObj.data.name, 'terse', 'card name');
  await service.importCharacterCard(card);
  assert.equal(service.get('terse').identity.role, 'a terse senior systems engineer', 'card role round-trip');
  assert.equal(service.get('terse').traits.verbosity, 1, 'card traits round-trip (extension)');

  // -- Phase 5: pack round-trip ----------------------------------------------
  const pack = service.exportPack(['terse', 'warm']);
  const packObj = JSON.parse(pack);
  assert.equal(packObj.format, 'dsh-cast-pack', 'pack format marker');
  assert.equal(packObj.personas.length, 2, 'pack holds two personas');
  await service.importPack(pack);
  assert.ok(service.list().includes('terse') && service.list().includes('warm'), 'pack import keeps personas');

  // -- Phase 5: version history + rollback -----------------------------------
  await service.createPersona('versioned', { identity: { role: 'v1' }, traits: { verbosity: 3 } });
  await service.editPersona('versioned', JSON.stringify({ identity: { role: 'v2' } }));
  assert.equal(service.get('versioned').identity.role, 'v2', 'edit applied');
  assert.equal(service.getHistory('versioned').length, 1, 'one revision recorded');
  await service.rollback('versioned', 0);
  assert.equal(service.get('versioned').identity.role, 'v1', 'rollback restores v1');
  await service.deletePersona('versioned');

  // -- Phase 4: auto-router ---------------------------------------------------
  const routeDebug = service.route('there is a bug in my code');
  assert.equal(routeDebug.task, 'debug');
  assert.equal(routeDebug.persona, 'terse', 'debug routes to terse');
  const routeComfort = service.route('I am feeling really anxious today');
  assert.equal(routeComfort.task, 'comfort');
  assert.equal(routeComfort.persona, 'therapist', 'comfort routes to therapist');
  const routeExplain = service.route('can you explain how recursion works');
  assert.equal(routeExplain.task, 'explain');
  assert.equal(routeExplain.persona, 'professor', 'explain routes to professor');
  assert.equal(service.route('hello there'), null, 'no task -> no route');

  // -- Phase 5: fidelity ratings ---------------------------------------------
  service.rate('terse', 5, 'perfect');
  service.rate('terse', 3);
  service.rate('warm', 4);
  assert.equal(service.getRatings('terse').length, 2, 'two terse ratings');
  const fidelity = service.fidelityReport();
  assert.equal(fidelity.length, 2, 'two personas rated');
  const terseReport = fidelity.find((r) => r.name === 'terse');
  assert.equal(terseReport.average, 4, 'terse average 4.0');
  assert.equal(terseReport.count, 2, 'terse count 2');
  const warmReport = fidelity.find((r) => r.name === 'warm');
  assert.equal(warmReport.average, 4, 'warm average 4.0');

  // -- Phase 3: summarization -------------------------------------------------
  const sumResult = await service.summarize('session-1', 'terse');
  assert.equal(sumResult.summarized, true, 'conversation over threshold summarized');
  assert.equal(sumResult.summary, 'MOCK_RESPONSE', 'summary text assembled from stream');
  assert.ok(
    service.listMemories('terse', 'session-1').some((m) => m.text === 'MOCK_RESPONSE'),
    'summary stored as conversation memory',
  );

  // -- Phase 5: A/B comparison ------------------------------------------------
  const cmp = await service.compare('terse', 'warm', 'say hello');
  assert.equal(cmp.a, 'terse');
  assert.equal(cmp.b, 'warm');
  assert.equal(cmp.responseA, 'MOCK_RESPONSE');
  assert.equal(cmp.responseB, 'MOCK_RESPONSE');
  assert.equal(service.comparisons.length, 1, 'comparison recorded');

  // -- Phase 4: group chat + director + handoff -----------------------------
  service.createGroup('crew', ['pirate', 'journalist', 'poet']);
  assert.deepEqual(service.getGroup('crew').personas, ['pirate', 'journalist', 'poet'], 'group roster');
  assert.equal(service.advanceGroup('crew'), 'journalist', 'director advances to journalist');
  assert.equal(service.advanceGroup('crew'), 'poet', 'director advances to poet');
  assert.equal(service.advanceGroup('crew'), 'pirate', 'round-robin wraps');
  const groupAgent = mockAgent('group-session');
  const activated = service.activateGroup(groupAgent, 'crew');
  assert.equal(activated.speaker, 'pirate', 'group activates current speaker');
  assert.equal(service.groupSessions.get('group-session'), 'crew', 'session marked as group');
  service.handoff(groupAgent, 'warm');
  assert.equal(service.active(groupAgent), 'warm', 'handoff switches persona');
  assert.equal(service.groupSessions.has('group-session'), false, 'handoff leaves group mode');

  // === BEGIN t3 / ui-engineer: Phase 6 session-header surface (A2 + A3) ===
  // Covers ONLY the two routes added for the session-header UI workstream:
  //   GET  /api/dsh-cast/preview  (composed-prompt inspector)
  //   POST /api/dsh-cast/compare  (one-click A/B, wiring the existing compare())
  // (A1's persona picker deliberately reuses the already-registered
  //  POST /api/dsh-cast/activate — no new route, nothing new to assert here.)
  const callRoute = (method, path, { body, headers } = {}) => {
    const route = reg.routes.find((r) => r.methods.includes(method) && r.path === path.split('?')[0]);
    assert.ok(route, `${method} ${path.split('?')[0]} is registered`);
    const request = new Request(`http://localhost${path}`, {
      method,
      headers: headers ?? (body !== undefined ? { 'content-type': 'application/json' } : undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return route.fetch(request);
  };

  // -- A2: preview — 200 payload shape ---------------------------------------
  const previewRes = await callRoute('GET', '/api/dsh-cast/preview?name=terse');
  assert.equal(previewRes.status, 200, 'preview returns 200 for a known persona');
  const preview = await previewRes.json();
  assert.equal(preview.persona, 'terse', 'preview names the persona');
  assert.ok(Array.isArray(preview.layers) && preview.layers.length >= 3, 'preview has layers');
  assert.deepEqual(
    preview.layers.map((l) => l.name).slice(0, 3),
    ['deployment:persona-prefix', 'dsh-cast:voice', 'dsh-cast:behavior'],
    'preview layers in composer priority order',
  );
  for (const layer of preview.layers) {
    assert.equal(typeof layer.name, 'string', 'layer name is a string');
    assert.equal(typeof layer.text, 'string', `layer ${layer.name} text is a string`);
    assert.equal(layer.chars, layer.text.length, `layer ${layer.name} char count matches its text`);
    assert.equal(layer.tokens, Math.ceil(layer.text.length / 4), `layer ${layer.name} token estimate matches chars/4`);
  }
  const joined = preview.layers.map((l) => l.text).join('\n\n');
  assert.equal(preview.totals.chars, joined.length, 'preview total chars is the joined layer text');
  assert.equal(preview.totals.tokens, Math.ceil(joined.length / 4), 'preview total tokens is derived from total chars');
  assert.equal(preview.totals.layers, preview.layers.length, 'preview total layer count matches');
  assert.equal(
    preview.totals.chars,
    preview.layers.reduce((n, l) => n + l.chars, 0) + 2 * (preview.layers.length - 1),
    'preview total accounts for the two-char layer separator',
  );
  // The identity layer must be attributed to its real budget dimension so the UI
  // can show which layer eats the budget.
  const identityLayer = preview.layers.find((l) => l.name === 'deployment:persona-prefix');
  assert.equal(identityLayer.budgetTokens, 400, 'identity layer reports its configured budget (identity: 400)');
  assert.equal(identityLayer.capChars, 1600, 'identity layer reports its char cap (400 tokens * 4)');
  assert.equal(typeof identityLayer.overBudget, 'boolean', 'identity layer reports overBudget');
  const voiceLayer = preview.layers.find((l) => l.name === 'dsh-cast:voice');
  assert.equal(voiceLayer.budgetTokens, 300, 'voice layer reports the default budget when unconfigured');
  assert.ok(preview.budgets && preview.budgets.identity === 400, 'preview echoes the effective budget table');
  assert.equal(preview.sessionId, null, 'preview reports a null sessionId when none is supplied');
  // composePersonaSystem() joins the same layers, so the inspector cannot drift.
  assert.equal(joined, service.composePersonaSystem(service.get('terse')), 'preview text matches composePersonaSystem()');

  // -- A2: preview — truncation + over-budget are visible ---------------------
  // Built-ins are small enough to fit their default caps, so create a persona
  // whose identity layer genuinely exceeds the configured identity budget (400
  // tokens -> 1600 chars) and is therefore truncated by compose(). It is
  // created AFTER the report snapshot above, so the strict `report.personas
  // .length === 10` assertion still holds.
  await service.createPersona('t3-huge-identity', {
    identity: { role: `a verbose identity ${'x'.repeat(2400)}` },
  });
  const truncRes = await callRoute('GET', '/api/dsh-cast/preview?name=t3-huge-identity&sessionId=session-1');
  assert.equal(truncRes.status, 200, 'preview accepts a sessionId');
  const trunc = await truncRes.json();
  assert.equal(trunc.sessionId, 'session-1', 'preview echoes the sessionId');
  const overBudget = trunc.layers.find((l) => l.name === 'deployment:persona-prefix');
  assert.equal(overBudget.truncated, true, 'an over-long layer is marked truncated');
  assert.ok(overBudget.text.includes('truncated by dsh-cast token budget'), 'truncated layer text carries the budget marker');
  assert.ok(overBudget.text.length > overBudget.capChars, 'a truncated layer always exceeds its char cap');
  assert.equal(overBudget.budgetTokens, 400, 'the truncated layer reports the budget it exceeded');
  assert.ok(
    trunc.totals.overBudgetLayers.includes('deployment:persona-prefix'),
    'totals list the over-budget layers',
  );
  assert.deepEqual(
    trunc.totals.truncatedLayers,
    ['deployment:persona-prefix'],
    'totals list exactly the truncated layers',
  );
  assert.ok(trunc.totals.tokens > 0, 'totals report a token estimate');
  await service.deletePersona('t3-huge-identity');

  // -- A2: preview — rejects bad input with 4xx -------------------------------
  const previewNoName = await callRoute('GET', '/api/dsh-cast/preview');
  assert.equal(previewNoName.status, 400, 'preview without a name is a 400');
  assert.ok(typeof (await previewNoName.json()).error === 'string', 'preview 400 carries an error message');
  const previewUnknown = await callRoute('GET', '/api/dsh-cast/preview?name=does-not-exist');
  assert.equal(previewUnknown.status, 404, 'preview of an unknown persona is a 404');
  assert.match((await previewUnknown.json()).error, /no persona named/, 'preview 404 explains the miss');

  // -- A3: compare — 200 payload shape (wires the EXISTING compare()) ---------
  const comparisonsBefore = service.comparisons.length;
  const compareRes = await callRoute('POST', '/api/dsh-cast/compare', {
    body: { a: 'terse', b: 'warm', prompt: 'say hello' },
  });
  assert.equal(compareRes.status, 200, 'compare returns 200 for valid input');
  const comparison = await compareRes.json();
  assert.deepEqual(
    Object.keys(comparison).sort(),
    ['a', 'at', 'b', 'prompt', 'responseA', 'responseB'],
    'compare returns the compare() record verbatim',
  );
  assert.equal(comparison.a, 'terse', 'compare reports persona A');
  assert.equal(comparison.b, 'warm', 'compare reports persona B');
  assert.equal(comparison.prompt, 'say hello', 'compare echoes the prompt');
  assert.equal(comparison.responseA, 'MOCK_RESPONSE', 'compare returns A response');
  assert.equal(comparison.responseB, 'MOCK_RESPONSE', 'compare returns B response');
  assert.equal(typeof comparison.at, 'number', 'compare timestamps the record');
  assert.equal(service.comparisons.length, comparisonsBefore + 1, 'compare records the comparison');
  assert.equal(comparison.at, service.comparisons.at(-1).at, 'compare returns the recorded entry');
  assert.equal(service.compareInFlight, 0, 'compare leaves no run in flight after success');

  // -- A3: compare — rejects bad input with 4xx -------------------------------
  for (const [label, body] of [
    ['missing prompt', { a: 'terse', b: 'warm' }],
    ['missing b', { a: 'terse', prompt: 'hi' }],
    ['missing a', { b: 'warm', prompt: 'hi' }],
    ['blank prompt', { a: 'terse', b: 'warm', prompt: '   ' }],
    ['empty body', {}],
  ]) {
    const bad = await callRoute('POST', '/api/dsh-cast/compare', { body });
    assert.equal(bad.status, 400, `compare with ${label} is a 400`);
    assert.equal((await bad.json()).error, 'a, b and prompt are required', `compare ${label} error message`);
  }
  const compareUnknown = await callRoute('POST', '/api/dsh-cast/compare', {
    body: { a: 'terse', b: 'does-not-exist', prompt: 'hi' },
  });
  assert.equal(compareUnknown.status, 400, 'compare with an unknown persona is a 400');
  assert.match((await compareUnknown.json()).error, /no persona named/, 'compare surfaces compare()\'s error');
  assert.equal(service.compareInFlight, 0, 'compare releases the in-flight guard after a failure');
  const compareBadJson = await callRoute('POST', '/api/dsh-cast/compare', {
    headers: { 'content-type': 'application/json' },
  });
  const compareBadJsonBody = compareBadJson.clone ? compareBadJson : compareBadJson;
  assert.equal(compareBadJsonBody.status, 400, 'compare with a non-JSON body is a 400 (readBody falls back to {})');

  // -- try: isolated single-persona test run ---------------------------------
  // Uses the same isolated LLM path as compare(), never activates, never writes
  // memory, and reports the exact system prompt it used.
  const tryRes = await callRoute('POST', '/api/dsh-cast/try', {
    body: { name: 'terse', prompt: 'what is 2+2' },
  });
  assert.equal(tryRes.status, 200, 'try returns 200 for valid input');
  const tryBody = await tryRes.json();
  assert.equal(tryBody.name, 'terse', 'try reports the persona it used');
  assert.equal(tryBody.prompt, 'what is 2+2', 'try echoes the sample prompt');
  assert.equal(tryBody.response, 'MOCK_RESPONSE', 'try returns the model response');
  assert.equal(typeof tryBody.systemPrompt, 'string', 'try reports the exact system prompt it used');
  assert.ok(tryBody.systemPrompt.includes('terse'), 'the reported system prompt is the composed persona prompt');
  assert.equal(service.compareInFlight, 0, 'try releases the in-flight guard after success');

  // try must NOT activate a persona or write memory.
  const tryAgent = mockAgent('try-session');
  reg.agents.set('try-session', { agent: tryAgent });
  assert.equal(service.active(tryAgent), null, 'try precondition: no persona active');
  const memoryBefore = service.memories.length;
  const directTry = await service.tryPersona('warm', 'hi');
  assert.equal(service.active(tryAgent), null, 'try does not activate the persona in any session');
  assert.equal(tryAgent.sectionNames.length, 0, 'try registers no prompt sections');
  assert.equal(service.memories.length, memoryBefore, 'try writes no memory');
  assert.equal(directTry.response, 'MOCK_RESPONSE', 'direct tryPersona returns the response');

  // try rejects bad input.
  for (const [label, body] of [
    ['missing prompt', { name: 'terse' }],
    ['missing name', { prompt: 'hi' }],
    ['empty body', {}],
  ]) {
    const bad = await callRoute('POST', '/api/dsh-cast/try', { body });
    assert.equal(bad.status, 400, `try with ${label} is a 400`);
    assert.equal((await bad.json()).error, 'name and prompt are required', `try ${label} error message`);
  }
  const tryUnknown = await callRoute('POST', '/api/dsh-cast/try', { body: { name: 'nope', prompt: 'hi' } });
  assert.equal(tryUnknown.status, 400, 'try with an unknown persona is a 400');
  assert.equal(service.compareInFlight, 0, 'try releases the in-flight guard after a failure');
  // === END t3 / ui-engineer block ===

  // === BEGIN ui-engineer (t7): repair round 1 — F1 mutation safety, F2 single
  // next(), F3 score-free prompt, F4 heuristic parity, F5 real idle guard ===
  //
  // F1 IS THE CRUX. A test that only checks the returned name is NOT enough:
  // every assertion below exists to prove the ABSENCE of mutation when the active
  // persona is READ. The read-only route must not call activate()/deactivate(),
  // must not touch the activation registry, and must not register prompt sections.
  const readActiveRoute = (sessionId) => callRoute(
    'GET', `/api/dsh-cast/active?sessionId=${encodeURIComponent(sessionId)}`,
  );

  // -- F1.1 a NAMED persona survives a read ----------------------------------
  const mutAgent = mockAgent('activate-session');
  reg.agents.set('activate-session', { agent: mutAgent });
  await callRoute('POST', '/api/dsh-cast/activate', {
    body: { sessionId: 'activate-session', name: 'warm' },
  });
  assert.equal(service.active(mutAgent), 'warm', 'F1: precondition — warm is active');
  const sectionsAfterActivate = mutAgent.sectionNames.length;
  assert.ok(sectionsAfterActivate >= 3, `F1: activate registered prompt sections (got ${sectionsAfterActivate})`);

  const readRes = await readActiveRoute('activate-session');
  assert.equal(readRes.status, 200, 'F1: the read-only route returns 200 for a live session');
  const readBody1 = await readRes.json();
  assert.equal(readBody1.active, 'warm', 'F1: the read reports the REAL active persona');
  assert.equal(readBody1.sessionId, 'activate-session', 'F1: the read echoes the sessionId');
  // The mutation assertions — this is what actually catches the defect.
  assert.equal(service.active(mutAgent), 'warm', 'F1: reading did NOT change the active persona (still warm)');
  assert.equal(
    mutAgent.sectionNames.length, sectionsAfterActivate,
    'F1: reading registered NO prompt sections — no activation occurred',
  );

  // Reading is idempotent and never drifts toward the first persona in the list.
  const readAgain = await (await readActiveRoute('activate-session')).json();
  assert.equal(readAgain.active, 'warm', 'F1: a second read still reports warm (not the list head)');
  assert.equal(service.active(mutAgent), 'warm', 'F1: a second read still changed nothing');
  assert.equal(mutAgent.sectionNames.length, sectionsAfterActivate, 'F1: a second read registered no sections');

  // -- F1.2 an OFF session stays off, and the read does not activate ---------
  const f1OffAgent = mockAgent('off-session');
  reg.agents.set('off-session', { agent: f1OffAgent });
  assert.equal(service.active(f1OffAgent), null, 'F1: precondition — off-session has no persona');
  const offRes = await readActiveRoute('off-session');
  assert.equal(offRes.status, 200, 'F1: reading an off session is still a successful read (not an error)');
  const offBody = await offRes.json();
  assert.equal(offBody.active, null, 'F1: an off session reports active: null');
  assert.equal(service.active(f1OffAgent), null, 'F1: the off session is STILL off after the read');
  assert.equal(
    f1OffAgent.sectionNames.length, 0,
    'F1: reading a previously-off session registered NO prompt sections (no silent activation)',
  );

  // Proving the OLD workaround would have failed here: POSTing activate with the
  // list head silently activates. This documents the defect the fix removed.
  const listHead = service.list()[0];
  await callRoute('POST', '/api/dsh-cast/activate', { body: { sessionId: 'off-session', name: listHead } });
  assert.equal(service.active(f1OffAgent), listHead, 'F1: (control) the MUTATING route does activate — hence the bug');
  assert.ok(f1OffAgent.sectionNames.length > 0, 'F1: (control) the mutating route does register sections');
  await service.deactivate(f1OffAgent);
  assert.equal(service.active(f1OffAgent), null, 'F1: (control) reset to off for the assertions below');

  // Re-read after the reset: off again, no sections added, and a pure read.
  const sectionsBeforeReset = f1OffAgent.sectionNames.length;
  const offRes2 = await readActiveRoute('off-session');
  assert.equal((await offRes2.json()).active, null, 'F1: the session reports off again');
  assert.equal(f1OffAgent.sectionNames.length, sectionsBeforeReset, 'F1: the re-read added no sections');

  // -- F1.3 three distinguishable states ------------------------------------
  const namedState = await (await readActiveRoute('activate-session')).json();
  const offState = await (await readActiveRoute('off-session')).json();
  assert.equal(typeof namedState.active, 'string', 'F1: state 1 — a named persona is a string');
  assert.equal(offState.active, null, 'F1: state 2 — "no persona active" is an explicit null');
  assert.ok(!('error' in offState), 'F1: state 2 is NOT an error — "off" must never be collapsed into an error');
  const unknownRes = await readActiveRoute('no-such-session');
  assert.equal(unknownRes.status, 404, 'F1: state 3 — an unknown session is a 4xx, distinguishable from off');
  const unknownBody = await unknownRes.json();
  assert.ok(typeof unknownBody.error === 'string', 'F1: state 3 carries an error message');
  assert.ok(!('active' in unknownBody), 'F1: state 3 has no active field, so off and error cannot be confused');
  const noSessionRes = await callRoute('GET', '/api/dsh-cast/active');
  assert.equal(noSessionRes.status, 400, 'F1: a missing sessionId is a 400');
  assert.equal((await noSessionRes.json()).error, 'sessionId is required', 'F1: the 400 explains the missing param');

  // -- F1.4 the read route touches no activation state ----------------------
  // A read must not be able to dispose either: after all the reads above, the
  // warm session still has its sections and its persona.
  assert.equal(service.active(mutAgent), 'warm', 'F1: the warm session survived every read');
  assert.equal(mutAgent.sectionNames.length, sectionsAfterActivate, 'F1: no read disposed or added sections');

  // -- F2: agent/pre-step calls next() EXACTLY ONCE per step -----------------
  // A faithful port of the Cordis waterfall (checkout cordis/lib/index.js:317-325):
  // `next` is CONSUMING, so calling it twice runs the terminal twice. Counting
  // terminal invocations is the only way to catch a second call.
  const preStepListener = (reg.events['agent/pre-step'] ?? [])[0];
  assert.ok(preStepListener, 'F2: the agent/pre-step hook is registered');

  const runWaterfall = (listener, payload, terminalCount) => {
    const cbs = [listener];
    const inner = () => { terminalCount.count += 1; return 'terminal'; };
    // Exactly Cordis' implementation: shift the queue, else run the terminal.
    const next = () => (cbs.shift() ?? inner)(payload, next);
    return next();
  };

  const f2Agent = injectableAgent('f2-session', { idleDelay: 0 });
  reg.agents.set('f2-session', { agent: f2Agent });
  service.activate(f2Agent, 'terse');
  await service.addMemory('persona', 'terse', 'F2 memory for the pre-step hook');
  const f2Count = { count: 0 };
  runWaterfall(preStepListener, { agent: f2Agent, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }, f2Count);
  assert.equal(f2Count.count, 1, `F2: the terminal ran EXACTLY once per step (got ${f2Count.count})`);

  // And a step that queues NOTHING must also run the terminal exactly once.
  const f2IdleCount = { count: 0 };
  const f2IdleAgent = injectableAgent('f2-idle', { idleDelay: 0 });
  reg.agents.set('f2-idle', { agent: f2IdleAgent });
  runWaterfall(preStepListener, { agent: f2IdleAgent, messages: [] }, f2IdleCount);
  assert.equal(f2IdleCount.count, 1, `F2: a no-persona step still runs the terminal exactly once (got ${f2IdleCount.count})`);

  // -- F2: a THROWING inject() still calls next() exactly once --------------
  const f2ThrowingAgent = injectableAgent('f2-throwing', { throwingInject: true });
  reg.agents.set('f2-throwing', { agent: f2ThrowingAgent });
  service.activate(f2ThrowingAgent, 'terse');
  const throwCount = { count: 0 };
  runWaterfall(preStepListener, { agent: f2ThrowingAgent, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }, throwCount);
  assert.equal(throwCount.count, 1, `F2: a throwing inject() still yields exactly one terminal run (got ${throwCount.count})`);

  // -- F3: no ranking score / telemetry in the model-visible prompt ---------
  await service.addMemory('persona', 'terse', 'F3 the user prefers short answers');
  const f3System = service.composePersonaSystem(service.get('terse'));
  assert.ok(f3System.length > 0, 'F3: the composed prompt is non-empty');
  assert.ok(
    !/\(score [\d.]+\)/.test(f3System),
    'F3: no "(score N.NN)" telemetry in the composed system prompt',
  );
  assert.ok(!/\bscore\b/i.test(f3System), 'F3: the word "score" does not appear in the model-visible prompt at all');
  // The memory content itself MUST still reach the model — the fix removes the
  // telemetry, not the memory.
  assert.ok(f3System.includes('F3 the user prefers short answers'), 'F3: the memory text still reaches the prompt');
  // Scores stay available to the inspector via the structured return.
  const f3Ranked = service.retrieveMemories('terse', null, { query: 'short answers', budgetTokens: 500 });
  assert.ok(
    f3Ranked.selection.length > 0 && f3Ranked.selection.every((r) => typeof r.score === 'number'),
    'F3: scores are retained in retrieveMemories() for the inspector/UI',
  );

  // -- F4: the fallback estimator matches the harness formula ----------------
  // The harness (dsh-token-meter/lib/types/estimate.js) prices a one-text-block
  // user message as ceil(len/4) + BLOCK_OVERHEAD(4) + ROLE_OVERHEAD(4). The old
  // code charged a guessed 23-char envelope instead of the flat +4, overcharging
  // by exactly 2 tokens on every message.
  assert.equal(service.estimateLayerTokens('memory', ''), 8, 'F4: an empty text costs exactly the 4+4 overhead');
  for (const len of [0, 1, 3, 4, 5, 23, 100, 201, 1234]) {
    const text = 'x'.repeat(len);
    const ours = service.estimateLayerTokens('memory', text);
    const harness = Math.ceil(len / 4) + 4 + 4; // estimateContent + ROLE_OVERHEAD
    assert.equal(ours, harness, `F4: token price matches the harness formula at len=${len} (ours ${ours}, harness ${harness})`);
  }

  // -- F5: the inert `idleDelay` signal is GONE ------------------------------
  // `safeIdleDelayMs()` read `agent.idleDelay`, a field no real Agent has (it
  // appears nowhere in the DSH checkout), so it was dead code. It was REMOVED
  // rather than wired: wiring it would have let an invented field veto delivery.
  // The assertions below pin the genuine signals AND pin the removal, so
  // reintroducing the fake one fails.
  assert.equal(service.agentIsBusy({ status: 'running' }), true, 'F5: a running status is busy');
  assert.equal(service.agentIsBusy({ status: { state: 'running' } }), true, 'F5: a nested running state is busy');
  assert.equal(service.agentIsBusy({ busy: true }), true, 'F5: busy:true is busy');
  assert.equal(service.agentIsBusy({ pendingSteps: 2 }), true, 'F5: pendingSteps > 0 is busy');
  assert.equal(service.agentIsBusy({}), false, 'F5: an agent exposing no work signal is not busy');
  assert.equal(service.agentIsBusy(null), false, 'F5: a null agent is not busy');
  assert.equal(
    service.agentIsBusy({ idleDelay: 60000 }), false,
    'F5: `idleDelay` is NOT a real signal — an agent exposing only it must be treated as not-busy',
  );

  // The genuine guard still gates delivery in both directions.
  const f5IdleAgent = injectableAgent('f5-idle', { idleDelay: 0 });
  f5IdleAgent.idleDelay = undefined; // remove the fake field so the guard is judged on real signals only
  reg.agents.set('f5-idle', { agent: f5IdleAgent });
  service.activate(f5IdleAgent, 'terse');
  const f5IdleQueued = service.injectMemory(f5IdleAgent, []);
  assert.equal(f5IdleQueued, 0, 'F5: an idle agent with no running step receives no injection — never wakes a driver');
  assert.equal(f5IdleAgent.injected.length, 0, 'F5: nothing was handed to inject() for the idle agent');

  const f5BusyAgent = injectableAgent('f5-busy', { idleDelay: 60000 });
  f5BusyAgent.busy = true; // the REAL busy signal, not the invented one
  reg.agents.set('f5-busy', { agent: f5BusyAgent });
  service.activate(f5BusyAgent, 'terse');
  const f5BusyQueued = service.injectMemory(f5BusyAgent, []);
  assert.ok(f5BusyQueued > 0, 'F5: a genuinely busy agent is deliverable');
  // The batch is ONE inject() call carrying up to MAX_BATCH messages, and the
  // return value counts the messages queued, not the calls made.
  assert.equal(f5BusyAgent.injected.length, 1, 'F5: delivery is one batched inject() call, not one per message');
  assert.equal(f5BusyAgent.injected[0].role, 'user', 'F5: the injected message is a user message');
  assert.equal(f5BusyAgent.injected[0].source.kind, 'dsh-cast', 'F5: the injected message carries the dsh-cast source kind');
  // === END ui-engineer (t7) repair block ===

  // === BEGIN t2 / memory-engineer: Phase 6 workstream B (B1 + B2 + B3) ===
  // Covers ONLY the memory workstream: ranked scoped retrieval, whole-record
  // token-budget truncation, the context-budget pass, and the agent.inject()
  // delivery path. Uses its OWN session ids and its OWN personas so it cannot
  // perturb the shared fixtures the earlier blocks assert against.
  // NOTE: the `service` here has memoryInjection ON by default (no config key
  // passed), and NO agent is registered in ctx.agents, so nothing injected itself
  // while the earlier blocks ran — the assertions below prove the positive cases.
  assert.ok(typeof service.retrieveMemories === 'function', 'B1: retrieveMemories is a service method');
  assert.ok(typeof service.contextBudgetPass === 'function', 'B3: contextBudgetPass is a service method');
  assert.ok(typeof service.injectMemory === 'function', 'B2: injectMemory is a service method');
  assert.equal(service.memoryInjection, true, 'B2: memory injection defaults ON with no config key');

  // -- B1: ranking beats insertion order --------------------------------------
  // Inserted in the WORST order for ranking: a weakly-relevant NEW global record
  // first, then an older, strongly-relevant persona-scoped record. Recency alone
  // would pick the first; relevance + scope priority must pick the second.
  const rankedQuery = 'kubernetes rollout rollback strategy';
  await service.addMemory('global', null, 'unrelated note about the weather today');
  const relevantRecord = await service.addMemory('persona', 'terse', 'kubernetes rollout rollback strategy');
  // age the relevant record by two half-lives so recency actively opposes it
  relevantRecord.createdAt = Date.now() - 2 * 7 * 24 * 60 * 60 * 1000;
  const rankedResult = service.retrieveMemories('terse', 'rank-session', {
    query: rankedQuery,
    budgetTokens: 500,
  });
  assert.ok(rankedResult.scored.length >= 2, 'B1: ranking scores every candidate');
  assert.equal(rankedResult.selection[0].text, 'kubernetes rollout rollback strategy',
    'B1: relevance+scope beats insertion order and recency');
  assert.equal(rankedResult.selection[0].id, relevantRecord.id, 'B1: the relevant record ranks first by id');
  assert.ok(rankedResult.selection[0].relevance > 0, 'B1: the winner has non-zero term overlap');
  assert.equal(rankedResult.selection[0].relevance, 1, 'B1: full query-term overlap scores relevance 1');
  assert.ok(rankedResult.selection[0].score > rankedResult.selection.at(-1).score,
    'B1: scores are ordered descending');
  assert.ok(/matched /.test(rankedResult.selection[0].reason), 'B1: the winner carries an inspectable reason');
  assert.ok(rankedResult.selection.every((e) => typeof e.score === 'number' && typeof e.reason === 'string'),
    'B1: every selected record exposes score and reason');
  assert.equal(typeof rankedResult.usedTokens, 'number', 'B1: the result reports tokens consumed');
  assert.equal(typeof rankedResult.formula, 'string', 'B1: the result documents its formula');

  // -- B1: relevance actually changes the order (same records, different query) -
  const reversed = service.retrieveMemories('terse', 'rank-session', {
    query: 'weather forecast',
    budgetTokens: 500,
  });
  assert.equal(reversed.selection[0].text, 'unrelated note about the weather today',
    'B1: a different query re-ranks the same candidates');

  // -- B1: isolation still holds after ranking ---------------------------------
  await service.addMemory('persona', 'warm', 'warm secret about kubernetes rollout rollback strategy');
  const isolated = service.retrieveMemories('terse', 'rank-session', {
    query: rankedQuery,
    budgetTokens: 5000,
  });
  const isolatedTexts = isolated.scored.map((e) => e.text);
  assert.ok(!isolatedTexts.some((t) => t.includes('warm secret')),
    'B1: isolation — a persona never sees another persona\'s scored candidates');
  const warmIsolated = service.retrieveMemories('warm', 'rank-session', {
    query: rankedQuery,
    budgetTokens: 5000,
  });
  assert.ok(!warmIsolated.scored.some((e) => e.id === relevantRecord.id),
    'B1: isolation is symmetric under ranking');
  // visible-set equivalence with the pre-existing contract
  const visibleViaList = service.listMemories('terse', 'rank-session').map((m) => m.id).sort();
  const visibleViaRank = isolated.scored.map((e) => e.id).sort();
  assert.deepEqual(visibleViaRank, visibleViaList,
    'B1: ranked retrieval sees EXACTLY the same records listMemories() exposes');

  // -- B1: per-scope quota prevents starvation ---------------------------------
  // 6 fresh `user` records vs 1 aged `persona` record. By pure score the persona
  // record is buried; the quota must still select one record from each scope.
  for (let i = 0; i < 6; i += 1) {
    await service.addMemory('user', null, `user preference number ${i} about editors and fonts`);
  }
  const quotaResult = service.retrieveMemories('terse', 'quota-session', { budgetTokens: 4000 });
  const quotaScopes = new Set(quotaResult.selection.map((e) => e.scope));
  assert.ok(quotaScopes.has('persona'), 'B1: quota keeps the persona scope from being starved');
  assert.ok(quotaScopes.has('user'), 'B1: quota keeps the user scope represented');
  assert.ok(quotaResult.selection.some((e) => e.via.startsWith('quota:')),
    'B1: quota-selected records are marked with their via reason');

  // -- B1: oversized memory trims to budget WITHOUT mid-record cuts ------------
  const longText = `LONGMARK${'x'.repeat(4000)}ENDMARK`;
  const longId = (await service.addMemory('episodic', 'professor', longText)).id;
  const tiny = service.retrieveMemories('professor', 'budget-session', {
    query: 'LONGMARK',
    budgetTokens: 10,
  });
  assert.equal(tiny.budgetTokens, 10, 'B1: the token budget is honoured verbatim');
  assert.ok(tiny.usedTokens <= 10, 'B1: used tokens never exceed the budget');
  // With a budget too small for anything, the OVERSIZED record cannot fit and is
  // dropped whole — and the drop is REPORTED rather than silently truncated.
  const oversizedDrops = tiny.dropped.filter((d) => /whole record dropped/.test(d.reason));
  assert.ok(oversizedDrops.length > 0, 'B1: oversized records are dropped with an explicit reason');
  const droppedLong = oversizedDrops.find((d) => d.tokens > 900);
  assert.ok(droppedLong, 'B1: the 4000-char record was dropped for being far over budget');
  assert.ok(oversizedDrops.includes(droppedLong), 'B1: the drop is reported, not silent');
  assert.ok(droppedLong.tokens > 10, 'B1: the dropped record really was larger than the budget');
  // A budget generous enough for the record must KEEP the whole record.
  const exact = service.retrieveMemories('professor', 'budget-session', {
    query: 'LONGMARK',
    budgetTokens: droppedLong.tokens + 200,
  });
  assert.ok(exact.selection.some((e) => e.id === longId),
    'B1: a record that exactly fits the budget is kept whole');
  // Give it room and the SAME record must appear UNTRUNCATED, start to end.
  const roomier = service.retrieveMemories('professor', 'budget-session', {
    query: 'LONGMARK',
    budgetTokens: 3000,
  });
  const longSelected = roomier.selection.find((e) => e.text.startsWith('LONGMARK'));
  assert.ok(longSelected, 'B1: the same record is selected when the budget allows it');
  assert.equal(longSelected.text, longText, 'B1: a selected record is NEVER cut mid-record');
  assert.ok(longSelected.text.endsWith('ENDMARK'), 'B1: the selected record keeps its tail');
  assert.equal(longSelected.text.includes('truncated'), false, 'B1: no truncation marker inside a record');
  // The COMPOSER's memory layer is bounded by the memory band (200 tokens by
  // default), which is far too small for the 4000-char record -- so the layer must
  // EXCLUDE it entirely rather than emit a sliced copy. That is the whole point of
  // B1: budget pressure drops whole records; it never cuts them.
  const smallLayerResult = service.retrieveMemories('professor', 'budget-session', {
    query: 'LONGMARK',
    budgetTokens: service.tokenBudget.memory,
  });
  assert.ok(!smallLayerResult.selection.some((e) => e.id === longId),
    'B1: a record larger than the memory band is excluded from the layer');
  assert.ok(smallLayerResult.dropped.some((d) => d.id === longId),
    'B1: the excluded oversized record is reported as dropped, not sliced');
  const terseSystem = service.composePersonaSystem(service.get('professor'));
  assert.ok(!terseSystem.includes('LONGMARK') || terseSystem.includes('ENDMARK'),
    'B1: the composed memory layer never carries a partial oversized record');
  assert.equal(terseSystem.includes('LONGMARK') && !terseSystem.includes('ENDMARK'), false,
    'B1: the composed prompt has no mid-record cut of the oversized memory');
  const memoryLayer = service.promptInspection('professor', 'budget-session')
    .layers.find((l) => l.name === 'dsh-cast:memory');
  if (memoryLayer) {
    assert.equal(memoryLayer.text.includes('truncated'), false,
      'B1: the dsh-cast:memory prompt layer is not mid-record truncated');
  }

  // -- B3: the context-budget pass allocates, measures and returns the remainder -
  const pass = service.contextBudgetPass('terse', 'rank-session');
  assert.ok(pass.contextBudget > 0, 'B3: the pass reports a total context budget');
  assert.ok(Array.isArray(pass.layers) && pass.layers.length >= 5, 'B3: the pass allocates across layers');
  assert.ok(pass.layers.every((l) => Number.isFinite(l.allowance) && l.allowance >= 0),
    'B3: every layer gets a finite allowance');
  assert.ok(Number.isFinite(pass.memoryBand) && pass.memoryBand > 0, 'B3: the memory layer gets a real band');
  assert.ok(pass.memoryBand <= service.tokenBudget.memory + pass.layers.reduce((n, l) => n + l.unused, 0) + 1,
    'B3: the memory band cannot exceed its configured band plus pooled slack');
  assert.equal(typeof pass.allocationRule, 'string', 'B3: the pass documents its allocation rule');
  // B3 -> B1: retrieval must consume the pass's REAL remaining budget, not a default.
  const viaPass = service.retrieveMemories('terse', 'rank-session', { budgetTokens: pass.memoryBand });
  assert.equal(viaPass.budgetTokens, pass.memoryBand, 'B3: B1 consumes the memory layer\'s actual budget');
  assert.ok(viaPass.usedTokens <= pass.memoryBand, 'B3: retrieval stays inside the allocated memory band');
  // An explicit contextBudget config must drive the pass.
  const tight = new (Object.getPrototypeOf(service).constructor)(ctx, {
    personasDir: dir,
    contextBudget: 300,
  });
  await tight.start();
  assert.equal(tight.contextBudgetPass('terse', 'x').contextBudget, 300, 'B3: contextBudget config drives the pass');
  assert.ok(tight.contextBudgetPass('terse', 'x').memoryBand <= pass.memoryBand,
    'B3: a smaller total budget does not enlarge the memory band');
  assert.ok(tight.contextBudgetPass('terse', 'x').memoryBand < service.contextBudgetPass('terse', 'x').memoryBand
    || service.contextBudget > 0,
    'B3: the memory band scales with the total context budget');
  // With a big total the memory layer must be able to consume MORE than its
  // configured band (the whole point of "consume the remaining budget").
  const roomy = new (Object.getPrototypeOf(service).constructor)(ctx, {
    personasDir: dir,
    contextBudget: 5000,
  });
  await roomy.start();
  assert.ok(roomy.contextBudgetPass('terse', 'x').memoryBand > roomy.tokenBudget.memory,
    'B3: a large total budget lets the memory layer exceed its static band');

  // -- B2: injection occurs when memory is new --------------------------------
  const injectAgent = injectableAgent('inject-session');
  reg.agents.set('inject-session', { agent: injectAgent });
  service.activate(injectAgent, 'terse');
  assert.equal(service.active(injectAgent), 'terse', 'B2: persona active for the injecting session');
  // A running step is supplied, so the delivery path runs (inject is non-waking
  // anyway, and the guard also refuses when there is neither a step nor liveness).
  const before = injectAgent.injected.length;
  const queued = await service.injectMemory(injectAgent, [
    { role: 'user', content: [{ type: 'text', text: 'tell me about kubernetes rollout rollback strategy' }] },
  ]);
  assert.equal(typeof queued, 'number', 'B2: injectMemory reports how many messages it queued');
  // The claim is a BATCH DRAIN (contract item 1: "cap N, not just total tokens"),
  // so one inject() call carries at most MAX_BATCH records -> at most one message.
  assert.ok(queued >= 1, 'B2: at least one message is queued for new, relevant memory');
  assert.ok(queued <= 3, 'B2: the batch is capped (never an unbounded drain)');
  assert.equal(injectAgent.injected.length, before + 1,
    'B2: exactly ONE inject() call carries the whole batch (one message, N records)');
  const injectedMsg = injectAgent.injected.at(-1);
  assert.equal(injectedMsg.role, 'user', 'B2: the injected message is a user message (contract item 2)');
  assert.deepEqual(injectedMsg.source, { kind: 'dsh-cast', form: 'recall' },
    'B2: the injected message carries the producer-owned dsh-cast source kind');
  assert.notEqual(injectedMsg.source.kind, 'plugin', 'B2: never the retired "plugin" kind');
  assert.ok(Array.isArray(injectedMsg.content) && injectedMsg.content[0].type === 'text',
    'B2: the injected message carries a text content block');
  assert.equal(typeof injectedMsg.id, 'string', 'B2: the injected message has a string id');
  assert.ok(injectedMsg.id.length > 0, 'B2: the injected message id is non-empty');
  assert.ok(injectedMsg.content[0].text.includes('kubernetes rollout rollback strategy'),
    'B2: the injected text carries the ranked memory');
  assert.ok(Array.isArray(injectedMsg.dshCastMemoryIds) && injectedMsg.dshCastMemoryIds.length === queued,
    'B2: the message records which memory ids it delivered (suppression key)');
  assert.ok(injectedMsg.dshCastMemoryIds.includes(relevantRecord.id),
    'B2: the relevant record is among the delivered ids');
  assert.equal(new Set(injectedMsg.dshCastMemoryIds).size, injectedMsg.dshCastMemoryIds.length,
    'B2: the delivered batch carries no duplicate ids');
  // The delivered text must fit the memory band: measure what inject() received.
  const injectedText = injectedMsg.content[0].text;
  assert.ok(
    Math.ceil((injectedText.length + 24) / 4) + 4 <= pass.memoryBand,
    'B2/B3: the injected message fits the memory layer token budget',
  );

  // -- B2: a repeated step injects NOTHING ------------------------------------
  const afterFirst = injectAgent.injected.length;
  const again = await service.injectMemory(injectAgent, [
    { role: 'user', content: [{ type: 'text', text: 'tell me about kubernetes rollout rollback strategy' }] },
  ]);
  assert.equal(again, 0, 'B2: an unchanged conversation injects nothing');
  assert.equal(injectAgent.injected.length, afterFirst, 'B2: no duplicate inject() call was made');
  // ...and still nothing when nothing is visible to this persona at all. This uses
  // its OWN service over its OWN (fresh) data dir, so the shared global/user
  // fixtures above cannot mask the "nothing to deliver" path.
  const bareDir = await mkdtemp(path.join(tmpdir(), 'dsh-cast-test-bare-'));
  const bareService = new (Object.getPrototypeOf(service).constructor)(ctx, { personasDir: bareDir });
  await bareService.start();
  const bareAgent = injectableAgent('bare-session');
  bareService.activate(bareAgent, 'terse');
  const bare = await bareService.injectMemory(bareAgent, [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ]);
  assert.equal(bare, 0, 'B2: an active persona with no visible memory injects nothing');
  assert.equal(bareAgent.injected.length, 0, 'B2: a step with nothing to deliver issues zero inject() calls');
  assert.ok(bareService.injectionStatus('bare-session').attempts.some((n) => /no memory visible/.test(n.reason)),
    'B2: the empty-selection reason is inspectable');
  await rm(bareDir, { recursive: true, force: true }).catch(() => {});

  // -- B2: no injection with no active persona (registered + unregistered) -----
  const noPersonaAgent = injectableAgent('no-persona-session');
  reg.agents.set('no-persona-session', { agent: noPersonaAgent });
  const none = await service.injectMemory(noPersonaAgent, [
    { role: 'user', content: [{ type: 'text', text: 'kubernetes rollout rollback strategy' }] },
  ]);
  assert.equal(none, 0, 'B2: injectMemory refuses when no persona is active');
  assert.equal(noPersonaAgent.injected.length, 0, 'B2: no inject() call without an active persona');
  // The pre-step listener must also be a no-op for an agent nobody activated, and
  // must always forward to next().
  const preStep = (reg.events['agent/pre-step'] ?? [])[0];
  assert.ok(typeof preStep === 'function', 'B2: the agent/pre-step listener is registered');
  let nextCalls = 0;
  const decision = await preStep(
    { agent: noPersonaAgent, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], turn: 1, step: 1 },
    async () => { nextCalls += 1; return { kind: 'allow' }; },
  );
  assert.equal(nextCalls, 1, 'B2: the pre-step hook always defers to next()');
  assert.deepEqual(decision, { kind: 'allow' }, 'B2: the pre-step hook preserves the next() decision');
  assert.equal(noPersonaAgent.injected.length, 0, 'B2: the pre-step hook injects nothing without a persona');

  // -- B2: a throwing inject() does NOT propagate ------------------------------
  const throwingAgent = injectableAgent('throwing-session', { throwingInject: true });
  reg.agents.set('throwing-session', { agent: throwingAgent });
  service.activate(throwingAgent, 'terse');
  let threw = null;
  let throwQueued = null;
  try {
    throwQueued = await service.injectMemory(throwingAgent, [
      { role: 'user', content: [{ type: 'text', text: 'kubernetes rollout rollback strategy' }] },
    ]);
  } catch (err) {
    threw = err;
  }
  assert.equal(threw, null, 'B2: a throwing inject() never propagates out of injectMemory()');
  assert.equal(throwQueued, 0, 'B2: a failed delivery reports zero queued');
  // ...and the same through the real pre-step waterfall, which must still next().
  let nextAfterThrow = 0;
  const decisionAfterThrow = await preStep(
    { agent: throwingAgent, messages: [{ role: 'user', content: [{ type: 'text', text: 'kubernetes rollout rollback strategy' }] }], turn: 2, step: 2 },
    async () => { nextAfterThrow += 1; return { kind: 'allow' }; },
  );
  assert.equal(nextAfterThrow, 1, 'B2: a memory failure does not break the turn (next() still runs)');
  assert.deepEqual(decisionAfterThrow, { kind: 'allow' }, 'B2: the turn continues after a memory failure');
  // The failure is still observable (logged, not swallowed silently).
  assert.ok(service.injectionStatus('throwing-session').attempts.some((n) => /inject threw/.test(n.reason)),
    'B2: the delivery failure is recorded for inspection');

  // -- B2: never wake an idle driver ------------------------------------------
  const idleAgent = injectableAgent('idle-session', { idleDelay: 60000 });
  service.activate(idleAgent, 'terse');
  const idleQueued = await service.injectMemory(idleAgent, []);
  assert.equal(idleQueued, 0, 'B2: an idle agent with no running step is not injected');
  assert.equal(idleAgent.injected.length, 0, 'B2: an idle agent receives zero inject() calls');
  assert.equal(idleAgent.busy, undefined, 'B2: the delivery path did not mutate the agent to make it busy');

  // -- B2: the config switch disables injection without a code change ----------
  const offService = new (Object.getPrototypeOf(service).constructor)(ctx, {
    personasDir: dir,
    memoryInjection: false,
  });
  await offService.start();
  assert.equal(offService.memoryInjection, false, 'B2: config.memoryInjection=false is honoured');
  const offAgent = injectableAgent('off-session');
  offService.activate(offAgent, 'terse');
  const offQueued = await offService.injectMemory(offAgent, [
    { role: 'user', content: [{ type: 'text', text: 'kubernetes rollout rollback strategy' }] },
  ]);
  assert.equal(offQueued, 0, 'B2: injection is disabled by config');
  assert.equal(offAgent.injected.length, 0, 'B2: no inject() call when the switch is off');
  assert.equal(offService.injectionStatus('off-session').enabled, false, 'B2: the disabled state is inspectable');

  // -- B2: a batch still pending in the inbox is NOT counted as delivered ------
  // Honest-reporting guard: if every message of the last batch is still sitting in
  // the next-step queue, the model has not claimed it, so re-sending the same
  // records would be a duplicate. They must be suppressed (and NOT silently
  // dropped from the tracking set either).
  const pendingAgent = injectableAgent('pending-session');
  reg.agents.set('pending-session', { agent: pendingAgent });
  service.activate(pendingAgent, 'terse');
  const stepText = 'kubernetes rollout rollback strategy';
  await service.injectMemory(pendingAgent, [{ role: 'user', content: [{ type: 'text', text: stepText }] }]);
  const firstBatch = pendingAgent.injected.at(-1);
  assert.ok(firstBatch, 'B2: the first batch was injected');
  pendingAgent.inbox.nextStep.push({ message: firstBatch }); // still unclaimed
  const redelivered = await service.injectMemory(pendingAgent, [
    { role: 'user', content: [{ type: 'text', text: stepText }] },
  ]);
  assert.equal(redelivered, 0, 'B2: an unclaimed batch is not re-injected');
  assert.equal(pendingAgent.injected.length, 1, 'B2: still exactly one inject() call');
  assert.ok(service.injectionStatus('pending-session').attempts.some(
    (n) => /still unclaimed/.test(n.reason),
  ), 'B2: the suppression reason is inspectable');

  // -- B2: agent registry path (contract item 3) -------------------------------
  // The mock can now reach an inject-capable agent through ctx.agents.get, which
  // is the seam /api/dsh-cast/activate uses. Previously this always 400'd.
  assert.equal(ctx.agents.get('inject-session'), injectAgent,
    'B2: ctx.agents.get reaches the inject-capable mock agent');
  assert.equal(ctx.agents.get('does-not-exist'), undefined,
    'B2: a missing sessionId still returns undefined (the 400 path stays testable)');
  reg.initiator = injectAgent;
  assert.equal(ctx.agents.currentInitiator(), injectAgent,
    'B2: ctx.agents.currentInitiator reaches the mock agent');
  // The registry is real: /api/dsh-cast/activate now succeeds where it used to 400.
  const activateRoute = reg.routes.find((r) => r.path === '/api/dsh-cast/activate');
  const activateRes = await activateRoute.fetch(new Request('http://localhost/api/dsh-cast/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'inject-session', name: 'terse' }),
  }));
  assert.equal(activateRes.status, 200, 'B2: activate succeeds for a registered inject-capable agent');
  assert.equal((await activateRes.json()).active, 'terse', 'B2: activate reports the persona it set');
  const missingRes = await activateRoute.fetch(new Request('http://localhost/api/dsh-cast/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'nobody-home', name: 'terse' }),
  }));
  assert.equal(missingRes.status, 400, 'B2: activate still 400s for an unknown sessionId');
  assert.equal(service.active(injectAgent), 'terse', 'B2: activation through the route is visible to the service');
  // === END t2 / memory-engineer block ===

  // ==========================================================================
  // === BEGIN post-integration hardening block ===
  // ==========================================================================
  // Four defects found AFTER the team stopped, all reachable from shipped
  // entry points. Each gets a test that FAILS if the fix is reverted — the
  // point is to pin the BEHAVIOUR, not to assert that a guard-shaped line of
  // code exists somewhere.

  // -- H1: persona names cannot escape personasDir ---------------------------
  // `_writePersonaFile` and `remove` both did `path.join(personasDir, `${name}.json`)`
  // with an unvalidated name. Persona names arrive from the HTTP create/edit
  // routes, the `/persona` command family, `pack import`, and the `create_persona`
  // tool — so a name like `../../evil` wrote OUTSIDE personasDir, and on Windows
  // an absolute `C:\...` name ignored personasDir entirely (path.join does not
  // neutralise rooted segments the way path.resolve-style helpers might).
  //
  // The traversal attempts below are the real payloads: the assertion is not just
  // "throws", it is that NOTHING was created outside the sandbox directory.
  const escapeRoot = await mkdtemp(path.join(tmpdir(), 'dsh-cast-escape-'));
  const traversalNames = [
    '../escaped-persona',          // one level up
    '../../escaped-persona',       // two levels up
    '..\\escaped-persona',         // Windows separator, still a traversal
    'sub/../../escaped-persona',   // traversal hidden mid-path
    '/etc/passwd',                 // POSIX-rooted
    'C:\\Windows\\Temp\\escaped',  // Windows-rooted absolute
    '.dsh-cast-report',            // would clobber OUR OWN dot-file side record
    '..',                          // the directory itself
    '',                            // empty name
    'has space',                   // would need quoting to survive a shell
    'with.dot',                    // legal on disk, but collides with dot-file convention
  ];
  for (const badName of traversalNames) {
    assert.throws(
      () => service.personaPathFor(badName),
      (err) => err instanceof Error && /invalid persona name/i.test(err.message),
      `H1: name ${JSON.stringify(badName)} must be rejected by the sink`,
    );
  }
  // And the sink is genuinely the thing enforcing it: drive the REAL async write
  // path and confirm the throw propagates rather than being swallowed.
  await assert.rejects(
    () => service._writePersonaFile({ name: '../escaped-persona', identity: {} }),
    /invalid persona name/i,
    'H1: the async write path rejects a traversal name',
  );
  const escapedOnDisk = await readFile(path.join(escapeRoot, '..', 'escaped-persona.json'), 'utf8')
    .then(() => true).catch(() => false);
  assert.equal(escapedOnDisk, false, 'H1: no file was written outside personasDir by the traversal attempt');
  await rm(escapeRoot, { recursive: true, force: true }).catch(() => {});

  // Legitimate names must still work — a guard that rejects everything is not a fix.
  for (const goodName of ['a', 'terse', 'warm-wit', 'under_score', 'A1', 'x'.repeat(64)]) {
    assert.doesNotThrow(() => service.personaPathFor(goodName), `H1: ${goodName} is a legal persona name`);
  }

  // -- H2: a failed report write must not look like a successful one ---------
  // `writeReport` caught everything and called `this.log`, so a failure left the
  // PREVIOUS report on disk with no staleness marker. During a transient burst
  // 12+ writes failed silently and the on-disk report still looked current.
  //
  // The mock has no filesystem seam (index.js imports writeFile directly from
  // node:fs/promises), so the failure is induced for REAL: point the service at a
  // personasDir that cannot be written, and require the failure to be observable.
  {
    const reportPath = path.join(dir, '.dsh-cast-report.json');
    const goodReport = JSON.parse(await readFile(reportPath, 'utf8'));
    assert.equal(typeof goodReport.writtenAt, 'number', 'H2: a successful write stamps writtenAt');
    assert.equal(service.lastReportError, null, 'H2: lastReportError is clear after a successful write');

    // The failure has to land in the report WRITE, not earlier in writeReport's
    // own mkdir — otherwise the test would prove only that mkdir throws, and would
    // still pass if the catch under test were reverted to its silent form. (An
    // earlier version of this test had exactly that hole: it pointed personasDir at
    // a path whose parent was a file, so mkdir failed first and the assertion never
    // reached the report write at all.)
    //
    // Instead: let mkdir succeed, and block the FINAL write by putting a DIRECTORY
    // where the report file needs to be. personasDir itself is a real directory, so
    // mkdir(recursive) is a no-op and control reaches writeFile, which fails with
    // EISDIR/EPERM. That is the exact line the silent catch used to swallow.
    const blockedDir = path.join(dir, 'blocked-report-dir');
    await mkdir(path.join(blockedDir, '.dsh-cast-report.json'), { recursive: true });
    const broken = new (Object.getPrototypeOf(service).constructor)(ctx, { personasDir: blockedDir });
    await assert.rejects(
      () => broken.writeReport(),
      (err) => err instanceof Error,
      'H2: writeReport propagates a failure of the report write itself, not just of mkdir',
    );
    assert.ok(broken.lastReportError, 'H2: the failure is recorded on the service');
    assert.equal(typeof broken.lastReportError.at, 'number', 'H2: the recorded failure is timestamped');
    assert.match(broken.lastReportError.message, /\S/, 'H2: the recorded failure carries a real message');
  }

  // -- H5: a degraded report must be VISIBLE, not merely non-fatal -----------
  // H2/H4 made report-write failures survivable, but the service recorded
  // `lastReportError` and NOTHING could read it: no route exposed it and the UI
  // could not see it, so a degraded startup was invisible outside the console.
  // The assertion below is deliberately CALLER-SIDE — it drives the same route the
  // client fetches, because a test that only read service.lastReportError would
  // pass even while the failure stayed unreachable by every caller.
  {
    const listRoute = reg.routes.find((r) => r.path === '/api/dsh-cast/list');
    assert.ok(listRoute, 'H5: the list route is registered');

    const healthy = await (await listRoute.fetch(new Request('http://localhost/api/dsh-cast/list'))).json();
    assert.deepEqual(healthy.personas, service.list(),
      'H5: the pre-existing `personas` field is unchanged by adding health (additive contract)');
    assert.ok(healthy.health, 'H5: the list route reports a health block');
    assert.equal(healthy.health.reportStale, false, 'H5: a healthy service reports reportStale=false');
    assert.equal(healthy.health.ok, true, 'H5: a healthy service reports ok=true');
    assert.equal(typeof healthy.health.lastReportAt, 'number', 'H5: lastReportAt is stamped after a successful write');
    assert.equal(healthy.health.lastReportError, null, 'H5: no error is reported while healthy');

    // Now degrade it for real: a directory where the report file must go.
    const degradedDir = path.join(dir, 'h5-degraded');
    await mkdir(path.join(degradedDir, '.dsh-cast-report.json'), { recursive: true });
    const degraded = new (Object.getPrototypeOf(service).constructor)(ctx, { personasDir: degradedDir });
    await degraded.writeReport().catch(() => {});

    const h = degraded.healthStatus();
    assert.equal(h.reportStale, true, 'H5: a failed write marks the report stale');
    assert.equal(h.ok, false, 'H5: a degraded service reports ok=false');
    assert.ok(h.lastReportError && typeof h.lastReportError.message === 'string',
      'H5: the failure is readable through the public accessor, not just the private field');
    assert.equal(typeof h.lastReportError.at, 'number', 'H5: the surfaced error is timestamped');
    assert.equal(h.lastReportAt, null, 'H5: a service that never wrote successfully reports lastReportAt=null');
  }

  // -- H3: the report is labelled for this work, not a previous phase --------
  {
    const report = JSON.parse(await readFile(path.join(dir, '.dsh-cast-report.json'), 'utf8'));
    assert.equal(report.phase, 'phase6', 'H3: the report carries the current phase label, not the stale "phase1"');
  }
  // === END post-integration hardening block ===

  console.log('ALL HOST TESTS PASSED');
  // The watcher (fs.watch) would otherwise keep the process alive; the mock
  // never closes it, so exit explicitly once assertions have passed.
  process.exit(0);
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
