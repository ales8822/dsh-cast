// Standalone structural smoke test for the dsh-cast CLIENT half (Phase 6).
//
// Why this exists: the real client bundle can only be exercised inside the Web
// shell (it needs a `window.__ModuleLoader__`, the baseline module table and a
// React runtime), so `client.js` cannot be *runtime*-verified from Node without
// a Web rebuild + page refresh. What CAN be checked offline, and is checked
// here, is everything structural the browser build would fail on:
//   1. the bundle wrapper + factory shape (`__ModuleLoader__.load({id, factory})`),
//   2. that the factory requires ONLY 'react' (no new npm dependency),
//   3. that it registers the Phase 6 session-header entry with the exact
//      `slots.inject(key, () => slots.register({name,id,order,label}, Component))`
//      pattern, fresh ids, and no `locale` (contract note items 6-8),
//   4. that the rendered elements of the new components are structurally sane
//      when rendered with a minimal React stand-in.
//
// The React stand-in below is a tiny in-file shim — it is NOT a dependency.
// `render()` walks the element tree and throws on the mistakes that matter
// (undefined component, component that throws, invalid style value).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Declared before the shim: `useState`/`useEffect` close over these.
const hookStore = new WeakMap();
let currentComponent = null;
let hookIndex = 0;
const pendingEffects = [];

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, '..', 'client.js'), 'utf8');

// -- 1. bundle wrapper + factory shape ---------------------------------------
assert.match(source, /window\.__ModuleLoader__\.load\(\{/, 'bundle registers through __ModuleLoader__.load');
assert.match(source, /id:\s*'@ales8822\/dsh-cast'/, 'bundle id matches the package name');
assert.match(source, /factory\(require\)\s*\{/, 'bundle exposes a factory(require)');

// -- 2. only 'react' may be required ------------------------------------------
const required = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
assert.deepEqual([...new Set(required)], ['react'], `factory requires only react (got ${JSON.stringify(required)})`);
assert.ok(!/\bimport\s+[^;]*from\s+['"]/.test(source), 'client.js has no ESM imports (browser bundle)');

// -- 3. execute the factory against a minimal React + slots harness -----------
const loaded = [];
const registered = [];
const injected = [];

const flatten = (list) => list.flatMap((x) => (Array.isArray(x) ? flatten(x) : [x]));
function el(type, props, ...children) {
  const flat = flatten(children);
  // React's createElement puts positional children on props.children; mirror
  // that so `h('select', {...}, ...options)` has options at `props.children`.
  const merged = { ...(props ?? {}) };
  if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat;
  return { type, props: merged, children: flat };
}

const ReactShim = {
  createElement: el,
  useState(initial) {
    const record = hookStore.get(currentComponent);
    assert.ok(record, 'useState called outside a component render');
    const i = hookIndex++;
    if (record.state[i] === undefined) record.state[i] = typeof initial === 'function' ? initial() : initial;
    return [record.state[i], (v) => { record.state[i] = typeof v === 'function' ? v(record.state[i]) : v; }];
  },
  useEffect(fn, deps) {
    const record = hookStore.get(currentComponent);
    assert.ok(record, 'useEffect called outside a component render');
    const i = hookIndex++;
    const prev = record.effects[i];
    // Run when deps are absent, or when any dep changed (React's rule).
    const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length
      || deps.some((d, j) => !Object.is(d, prev.deps[j]));
    if (changed) {
      const cleanup = prev && typeof prev.cleanup === 'function' ? prev.cleanup : undefined;
      record.effects[i] = { deps, cleanup: undefined };
      // The real React runs effects after paint; here we run them inline, which
      // is what lets the assertions observe the fetched state.
      record.effects[i].cleanup = fn();
    }
  },
};

globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      loaded.push(def);
    },
  },
};

const src = source.replace(/^\/\/.*$/gm, '');
// Evaluate the bundle body so `window.__ModuleLoader__.load` is invoked.
// eslint-disable-next-line no-new-func
new Function('window', src)(globalThis.window);

assert.equal(loaded.length, 1, 'exactly one bundle registration');
assert.equal(loaded[0].id, '@ales8822/dsh-cast', 'registered bundle id');
const exports_ = loaded[0].factory((spec) => {
  assert.equal(spec, 'react', `factory requested an unexpected module "${spec}"`);
  return ReactShim;
});
assert.ok(exports_.inject.includes('slots'), 'export face injects slots');
assert.equal(typeof exports_.apply, 'function', 'export face has apply(ctx)');

const ctx = {
  slots: {
    inject(key, fn) { injected.push(key); return fn(); },
    register(options, Component) { registered.push({ options, Component }); return () => {}; },
  },
};
exports_.apply(ctx);

assert.deepEqual(injected.sort(), ['conversation.input.left', 'conversation.session.header.actions', 'settings.section'],
  'slots.inject used for every registration (the established pattern)');
assert.deepEqual(registered.map((r) => r.options.name).sort(),
  ['conversation.input.left', 'conversation.session.header.actions', 'settings.section'],
  'name matches the injected slot key');
assert.deepEqual(registered.map((r) => r.options.id).sort(),
  ['dsh-cast-persona-picker', 'dsh-cast-personas', 'dsh-cast-switcher'],
  'fresh id per registration');
assert.ok(registered.every((r) => r.options.locale === undefined),
  'no locale passed (dsh-cast ships no dictionary; declaring one fails loud)');
const header = registered.find((r) => r.options.name === 'conversation.session.header.actions');
assert.ok(header, 'phase 6 registers into conversation.session.header.actions');
assert.equal(header.options.order, 15, 'header entry declares a numeric order');
assert.equal(header.options.label, 'Persona', 'header entry declares a label');
assert.equal(typeof header.Component, 'function', 'header entry has a component');

// -- 4. render the new components with the stand-in React ---------------------
// This catches undefined components, components that throw, invalid style
// objects and unresolved data paths — the failures a browser build would show.
const seen = { hostCalls: [], bodies: [] };
// The mock's own notion of the session's active persona. `null` === "off".
// Only POST /activate may change it; GET /active must only read it.
let activeState = null;
globalThis.fetch = (url, options) => {
  seen.hostCalls.push(`${(options && options.method) || 'GET'} ${url}`);
  if (options && options.body != null) seen.bodies.push(`${options.method || 'GET'} ${url} :: ${options.body}`);

  // A STATEFUL active persona, so a wrong active persona is detectable (F1/F6).
  // The old mock returned `{active:'terse'}` unconditionally, which meant no
  // assertion could tell a correct read from a clobbering one.
  //
  // Semantics mirror the host exactly:
  //   GET  /dsh-cast/active   -> a PURE READ of `activeState` (never mutates)
  //   POST /dsh-cast/activate -> MUTATES `activeState` (this is the route F1
  //                              forbids the client from using to read)
  // `activeState` starts as `null` ("off"), so a client that reads via the
  // mutating route is caught: it would leave 'terse' behind, not null.
  // NB: match on the exact path, because '/dsh-cast/activate' also CONTAINS the
  // substring '/dsh-cast/active' — a naive `includes` would route the mutating
  // call into the read branch and hide the defect this mock exists to catch.
  const pathname = String(url).split('?')[0].replace(/^api/, '');
  if (pathname === '/dsh-cast/active') {
    const queried = decodeURIComponent((String(url).split('sessionId=')[1] ?? '').split('&')[0]);
    if (queried !== 's1') {
      return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: `no agent for sessionId "${queried}"` }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ sessionId: queried, active: activeState }) });
  }
  if (pathname === '/dsh-cast/activate') {
    const sent = JSON.parse((options && options.body) || '{}');
    activeState = sent.name === 'off' ? null : (sent.name ?? null);
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ active: activeState }) });
  }

  const body = url.includes('/dsh-cast/list')
    ? { personas: ['terse', 'warm'] }
    : url.includes('/dsh-cast/get')
      ? {
          persona: {
            name: activeState ?? 'terse',
            definition: {
              identity: 'a terse senior systems engineer',
              expertise: 'systems, on-call, brevity',
              behavior: 'Start with the answer.',
              communication: 'Terse, one line when possible.',
              rules: 'Never apologize.',
              examples: [{ user: 'what is 2+2', assistant: '4.' }],
            },
          },
          migrated: false,
        }
      : url.includes('/dsh-cast/preview')
        ? {
            persona: activeState ?? 'terse',
            sessionId: 's1',
            notes: ['estimate'],
            definition: {
              identity: 'a terse senior systems engineer',
              expertise: '',
              behavior: '',
              communication: 'Terse.',
              rules: '',
              examples: [],
            },
            migrated: false,
            warnings: [],
            layers: [
              { name: 'deployment:persona-prefix', order: 0, sources: ['identity'], text: 'You are terse.', chars: 15, tokens: 4, budgetTokens: 400, capChars: 1600, overBudget: false, truncated: false },
              { name: 'dsh-cast:examples', order: 465, sources: ['examples'], text: 'x'.repeat(40), chars: 40, tokens: 10, budgetTokens: 300, capChars: 1200, overBudget: false, truncated: false },
            ],
            totals: { layers: 2, chars: 57, tokens: 15, overBudgetLayers: [], truncatedLayers: [] },
          }
        : url.includes('/dsh-cast/compare')
          ? { a: 'terse', b: 'warm', prompt: 'hi', responseA: 'short', responseB: 'long', at: 1 }
          : url.includes('/dsh-cast/try')
            ? { name: 'terse', prompt: 'hi', response: 'isolated test reply', systemPrompt: 'You are terse.', at: 1 }
            : {};
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
};

// A hooks-recording renderer. Hook state is keyed by the *component function*
// so each component instance gets its own slot array, and a re-render of the
// same component sees the state its own onClick wrote.
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null;
  if (typeof node === 'string' || typeof node === 'number') return { kind: 'text', text: String(node) };
  assert.ok(node.type, 'element has a type');
  if (typeof node.type === 'function') {
    const prevComponent = currentComponent;
    const prevIndex = hookIndex;
    currentComponent = node.type;
    hookIndex = 0;
    let record = hookStore.get(node.type);
    if (!record) {
      record = { state: [], effects: [] };
      hookStore.set(node.type, record);
    }
    let out;
    try {
      out = node.type(node.props ?? {});
    } finally {
      // Restore the PARENT's cursor: a child component's hooks must not consume
      // slots from the component that rendered it.
      currentComponent = prevComponent;
      hookIndex = prevIndex;
    }
    return render(out);
  }
  assert.equal(typeof node.type, 'string', `host element type must be a string (got ${typeof node.type})`);
  for (const [key, value] of Object.entries(node.props.style ?? {})) {
    assert.ok(['string', 'number'].includes(typeof value), `style.${key} must be a string/number, got ${typeof value}`);
  }
  return {
    kind: 'host', type: node.type, props: node.props,
    children: node.children.map(render),
  };
}

function collect(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const c of node.children ?? []) collect(c, out);
  return out;
}
const textOf = (tree) => collect(tree).filter((n) => n.kind === 'text').map((n) => n.text).join(' ');
const typesOf = (tree) => collect(tree).filter((n) => n.kind === 'host').map((n) => n.type);
const findHost = (tree, type) => collect(tree).find((n) => n.kind === 'host' && n.type === type);
// Let the component's own fetch().then() chain settle. The shim's fetch resolves
// immediately, so a few microtask turns are enough.
const settle = async (turns = 6) => { for (let i = 0; i < turns; i += 1) await Promise.resolve(); };
const click = (tree, type) => {
  const node = findHost(tree, type);
  assert.ok(node, `rendered tree has a <${type}> to click`);
  assert.equal(typeof node.props.onClick, 'function', `<${type}> has an onClick`);
  node.props.onClick({ preventDefault() {} });
};

// -- header entry (A1) --------------------------------------------------------
const headerTree = render(el(header.Component, { sessionId: 's1' }));
assert.ok(headerTree, 'header component renders');
assert.ok(typesOf(headerTree).includes('button'), 'header component renders a button');
assert.ok(textOf(headerTree).includes('Persona'), 'header button is labelled Persona');
click(headerTree, 'button');
await settle(12);
const headerOpen = render(el(header.Component, { sessionId: 's1' }));
const headerOpenText = textOf(headerOpen);
assert.ok(headerOpenText.includes('Persona'), 'header popover opens');
assert.ok(typesOf(headerOpen).includes('select'), 'header popover exposes the A/B persona pickers');
assert.ok(headerOpenText.includes('A/B compare'), 'header popover exposes one-click A/B');
assert.ok(headerOpenText.includes('Run A/B'), 'header popover exposes the A/B run control');
// With no persona active the picker must render the explicit OFF state and must
// NOT mount the inspector or the identity preview (nothing to show). The
// three-state contract (F1) replaced the older "explain the inspector is empty"
// behaviour, which could not distinguish off from error.
assert.ok(headerOpenText.includes('active: off'), 'header popover reports the off state explicitly');
assert.ok(!headerOpenText.includes('What the model sees'),
  'no inspector is mounted while no persona is active');
assert.ok(!headerOpenText.includes('Activate a persona to inspect its composed prompt.'),
  'the off state is a real state, not the inspector empty-state fallback');

// -- composer switcher (shared picker body) -----------------------------------
const Switcher = registered.find((r) => r.options.name === 'conversation.input.left').Component;
const closedTree = render(el(Switcher, { sessionId: 's1' }));
assert.deepEqual(typesOf(closedTree), ['div', 'button'], 'switcher renders just its trigger until opened');
click(closedTree, 'button');
await settle();
const bodyTree = render(el(Switcher, { sessionId: 's1' }));
const bodyText = textOf(bodyTree);
const bodyTypes = typesOf(bodyTree);
assert.ok(bodyText.includes('Off'), 'picker offers "Off" (deactivate)');
assert.ok(bodyText.includes('terse') && bodyText.includes('warm'), 'picker lists every persona');
assert.ok(bodyTypes.includes('select'), 'A/B renders persona A/B pickers');
assert.ok(bodyTypes.includes('input'), 'A/B renders the prompt input');
assert.ok(bodyText.includes('A/B compare'), 'A/B panel is present');
assert.ok(bodyText.includes('Run A/B'), 'A/B panel exposes its run control');
assert.ok(bodyText.includes('active: off'), 'picker reports "active: off" while the persona lookup is pending');

// -- active state + inspector, driven through the picker's own activate() -----
// Clicking a persona calls POST /activate and must update the visible active
// state (A1's "activating from here updates the active state").
const buttonText = (n) => (n.children ?? []).filter((c) => c.kind === 'text').map((c) => c.text).join('');
const personaButton = collect(bodyTree).find(
  (n) => n.kind === 'host' && n.type === 'button' && buttonText(n) === 'terse',
);
assert.ok(personaButton, 'the list renders a button per persona');
personaButton.props.onClick();
await settle();
const activatedTree = render(el(Switcher, { sessionId: 's1' }));
const activatedText = textOf(activatedTree);
// Activating closes the popover (existing switcher behaviour) and updates the
// visible active state on the trigger; reopen it to inspect the details.
assert.ok(activatedText.trim() === '\u{1F3AD} terse',
  `activating updates the visible active state (trigger reads "🎭 terse", got ${JSON.stringify(activatedText.trim())})`);
click(activatedTree, 'button');
await settle(12);
let activatedTree2 = render(el(Switcher, { sessionId: 's1' }));
await settle(12);
// The identity preview mounts, fetches /get, and only then has a role to show;
// render once more so the assertions see the settled state.
await settle(12);
activatedTree2 = render(el(Switcher, { sessionId: 's1' }));
const activatedText2 = textOf(activatedTree2);
assert.ok(activatedText2.includes('active: terse'), 'the picker reports the newly active persona');
assert.ok(activatedText2.includes('\u2713 terse'), 'the active persona is marked in the list');
assert.ok(activatedText2.includes('a terse senior systems engineer'), 'identity preview shows the resolved identity text');
assert.ok(!activatedText2.includes('verbosity'), 'identity preview no longer renders numeric trait chips');
assert.ok(!activatedText2.includes('formality'), 'the numeric personality controls are gone from the picker preview');

// The inspector fetches /preview for the active persona and renders each layer
// by name with its own counts (A2's "the user must see which layer eats the
// budget").
const inspectorTree = activatedTree2;
const inspectorText = textOf(inspectorTree);
assert.ok(inspectorText.includes('What the model sees'), 'inspector heading is present for an active persona');
assert.ok(inspectorText.includes('deployment:persona-prefix'), 'inspector names the identity layer');
assert.ok(inspectorText.includes('dsh-cast:examples'), 'inspector names the examples layer');
assert.ok(/deployment:persona-prefix 15 chars/.test(inspectorText.replace(/\s+/g, ' ')),
  'inspector shows the identity layer char count');
assert.ok(inspectorText.includes('~4 tok'), 'inspector shows per-layer token estimates');
assert.ok(inspectorText.includes('budget 400'), 'inspector shows the budget the layer is measured against');
assert.ok(/2 layers · 57 chars · ~15 tokens/.test(inspectorText.replace(/\s+/g, ' ')),
  'inspector shows the composed-prompt totals');
assert.ok(typesOf(inspectorTree).includes('pre'), 'inspector renders layer text as readable blocks, not raw JSON');

// A/B: run it and check both sides come back, plus the error path.
const selectNode = collect(inspectorTree).find((n) => n.kind === 'host' && n.type === 'select');
assert.ok(selectNode, 'A/B renders a persona A/B picker');
assert.equal(selectNode.children.length, 3, 'A/B picker offers "\u2014" plus every persona');
const abInput = collect(inspectorTree).find((n) => n.kind === 'host' && n.type === 'input');
assert.ok(abInput, 'A/B renders the prompt input');
assert.equal(typeof abInput.props.onChange, 'function', 'A/B prompt input is controlled');
assert.ok(selectNode.props.onChange, 'A/B picker is controlled');

// -- host contract: the client only calls routes the host registers -----------
// client.js's api() builds a RELATIVE url ('api' + '/dsh-cast/x', contract note
// item 9), so normalize to the '/dsh-cast/x' form the host registers.
const hostRoutes = new Set([
  'GET /dsh-cast/active', 'GET /dsh-cast/list', 'GET /dsh-cast/get', 'GET /dsh-cast/preview',
  'POST /dsh-cast/activate', 'POST /dsh-cast/compare', 'POST /dsh-cast/try',
  'POST /dsh-cast/create', 'POST /dsh-cast/edit', 'POST /dsh-cast/delete',
]);
for (const call of seen.hostCalls) {
  const [method, rawUrl] = call.split(' ');
  const bare = '/' + rawUrl.replace(/^api\//, '').split('?')[0];
  assert.ok(hostRoutes.has(`${method} ${bare}`), `client called a registered route: ${call} -> ${method} ${bare}`);
}

// === F1 / F6 REGRESSION GUARD — reading the active persona must not mutate ===
// The previous version of this file asserted the OPPOSITE of the truth:
//   'the picker reads the active persona through the EXISTING /activate route'
// That locked in the blocker. The two assertions below invert it, so the defect
// cannot come back: reading goes through the read-only route, and the mutating
// route is only ever used for a genuine user-initiated activation.
assert.ok(
  seen.hostCalls.some((c) => c.startsWith('GET api/dsh-cast/active')),
  'F1: the picker READS the active persona through the read-only GET /active route',
);
assert.ok(
  !seen.hostCalls.some((c) => c.includes('/dsh-cast/activate') && c.startsWith('GET')),
  'F1: the read-only path is never a mutation',
);
// Every POST to /activate must be a REAL activation of a real persona — never
// the "guess a name and read back the result" workaround, which used the list
// head purely to discover state.
const activatePosts = seen.hostCalls.filter((c) => c.startsWith('POST api/dsh-cast/activate'));
assert.ok(activatePosts.length > 0, 'F1: the picker can still activate (a real mutation, via POST)');
assert.ok(!seen.hostCalls.some((c) => c.includes('/dsh-cast/preview') && !c.startsWith('GET')),
  'preview is only ever called with GET');
assert.ok(!seen.hostCalls.some((c) => c.includes('/dsh-cast/compare')),
  'A/B does not fire until the user runs it (no automatic model call on mount)');

// === F1: an OFF session stays off after mounting, and reads do not activate ==
// Reset the mock's session to "off" and mount a fresh component. If the client
// still used the mutating route to read, `activeState` would be clobbered to
// 'terse' (the list head) and the session would be silently activated.
activeState = null;
hookStore.delete(Switcher); // fresh mount: new hook state, as a new panel would have
const offTree = render(el(Switcher, { sessionId: 's1' }));
await settle(12);
click(offTree, 'button');
await settle(12);
const offTreeOpen = render(el(Switcher, { sessionId: 's1' }));
const offText = textOf(offTreeOpen);
assert.equal(activeState, null, 'F1: mounting the picker did NOT activate a persona (session still off)');
assert.ok(offText.includes('active: off'), 'F1: an off session renders as "active: off", not as an error');
assert.ok(!offText.includes('active: terse'), 'F1: the off session is not misreported as having a persona');
assert.ok(!offText.includes('\u2713 terse'), 'F1: no persona is marked active in an off session');
// And the read-only route was used, not the mutating one.
const postsBeforeOffRead = seen.hostCalls.filter((c) => c.startsWith('POST api/dsh-cast/activate')).length;
assert.equal(
  postsBeforeOffRead, activatePosts.length,
  'F1: merely reading an off session issued no POST /activate call at all',
);

// === F1: a WRONG active persona is now detectable ===========================
// The old mock returned {active:'terse'} unconditionally. Because the mock is
// now stateful, activating "warm" and reading back must report "warm" — a client
// that echoed a hard-coded or stale name would fail here.
hookStore.delete(Switcher);
activeState = null;
const warmTree = render(el(Switcher, { sessionId: 's1' }));
await settle(12);
click(warmTree, 'button');
await settle(12);
const warmOpen = render(el(Switcher, { sessionId: 's1' }));
const warmButton = collect(warmOpen).find(
  (n) => n.kind === 'host' && n.type === 'button' && buttonText(n) === 'warm',
);
assert.ok(warmButton, 'the list renders a "warm" button to activate');
warmButton.props.onClick();
await settle(12);
assert.equal(activeState, 'warm', 'the mock recorded the real activation of warm');
hookStore.delete(Switcher);
activeState = 'warm'; // the session is genuinely warm now; the read must report it
render(el(Switcher, { sessionId: 's1' }));
await settle(12);
const warmRead = render(el(Switcher, { sessionId: 's1' }));
assert.ok(
  textOf(warmRead).includes('\u{1F3AD} warm'),
  `a wrong active persona is now detectable: the trigger shows "🎭 warm" (got ${JSON.stringify(textOf(warmRead).trim())})`,
);
assert.ok(!textOf(warmRead).includes('\u{1F3AD} terse'), 'the stale "terse" name is not echoed back');

// ==========================================================================
// === Structured persona editor (settings panel) ===
// ==========================================================================
// The six sliders are gone; the editor is now six natural-language sections
// (five textareas + a user/assistant example list) with save, preview, and
// unsaved-change handling. This exercises the real panel component against the
// stand-in React and the stateful host mock.
const Panel = registered.find((r) => r.options.name === 'settings.section').Component;
assert.ok(typeof Panel === 'function', 'settings panel component is registered');

hookStore.delete(Panel); // fresh mount for the editor, independent of the pickers
render(el(Panel, {}));
await settle(12);
const panelTree = render(el(Panel, {}));
await settle(12);
const panelText = textOf(panelTree);
assert.ok(panelText.includes('Create persona'), 'editor renders the create form');
assert.ok(panelText.includes('Personas'), 'editor renders the persona list');
assert.ok(panelText.includes('terse') && panelText.includes('warm'), 'editor lists every persona');

// No numeric personality controls remain: there must be no <input type="range">.
const ranges = collect(panelTree).filter(
  (n) => n.kind === 'host' && n.type === 'input' && n.props.type === 'range',
);
assert.equal(ranges.length, 0, 'the six personality sliders are removed (no range inputs anywhere)');

// Select a persona to open the editor.
const rowButton = collect(panelTree).find(
  (n) => n.kind === 'host' && n.type === 'button' && buttonText(n) === 'terse',
);
assert.ok(rowButton, 'the editor renders a persona row button');
rowButton.props.onClick();
await settle(12);
let editorTree = render(el(Panel, {}));
await settle(12);
editorTree = render(el(Panel, {}));
const editorText = textOf(editorTree);
assert.ok(editorText.includes('Persona \u2014 terse'), 'editor opens for the selected persona');
for (const label of [
  'Identity and role',
  'Expertise and capabilities',
  'Behavior and personality',
  'Communication and response style',
  'Rules and preferences',
  'Example responses',
]) {
  assert.ok(editorText.includes(label), `editor renders the "${label}" section`);
}
assert.ok(editorText.includes('Save persona'), 'editor has a Save persona control');
assert.ok(editorText.includes('Preview effective prompt'), 'editor has a Preview effective prompt control');

// The definition loaded from /get must populate the textareas.
const fieldBy = (tree, name) => collect(tree).find(
  (n) => n.kind === 'host' && n.type === 'textarea' && n.props.name === name,
);
const identityField = fieldBy(editorTree, 'identity');
assert.ok(identityField, 'identity textarea is present');
assert.equal(identityField.props.value, 'a terse senior systems engineer', 'identity textarea is populated from /get');
assert.equal(fieldBy(editorTree, 'expertise').props.value, 'systems, on-call, brevity', 'expertise textarea is populated');

// Editing a field marks the draft unsaved and updates the value.
identityField.props.onChange({ target: { value: 'a different engineer' } });
let dirtyTree = render(el(Panel, {}));
assert.ok(textOf(dirtyTree).includes('Unsaved changes'), 'editing marks the draft as unsaved');
assert.equal(fieldBy(dirtyTree, 'identity').props.value, 'a different engineer', 'the identity field reflects the edit');

// Example add/remove.
const userCount = (tree) => collect(tree).filter(
  (n) => n.kind === 'host' && n.type === 'textarea' && /^user-/.test(n.props.name ?? ''),
).length;
assert.equal(userCount(dirtyTree), 1, 'the loaded definition has one example pair');
const addBtn = collect(dirtyTree).find(
  (n) => n.kind === 'host' && n.type === 'button' && buttonText(n) === 'Add example',
);
assert.ok(addBtn, 'editor has an Add example button');
addBtn.props.onClick();
const afterAdd = render(el(Panel, {}));
assert.equal(userCount(afterAdd), 2, 'adding an example increases the pair count');
const removeButtons = collect(afterAdd).filter(
  (n) => n.kind === 'host' && n.type === 'button' && buttonText(n) === 'Remove',
);
assert.equal(removeButtons.length, 2, 'each example row has a Remove button');
removeButtons[0].props.onClick();
const afterRemove = render(el(Panel, {}));
assert.equal(userCount(afterRemove), 1, 'removing an example decreases the pair count');

// Save POSTs the whole definition to /edit and clears the dirty flag.
const saveBtn = collect(afterRemove).find(
  (n) => n.kind === 'host' && n.type === 'button' && buttonText(n) === 'Save persona',
);
assert.ok(saveBtn, 'editor has a Save persona button');
saveBtn.props.onClick();
await settle(12);
assert.ok(
  seen.bodies.some((b) => b.startsWith('POST api/dsh-cast/edit') && b.includes('"definition"') && b.includes('a different engineer')),
  'saving POSTs the definition to /edit',
);
const savedTree = render(el(Panel, {}));
assert.ok(textOf(savedTree).includes('Saved.'), 'a successful save shows confirmation feedback');
assert.ok(!textOf(savedTree).includes('Unsaved changes'), 'saving clears the unsaved-changes flag');

// Preview is a pure GET and renders the resolved prompt sections with provenance.
const previewBtn = collect(savedTree).find(
  (n) => n.kind === 'host' && n.type === 'button' && buttonText(n) === 'Preview effective prompt',
);
assert.ok(previewBtn, 'editor has a preview button');
previewBtn.props.onClick();
await settle(12);
const previewTree = render(el(Panel, {}));
const previewText = textOf(previewTree);
assert.ok(previewText.includes('Effective prompt'), 'preview panel opens');
assert.ok(previewText.includes('deployment:persona-prefix'), 'preview shows the identity section name');
assert.ok(previewText.includes('dsh-cast:examples'), 'preview shows the examples section name');
assert.ok(previewText.includes('(from: identity)'), 'preview shows each section source field');
assert.ok(previewText.includes('Copy prompt'), 'preview offers a copy control');
assert.ok(
  !seen.hostCalls.some((c) => c.includes('/dsh-cast/preview') && !c.startsWith('GET')),
  'the editor preview is a pure GET /preview (never a mutation)',
);

// Try persona: an isolated single-persona test run (POST /try), clearly labelled.
const tryTree = render(el(Panel, {}));
const tryText = textOf(tryTree);
assert.ok(tryText.includes('Try persona'), 'editor renders a Try persona action');
assert.ok(tryText.includes('without changing your active session'), 'try is labelled as isolated/side-effect-free');
const tryInput = collect(tryTree).find(
  (n) => n.kind === 'host' && n.type === 'input' && n.props.placeholder === 'sample message',
);
assert.ok(tryInput, 'try renders a sample message input');
tryInput.props.onChange({ target: { value: 'hello' } });
const tryTree2 = render(el(Panel, {}));
const tryButton = collect(tryTree2).find(
  (n) => n.kind === 'host' && n.type === 'button' && buttonText(n) === 'Try',
);
assert.ok(tryButton, 'try renders a Try button');
tryButton.props.onClick();
await settle(12);
const tryTree3 = render(el(Panel, {}));
assert.ok(textOf(tryTree3).includes('isolated test reply'), 'try shows the isolated model response');
assert.ok(textOf(tryTree3).includes('this is a test response, not your conversation'), 'try distinguishes a test from a real reply');
assert.ok(
  seen.bodies.some((b) => b.startsWith('POST api/dsh-cast/try') && b.includes('"name":"terse"')),
  'try POSTs the persona name and sample message',
);

console.log('ALL CLIENT SMOKE TESTS PASSED');
process.exit(0);
