// @ales8822/dsh-cast — a persona engine for DSH.
//
// Phase 1 (host-side only): PersonaService registered as `ctx.personas`, a trait
// engine over six numeric dimensions, a layered/priority-ordered/token-budgeted
// prompt composer, a file-backed persona store with hot reload, three built-in
// personas, and a `/persona` debug command.
//
// This bundle intentionally imports only Node built-ins and reads everything
// else from the Cordis context, so it needs no dependencies and resolves in any
// profile. The service is registered with `ctx.provide('personas', …)` (the same
// mechanism the Cordis `Service` base class uses internally), giving the same
// fiber-scoped lifetime + auto-unregistration.

import { watch } from 'node:fs';
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DIMENSIONS = ['formality', 'warmth', 'humor', 'verbosity', 'directness', 'chaos'];
const DEFAULT_TRAITS = { formality: 5, warmth: 5, humor: 3, verbosity: 5, directness: 5, chaos: 3 };
const DEFAULT_BUDGET = { identity: 400, voice: 300, behavior: 300, expertise: 300, rules: 300, examples: 300, state: 80, memory: 200 };
const DEFAULT_STATE = { mood: 5, energy: 7, trust: 3, familiarity: 0, updatedAt: 0 };
const MEMORY_SCOPES = ['global', 'user', 'persona', 'conversation', 'episodic'];
const BEHAVIOR_FIELDS = [
  ['greeting', 'Greeting'],
  ['disagreement', 'Disagreeing'],
  ['uncertainty', 'Uncertainty'],
  ['errorHandling', 'Errors'],
];

// ---------------------------------------------------------------------------
// Structured persona schema (natural-language definition).
//
// A persona is now described by SIX fields. Five are free-form text; `examples`
// is an ordered list of user/assistant pairs. These fields are the PRIMARY
// persona definition and the source the prompt resolver assembles from.
//
// The legacy numeric `traits` and the structured `identity`/`voice`/`behavior`/
// `boundaries` objects are PRESERVED (not deleted) because other features still
// consume them — trait-based routing, `mix`, `tune`, mixins, and the markdown /
// character-card export formats — and because they are the migration source for
// personas that predate this schema. The prompt no longer reads them directly.
//
// Schema versioning is signalled by the PRESENCE of a `definition` key on the
// persona (with `schemaVersion: 2` written alongside it). A persona without a
// `definition` key is a legacy persona and is migrated in memory, on the fly, by
// `resolveDefinition()` — never rewritten to disk just because it was loaded.
// ---------------------------------------------------------------------------
const DEFINITION_TEXT_FIELDS = ['identity', 'expertise', 'behavior', 'communication', 'rules'];
const DEFINITION_EXAMPLE_FIELDS = ['user', 'assistant'];
const DEFINITION_TEXT_MAX = 8000;          // per-text-field input cap (sensible limit)
const DEFINITION_EXAMPLES_MAX = 50;        // max example pairs per persona
const DEFINITION_EXAMPLE_PART_MAX = 4000;  // per user/assistant part input cap

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || lo));
// Layered-composer bands whose truncation the inspector must be able to explain.
const BUDGETED_LAYERS = [
  ['deployment:persona-prefix', 'identity'],
  ['dsh-cast:voice', 'voice'],
  ['dsh-cast:behavior', 'behavior'],
  ['dsh-cast:expertise', 'expertise'],
  ['dsh-cast:rules', 'rules'],
  ['dsh-cast:state', 'state'],
  ['dsh-cast:memory', 'memory'],
  ['dsh-cast:examples', 'examples'],
];
const TRUNCATION_MARKER = '…[truncated by dsh-cast token budget]';
const tokensToChars = (tokens) => Math.max(16, Math.floor(Number(tokens) * 4));

function budget(text, tokens) {
  const cap = tokensToChars(tokens);
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n…[truncated by dsh-cast token budget]`;
}

// Coerce a `definition` value into the canonical six-field shape. Unknown keys
// are dropped; missing text fields become ''; missing/mis-typed `examples`
// become []. This is the ONLY normalization a definition goes through on the way
// into the store, so the stored shape stays predictable without inventing nested
// schemas.
function normalizeDefinition(def) {
  const d = def && typeof def === 'object' ? def : {};
  const out = {};
  for (const f of DEFINITION_TEXT_FIELDS) {
    const v = d[f];
    out[f] = typeof v === 'string' ? v : '';
  }
  out.examples = Array.isArray(d.examples) ? d.examples : [];
  return out;
}

// Validate a definition for WRITES. Reads never validate (a legacy persona with a
// malformed definition still loads and migrates); writes reject so an invalid edit
// can never overwrite the last good definition. Returns { valid, errors, warnings }.
function validateDefinition(def) {
  if (def != null && (typeof def !== 'object' || Array.isArray(def))) {
    return { valid: false, errors: [{ field: 'definition', message: '"definition" must be an object' }], warnings: [] };
  }
  const d = def && typeof def === 'object' ? def : {};
  const errors = [];
  const warnings = [];
  for (const f of DEFINITION_TEXT_FIELDS) {
    const v = d[f];
    if (v == null || v === '') continue;
    if (typeof v !== 'string') {
      errors.push({ field: f, message: `"${f}" must be a string` });
    } else if (v.length > DEFINITION_TEXT_MAX) {
      errors.push({ field: f, message: `"${f}" is too long (${v.length} chars; limit ${DEFINITION_TEXT_MAX})` });
    }
  }
  const ex = d.examples;
  if (ex != null && !Array.isArray(ex)) {
    errors.push({ field: 'examples', message: '"examples" must be an array of { "user", "assistant" } objects' });
  } else if (Array.isArray(ex)) {
    if (ex.length > DEFINITION_EXAMPLES_MAX) {
      errors.push({ field: 'examples', message: `too many examples (${ex.length}; limit ${DEFINITION_EXAMPLES_MAX})` });
    }
    ex.forEach((pair, i) => {
      if (pair == null || typeof pair !== 'object' || Array.isArray(pair)) {
        errors.push({ field: `examples[${i}]`, message: 'each example must be an object with "user" and "assistant" strings' });
        return;
      }
      const user = pair.user;
      const assistant = pair.assistant;
      if (typeof user !== 'string' || typeof assistant !== 'string') {
        errors.push({ field: `examples[${i}]`, message: 'each example needs string "user" and "assistant" fields' });
        return;
      }
      if (user.length > DEFINITION_EXAMPLE_PART_MAX) {
        errors.push({ field: `examples[${i}].user`, message: `example user text too long (limit ${DEFINITION_EXAMPLE_PART_MAX})` });
      }
      if (assistant.length > DEFINITION_EXAMPLE_PART_MAX) {
        errors.push({ field: `examples[${i}].assistant`, message: `example assistant text too long (limit ${DEFINITION_EXAMPLE_PART_MAX})` });
      }
      if (!user.trim() && !assistant.trim()) {
        warnings.push({ field: `examples[${i}]`, message: 'an empty example pair has no effect and is ignored' });
      }
    });
  }
  return { valid: errors.length === 0, errors, warnings };
}

// A persona "has a definition" iff the raw object carries a `definition` key. Key
// presence (not content) is the schema marker: an empty-but-present definition is
// an authoritative "this persona is empty", while an absent key means "legacy —
// migrate from traits/voice/behavior/boundaries". This is what lets a user CLEAR
// a legacy persona's fields and have the clearing stick, rather than silently
// re-migrating the old slider prose back in.
function hasDefinitionKey(persona) {
  return persona != null && typeof persona === 'object'
    && Object.prototype.hasOwnProperty.call(persona, 'definition');
}

// ===========================================================================
// === BEGIN memory-engineer (workstream B1): scoped-memory ranking ===
// ===========================================================================
// Ranking constants. See retrieveMemories() for the exact formula.
const DEFAULT_MEMORY_TOKENS = 200;   // matches DEFAULT_BUDGET.memory
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // one week
const SCOPE_PRIORITY = { conversation: 5, persona: 4, user: 3, episodic: 2, global: 1 };
const SCOPE_PRIORITY_BONUS = 0.15;   // max (normalized) contribution of scope priority
const MAX_CANDIDATES_TO_RENDER = 12;

// THE token meter, for the estimate only. This mirrors the harness heuristic
// (@deepseek-ai/dsh-token-meter/lib/types/estimate.js, "Fixed text-density
// estimate"): CHARS_PER_TOKEN = 4, BLOCK_OVERHEAD = 4 per content block,
// ROLE_OVERHEAD = 4 per message. Deliberately re-implemented in ~10 lines rather
// than imported, because the host half must keep ZERO npm dependencies
// (phase6-contract.md item 10) and the estimator is not exposed through any
// Cordis service as a scalar. If a real token meter is mounted we PREFER it —
// see PersonaService._measureText() — and fall back to this.
//
// DEVIATION FROM THE HARNESS (stated honestly, per review finding F4; the
// earlier comment here claimed "byte-for-byte" equality and that was WRONG):
// the harness prices a text block as `ceil(len/4) + BLOCK_OVERHEAD`, i.e. the
// +4 is flat structural overhead regardless of the block's JSON envelope. An
// earlier version of this function instead measured the literal envelope string
// `{"type":"text","text":""}` (23 chars -> ceil(23/4) = 6) and charged that, on
// top of `ceil(len/4)`, for a total of `ceil(len/4) + 6 + 4` — overcharging by
// exactly 2 tokens on every message. The block term is now the flat
// BLOCK_OVERHEAD constant, so for a single-text-block user message this returns
// exactly `estimateMessage()`'s number. See heuristicMatchesHarness() below,
// which is asserted against a faithful re-derivation of the harness formula.
const HEURISTIC_CHARS_PER_TOKEN = 4;
const HEURISTIC_BLOCK_OVERHEAD = 4;
const HEURISTIC_ROLE_OVERHEAD = 4;

function heuristicTextTokens(text) {
  const body = Math.ceil(String(text ?? '').length / HEURISTIC_CHARS_PER_TOKEN);
  return body + HEURISTIC_BLOCK_OVERHEAD + HEURISTIC_ROLE_OVERHEAD;
}

// The harness formula, re-derived independently for the regression test:
// estimateMessage({role:'user', content:[{type:'text', text}]})
//   = estimateContent([block]) + ROLE_OVERHEAD
//   = (ceil(text.length/4) + BLOCK_OVERHEAD) + ROLE_OVERHEAD
function harnessEstimateMessage(text) {
  const content = Math.ceil(String(text ?? '').length / HEURISTIC_CHARS_PER_TOKEN) + HEURISTIC_BLOCK_OVERHEAD;
  return content + HEURISTIC_ROLE_OVERHEAD;
}

// True when our fallback agrees with the harness formula for a text message.
// Kept as a named function so the test asserts the PROPERTY, not a copy of the
// arithmetic (a test that re-implements the body would pass even if both drifted).
function heuristicMatchesHarness(text) {
  return heuristicTextTokens(text) === harnessEstimateMessage(text);
}

// Price a candidate `user/message` exactly the way the harness meter prices the
// message we would hand to agent.inject(): one text block + role framing.
function priceMessage(text) {
  return heuristicTextTokens(text);
}

// Price ONE memory record as a prompt line. The price is the record's own line as
// the renderer emits it (`- [scope] text`) plus the newline that separates lines —
// i.e. the real bytes the model would read, not a nominal per-record constant.
// `record` is accepted so a future fielded renderer can stay in sync; it is
// currently unused beyond form: the renderer prints only scope and text.
function priceMemoryMessage(text, record) {
  void record;
  const line = `- [${String(record?.scope ?? 'global')}] ${String(text ?? '')}`;
  return { tokens: heuristicTextTokens(line) + 1, chars: line.length + 1 };
}

// Relevance terms of a query. `memories` is deliberately in the stop list: every
// candidate lives in a store called "memories", so the word carries no signal and
// would otherwise make unrelated records look relevant.
const STOP_TERMS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'what', 'when', 'where',
  'which', 'who', 'whom', 'your', 'yours', 'you', 'have', 'has', 'had', 'was', 'were', 'are',
  'not', 'but', 'all', 'any', 'can', 'could', 'would', 'should', 'will', 'just', 'than', 'then',
  'them', 'they', 'their', 'there', 'here', 'how', 'why', 'does', 'did', 'doing', 'been', 'being',
  'our', 'out', 'own', 'too', 'very', 'get', 'got', 'make', 'made', 'like', 'use', 'using', 'memories',
]);

function tokenizeForRelevance(text) {
  return new Set(
    String(text ?? '')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length > 2 && !STOP_TERMS.has(w)),
  );
}

// Recency in [0, 1]: 1 at createdAt === now, 0.5 after one half-life, -> 0 as the
// next half-life passes. Records with no usable createdAt are treated as oldest.
function recencyScore(createdAt, now) {
  const at = Number(createdAt);
  if (!Number.isFinite(at) || at <= 0) return 0;
  const age = Math.max(0, now - at);
  return Math.pow(0.5, age / RECENCY_HALF_LIFE_MS);
}

// --- context-budget pass ---------------------------------------------------
// Layers the budget is allocated across. `band` names the DEFAULT_BUDGET key.
const CONTEXT_LAYERS = [
  { name: 'identity', band: 'identity', share: 0.26 },
  { name: 'voice', band: 'voice', share: 0.15 },
  { name: 'behavior', band: 'behavior', share: 0.15 },
  { name: 'expertise', band: 'expertise', share: 0.09 },
  { name: 'rules', band: 'rules', share: 0.09 },
  { name: 'examples', band: 'examples', share: 0.16 },
  { name: 'state', band: 'state', share: 0.04 },
  { name: 'memory', band: 'memory', share: 0.06 },
];

// The context-budget layer keys are the DEFAULT_BUDGET band names; the composer
// names the same bands as prompt sections. This is the one mapping between them.
const LAYER_NAME_BY_BAND = {
  identity: 'deployment:persona-prefix',
  voice: 'dsh-cast:voice',
  behavior: 'dsh-cast:behavior',
  expertise: 'dsh-cast:expertise',
  rules: 'dsh-cast:rules',
  examples: 'dsh-cast:examples',
  state: 'dsh-cast:state',
  memory: 'dsh-cast:memory',
};

const layerKeyToLayerName = (band) => LAYER_NAME_BY_BAND[band] ?? band;

// REMOVED (review finding F5): `safeIdleDelayMs(agent)` read `agent.idleDelay`.
// That field does not exist on a real Agent — it appears nowhere in the DSH
// checkout — so the function was dead code and the comment naming it was wrong.
// It was originally removed rather than "wired", because wiring it would have
// given an invented field authority over the delivery decision: every real agent
// would read as idle-and-therefore-undeliverable, silently disabling injection.
// The genuine idle signal is `agent.status` / `pendingSteps`, which
// PersonaService.agentIsBusy() already checks.

// Existence check for the "is every record in this batch still unclaimed?" guard.
function inboxItemMessage(item) {
  return item?.message ?? item;
}
// ===========================================================================
// === END memory-engineer (workstream B1) constants ===
// ===========================================================================

function traitDirective(name, value) {
  const v = clamp(value, 0, 10);
  switch (name) {
    case 'formality':
      return v <= 3
        ? 'use casual, colloquial language (slang and contractions are welcome)'
        : v <= 6
          ? 'use neutral, everyday prose'
          : 'use formal, structured prose and precise vocabulary';
    case 'warmth':
      return v <= 3
        ? 'stay detached and matter-of-fact; do not mirror or soothe emotions'
        : v <= 6
          ? 'stay measured and courteous without being effusive'
          : 'be warm, emotionally attuned, and encouraging';
    case 'humor':
      return v <= 2
        ? 'avoid jokes and levity entirely'
        : v <= 5
          ? 'use occasional dry, understated humor'
          : v <= 8
            ? 'use frequent, playful humor'
            : 'be persistently witty and comedic';
    case 'verbosity':
      return v <= 3
        ? 'be terse: short sentences, no padding, one point per line when possible'
        : v <= 6
          ? 'be moderately concise: answer fully but without rambling'
          : 'be expansive and thorough; elaborate with examples and context';
    case 'directness':
      return v <= 3
        ? 'hedge and soften claims; invite the other perspective'
        : v <= 6
          ? 'be balanced: state your view plainly while staying polite'
          : 'be blunt and direct; say exactly what you mean without hedging';
    case 'chaos':
      return v <= 3
        ? 'be predictable and consistent in phrasing and structure'
        : v <= 6
          ? 'vary your phrasing and structure for interest'
          : 'be unpredictable: vary sentence rhythm, digress, surprise, and break conventions';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Trait engine: defaults -> archetype -> mixins -> persona overrides (later wins).
// ---------------------------------------------------------------------------
const BUILTIN_MIXINS = {
  'british-sarcasm': {
    name: 'british-sarcasm',
    traits: { formality: 7, humor: 8, directness: 4, warmth: 3 },
    voice: { catchphrases: ['rather.', 'quite.'] },
  },
  concise: {
    name: 'concise',
    traits: { verbosity: 1, directness: 8, chaos: 2 },
    voice: { taboo: ['rambling', 'padding'] },
  },
  noir: {
    name: 'noir',
    traits: { formality: 6, warmth: 1, humor: 2, chaos: 4 },
    voice: { catchphrases: ['It was raining again.'] },
  },
};

// keyword -> trait delta for natural-language tune ("make them warmer, less chatty").
const EDIT_KEYWORDS = [
  [/\bwarmer\b/i, 'warmth', 2],
  [/\bcolder\b|\bmore detached\b/i, 'warmth', -2],
  [/\bless chatty\b|\bmore terse\b|\bconcise\b/i, 'verbosity', -2],
  [/\bchattier\b|\bmore talkative\b|\bmore verbose\b/i, 'verbosity', 2],
  [/\bmore formal\b/i, 'formality', 2],
  [/\bless formal\b|\bmore casual\b/i, 'formality', -2],
  [/\bfunnier\b|\bmore humor\b|\bwittier\b/i, 'humor', 2],
  [/\bmore direct\b|\bblunter\b/i, 'directness', 2],
  [/\bsofter\b|\bless direct\b|\bgentler\b/i, 'directness', -2],
  [/\bmore chaotic\b|\bunpredictable\b/i, 'chaos', 2],
  [/\bmore predictable\b/i, 'chaos', -2],
];

function mergeVoice(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (Array.isArray(value) && Array.isArray(target[key])) target[key] = [...target[key], ...value];
    else target[key] = value;
  }
  return target;
}

// Fully resolve a persona: archetype (recursive) -> mixins (in order) -> own fields.
function resolvePersona(persona, store) {
  const layers = [];
  const archetype = persona.composition?.archetype;
  if (archetype) {
    const arch = store.get(archetype);
    if (arch && arch.name !== persona.name) layers.push(resolvePersona(arch, store));
  }
  for (const mixinName of persona.composition?.mixins ?? []) {
    const mixin = store.getMixin(mixinName);
    if (mixin) layers.push(mixin);
  }
  layers.push(persona);

  const merged = {
    name: persona.name,
    identity: {},
    traits: {},
    voice: {},
    behavior: {},
    boundaries: { always: [], never: [] },
    examples: [],
    parameters: {},
    composition: persona.composition ?? {},
  };
  // The natural-language definition merges across layers the same way the legacy
  // fields do: a later layer's non-empty text wins per field, and a later layer's
  // non-empty example list replaces the whole list. An archetype/mixin that has no
  // `definition` key contributes nothing, so legacy inheritance still flows through
  // the legacy fields and is migrated AFTER this merge (see resolveDefinition()).
  let mergedDefinition = null;
  for (const layer of layers) {
    if (layer.identity) Object.assign(merged.identity, layer.identity);
    if (layer.traits) Object.assign(merged.traits, layer.traits);
    if (layer.voice) mergeVoice(merged.voice, layer.voice);
    if (layer.behavior) Object.assign(merged.behavior, layer.behavior);
    if (layer.boundaries?.always) merged.boundaries.always.push(...layer.boundaries.always);
    if (layer.boundaries?.never) merged.boundaries.never.push(...layer.boundaries.never);
    if (Array.isArray(layer.examples) && layer.examples.length) merged.examples = layer.examples;
    if (layer.parameters) Object.assign(merged.parameters, layer.parameters);
    if (layer.definition && typeof layer.definition === 'object') {
      mergedDefinition = mergedDefinition ?? { identity: '', expertise: '', behavior: '', communication: '', rules: '', examples: [] };
      for (const f of DEFINITION_TEXT_FIELDS) {
        const v = layer.definition[f];
        if (typeof v === 'string' && v.trim()) mergedDefinition[f] = v;
      }
      if (Array.isArray(layer.definition.examples) && layer.definition.examples.length) {
        mergedDefinition.examples = layer.definition.examples;
      }
    }
  }
  if (mergedDefinition) merged.definition = mergedDefinition;
  for (const k of DIMENSIONS) merged.traits[k] = clamp(merged.traits[k] ?? DEFAULT_TRAITS[k], 0, 10);
  return merged;
}

function resolveTraits(persona, store) {
  return resolvePersona(persona, store).traits;
}

// ---------------------------------------------------------------------------
// Migration + resolution.
//
// `resolveDefinition(resolvedPersona)` is the single place a stored persona turns
// into the six-field definition the prompt is built from. It is DETERMINISTIC:
// identical input produces identical output, and it never writes to disk.
//
//   - If the persona carries a `definition` key, that definition IS the persona
//     (an all-empty definition is authoritative, so a user's clearing sticks).
//   - Otherwise the persona is legacy: its traits/voice/behavior/boundaries are
//     translated into the six fields. Trait values are mapped to prose ONLY via
//     the existing, documented `traitDirective()` wording — nothing is invented
//     for undocumented values.
// ---------------------------------------------------------------------------
function migrateLegacyDefinition(persona) {
  const id = persona.identity ?? {};
  const traits = persona.traits ?? {};
  const voice = persona.voice ?? {};
  const behavior = persona.behavior ?? {};
  const boundaries = persona.boundaries ?? {};

  // identity — reuse the existing identity wording (the authoritative clause is
  // re-added by the section builder, not stored in the field).
  const idParts = [`You are ${id.role ?? persona.name}.`];
  if (id.backstory) idParts.push(`Background: ${id.backstory}`);
  if (Array.isArray(id.values) && id.values.length) idParts.push(`You value: ${id.values.join('; ')}.`);
  if (Array.isArray(id.goals) && id.goals.length) idParts.push(`Your goals: ${id.goals.join('; ')}.`);

  // communication — the legacy voice layer: trait directives + catchphrases + taboo.
  const voiceParts = ['Voice and style:'];
  for (const dim of DIMENSIONS) {
    const directive = traitDirective(dim, traits[dim]);
    if (directive) voiceParts.push(`- ${dim}: ${directive}.`);
  }
  if (Array.isArray(voice.catchphrases) && voice.catchphrases.length) {
    voiceParts.push(`- Catchphrases you may use: ${voice.catchphrases.join(', ')}.`);
  }
  if (Array.isArray(voice.taboo) && voice.taboo.length) {
    voiceParts.push(`- Avoid: ${voice.taboo.join(', ')}.`);
  }

  // behavior — the legacy behavior object (greeting/disagreement/uncertainty/errors).
  const behaviorParts = ['How you interact:'];
  for (const [key, label] of BEHAVIOR_FIELDS) {
    if (behavior[key]) behaviorParts.push(`- ${label}: ${behavior[key]}.`);
  }

  // rules — the legacy boundaries (always/never), which are exactly "explicit
  // preferences and constraints".
  const rulesParts = [];
  if (Array.isArray(boundaries.always) && boundaries.always.length) {
    rulesParts.push(`Always: ${boundaries.always.join('; ')}.`);
  }
  if (Array.isArray(boundaries.never) && boundaries.never.length) {
    rulesParts.push(`Never: ${boundaries.never.join('; ')}.`);
  }

  // examples — parse the legacy "Q: …\nA: …" strings into user/assistant pairs.
  const pairs = [];
  for (const ex of Array.isArray(persona.examples) ? persona.examples : []) {
    const s = String(ex);
    const m = s.match(/^\s*Q\s*:\s*([\s\S]*?)\n\s*A\s*:\s*([\s\S]*)$/i);
    if (m) pairs.push({ user: m[1].trim(), assistant: m[2].trim() });
    else pairs.push({ user: '', assistant: s.trim() });
  }

  return normalizeDefinition({
    identity: idParts.join('\n'),
    expertise: '',
    behavior: behaviorParts.length > 1 ? behaviorParts.join('\n') : '',
    communication: voiceParts.join('\n'),
    rules: rulesParts.join('\n'),
    examples: pairs,
  });
}

function resolveDefinition(resolvedPersona) {
  if (hasDefinitionKey(resolvedPersona)) {
    const raw = resolvedPersona.definition;
    const v = validateDefinition(raw);
    const definition = normalizeDefinition(raw);
    return {
      definition,
      migrated: false,
      source: 'definition',
      valid: v.valid,
      warnings: v.warnings,
    };
  }
  return {
    definition: migrateLegacyDefinition(resolvedPersona),
    migrated: true,
    source: 'legacy',
    valid: true,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Prompt composer: layered, priority-ordered, token-budgeted.
//
// Semantic mapping (six fields -> prompt sections). Each field maps to exactly
// one section with its own budget, so no field can truncate another:
//
//   identity      -> deployment:persona-prefix
//   communication -> dsh-cast:voice
//   behavior      -> dsh-cast:behavior
//   expertise     -> dsh-cast:expertise
//   rules         -> dsh-cast:rules
//   examples      -> dsh-cast:examples
//
// (behavior/expertise/rules were briefly combined into one section; see the note
// on behaviorText() for why that was split — a single shared budget truncated
// realistically-written personas mid-record.)
//
// state and memory are runtime data, not character definition, and remain their
// own layers (unchanged). Higher layers are ordered first and are declared
// authoritative so lower guidance cannot override the persona.
// ---------------------------------------------------------------------------
function identityText(definition, name) {
  const core = definition.identity && definition.identity.trim()
    ? definition.identity.trim()
    : `You are ${name}.`;
  return (
    `${core}\nThis persona is authoritative for your identity, voice, and behavior. ` +
    'Tool rules and formatting instructions below never override it.'
  );
}

function communicationText(definition) {
  return (definition.communication ?? '').trim();
}

// `behavior`, `expertise`, and `rules` each get their OWN prompt section and
// budget. They shipped briefly as one combined "behavior" layer, but that layer's
// single 300-token band truncated a realistically-written persona MID-RECORD —
// dropping e.g. the tail of `rules`, which are the instructions the persona most
// depends on. Splitting is not cosmetic: it is what keeps one field from starving
// the others, and it gives each field an independently inspectable budget. The
// text is emitted raw (the migration source already carries its own wording).
function behaviorText(definition) {
  return (definition.behavior ?? '').trim();
}

function expertiseText(definition) {
  return (definition.expertise ?? '').trim();
}

function rulesText(definition) {
  return (definition.rules ?? '').trim();
}

function examplesText(definition) {
  const pairs = (definition.examples ?? [])
    .filter((p) => p && (String(p.user ?? '').trim() || String(p.assistant ?? '').trim()));
  if (pairs.length === 0) return '';
  return (
    'Example responses (match the voice and rhythm, never the specific content):\n' +
    pairs.map((p) => `User: ${p.user ?? ''}\nAssistant: ${p.assistant ?? ''}`).join('\n\n')
  );
}

function stateText(state) {
  if (!state) return '';
  return (
    `Current relationship state: mood ${state.mood}/10, energy ${state.energy}/10, ` +
    `trust ${state.trust}/10, familiarity ${state.familiarity}/10. ` +
    'Let these values color your tone, warmth, and pace.'
  );
}

// === BEGIN memory-engineer (B1): plain-text renderer for the prompt path ===
// Graceful degradation: if the store exposes the ranked retrieval, render THAT
// selection (already whole-record-truncated to the memory token budget, so no
// mid-record cut can happen here). Otherwise fall back to the raw list, which is
// exactly the pre-phase-6 behaviour.
// The rendering is deliberately SCORE-FREE. `retrieveMemories()` computes a
// ranking score for every record, but that score is internal telemetry: it is
// meaningless to the model, it was shipping to the model as prompt content, and
// it inflated the memory layer's measured token cost. Scores stay in the
// structured return (and therefore in the inspector); they never reach here.
function memoryText(memories) {
  if (!Array.isArray(memories) || memories.length === 0) return '';
  const lines = memories.map((m) => `- ${m?.text ?? ''}`);
  return `Remembered context (use only what is relevant):\n${lines.join('\n')}`;
}
// === END memory-engineer (B1) renderer ===

// Build the ordered, budgeted prompt layers from a resolved six-field definition.
// Each layer carries `sources` (which definition field(s) it was assembled from)
// so the inspector can show provenance without a second, parallel implementation.
// State and memory remain runtime layers, independent of the character definition.
function composeDefinition(definition, name, budgetMap, store, sessionId) {
  const b = { ...DEFAULT_BUDGET, ...(budgetMap ?? {}) };
  const layers = [
    { name: 'deployment:persona-prefix', order: 0, sources: ['identity'], text: budget(identityText(definition, name), b.identity) },
  ];
  const voice = budget(communicationText(definition), b.voice);
  if (voice) layers.push({ name: 'dsh-cast:voice', order: 250, sources: ['communication'], text: voice });
  // behavior / expertise / rules are three independent sections with three
  // independent budgets (see the note on behaviorText above). Each is emitted only
  // when it has content, so an empty field produces no section at all.
  const behavior = budget(behaviorText(definition), b.behavior);
  if (behavior) layers.push({ name: 'dsh-cast:behavior', order: 450, sources: ['behavior'], text: behavior });
  const expertise = budget(expertiseText(definition), b.expertise);
  if (expertise) layers.push({ name: 'dsh-cast:expertise', order: 452, sources: ['expertise'], text: expertise });
  const rules = budget(rulesText(definition), b.rules);
  if (rules) layers.push({ name: 'dsh-cast:rules', order: 454, sources: ['rules'], text: rules });
  const state = stateText(store.getState(name));
  if (state) layers.push({ name: 'dsh-cast:state', order: 455, sources: ['state'], text: budget(state, b.state) });
  // === BEGIN memory-engineer (B1): ranked, whole-record, budget-bounded ===
  // When the store supports it, the memory layer is produced by the ranked
  // retrieval (already bounded to the layer's real budget) and is NOT re-cut by
  // budget(); the plain-text renderer above is the fallback for anything else.
  let memoryRender = null;
  if (typeof store.retrieveMemories === 'function') {
    const budgetTokens = Number(b.memory ?? DEFAULT_MEMORY_TOKENS);
    const ranked = store.retrieveMemories(name, sessionId, { budgetTokens });
    if (ranked && ranked.selection.length) memoryRender = memoryText(ranked.selection);
  } else {
    memoryRender = memoryText(store.listMemories(name, sessionId));
  }
  if (memoryRender) {
    layers.push({ name: 'dsh-cast:memory', order: 460, sources: ['memory'], text: memoryRender });
  }
  // === END memory-engineer (B1) memory layer ===
  const examples = budget(examplesText(definition), b.examples);
  if (examples) {
    layers.push({ name: 'dsh-cast:examples', order: 465, sources: ['examples'], text: examples });
  }
  return layers;
}

function compose(persona, budgetMap, store, sessionId) {
  const resolved = resolvePersona(persona, store);
  const rd = resolveDefinition(resolved);
  return composeDefinition(rd.definition, resolved.name, budgetMap, store, sessionId);
}

// ---------------------------------------------------------------------------
// Phase 5: import/export formats (Markdown, Character Card V2, packs).
// ---------------------------------------------------------------------------
function parseList(body) {
  return String(body ?? '').split('\n').map((s) => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
}

function parseKeyValues(body) {
  const out = {};
  for (const line of String(body ?? '').split('\n')) {
    const m = line.match(/^[-*]\s*([A-Za-z]+)\s*:\s*([-\d.]+)/);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

function personaToMarkdown(persona) {
  const id = persona.identity ?? {};
  const lines = [`# ${persona.name}`];
  if (id.role) lines.push(`## Role\n${id.role}`);
  if (id.backstory) lines.push(`## Backstory\n${id.backstory}`);
  if (id.values?.length) lines.push(`## Values\n${id.values.map((v) => `- ${v}`).join('\n')}`);
  if (id.goals?.length) lines.push(`## Goals\n${id.goals.map((g) => `- ${g}`).join('\n')}`);
  if (persona.traits && Object.keys(persona.traits).length) {
    lines.push(`## Traits\n${Object.entries(persona.traits).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`);
  }
  const v = persona.voice ?? {};
  if (v.catchphrases?.length) lines.push(`## Catchphrases\n${v.catchphrases.map((c) => `- ${c}`).join('\n')}`);
  if (v.taboo?.length) lines.push(`## Avoid\n${v.taboo.map((t) => `- ${t}`).join('\n')}`);
  const b = persona.behavior ?? {};
  if (Object.keys(b).length) {
    lines.push(`## Behavior\n${Object.entries(b).map(([k, val]) => `- ${k}: ${val}`).join('\n')}`);
  }
  const bd = persona.boundaries ?? {};
  if (bd.always?.length) lines.push(`## Always\n${bd.always.map((x) => `- ${x}`).join('\n')}`);
  if (bd.never?.length) lines.push(`## Never\n${bd.never.map((x) => `- ${x}`).join('\n')}`);
  if (persona.examples?.length) lines.push(`## Examples\n${persona.examples.join('\n\n')}`);
  return lines.join('\n\n');
}

function markdownToPersona(name, md) {
  const persona = {
    name,
    identity: {}, traits: {}, voice: {}, behavior: {},
    boundaries: { always: [], never: [] }, examples: [],
    parameters: {}, composition: {},
  };
  for (const section of String(md ?? '').split(/\n##\s+/)) {
    const nl = section.indexOf('\n');
    const heading = (nl >= 0 ? section.slice(0, nl) : section).replace(/^#+\s*/, '').trim();
    const body = (nl >= 0 ? section.slice(nl + 1) : '').trim();
    switch (heading) {
      case 'Role': persona.identity.role = body; break;
      case 'Backstory': persona.identity.backstory = body; break;
      case 'Values': persona.identity.values = parseList(body); break;
      case 'Goals': persona.identity.goals = parseList(body); break;
      case 'Traits': persona.traits = parseKeyValues(body); break;
      case 'Catchphrases': persona.voice.catchphrases = parseList(body); break;
      case 'Avoid': persona.voice.taboo = parseList(body); break;
      case 'Behavior': {
        for (const line of String(body).split('\n')) {
          const m = line.match(/^[-*]\s*([A-Za-z]+)\s*:\s*(.+)$/);
          if (m) persona.behavior[m[1]] = m[2].trim();
        }
        break;
      }
      case 'Always': persona.boundaries.always = parseList(body); break;
      case 'Never': persona.boundaries.never = parseList(body); break;
      case 'Examples': persona.examples = String(body).split(/\n\n+/).map((s) => s.trim()).filter(Boolean); break;
      default: break;
    }
  }
  return normalize(persona);
}

function personaToCharacterCard(persona) {
  const id = persona.identity ?? {};
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: persona.name,
      description: [id.role, id.backstory].filter(Boolean).join('\n'),
      personality: persona.traits ? Object.entries(persona.traits).map(([k, v]) => `${k}: ${v}`).join(', ') : '',
      scenario: id.goals?.join('; ') ?? '',
      first_mes: persona.behavior?.greeting ?? '',
      mes_example: persona.examples?.length ? persona.examples.join('\n<START>\n') : '',
      creator_notes: id.backstory ?? '',
      tags: [],
      creator: 'dsh-cast',
      character_version: '1',
      extensions: { dsh_cast: { traits: persona.traits ?? {}, voice: persona.voice ?? {}, boundaries: persona.boundaries ?? {} } },
    },
  };
}

function characterCardToPersona(card) {
  const d = card?.data ?? {};
  const ext = d.extensions?.dsh_cast ?? {};
  return normalize({
    name: d.name ?? 'card-persona',
    identity: {
      role: d.description ? String(d.description).split('\n')[0] : undefined,
      backstory: d.creator_notes || undefined,
      goals: d.scenario ? String(d.scenario).split(';').map((s) => s.trim()).filter(Boolean) : [],
    },
    traits: ext.traits ?? {},
    voice: ext.voice ?? {},
    behavior: d.first_mes ? { greeting: d.first_mes } : {},
    boundaries: ext.boundaries ?? {},
    examples: d.mes_example ? String(d.mes_example).split(/\n<START>\n/).map((s) => s.trim()).filter(Boolean) : [],
    parameters: {},
    composition: {},
  });
}

// ---------------------------------------------------------------------------
// Phase 4: auto-router (task classification -> best-matching persona).
// ---------------------------------------------------------------------------
const TASK_PROFILES = {
  debug: { directness: 9, verbosity: 2, warmth: 2, chaos: 2 },
  comfort: { warmth: 9, directness: 3, chaos: 2 },
  explain: { verbosity: 8, formality: 8, warmth: 5, chaos: 2 },
  brainstorm: { chaos: 9, humor: 8, verbosity: 7 },
  write: { chaos: 6, humor: 3, warmth: 6, verbosity: 6 },
  plan: { directness: 7, verbosity: 3, formality: 6, chaos: 2 },
};

function classifyTask(message) {
  const m = String(message ?? '').toLowerCase();
  if (/(bug|error|debug|fix|broken|crash|fails?)/.test(m)) return 'debug';
  if (/(sad|upset|anxious|worried|stressed|comfort|vent|lonely)/.test(m)) return 'comfort';
  if (/(explain|why|how does|teach|understand|concept|what is)/.test(m)) return 'explain';
  if (/(idea|brainstorm|creative|imagine|what if|story|novel)/.test(m)) return 'brainstorm';
  if (/(write|draft|poem|essay|letter|blog|prose)/.test(m)) return 'write';
  if (/(plan|roadmap|schedule|organize|steps|todo)/.test(m)) return 'plan';
  return null;
}

function scorePersona(persona, profile, store) {
  const traits = resolveTraits(persona, store);
  let score = 0;
  for (const [dim, target] of Object.entries(profile)) {
    score += 10 - Math.abs((traits[dim] ?? DEFAULT_TRAITS[dim]) - target);
  }
  return score;
}

function routePersona(message, store) {
  const task = classifyTask(message);
  if (!task) return null;
  const profile = TASK_PROFILES[task];
  let best = null;
  let bestScore = -Infinity;
  for (const name of store.list()) {
    const persona = store.get(name);
    if (!persona) continue;
    const s = scorePersona(persona, profile, store);
    if (s > bestScore) {
      bestScore = s;
      best = name;
    }
  }
  return { task, persona: best, score: bestScore };
}

function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages ?? []) {
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) {
      for (const b of c) if (b && typeof b.text === 'string') chars += b.text.length;
    }
  }
  return Math.ceil(chars / 4);
}

// The harness `RequestMessage.content` is a `readonly ContentBlock[]`, never a bare
// string. Provider adapters serialize it with `content.flatMap(...)`, so a string
// content throws INSIDE the adapter and surfaces only as an opaque
// "DeepSeek Messages transport failed". Normalize string content into a text block
// here, once, so every isolated caller (compare / try / summarize) is safe.
function normalizeRequestMessages(messages) {
  return (messages ?? []).map((message) => {
    const content = message?.content;
    if (typeof content !== 'string') return message;
    return { ...message, content: [{ type: 'text', text: content }] };
  });
}

// A persona name becomes a FILENAME (`<personasDir>/<name>.json`). Anything that
// reaches the filesystem therefore has to be constrained HERE, at the single
// choke point, rather than at each caller: persona names arrive from a lot of
// directions (the HTTP create/edit routes, the `/persona` command family intentionally
// renamed away from the mutating verb, the `create_persona` tool, `pack import`), and
// a per-caller check is a check that eventually gets forgotten.
//
// The characters below also keep the name safe for the dot-prefixed side files in
// personasDir (`.dsh-cast-state.json`, `.dsh-cast-report.json`, …): with no dots and
// no slashes in a name, a persona can never collide with or overwrite them, and the
// directory watcher (which ignores dot-files) stays consistent with what we write.
const PERSONA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function personaFileName(name) {
  const raw = String(name ?? '');
  if (!PERSONA_NAME_RE.test(raw)) {
    throw new Error(
      `invalid persona name ${JSON.stringify(raw)}: names must be 1-64 chars, ` +
        'start with a letter or digit, and contain only letters, digits, "_" or "-"',
    );
  }
  return `${raw}.json`;
}

// Paths (relative to personasDir) that dsh-cast owns and must never treat as a
// persona file, even though they end in .json.
const RESERVED_PERSONA_FILES = new Set([
  '.dsh-cast-state.json',
  '.dsh-cast-report.json',
  '.dsh-cast-memory.json',
  '.dsh-cast-history.json',
  '.dsh-cast-ratings.json',
  '.dsh-cast-comparisons.json',
  '.dsh-cast-groups.json',
  '.dsh-cast-user.json',
]);

function normalize(persona) {
  const p = persona && typeof persona === 'object' ? persona : {};
  const out = {
    name: String(p.name ?? 'unnamed'),
    identity: p.identity ?? {},
    traits: p.traits ?? {},
    voice: p.voice ?? {},
    behavior: p.behavior ?? {},
    boundaries: p.boundaries ?? {},
    examples: Array.isArray(p.examples) ? p.examples : [],
    parameters: p.parameters ?? {},
    composition: p.composition ?? {},
  };
  // Preserve the `definition` key only when the raw persona actually carried one.
  // Key presence is the schema marker (see hasDefinitionKey()); a legacy persona
  // with no key must stay key-less so it is migrated on the fly and is NOT
  // rewritten to disk with an empty definition just because it was normalized.
  if (hasDefinitionKey(p)) {
    out.definition = normalizeDefinition(p.definition);
    out.schemaVersion = Number.isInteger(p.schemaVersion) ? p.schemaVersion : 2;
  } else if (Number.isInteger(p.schemaVersion)) {
    out.schemaVersion = p.schemaVersion;
  }
  return out;
}

export const inject = ['llm', 'sessions', 'tools', 'systemPrompt', 'commands', 'agents', 'connection'];

export function apply(ctx, config) {
  const service = new PersonaService(ctx, config ?? {});
  ctx.provide('personas', service);
  // `apply` is a synchronous Cordis entry point, so start() cannot be awaited here.
  // An un-awaited promise that rejects becomes an unhandledRejection, which on Node
  // 20+ is PROCESS-FATAL by default — so before this catch existed, a single failed
  // report write during startup (e.g. one transient EISDIR/EPERM burst) would take
  // down the whole host instead of being reported. That is the availability half of
  // a trade made by review finding H2, whose re-throw is deliberate and stays: the
  // write failure must be visible. The fix is to give the rejection a landing site
  // here, at the only synchronous boundary that can hold one.
  promise_fail_soft(service.start(), `plugin start() failed: `, service);
}

// Attach a handler so a rejection inside un-awaited startup work is LOGGED rather
// than fatal. Startup is best-effort by design: load*() and writeReport() populate
// caches and side files, and the service is usable without them — the tool routes
// and prompt layers read live state, not the report. So a startup failure degrades
// features; it must never be allowed to terminate the process.
function promise_fail_soft(promise, label, service) {
  return Promise.resolve(promise).catch((err) => {
    const message = err && err.message ? err.message : String(err);
    try {
      service.log(`${label}${message} (continuing; the service is usable but may be missing cached state)`);
    } catch {
      // log() itself must never be able to reintroduce a fatal path.
      console.error(`[dsh-cast] ${label}${message}`);
    }
  });
}

class PersonaService {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.personasDir = typeof config.personasDir === 'string' && config.personasDir
      ? path.resolve(config.personasDir)
      : path.resolve(process.env.DSH_HOME || process.cwd(), 'dsh-cast-personas');
    this.autoActivate = typeof config.autoActivate === 'string' ? config.autoActivate : '';
    this.tokenBudget = { ...DEFAULT_BUDGET, ...(config.tokenBudget ?? {}) };

    this.builtins = new Map(); // name -> persona (bundled, read-only)
    this.user = new Map();     // name -> persona (from personasDir)
    this.userMixins = new Map(); // name -> mixin (future: user-defined mixins)
    this.activations = new Map(); // SessionId -> { persona, disposers, personaObj }
    this.state = new Map();    // personaName -> relationship state
    this.memories = [];        // scoped memory records
    this.history = {};         // personaName -> [ { at, persona } ]
    this.ratings = {};         // personaName -> [ { score, note, at } ]
    this.comparisons = [];     // A/B comparison records
    this.summaryThreshold = Number(config.summaryThreshold ?? 4000);
    this.groups = {};          // groupName -> { personas: [], turn: 0 }
    this.groupSessions = new Map(); // sessionId -> groupName
    this._memorySeq = 0;
    this.compareInFlight = 0;  // in-flight A/B runs (LLM calls are slow + serialized)
    // Report health, surfaced through healthStatus() so a degraded startup is
    // visible to the UI and not only in the console. Both null until the first
    // write succeeds; lastReportError is set (and NOT cleared) on failure.
    this.lastReportError = null;
    this.lastReportAt = null;
    // === BEGIN memory-engineer (B2/B3): injection + budget config ===
    // config.memoryInjection is the explicit off-switch; default ON.
    this.memoryInjection = config.memoryInjection !== false;
    this.memoryInjectBudget = Number(config.memoryInjectBudget ?? 0);
    this.memoryInjectMinScore = Number(config.memoryInjectMinScore ?? 0.35);
    this.memoryInjectMinOverlap = Number(config.memoryInjectMinOverlap ?? 0.25);
    this.contextBudget = Number(config.contextBudget ?? 0); // 0 => sum of tokenBudget
    this.memoryUsage = new Map();       // sessionId -> last delivered state (dedupe)
    this.injectionLog = [];             // append-only delivery attempts, capped
    // === END memory-engineer (B2/B3) config ===
    this._watcher = null;
    this._chain = Promise.resolve();
    this.setPersonaConfirm = config.setPersonaConfirm === true;

    this.registerCommand();
    this.registerAutoActivate();
    this.registerParameterInjection();
    this.registerDisposedCleanup();
    this.registerTools();
    this.registerToolConfirmation();
    this.registerHttpApi();
    this.registerStateDrift();
    this.registerGroupDriver();
    // === BEGIN memory-engineer (B2): injection delivery hook ===
    this.registerMemoryInjection();
    // === END memory-engineer (B2) ===
  }

  // Serialize store mutations + reloads so overlapping watcher callbacks and
  // CRUD operations never interleave (e.g. read a file mid-write or mid-unlink).
  _serialize(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.then(() => {}, () => {});
    return run;
  }

  // -- store ---------------------------------------------------------------
  get(name) {
    return this.user.get(name) ?? this.builtins.get(name);
  }

  list() {
    const seen = new Set();
    const out = [];
    for (const name of [...this.builtins.keys(), ...this.user.keys()]) {
      if (!seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
    return out.sort();
  }

  async loadBuiltins() {
    const dir = path.join(__dirname, 'personas');
    try {
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        const persona = normalize(JSON.parse(await readFile(path.join(dir, f), 'utf8')));
        this.builtins.set(persona.name, persona);
      }
    } catch (err) {
      this.log(`builtins load failed: ${err.message}`);
    }
  }

  async loadUser() {
    this.user.clear();
    if (!this.personasDir) return;
    try {
      await mkdir(this.personasDir, { recursive: true });
      const files = (await readdir(this.personasDir))
        .filter((f) => f.endsWith('.json') && !f.startsWith('.'));
      for (const f of files) {
        try {
          const persona = normalize(JSON.parse(await readFile(path.join(this.personasDir, f), 'utf8')));
          if (persona.name && persona.name !== 'unnamed') this.user.set(persona.name, persona);
        } catch (err) {
          // a file removed mid-scan must not abort the whole load
          this.log(`skipping ${f}: ${err.message}`);
        }
      }
    } catch (err) {
      this.log(`user load failed: ${err.message}`);
    }
  }

  save(persona) {
    return this._serialize(async () => {
      if (!this.personasDir) throw new Error('personasDir is not configured');
      const p = normalize(persona);
      if (!p.name || p.name === 'unnamed') throw new Error('persona requires a "name"');
      const existing = this.get(p.name);
      if (existing) {
        (this.history[p.name] ??= []).push({ at: Date.now(), persona: existing });
        this.saveHistory();
      }
      await this._writePersonaFile(p);
      await this.loadUser();
    });
  }

  async _writePersonaFile(p) {
    await mkdir(this.personasDir, { recursive: true });
    await writeFile(this.personaPathFor(p.name), JSON.stringify(p, null, 2), 'utf8');
  }

  // The ONE place a persona name turns into a path. Both writers below go through
  // it, and it is the seam the tests drive, so a traversal attempt has exactly one
  // place to be stopped. Throws on an illegal name rather than sanitising it: a
  // silently-renamed persona is a worse failure mode than a loud rejection, because
  // the caller would believe it wrote `../../evil` when it actually wrote something else.
  personaPathFor(name) {
    if (!this.personasDir) throw new Error('personasDir is not configured');
    return path.join(this.personasDir, personaFileName(name));
  }

  remove(name) {
    return this._serialize(async () => {
      await unlink(this.personaPathFor(name));
      await this.loadUser();
    });
  }

  watchUserDir() {
    if (!this.personasDir || this._watcher) return;
    this._watcher = this.ctx.effect(() => {
      let watcher;
      try {
        watcher = watch(this.personasDir, (_event, filename) => {
          if (typeof filename === 'string' && filename.startsWith('.')) return;
          this.reload().catch((err) => this.log(`reload failed: ${err.message}`));
        });
      } catch (err) {
        this.log(`watch failed: ${err.message}`);
      }
      // The try/catch above covers ONLY the synchronous throw from watch(). An
      // FSWatcher is an EventEmitter, and fs.watch also reports failures
      // ASYNCHRONOUSLY: an 'error' event with no listener is re-thrown by Node as an
      // uncaught exception, which kills the process. (`fs.watch` on a path whose
      // parent directory is later removed emits exactly that, e.g. EPERM.) Without
      // this listener the guard above LOOKS like it handles watch failures while the
      // async path escapes it entirely — so the handler is attached to the watcher,
      // not wrapped around its construction.
      watcher?.on('error', (err) => {
        this.log(`personas dir watch error (watcher is now inert; reload returns on next successful watch): ${err?.message ?? err}`);
      });
      // Exposed so the error channel is reachable by tests: the handler above guards
      // an ASYNC event, and a test that cannot reach this emitter can only assert the
      // handler exists, not that emitting on it is survivable. Kept on the service
      // (not module scope) so two service instances never share one watcher.
      this._watcherHandle = watcher;
      return () => watcher?.close();
    }, 'dsh-cast.watch-personas-dir');
  }

  reload() {
    return this._serialize(async () => {
      await this.loadBuiltins();
      await this.loadUser();
      for (const [id, rec] of [...this.activations]) {
        const agent = this.ctx.agents?.get(id);
        if (!agent) {
          this.activations.delete(id);
          continue;
        }
        try {
          this.activate(agent, rec.persona);
        } catch (err) {
          this.deactivate(agent);
        }
      }
      await this.writeReport();
    });
  }

  // -- activation ----------------------------------------------------------
  activate(agent, name) {
    const persona = this.get(name);
    if (!persona) throw new Error(`no persona named "${name}"`);
    this.deactivate(agent);
    const layers = compose(persona, this.tokenBudget, this, agent.id);
    const disposers = layers.map((layer) =>
      agent.ctx.effect(
        () => agent.ctx.systemPrompt.section({
          name: layer.name,
          order: layer.order,
          text: layer.text,
          interpolate: false,
        }),
        `dsh-cast.${persona.name}.${layer.name}`,
      ),
    );
    this.activations.set(agent.id, { persona: persona.name, personaObj: persona, disposers });
    return persona;
  }

  deactivate(agent) {
    const rec = this.activations.get(agent.id);
    if (!rec) return;
    for (const dispose of rec.disposers) dispose();
    this.activations.delete(agent.id);
  }

  active(agent) {
    return this.activations.get(agent.id)?.persona ?? null;
  }

  // -- registrations -------------------------------------------------------
  registerCommand() {
    this.ctx.effect(() => this.ctx.commands.register({
      name: 'persona',
      description:
        'Manage dsh-cast personas: /persona list | use <name> | off | show <name> | create <name> | delete <name> | edit <name> <json> | export <name> | import <json> | reload',
      input: {
        hint: 'list | use <name> | off | show <name> | create <name> | delete <name> | edit <name> <json> | export <name> | import <json> | reload',
      },
      handler: (inv) => this.handleCommand(inv),
    }), 'dsh-cast.command.persona');
  }

  registerAutoActivate() {
    this.ctx.effect(() => this.ctx.on('agent/created', (payload) => {
      if (!this.autoActivate) return;
      try {
        this.activate(payload.agent, this.autoActivate);
      } catch (err) {
        this.log(`auto-activate "${this.autoActivate}" failed: ${err.message}`);
      }
    }), 'dsh-cast.auto-activate');
  }

  registerParameterInjection() {
    this.ctx.effect(() => this.ctx.on('agent/request', async (payload, next) => {
      const base = await next();
      const rec = this.activations.get(payload.agent.id);
      if (!rec) return base;
      const p = rec.personaObj?.parameters ?? {};
      const merged = { ...base };
      if (typeof p.temperature === 'number') merged.temperature = p.temperature;
      if (typeof p.maxTokens === 'number') merged.maxTokens = p.maxTokens;
      if (Array.isArray(p.stop) && p.stop.length) merged.stop = p.stop;
      return merged;
    }), 'dsh-cast.agent-request');
  }

  registerDisposedCleanup() {
    this.ctx.effect(() => this.ctx.on('agent/disposed', (payload) => {
      this.activations.delete(payload.agent.id);
    }), 'dsh-cast.agent-disposed');
  }

  // -- command handling ----------------------------------------------------
  async handleCommand(inv) {
    const [sub, ...rest] = String(inv.rawInput ?? '').trim().split(/\s+/).filter(Boolean);
    switch (sub) {
      case 'list':
        return { kind: 'success', text: this.listText() };
      case 'use':
        return this.activateCommand(inv.agent, rest.join(' '));
      case 'off':
        return this.deactivateCommand(inv.agent);
      case 'show':
        return this.showCommand(rest.join(' '));
      case 'create':
        return this.createCommand(rest[0] ?? '');
      case 'delete':
        return this.deleteCommand(rest[0] ?? '');
      case 'edit':
        return this.editCommand(rest[0] ?? '', rest.slice(1).join(' '));
      case 'export':
        return this.exportCommand(rest);
      case 'pack':
        return this.packCommand(rest);
      case 'history':
        return this.historyCommand(rest);
      case 'rollback':
        return this.rollbackCommand(rest);
      case 'route':
        return this.routeCommand(rest);
      case 'rate':
        return this.rateCommand(rest);
      case 'ratings':
        return this.ratingsCommand(rest);
      case 'import':
        return this.importCommand(rest.join(' '));
      case 'mix':
        return this.mixCommand(rest);
      case 'tune':
        return this.tuneCommand(rest);
      case 'memory':
        return this.memoryCommand(rest, inv.agent);
      case 'summarize':
        return this.summarizeCommand(rest, inv.agent);
      case 'compare':
        return this.compareCommand(rest);
      case 'group':
        return this.groupCommand(rest, inv.agent);
      case 'handoff':
        return this.handoffCommand(rest, inv.agent);
      case 'reload':
        await this.reload();
        return { kind: 'success', text: `Reloaded ${this.list().length} personas.` };
      default:
        return { kind: 'success', text: this.usage() };
    }
  }

  listText() {
    const names = this.list();
    if (!names.length) return 'No personas loaded.';
    const active = new Set([...this.activations.values()].map((r) => r.persona));
    return `Personas:\n${names.map((n) => `${active.has(n) ? '*' : ' '} ${n}`).join('\n')}`;
  }

  activateCommand(agent, name) {
    if (!name) return { kind: 'error', text: 'Usage: /persona use <name>' };
    try {
      this.activate(agent, name);
      return { kind: 'success', text: `Activated persona "${name}".` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  deactivateCommand(agent) {
    this.deactivate(agent);
    return { kind: 'success', text: 'Persona off.' };
  }

  showCommand(name) {
    const p = this.get(name);
    if (!p) return { kind: 'error', text: `No persona named "${name}".` };
    return { kind: 'success', text: JSON.stringify(p, null, 2) };
  }

  usage() {
    return 'Usage: /persona list | use <name> | off | show <name> | create <name> | delete <name> | edit <name> <json> | export <name> | import <json> | memory <name> add <text>|show|clear | reload';
  }

  // -- Phase 2: CRUD + import/export handlers --------------------------------
  async createCommand(name) {
    try {
      const persona = await this.createPersona(name);
      return { kind: 'success', text: `Created persona "${persona.name}".` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  async deleteCommand(name) {
    try {
      await this.deletePersona(name);
      return { kind: 'success', text: `Deleted persona "${name}".` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  async editCommand(name, jsonText) {
    try {
      const persona = await this.editPersona(name, jsonText);
      return { kind: 'success', text: `Updated persona "${persona.name}".` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  exportCommand(parts) {
    const [name, format = 'json'] = parts;
    try {
      if (format === 'markdown') return { kind: 'success', text: this.exportMarkdown(name) };
      if (format === 'card') return { kind: 'success', text: this.exportCharacterCard(name) };
      return { kind: 'success', text: this.exportPersona(name) };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  packCommand(parts) {
    const [sub, ...rest] = parts;
    if (sub === 'export') {
      try {
        return { kind: 'success', text: this.exportPack(rest) };
      } catch (err) {
        return { kind: 'error', text: err.message };
      }
    }
    if (sub === 'import') return this.importPackCommand(rest.join(' '));
    return { kind: 'error', text: 'Usage: /persona pack export <name...> | import <json>' };
  }

  async importPackCommand(jsonText) {
    try {
      const imported = await this.importPack(jsonText);
      return { kind: 'success', text: `Imported ${imported.length} personas: ${imported.join(', ')}.` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  historyCommand(parts) {
    const [name] = parts;
    if (!name) return { kind: 'error', text: 'Usage: /persona history <name>' };
    const snaps = this.getHistory(name);
    if (snaps.length === 0) return { kind: 'success', text: `No history for "${name}".` };
    return {
      kind: 'success',
      text: `History for "${name}":\n${snaps.map((s, i) => `${i}: ${new Date(s.at).toISOString()}`).join('\n')}`,
    };
  }

  async rollbackCommand(parts) {
    const [name, indexStr] = parts;
    if (!name || indexStr == null) return { kind: 'error', text: 'Usage: /persona rollback <name> <index>' };
    try {
      await this.rollback(name, Number(indexStr));
      return { kind: 'success', text: `Rolled back "${name}" to version ${indexStr}.` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  routeCommand(parts) {
    const message = parts.join(' ').trim();
    if (!message) return { kind: 'error', text: 'Usage: /persona route <message>' };
    const result = this.route(message);
    if (!result) return { kind: 'success', text: 'No specific task detected; no route recommended.' };
    return { kind: 'success', text: `Task "${result.task}" -> persona "${result.persona}" (score ${result.score}).` };
  }

  rateCommand(parts) {
    const [name, score, ...rest] = parts;
    if (!name || score == null) return { kind: 'error', text: 'Usage: /persona rate <name> <1-5> [note]' };
    try {
      this.rate(name, score, rest.join(' '));
      return { kind: 'success', text: `Rated "${name}" ${score}/5.` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  ratingsCommand(parts) {
    const [name] = parts;
    if (name) {
      const list = this.getRatings(name);
      if (list.length === 0) return { kind: 'success', text: `No ratings for "${name}".` };
      return {
        kind: 'success',
        text: `Ratings for "${name}":\n${list.map((r, i) => `${i}: ${r.score}/5 ${r.note ? `(${r.note})` : ''}`).join('\n')}`,
      };
    }
    const report = this.fidelityReport();
    if (report.length === 0) return { kind: 'success', text: 'No ratings yet.' };
    return {
      kind: 'success',
      text: `Fidelity report:\n${report.map((r) => `- ${r.name}: ${r.average}/5 (${r.count})`).join('\n')}`,
    };
  }

  async summarizeCommand(parts, agent) {
    const personaName = parts[0] ?? this.active(agent) ?? 'user';
    try {
      const result = await this.summarize(agent.id, personaName);
      if (result.skipped) {
        return { kind: 'success', text: `Skipped: conversation is only ${result.tokens} tokens (threshold ${this.summaryThreshold}).` };
      }
      return { kind: 'success', text: `Summarized (${result.tokens} tokens): ${result.summary}` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  async compareCommand(parts) {
    const [a, b, ...rest] = parts;
    const prompt = rest.join(' ');
    if (!a || !b || !prompt) return { kind: 'error', text: 'Usage: /persona compare <a> <b> <prompt>' };
    try {
      const record = await this.compare(a, b, prompt);
      return { kind: 'success', text: `${record.a}: ${record.responseA}\n\n${record.b}: ${record.responseB}` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  groupCommand(parts, agent) {
    const [sub, ...rest] = parts;
    if (sub === 'create') {
      const [name, ...personas] = rest;
      if (!name || personas.length < 2) return { kind: 'error', text: 'Usage: /persona group create <name> <p1> <p2> [...]' };
      try {
        this.createGroup(name, personas);
        return { kind: 'success', text: `Group "${name}" created.` };
      } catch (err) {
        return { kind: 'error', text: err.message };
      }
    }
    if (sub === 'use') {
      const name = rest[0];
      if (!name) return { kind: 'error', text: 'Usage: /persona group use <name>' };
      try {
        const result = this.activateGroup(agent, name);
        return { kind: 'success', text: `Group "${name}" active; speaking: ${result.speaker}.` };
      } catch (err) {
        return { kind: 'error', text: err.message };
      }
    }
    if (sub === 'list') {
      const lines = this.listGroups().map((g) => `- ${g}: ${this.groups[g].personas.join(', ')}`);
      return { kind: 'success', text: `Groups:\n${lines.join('\n')}` };
    }
    return { kind: 'error', text: 'Usage: /persona group create|use|list' };
  }

  handoffCommand(parts, agent) {
    const name = parts[0];
    if (!name) return { kind: 'error', text: 'Usage: /persona handoff <name>' };
    try {
      this.handoff(agent, name);
      return { kind: 'success', text: `Handed off to "${name}".` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  async importCommand(jsonText) {
    try {
      const persona = await this.importPersona(jsonText);
      return { kind: 'success', text: `Imported persona "${persona.name}".` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  async mixCommand(parts) {
    const [a, b, name] = parts;
    if (!a || !b) return { kind: 'error', text: 'Usage: /persona mix <a> <b> [name]' };
    try {
      const mixed = this.mixPersona(a, b, name ? { name } : {});
      await this.save(mixed);
      return { kind: 'success', text: `Mixed "${a}" + "${b}" -> "${mixed.name}".` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  async tuneCommand(parts) {
    const [name, ...rest] = parts;
    const phrase = rest.join(' ');
    if (!name || !phrase) return { kind: 'error', text: 'Usage: /persona tune <name> <phrase>' };
    try {
      const result = await this.naturalEdit(name, phrase);
      return { kind: 'success', text: `Tuned "${name}": ${result.applied.join(', ')}.` };
    } catch (err) {
      return { kind: 'error', text: err.message };
    }
  }

  // -- Phase 2: service methods for CRUD/import/export ------------------------
  async createPersona(name, fields = {}) {
    if (!name) throw new Error('persona name is required');
    if (this.builtins.has(name) && !this.user.has(name)) {
      throw new Error(`"${name}" is a built-in persona; pick another name`);
    }
    // A definition may be supplied (new schema); if so it must be valid BEFORE any
    // write. Invalid input must never reach disk. Validate the RAW input (before
    // normalization coerces malformed shapes away).
    if (fields.definition != null) {
      const v = validateDefinition(fields.definition);
      if (!v.valid) {
        throw new Error(
          `invalid persona definition: ${v.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`,
        );
      }
    }
    const definition = fields.definition != null ? normalizeDefinition(fields.definition) : null;
    const persona = normalize({
      name,
      identity: fields.identity ?? { role: `a persona named ${name}` },
      traits: fields.traits ?? {},
      voice: fields.voice ?? {},
      behavior: fields.behavior ?? {},
      boundaries: fields.boundaries ?? {},
      examples: fields.examples ?? [],
      parameters: fields.parameters ?? {},
      composition: fields.composition ?? {},
      ...(definition ? { definition } : {}),
    });
    await this.save(persona);
    return persona;
  }

  async deletePersona(name) {
    if (!name) throw new Error('persona name is required');
    if (!this.user.has(name)) {
      throw new Error(`cannot delete "${name}": not a user persona (or not found)`);
    }
    await this.remove(name);
  }

  async editPersona(name, jsonText) {
    const existing = this.get(name);
    if (!existing) throw new Error(`no persona named "${name}"`);
    let patch;
    try {
      patch = JSON.parse(jsonText || '{}');
    } catch (err) {
      throw new Error(`invalid JSON: ${err.message}`);
    }
    // Validate the definition BEFORE merging, so an invalid edit leaves the last
    // valid saved persona intact (the save below never runs on invalid input).
    // Validate the RAW input; normalize only after it has passed.
    if (patch.definition != null) {
      const v = validateDefinition(patch.definition);
      if (!v.valid) {
        throw new Error(
          `invalid persona definition: ${v.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`,
        );
      }
      patch = { ...patch, definition: normalizeDefinition(patch.definition) };
    }
    const merged = normalize({ ...existing, ...patch, name: existing.name });
    await this.save(merged);
    return merged;
  }

  exportPersona(name) {
    const persona = this.get(name);
    if (!persona) throw new Error(`no persona named "${name}"`);
    return JSON.stringify(persona, null, 2);
  }

  async importPersona(jsonText) {
    let raw;
    try {
      raw = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(`invalid JSON: ${err.message}`);
    }
    if (raw?.spec === 'chara_card_v2') return this.importCharacterCard(jsonText);
    if (raw?.format === 'dsh-cast-pack') return this.importPack(jsonText);
    const persona = normalize(raw);
    if (!persona.name || persona.name === 'unnamed') throw new Error('imported persona requires a "name"');
    await this.save(persona);
    return persona;
  }

  // -- Phase 4: composition ---------------------------------------------------
  getMixin(name) {
    return this.userMixins.get(name) ?? BUILTIN_MIXINS[name];
  }

  mixPersona(nameA, nameB, options = {}) {
    const a = this.get(nameA);
    const b = this.get(nameB);
    if (!a) throw new Error(`no persona named "${nameA}"`);
    if (!b) throw new Error(`no persona named "${nameB}"`);
    const weight = options.weight ?? 0.5;
    const traitsA = resolveTraits(a, this);
    const traitsB = resolveTraits(b, this);
    const traits = {};
    for (const k of DIMENSIONS) {
      traits[k] = Math.round(clamp(traitsA[k] * weight + traitsB[k] * (1 - weight), 0, 10) * 10) / 10;
    }
    const merged = normalize({
      name: options.name ?? `${a.name}-${b.name}`,
      identity: {
        role: `${a.identity?.role ?? a.name}, blended with ${b.identity?.role ?? b.name}`,
        backstory: `${a.identity?.backstory ?? ''} ${b.identity?.backstory ?? ''}`.trim() || undefined,
        values: [...(a.identity?.values ?? []), ...(b.identity?.values ?? [])],
        goals: [...(a.identity?.goals ?? []), ...(b.identity?.goals ?? [])],
      },
      traits,
      voice: {
        catchphrases: [...(a.voice?.catchphrases ?? []), ...(b.voice?.catchphrases ?? [])],
        taboo: [...(a.voice?.taboo ?? []), ...(b.voice?.taboo ?? [])],
      },
      behavior: { ...(a.behavior ?? {}), ...(b.behavior ?? {}) },
      boundaries: {
        always: [...(a.boundaries?.always ?? []), ...(b.boundaries?.always ?? [])],
        never: [...(a.boundaries?.never ?? []), ...(b.boundaries?.never ?? [])],
      },
      examples: b.examples?.length ? b.examples : a.examples,
      parameters: { ...(a.parameters ?? {}), ...(b.parameters ?? {}) },
      composition: { archetype: null, mixins: [] },
    });
    return merged;
  }

  async naturalEdit(name, phrase) {
    const persona = this.get(name);
    if (!persona) throw new Error(`no persona named "${name}"`);
    const traits = { ...resolveTraits(persona, this) };
    const applied = [];
    for (const [pattern, dim, delta] of EDIT_KEYWORDS) {
      if (pattern.test(phrase)) {
        traits[dim] = Math.round(clamp(traits[dim] + delta, 0, 10) * 10) / 10;
        applied.push(`${dim} ${delta >= 0 ? '+' : ''}${delta}`);
      }
    }
    if (applied.length === 0) throw new Error(`no recognized change in "${phrase}"`);
    const updated = normalize({
      ...persona,
      traits,
      composition: { ...(persona.composition ?? {}), mixins: [] },
    });
    await this.save(updated);
    return { persona: updated, applied };
  }

  // -- Phase 5: version history ----------------------------------------------
  _historyPath() {
    return path.join(this.personasDir, '.dsh-cast-history.json');
  }

  async loadHistory() {
    this.history = {};
    try {
      this.history = JSON.parse(await readFile(this._historyPath(), 'utf8'));
    } catch {
      // no history yet
    }
  }

  async saveHistory() {
    try {
      await writeFile(this._historyPath(), JSON.stringify(this.history, null, 2), 'utf8');
    } catch (err) {
      this.log(`history save failed: ${err.message}`);
    }
  }

  getHistory(name) {
    return this.history[name] ?? [];
  }

  rollback(name, index) {
    return this._serialize(async () => {
      const snapshots = this.history[name] ?? [];
      const snap = snapshots[index];
      if (!snap) throw new Error(`no version ${index} for "${name}"`);
      await this._writePersonaFile(snap.persona);
      await this.loadUser();
      return snap.persona;
    });
  }

  // -- Phase 5: formats + packs ----------------------------------------------
  exportMarkdown(name) {
    const persona = this.get(name);
    if (!persona) throw new Error(`no persona named "${name}"`);
    return personaToMarkdown(persona);
  }

  exportCharacterCard(name) {
    const persona = this.get(name);
    if (!persona) throw new Error(`no persona named "${name}"`);
    return JSON.stringify(personaToCharacterCard(persona), null, 2);
  }

  async importCharacterCard(jsonText) {
    const card = JSON.parse(jsonText);
    const persona = characterCardToPersona(card);
    if (!persona.name || persona.name === 'card-persona') throw new Error('character card has no name');
    await this.save(persona);
    return persona;
  }

  async importMarkdown(name, md) {
    if (!name) throw new Error('markdown import requires a name');
    const persona = markdownToPersona(name, md);
    await this.save(persona);
    return persona;
  }

  exportPack(names) {
    const personas = names.map((n) => {
      const p = this.get(n);
      if (!p) throw new Error(`no persona named "${n}"`);
      return p;
    });
    return JSON.stringify({ format: 'dsh-cast-pack', version: 1, personas }, null, 2);
  }

  async importPack(jsonText) {
    const raw = JSON.parse(jsonText);
    const list = Array.isArray(raw) ? raw : (raw.personas ?? []);
    const imported = [];
    for (const item of list) {
      const p = normalize(item);
      if (!p.name || p.name === 'unnamed') continue;
      await this.save(p);
      imported.push(p.name);
    }
    return imported;
  }

  // -- Phase 4/5: auto-router + fidelity ratings ------------------------------
  route(message) {
    return routePersona(message, this);
  }

  _ratingsPath() {
    return path.join(this.personasDir, '.dsh-cast-ratings.json');
  }

  async loadRatings() {
    this.ratings = {};
    try {
      this.ratings = JSON.parse(await readFile(this._ratingsPath(), 'utf8'));
    } catch {
      // no ratings yet
    }
  }

  async saveRatings() {
    try {
      await writeFile(this._ratingsPath(), JSON.stringify(this.ratings, null, 2), 'utf8');
    } catch (err) {
      this.log(`ratings save failed: ${err.message}`);
    }
  }

  rate(name, score, note) {
    const persona = this.get(name);
    if (!persona) throw new Error(`no persona named "${name}"`);
    const s = Number(score);
    if (!Number.isFinite(s) || s < 1 || s > 5) throw new Error('score must be 1-5');
    (this.ratings[name] ??= []).push({ score: s, note: note || '', at: Date.now() });
    this.saveRatings();
    return { name, score: s };
  }

  getRatings(name) {
    return name ? (this.ratings[name] ?? []) : this.ratings;
  }

  fidelityReport() {
    const out = [];
    for (const [name, list] of Object.entries(this.ratings)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const avg = list.reduce((n, r) => n + r.score, 0) / list.length;
      out.push({ name, average: Math.round(avg * 100) / 100, count: list.length });
    }
    return out.sort((a, b) => b.average - a.average);
  }

  // -- LLM-driven helpers (summarization + A/B + try) ------------------------
  //
  // The provider/model for an ISOLATED (non-session) call must come from the
  // harness's configured default model, NOT from `listProviders()[0]`. Provider
  // registration order is arbitrary: on a real profile the first registered route
  // is frequently not the configured one, so the old guess silently streamed a
  // call that produced no text and `_llmComplete` returned '' — which is exactly
  // how "Try persona" appeared to "not work" (HTTP 200, empty response).
  // `ctx.agentDefaultModel.currentSelection()` is the same selection the agent
  // loop uses for sessions, so an isolated call now matches what the user expects.
  _defaultModelSelection() {
    try {
      // Resolve OPTIONALLY: `agentDefaultModel` is a harness bundle service, not a
      // declared dependency of this plugin, so it is read through the context
      // service registry (`get`) with a property fallback — never added to inject,
      // which would stop the plugin loading in a profile that lacks it.
      const svc = (typeof this.ctx.get === 'function' ? this.ctx.get('agentDefaultModel') : null)
        ?? this.ctx.agentDefaultModel;
      if (svc && typeof svc.currentSelection === 'function') {
        const sel = svc.currentSelection();
        if (sel && sel.provider && sel.model) {
          return { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort };
        }
      }
    } catch (err) {
      this.log(`agentDefaultModel unavailable, falling back to provider discovery: ${err.message}`);
    }
    return null;
  }

  async _resolveModelSelection() {
    const configured = this._defaultModelSelection();
    if (configured) return configured;
    const llm = this.ctx.llm;
    if (!llm) throw new Error('no llm service');
    const provider = llm.listProviders?.()[0]?.id;
    if (!provider) throw new Error('no LLM provider registered');
    const models = await llm.listModels(provider);
    const model = models[0]?.id;
    if (!model) throw new Error(`no model for provider "${provider}"`);
    return { provider, model };
  }

  async _llmComplete(messages, systemPrompt) {
    const llm = this.ctx.llm;
    if (!llm) throw new Error('no llm service');
    const selection = await this._resolveModelSelection();
    const options = {
      provider: selection.provider,
      model: selection.model,
      messages: normalizeRequestMessages(messages),
      system: systemPrompt,
    };
    // A branded ReasoningEffortId from currentSelection() is passed through; the
    // fallback path has none, so the provider default applies.
    if (selection.reasoningEffort !== undefined) options.reasoningEffort = selection.reasoningEffort;
    let text = '';
    let failure = null;
    const stream = llm.stream(options);
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text;
      else if (chunk.type === 'finish' && chunk.reason
        && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        failure = chunk.reason;
      }
    }
    // A stream that ends in error/abort with no text must NOT look like an empty
    // success — that is the failure mode this helper used to hide.
    if (!text.trim() && failure) {
      const f = failure.failure ?? {};
      const detail = f.message || f.code || failure.kind;
      throw new Error(`model call ${failure.kind} (${selection.provider}/${selection.model}): ${detail}`);
    }
    return text.trim();
  }

  composePersonaSystem(persona) {
    return compose(persona, this.tokenBudget, this, undefined).map((l) => l.text).join('\n\n');
  }

  // Canonical persona resolution. This is the single place a stored persona turns
  // into (a) its six-field definition and (b) the ordered prompt sections that are
  // registered by activate() and shown by the inspector. Deterministic for
  // identical input + config, and side-effect-free (never activates, never writes).
  resolvePrompt(persona, sessionId) {
    const resolved = resolvePersona(persona, this);
    const rd = resolveDefinition(resolved);
    const layers = composeDefinition(rd.definition, resolved.name, this.tokenBudget, this, sessionId);
    return {
      name: resolved.name,
      definition: rd.definition,
      migrated: rd.migrated,
      source: rd.source,
      valid: rd.valid,
      warnings: rd.warnings,
      layers,
    };
  }

  // -- Phase 6: composed-prompt inspection ------------------------------------
  // Read-only. Purely additive: it uses resolvePrompt(), the SAME resolution the
  // live prompt uses, so the inspector cannot drift from what is actually applied.
  promptInspection(name, sessionId) {
    const persona = this.get(name);
    if (!persona) throw new Error(`no persona named "${name}"`);
    const budgetMap = this.tokenBudget ?? {};
    const prompt = this.resolvePrompt(persona, sessionId != null ? sessionId : undefined);
    const layers = prompt.layers.map((layer) => {
      const band = BUDGETED_LAYERS.find(([n]) => n === layer.name);
      const dim = band ? band[1] : null;
      const budgetTokens = dim ? Number(budgetMap[dim] ?? DEFAULT_BUDGET[dim]) : null;
      const capChars = dim ? tokensToChars(budgetTokens) : null;
      const truncated = layer.text.includes(TRUNCATION_MARKER);
      return {
        name: layer.name,
        order: layer.order,
        sources: layer.sources ?? [],
        text: layer.text,
        chars: layer.text.length,
        tokens: Math.ceil(layer.text.length / 4),
        budgetTokens,
        capChars,
        budgetChars: dim ? tokensToChars(budgetTokens) : null,
        overBudget: dim ? layer.text.length > tokensToChars(budgetTokens) : false,
        truncated,
      };
    });
    const raw = layers.reduce((n, l) => n + l.chars, 0);
    const text = layers.map((l) => l.text).join('\n\n');
    return {
      persona: persona.name,
      sessionId: sessionId != null ? sessionId : null,
      migrated: prompt.migrated,
      source: prompt.source,
      valid: prompt.valid,
      warnings: prompt.warnings,
      definition: prompt.definition,
      notes: [
        'Sections are the dsh-cast contributions to the system prompt, in the same order and with the same token-budget truncation the live prompt uses.',
        'Each section lists the definition field(s) it was assembled from ("sources").',
        'Counts are a chars/4 heuristic, not a real tokenizer — treat them as an estimate.',
        'The full request prompt also carries harness sections and the tool catalog, which this view does not include.',
      ],
      layers,
      totals: {
        layers: layers.length,
        chars: text.length,
        tokens: Math.ceil(text.length / 4),
        unbudgetedChars: raw,
        truncatedLayers: layers.filter((l) => l.truncated).map((l) => l.name),
        overBudgetLayers: layers.filter((l) => l.overBudget).map((l) => l.name),
      },
      budgets: {
        identity: Number(budgetMap.identity ?? DEFAULT_BUDGET.identity),
        voice: Number(budgetMap.voice ?? DEFAULT_BUDGET.voice),
        behavior: Number(budgetMap.behavior ?? DEFAULT_BUDGET.behavior),
        expertise: Number(budgetMap.expertise ?? DEFAULT_BUDGET.expertise),
        rules: Number(budgetMap.rules ?? DEFAULT_BUDGET.rules),
        state: Number(budgetMap.state ?? DEFAULT_BUDGET.state),
        memory: Number(budgetMap.memory ?? DEFAULT_BUDGET.memory),
        examples: Number(budgetMap.examples ?? DEFAULT_BUDGET.examples),
      },
    };
  }

  async summarize(sessionId, personaName) {
    const session = this.ctx.sessions?.get(sessionId);
    if (!session) throw new Error('no session for summarization');
    const messages = session.deriveMessages();
    const tokens = estimateTokens(messages);
    if (tokens < this.summaryThreshold) return { skipped: true, tokens };
    const summary = await this._llmComplete(
      messages,
      'Summarize this conversation in 2-3 sentences, third person, past tense.',
    );
    this.addMemory('conversation', personaName, summary, sessionId);
    return { summarized: true, tokens, summary };
  }

  async compare(nameA, nameB, prompt) {
    const a = this.get(nameA);
    const b = this.get(nameB);
    if (!a) throw new Error(`no persona named "${nameA}"`);
    if (!b) throw new Error(`no persona named "${nameB}"`);
    const messages = [{ role: 'user', content: prompt }];
    const responseA = await this._llmComplete(messages, this.composePersonaSystem(a));
    const responseB = await this._llmComplete(messages, this.composePersonaSystem(b));
    const record = { a: a.name, b: b.name, prompt, responseA, responseB, at: Date.now() };
    this.comparisons.push(record);
    this.saveComparisons();
    return record;
  }

  // Isolated single-persona try-out. Runs ONE persona against a sample message
  // through the SAME isolated LLM path compare() uses: it composes the resolved
  // system prompt and calls the model, WITHOUT activating the persona, WITHOUT
  // touching the session's active persona, and WITHOUT writing to memory. Returns
  // the exact system prompt that was used so the caller can show it and prove the
  // test used the intended configuration.
  async tryPersona(name, prompt) {
    const persona = this.get(name);
    if (!persona) throw new Error(`no persona named "${name}"`);
    const systemPrompt = this.composePersonaSystem(persona);
    const response = await this._llmComplete([{ role: 'user', content: prompt }], systemPrompt);
    return { name: persona.name, prompt, response, systemPrompt, at: Date.now() };
  }

  _comparisonsPath() {
    return path.join(this.personasDir, '.dsh-cast-comparisons.json');
  }

  async loadComparisons() {
    this.comparisons = [];
    try {
      this.comparisons = JSON.parse(await readFile(this._comparisonsPath(), 'utf8'));
    } catch {
      // no comparisons yet
    }
  }

  async saveComparisons() {
    try {
      await writeFile(this._comparisonsPath(), JSON.stringify(this.comparisons, null, 2), 'utf8');
    } catch (err) {
      this.log(`comparisons save failed: ${err.message}`);
    }
  }

  // -- Phase 4: group chat + director + handoff ------------------------------
  _groupsPath() {
    return path.join(this.personasDir, '.dsh-cast-groups.json');
  }

  async loadGroups() {
    this.groups = {};
    try {
      this.groups = JSON.parse(await readFile(this._groupsPath(), 'utf8'));
    } catch {
      // no groups yet
    }
  }

  async saveGroups() {
    try {
      await writeFile(this._groupsPath(), JSON.stringify(this.groups, null, 2), 'utf8');
    } catch (err) {
      this.log(`groups save failed: ${err.message}`);
    }
  }

  createGroup(name, personaNames) {
    if (!name) throw new Error('group name required');
    const personas = [...new Set(personaNames)].filter((n) => this.get(n));
    if (personas.length < 2) throw new Error('group needs at least two valid personas');
    this.groups[name] = { personas, turn: 0 };
    this.saveGroups();
    return this.groups[name];
  }

  getGroup(name) {
    return this.groups[name];
  }

  listGroups() {
    return Object.keys(this.groups);
  }

  // Director: advance the round-robin and return the next speaker.
  advanceGroup(groupName) {
    const g = this.groups[groupName];
    if (!g) throw new Error(`no group "${groupName}"`);
    g.turn = (g.turn + 1) % g.personas.length;
    this.saveGroups();
    return g.personas[g.turn];
  }

  activateGroup(agent, groupName) {
    const g = this.groups[groupName];
    if (!g) throw new Error(`no group "${groupName}"`);
    this.groupSessions.set(agent.id, groupName);
    const speaker = g.personas[g.turn % g.personas.length];
    this.activate(agent, speaker);
    return { group: groupName, speaker };
  }

  deactivateGroup(agent) {
    this.groupSessions.delete(agent.id);
    this.deactivate(agent);
  }

  handoff(agent, toName) {
    const persona = this.get(toName);
    if (!persona) throw new Error(`no persona named "${toName}"`);
    this.groupSessions.delete(agent.id);
    this.activate(agent, toName);
    return { active: toName };
  }

  registerGroupDriver() {
    this.ctx.effect(() => this.ctx.on('agent/turn-stopping', (payload) => {
      const groupName = this.groupSessions.get(payload.agent.id);
      if (!groupName) return;
      this.activate(payload.agent, this.advanceGroup(groupName));
    }), 'dsh-cast.group-driver');
  }

  // -- Phase 2: agent-callable tools -----------------------------------------
  registerTools() {
    const textOutput = {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    };

    this.ctx.effect(() => this.ctx.tools.register({
      name: 'set_persona',
      description:
        'Activate a dsh-cast persona for this session (by name), or pass "off" to deactivate. This changes how the assistant sounds and behaves for the rest of the session.',
      parameters: {
        type: 'object',
        properties: {
          persona: { type: 'string', description: 'Persona name to activate, or "off" to turn personas off.' },
        },
        required: ['persona'],
      },
      output: textOutput,
      execute: async (args, exec) => {
        const agent = exec.agent ?? this.ctx.agents?.currentInitiator();
        if (!agent) throw new Error('set_persona: no agent context');
        const name = String(args?.persona ?? '').trim();
        if (!name) throw new Error('set_persona: "persona" is required');
        if (name === 'off') {
          this.deactivate(agent);
          return { active: null, message: 'Persona off.' };
        }
        this.activate(agent, name);
        return { active: name, message: `Activated persona "${name}".` };
      },
    }), 'dsh-cast.tool.set_persona');

    this.ctx.effect(() => this.ctx.tools.register({
      name: 'list_personas',
      description: 'List every available dsh-cast persona and which one is active for this session.',
      parameters: { type: 'object', properties: {} },
      output: textOutput,
      execute: async (_args, exec) => {
        const agent = exec.agent ?? this.ctx.agents?.currentInitiator();
        const active = agent ? this.active(agent) : null;
        return {
          active,
          personas: this.list().map((name) => ({ name, active: name === active })),
        };
      },
    }), 'dsh-cast.tool.list_personas');

    this.ctx.effect(() => this.ctx.tools.register({
      name: 'create_persona',
      description:
        'Create a new dsh-cast persona from a name and an optional natural-language definition. ' +
        'The definition has six fields: identity (who it is), expertise (what it is good at), ' +
        'behavior (how it acts), communication (tone and response style), rules (explicit do/don\u2019t ' +
        'preferences), and examples (user/assistant pairs).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique persona name.' },
          definition: {
            type: 'object',
            description: 'Optional structured persona definition (six natural-language fields).',
            properties: {
              identity: { type: 'string', description: 'Who the persona is: role, background, defining characteristics.' },
              expertise: { type: 'string', description: 'Subject areas, capabilities, preferred problem-solving approach.' },
              behavior: { type: 'string', description: 'How the persona thinks, reacts, challenges assumptions, interacts.' },
              communication: { type: 'string', description: 'Tone, structure, level of detail, writing style.' },
              rules: { type: 'string', description: 'Explicit preferences, constraints, recurring behavioral instructions.' },
              examples: {
                type: 'array',
                description: 'Representative user/assistant exchanges.',
                items: {
                  type: 'object',
                  properties: {
                    user: { type: 'string', description: 'What the user says.' },
                    assistant: { type: 'string', description: 'What the persona replies.' },
                  },
                },
              },
            },
          },
          traits: {
            type: 'object',
            description: 'Optional legacy trait values (kept for routing/mixing; the prompt uses `definition`).',
            properties: {
              formality: { type: 'number' }, warmth: { type: 'number' }, humor: { type: 'number' },
              verbosity: { type: 'number' }, directness: { type: 'number' }, chaos: { type: 'number' },
            },
          },
          identity: { type: 'object', description: 'Optional legacy identity override (e.g. { "role": "..." }).' },
        },
        required: ['name'],
      },
      output: textOutput,
      execute: async (args) => {
        const name = String(args?.name ?? '').trim();
        const persona = await this.createPersona(name, {
          definition: args?.definition,
          traits: args?.traits,
          identity: args?.identity,
        });
        return { created: persona.name };
      },
    }), 'dsh-cast.tool.create_persona');
  }

  // Confirmation mode for set_persona (mirrors dsh-soul's requireToolConfirmation).
  registerToolConfirmation() {
    this.ctx.effect(() => this.ctx.on('tools/pre-execute', (exec, next) => {
      if (this.setPersonaConfirm && exec.name === 'set_persona') {
        const name = String(exec.arguments?.persona ?? 'off');
        return {
          kind: 'ask',
          reason: `Switching this session's persona to "${name}" requires confirmation.`,
          displayReason: { en: `Switch this session's persona to "${name}"?` },
        };
      }
      return next();
    }), 'dsh-cast.set-persona-confirm');
  }

  // -- Phase 2: client-facing HTTP JSON API (authenticated /api channel) ------
  registerHttpApi() {
    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
    const readBody = async (request) => {
      try {
        return await request.json();
      } catch {
        return {};
      }
    };
    const route = (path, methods, fetch) => this.ctx.effect(
      () => this.ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch }),
      `dsh-cast.http${path}`,
    );

    // `health` is additive to the existing shape, so older clients that only read
    // `personas` keep working. It exists because H2/H4 made report-write failures
    // non-fatal but left them observable only in the log: the service recorded
    // `lastReportError` and NOTHING could read it, which meant a degraded startup
    // was survivable but invisible. A failure the user cannot see is only half
    // fixed — surfacing it here is what makes the honesty mechanism reach the UI.
    route('/api/dsh-cast/list', ['GET'], () => Promise.resolve(json({
      personas: this.list(),
      health: this.healthStatus(),
    })));

    // GET is a pure read. It returns the STORED persona plus the RESOLVED
    // definition attached, so a legacy persona (no `definition` key) is presented
    // to the editor already migrated. `migrated` tells the client the definition
    // was derived from legacy fields and will be persisted on the next explicit
    // save — reading never rewrites the file.
    route('/api/dsh-cast/get', ['GET'], (request) => {
      const name = new URL(request.url).searchParams.get('name') ?? '';
      const persona = this.get(name);
      if (!persona) return Promise.resolve(json({ error: `no persona named "${name}"` }, 404));
      const prompt = this.resolvePrompt(persona, undefined);
      return Promise.resolve(json({
        persona: { ...persona, definition: prompt.definition },
        migrated: prompt.migrated,
      }));
    });

    route('/api/dsh-cast/create', ['POST'], async (request) => {
      const body = await readBody(request);
      try {
        const persona = await this.createPersona(String(body.name ?? '').trim(), body);
        return json({ persona: persona.name });
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    });

    route('/api/dsh-cast/edit', ['POST'], async (request) => {
      const body = await readBody(request);
      try {
        const persona = await this.editPersona(String(body.name ?? '').trim(), JSON.stringify(body.patch ?? {}));
        return json({ persona: persona.name });
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    });

    route('/api/dsh-cast/delete', ['POST'], async (request) => {
      const body = await readBody(request);
      try {
        await this.deletePersona(String(body.name ?? '').trim());
        return json({ deleted: body.name });
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    });

    route('/api/dsh-cast/activate', ['POST'], async (request) => {
      const body = await readBody(request);
      const agent = this.ctx.agents?.get(body.sessionId);
      if (!agent) return json({ error: 'no agent for sessionId' }, 400);
      try {
        if (body.name === 'off') {
          this.deactivate(agent);
          return json({ active: null });
        }
        this.activate(agent, String(body.name ?? ''));
        return json({ active: String(body.name ?? '') });
      } catch (err) {
        return json({ error: err.message }, 400);
      }
    });

    // F1 (review blocker): the READ-ONLY active-persona route.
    //
    // Why this exists: the client previously discovered the active persona by
    // POSTing the MUTATING /activate route with an arbitrary name and reading
    // back `active`. Because activate() disposes and re-registers prompt
    // sections, that "read" changed the session — it clobbered a persona set to
    // "warm" down to whatever name the client guessed, and silently ACTIVATED a
    // persona in a session that had it turned off.
    //
    // This route MUST stay a pure read. It never calls activate()/deactivate(),
    // never touches `this.activations`, and never registers prompt sections. It
    // only asks the existing `active()` authority (index.js `active(agent)`,
    // the same source list_personas uses) and reports what it finds.
    //
    // Response contract — THREE distinguishable states, deliberately explicit so
    // the client never has to infer "off" from an error:
    //   { sessionId, active: 'name' }   -> a named persona is active
    //   { sessionId, active: null }     -> no persona is active ("off")
    //   { error } with 4xx              -> the read failed / unknown session
    route('/api/dsh-cast/active', ['GET'], (request) => {
      const sessionId = (new URL(request.url).searchParams.get('sessionId') ?? '').trim();
      if (!sessionId) return Promise.resolve(json({ error: 'sessionId is required' }, 400));
      const agent = this.ctx.agents?.get(sessionId);
      if (!agent) return Promise.resolve(json({ error: `no agent for sessionId "${sessionId}"` }, 404));
      try {
        return Promise.resolve(json({ sessionId, active: this.active(agent) ?? null }));
      } catch (err) {
        return Promise.resolve(json({ error: err.message }, 400));
      }
    });

    // Phase 6 (A2): "what the model actually sees" — the composed persona prompt
    // split into its named layers, with per-layer character/token counts.
    // Read-only; never performs a write.
    route('/api/dsh-cast/preview', ['GET'], (request) => {
      const params = new URL(request.url).searchParams;
      const name = (params.get('name') ?? '').trim();
      if (!name) return Promise.resolve(json({ error: 'name is required' }, 400));
      const sessionId = (params.get('sessionId') ?? '').trim();
      try {
        return Promise.resolve(json(this.promptInspection(name, sessionId || undefined)));
      } catch (err) {
        return Promise.resolve(json({ error: err.message }, 404));
      }
    });

    // Phase 6 (A3): one-click A/B. Wires the EXISTING compare() to the browser —
    // compare() itself is not reimplemented here. The LLM call is slow, so the
    // client must show a pending state; failures surface as { error }.
    route('/api/dsh-cast/compare', ['POST'], async (request) => {
      const body = await readBody(request);
      const nameA = String(body.a ?? '').trim() || String(body.nameA ?? '').trim();
      const nameB = String(body.b ?? '').trim() || String(body.nameB ?? '').trim();
      const prompt = String(body.prompt ?? '').trim();
      if (!nameA || !nameB || !prompt) {
        return json({ error: 'a, b and prompt are required' }, 400);
      }
      if (this.compareInFlight > 0) return json({ error: 'an A/B comparison is already running' }, 409);
      this.compareInFlight += 1;
      try {
        return json(await this.compare(nameA, nameB, prompt));
      } catch (err) {
        return json({ error: err.message }, 400);
      } finally {
        this.compareInFlight -= 1;
      }
    });

    // Isolated single-persona try-out. Never activates, never writes memory: it
    // runs the resolved system prompt through the isolated LLM path and reports
    // the exact prompt it used. Shares compare()'s in-flight guard (the LLM call
    // is slow and serialized).
    route('/api/dsh-cast/try', ['POST'], async (request) => {
      const body = await readBody(request);
      const name = String(body.name ?? '').trim();
      const prompt = String(body.prompt ?? '').trim();
      if (!name || !prompt) return json({ error: 'name and prompt are required' }, 400);
      if (this.compareInFlight > 0) return json({ error: 'an A/B comparison or try is already running' }, 409);
      this.compareInFlight += 1;
      try {
        return json(await this.tryPersona(name, prompt));
      } catch (err) {
        return json({ error: err.message }, 400);
      } finally {
        this.compareInFlight -= 1;
      }
    });
  }

  // -- lifecycle -----------------------------------------------------------
  async start() {
    await this.loadBuiltins();
    await this.loadUser();
    await this.loadState();
    await this.loadMemory();
    await this.loadHistory();
    await this.loadRatings();
    await this.loadComparisons();
    await this.loadGroups();
    this.watchUserDir();
    await this.writeReport();
  }

  async writeReport() {
    try {
      await mkdir(this.personasDir, { recursive: true });
      const personas = this.list().map((name) => {
        const p = this.get(name);
        return { name, resolvedTraits: resolveTraits(p, this), layers: compose(p, this.tokenBudget, this, undefined) };
      });
      const report = {
        phase: 'phase6',
        personasDir: this.personasDir,
        autoActivate: this.autoActivate,
        tokenBudget: this.tokenBudget,
        personas,
        writtenAt: Date.now(),
      };
      await writeFile(
        path.join(this.personasDir, '.dsh-cast-report.json'),
        JSON.stringify(report, null, 2),
        'utf8',
      );
      this.lastReportError = null;
      this.lastReportAt = report.writtenAt;
    } catch (err) {
      // This used to be a bare `this.log(...)`, which made a FAILED write
      // indistinguishable from a successful one: the previous report stayed on disk
      // with no staleness marker, so anything reading it (or a human skimming the
      // logs) could read a stale file as current. A transient burst once swallowed
      // 12+ of these. Record it loudly and on the service, so it can be surfaced.
      this.lastReportError = { at: Date.now(), message: String(err?.message ?? err) };
      this.log(`REPORT WRITE FAILED (report on disk is now stale): ${err.message}`);
      throw err;
    }
  }

  // -- Phase 3: relationship state -------------------------------------------
  _statePath() {
    return path.join(this.personasDir, '.dsh-cast-state.json');
  }

  _memoryPath() {
    return path.join(this.personasDir, '.dsh-cast-memory.json');
  }

  async loadState() {
    this.state.clear();
    try {
      const raw = JSON.parse(await readFile(this._statePath(), 'utf8'));
      for (const [name, value] of Object.entries(raw)) {
        this.state.set(name, { ...DEFAULT_STATE, ...value });
      }
    } catch {
      // no state yet
    }
  }

  async saveState() {
    try {
      const obj = {};
      for (const [name, value] of this.state) obj[name] = value;
      await writeFile(this._statePath(), JSON.stringify(obj, null, 2), 'utf8');
    } catch (err) {
      this.log(`state save failed: ${err.message}`);
    }
  }

  getState(name) {
    return this.state.get(name) ?? null;
  }

  setState(name, value) {
    this.state.set(name, { ...DEFAULT_STATE, ...value });
    this.saveState();
  }

  // Drift over turns + recovery over idle time.
  advanceState(name, opts = {}) {
    const now = Date.now();
    const prev = this.getState(name) ?? { ...DEFAULT_STATE, updatedAt: now };
    const elapsedHours = Math.max(0, (now - (prev.updatedAt || now)) / 3600000);
    const round2 = (v) => Math.round(v * 100) / 100;
    const next = {
      mood: DEFAULT_STATE.mood,
      energy: round2(clamp(prev.energy + elapsedHours * 3 - 1, 0, 10)),
      trust: round2(clamp(prev.trust + (opts.error ? -1 : 0.5), 0, 10)),
      familiarity: round2(clamp(prev.familiarity + 1, 0, 10)),
      updatedAt: now,
    };
    next.mood = Math.round(clamp(
      5 + (next.energy - 5) * 0.4 + (next.trust - 5) * 0.4 + (next.familiarity - 5) * 0.2,
      0, 10,
    ) * 10) / 10;
    this.setState(name, next);
    return next;
  }

  registerStateDrift() {
    this.ctx.effect(() => this.ctx.on('agent/turn-stopping', (payload) => {
      const rec = this.activations.get(payload.agent.id);
      if (rec) this.advanceState(rec.persona);
    }), 'dsh-cast.state-drift');
  }

  // -- Phase 3: scoped memory -------------------------------------------------
  async loadMemory() {
    this.memories = [];
    try {
      const raw = JSON.parse(await readFile(this._memoryPath(), 'utf8'));
      if (Array.isArray(raw)) this.memories = raw;
    } catch {
      // no memory yet
    }
  }

  async saveMemory() {
    try {
      await writeFile(this._memoryPath(), JSON.stringify(this.memories, null, 2), 'utf8');
    } catch (err) {
      this.log(`memory save failed: ${err.message}`);
    }
  }

  addMemory(scope, personaName, text, sessionId) {
    if (!MEMORY_SCOPES.includes(scope)) throw new Error(`unknown memory scope "${scope}"`);
    const body = String(text ?? '').trim();
    if (!body) throw new Error('memory text is required');
    this._memorySeq += 1;
    const record = {
      id: `m-${Date.now()}-${this._memorySeq}`,
      scope,
      persona: personaName ?? '*',
      sessionId: sessionId ?? null,
      text: body,
      createdAt: Date.now(),
    };
    this.memories.push(record);
    this.saveMemory();
    return record;
  }

  // Isolation: a persona sees global + user + its own persona/episodic scopes,
  // plus conversation scope for its session — never another persona's scopes.
  listMemories(personaName, sessionId) {
    return this.memories.filter((m) =>
      m.scope === 'global' ||
      m.scope === 'user' ||
      (m.scope === 'persona' && m.persona === personaName) ||
      (m.scope === 'episodic' && m.persona === personaName) ||
      (m.scope === 'conversation' && sessionId != null && m.sessionId === sessionId),
    );
  }

  // =========================================================================
  // === BEGIN memory-engineer (B1): ranked scoped-memory retrieval ===
  // =========================================================================
  //
  // RANKING FORMULA (exact, so the behaviour is inspectable and reviewable):
  //
  //   relevance   = |queryTerms ∩ recordTerms| / |queryTerms|          in [0, 1]
  //   recency     = 0.5 ^ (ageMs / RECENCY_HALF_LIFE_MS)               in (0, 1]
  //   scopeBonus  = SCOPE_PRIORITY[scope] / max(SCOPE_PRIORITY)        in (0, 1]
  //                 (conversation 5 > persona 4 > user 3 > episodic 2 > global 1)
  //   score       = 0.7 * relevance + 0.2 * recency + 0.15 * scopeBonus
  //
  // With no query the relevance term is 0 for every candidate, so the ranking
  // collapses to recency + scope — i.e. "newest and most specific first".
  //
  // Ties break deterministically on (score, createdAt, id) so a stored list and a
  // re-run always produce the same order.
  //
  // PER-SCOPE QUOTA: at least QUOTA_MIN (2) records per surviving scope, taken as
  // that scope's own highest-ranked records, so a scope that has records cannot be
  // starved out of the selection by a scope that happens to be newer. NAMED
  // LIMITATION: quota selection is by score WITHIN a scope, never global rank, so a
  // high-scoring record from a heavy scope can lose its place to a weaker record
  // that happens to be its scope's best.
  //
  // TOKEN BUDGET: the selection is bounded by SUMMING THE PRICE OF THE ACTUAL
  // CANDIDATE MESSAGES (see priceMemoryMessage) — the same number the harness
  // token meter would report for the message we hand to agent.inject(). A record
  // that does not fit is DROPPED WHOLE; nothing is ever cut mid-record (unlike the
  // budget() helper in the composer header). The same pricing is what makes the
  // memory layer's own prompt section fit its band, because compose() calls this
  // with the layer's budget and then does NOT re-run budget() over the result.
  retrieveMemories(personaName, sessionId, options = {}) {
    const query = String(options.query ?? '').trim();
    const budgetTokens = Math.max(0, Math.floor(Number(options.budgetTokens ?? this.tokenBudget?.memory ?? DEFAULT_MEMORY_TOKENS) || 0));
    const now = Number(options.now ?? Date.now());
    const candidates = this.listMemories(personaName, sessionId);
    const queryTerms = tokenizeForRelevance(query);

    const scored = candidates.map((record) => {
      const text = String(record.text ?? '');
      const recordTerms = tokenizeForRelevance(text);
      const matched = [...queryTerms].filter((t) => recordTerms.has(t));
      const relevance = queryTerms.size > 0 ? matched.length / queryTerms.size : 0;
      const recency = recencyScore(record.createdAt, now);
      const scopeBonus = (SCOPE_PRIORITY[record.scope] ?? 1) / 5;
      const score = 0.7 * relevance + 0.2 * recency + 0.15 * scopeBonus;
      const price = priceMemoryMessage(text, record);
      return {
        record,
        id: record.id,
        scope: record.scope,
        text,
        createdAt: Number(record.createdAt) || 0,
        relevance: Math.round(relevance * 1000) / 1000,
        recency: Math.round(recency * 1000) / 1000,
        scopeBonus: Math.round(scopeBonus * 1000) / 1000,
        score: Math.round(score * 10000) / 10000,
        matchedTerms: matched,
        tokens: price.tokens,
        chars: price.chars,
        reason: queryTerms.size > 0 && matched.length > 0
          ? `matched ${matched.join('+')}`
          : (queryTerms.size > 0 ? 'recency+scope (no term overlap)' : 'recency+scope (no query)'),
      };
    });

    const byRank = (a, b) => (b.score - a.score) || (b.createdAt - a.createdAt) || String(a.id).localeCompare(String(b.id));
    scored.sort(byRank);

    const buckets = new Map();
    for (const entry of scored) {
      if (!buckets.has(entry.scope)) buckets.set(entry.scope, []);
      buckets.get(entry.scope).push(entry);
    }
    const quotaMin = Math.max(1, Math.min(2, Math.ceil(scored.length / Math.max(1, buckets.size))));

    const picked = new Map(); // id -> { entry, via }
    const take = (entry, via) => { if (!picked.has(entry.id)) picked.set(entry.id, { entry, via }); };
    for (const [scope, list] of buckets) {
      for (const entry of list.slice(0, quotaMin)) take(entry, `quota:${scope}`);
    }
    for (const entry of scored) take(entry, 'rank');

    const ordered = [...picked.values()].sort((a, b) => byRank(a.entry, b.entry));
    const selection = [];
    let usedTokens = 0;
    const dropped = [];
    for (const { entry, via } of ordered) {
      if (usedTokens + entry.tokens <= budgetTokens) {
        usedTokens += entry.tokens;
        selection.push({ ...entry, via });
      } else {
        dropped.push({
          id: entry.id,
          scope: entry.scope,
          score: entry.score,
          tokens: entry.tokens,
          reason: `whole record dropped: ${entry.tokens} tokens + ${usedTokens} used > ${budgetTokens} budget`,
        });
      }
    }

    return {
      persona: personaName,
      sessionId: sessionId != null ? String(sessionId) : null,
      query,
      budgetTokens,
      usedTokens,
      remainingTokens: Math.max(0, budgetTokens - usedTokens),
      candidateCount: candidates.length,
      scored,
      selection,
      dropped,
      quota: { minPerScope: quotaMin, scopesWithRecords: [...buckets.keys()] },
      formula: 'score = 0.7*relevance + 0.2*recency + 0.15*(scopePriority/5); ties by createdAt then id; whole-record token-budget truncation',
    };
  }
  // =========================================================================
  // === END memory-engineer (B1) ===
  // =========================================================================

  // =========================================================================
  // === BEGIN memory-engineer (B3): context-budget pass ===
  // =========================================================================
  //
  // MEASURE -> ALLOCATE -> LET THE MEMORY LAYER CONSUME WHAT IS LEFT.
  //
  // `contextBudget` is the total token allowance for the dsh-cast prompt layers
  // (default = the sum of tokenBudget, i.e. exactly the configured table).
  // Each layer gets share * (contextBudget - reserved), and a layer that is
  // configured with a smaller explicit band is capped to that band. The layer's
  // own budget is then MEASURED against its actual text: unused band is returned
  // to a pool, and the pool is handed to the memory layer, so retrieval prices its
  // candidates against the memory layer's REAL remaining budget rather than a
  // fixed default.
  contextBudgetPass(personaName, sessionId, options = {}) {
    const b = this.tokenBudget ?? {};
    const configuredTotal = Object.keys(DEFAULT_BUDGET).reduce(
      (n, key) => n + Number(b[key] ?? DEFAULT_BUDGET[key]),
      0,
    );
    const total = Math.max(1, Math.floor(this.contextBudget > 0 ? this.contextBudget : configuredTotal));
    const memoryShare = CONTEXT_LAYERS.find((l) => l.name === 'memory')?.share ?? 0.1;
    const otherShares = CONTEXT_LAYERS.reduce((n, l) => (l.name === 'memory' ? n : n + l.share), 0) || 1;

    // 1. MEASURE. Price the ACTUAL composed layer texts (not a nominal constant).
    //    Measuring is the DEFAULT; pass { measure: false } for an allocation-only
    //    view, or { texts } to supply texts you already composed.
    const texts = options.measure === false ? null : (options.texts ?? (() => {
      try {
        return Object.fromEntries(
          compose(this.get(personaName), b, this, sessionId).map((l) => [l.name, l.text]),
        );
      } catch (err) {
        this.log(`context budget pass could not compose "${personaName}": ${err.message}`);
        return null;
      }
    })());

    // 2. ALLOCATE. Reserve the memory share first so the memory band can never be
    //    squeezed to zero by the other layers, then give the rest their share of
    //    the remaining budget, each capped by its own configured band.
    const reservedForMemory = Math.floor((total * memoryShare) / (memoryShare + otherShares));
    const allocatable = Math.max(0, total - reservedForMemory);
    const measured = [];
    let pooled = 0;
    for (const layer of CONTEXT_LAYERS) {
      if (layer.name === 'memory') continue;
      const band = Number(b[layer.band] ?? DEFAULT_BUDGET[layer.band]);
      const allowance = Math.max(0, Math.min(Math.floor((allocatable * layer.share) / otherShares), band));
      const text = texts ? texts[layerKeyToLayerName(layer.name)] : undefined;
      const used = text == null ? null : this.estimateLayerTokens(layer.name, text);
      // 3. RETURN THE REMAINDER. Only an actually-measured layer can hand back
      //    slack; an unmeasured layer consumes its whole allowance.
      const unused = used == null ? 0 : Math.max(0, allowance - used);
      pooled += unused;
      measured.push({ layer: layer.name, allowance, band, used, unused });
    }

    // The memory band = its reserved share + every token the other layers left on
    // the table, capped by the configured memory band. It is deliberately allowed
    // to EXCEED the configured band when the total context budget is larger, so the
    // memory layer really does consume the remaining budget rather than a default.
    const memoryBand = Math.max(0, Math.min(
      Number(b.memory ?? DEFAULT_BUDGET.memory) + pooled,
      reservedForMemory + pooled,
    ));
    return {
      contextBudget: total,
      configuredTotal,
      persona: personaName ?? null,
      sessionId: sessionId != null ? String(sessionId) : null,
      measured: texts != null,
      layers: measured,
      pooledTokens: pooled,
      reservedForMemory,
      memoryBand,
      allocationRule: 'memory reserve first (its share of contextBudget), other layers share the rest capped by their configured band; measured slack is pooled and handed back to the memory band, capped at configuredMemoryBand + pooled',
    };
  }

  // Price an already-composed layer text with the preferred meter.
  estimateLayerTokens(name, text) {
    void name;
    return priceMessage(text);
  }

  // Prefer the mounted token meter when it exposes a scalar estimator; otherwise
  // use the identical built-in heuristic. Never throws: a meter failure must not
  // break composing or delivery.
  _measureText(text) {
    try {
      const meter = this.ctx.tokenMeter;
      if (meter && typeof meter.estimateMessage === 'function') {
        const value = meter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] });
        if (Number.isFinite(value) && value >= 0) return { tokens: Math.floor(value), source: 'ctx.tokenMeter.estimateMessage' };
      }
    } catch (err) {
      this.log(`tokenMeter unavailable, using the built-in heuristic: ${err.message}`);
    }
    return { tokens: priceMessage(text), source: 'built-in fixed-density heuristic (chars/4 + role framing)' };
  }
  // =========================================================================
  // === END memory-engineer (B3) ===
  // =========================================================================

  // =========================================================================
  // === BEGIN memory-engineer (B2): agent.inject() delivery on pre-step ===
  // =========================================================================
  registerMemoryInjection() {
    this.ctx.effect(() => this.ctx.on('agent/pre-step', (payload, next) => {
      // A memory failure must never break a turn: the whole hook is guarded and
      // always defers to next(). We never await anything inside: inject() is a
      // fire-and-forget `void` call with no ack (phase6-contract.md item 1).
      try {
        this.injectMemory(payload?.agent, payload?.messages);
      } catch (err) {
        this.log(`memory injection failed, turn continues: ${err.message}`);
      }
      // EXACTLY ONE next() on every path. The Cordis waterfall is CONSUMING
      // (`const next = () => (cbs.shift() ?? inner)(...args)`), so a second call
      // finds an empty queue and re-runs the terminal. The previous version did
      // `if (queued > 0) void next();` here AND `return next();` below, which ran
      // the terminal twice per step. Do not reintroduce a second call.
      return next();
    }), 'dsh-cast.memory-inject');
  }

  // Query for retrieval: the user-authored messages entering this step. Injected
  // content (our own source kind) is excluded so delivery cannot feed on itself.
  queryTermsFromMessages(messages) {
    const parts = [];
    for (const message of messages ?? []) {
      if (message?.role !== 'user') continue;
      if (message?.source?.kind === 'dsh-cast') continue;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (typeof block?.text === 'string') parts.push(block.text);
      }
    }
    return parts.join(' ').slice(0, 2000);
  }

  // Delivery decision. Returns the number of messages handed to inject().
  injectMemory(agent, stepMessages) {
    if (!this.memoryInjection) return 0;
    if (!agent || typeof agent.inject !== 'function') return 0;
    const sessionId = String(agent.id ?? '');
    if (!sessionId) return 0;

    // Never inject when no persona is active. `active()` is the same authority
    // every other feature uses, so an unknown agent is simply "no persona".
    const personaName = this.active(agent);
    if (!personaName) return 0;

    // Never wake an idle driver. inject() is wakeup:false by construction, but we
    // also refuse when the agent is neither mid-step nor busy, so a future change
    // to the delivery path cannot turn this into a wake.
    const inStep = Array.isArray(stepMessages) && stepMessages.length > 0;
    if (!inStep && !this.agentIsBusy(agent)) {
      this._noteInjection(sessionId, { queued: 0, reason: 'idle: no running step' });
      return 0;
    }

    const band = this.contextBudgetPass(personaName, sessionId).memoryBand;
    const budgetTokens = Math.floor(this.memoryInjectBudget > 0 ? Math.min(this.memoryInjectBudget, band) : band);
    if (budgetTokens <= 0) {
      this._noteInjection(sessionId, { queued: 0, reason: 'no token budget for the memory layer' });
      return 0;
    }

    const query = this.queryTermsFromMessages(stepMessages);
    const ranked = this.retrieveMemories(personaName, sessionId, { query, budgetTokens });
    const delivered = this.memoryUsage.get(sessionId);
    const seen = delivered?.seen ?? new Set();
    // Records that were SELECTED for a previous batch are marked as accounted for,
    // whether or not the batch cap let them into that particular message. Without
    // this, records ranked below the batch cap would look "new" at every step
    // forever, and the very next step would re-inject a near-duplicate batch.
    const accounted = delivered?.accounted ?? new Set();

    // "Genuinely new OR relevant" -- precisely: a record is deliverable if it has
    // never been offered for this session, OR (for a still unclaimed batch) it is
    // not part of that pending batch but does overlap this step's query. A record
    // already offered in a CONSUMED batch is suppressed: re-sending it would be a
    // duplicate, and "relevant" is not a licence to repeat what the model has read.
    const pending = this.inboxMessages(agent);
    const pendingIds = new Set();
    if (pending !== null) {
      for (const m of pending) {
        for (const id of (Array.isArray(m?.dshCastMemoryIds) ? m.dshCastMemoryIds : [])) pendingIds.add(id);
      }
    }
    const batchStillPending = pendingIds.size > 0;
    const qualified = ranked.selection.filter((entry) => {
      if (pendingIds.has(entry.id)) return false;        // already queued, unclaimed
      if (!accounted.has(entry.id)) return true;         // never offered: genuinely new
      if (!batchStillPending) return false;              // offered and consumed: duplicate
      return entry.relevance >= this.memoryInjectMinOverlap; // unclaimed batch: re-offer if on-topic
    });
    if (qualified.length === 0) {
      this._noteInjection(sessionId, {
        queued: 0,
        reason: batchStillPending
          ? 'previous batch still unclaimed in the inbox'
          : (ranked.candidateCount === 0 ? 'no memory visible to this persona' : 'nothing new or relevant to deliver'),
      });
      return 0;
    }

    // Cap the batch (phase6-contract.md item 1: "cap N, not just total tokens").
    // Selection is already token-bounded, so the cap only trims the count.
    const MAX_BATCH = 3;
    const batch = [];
    let batchTokens = 0;
    for (const entry of qualified) {
      if (batch.length >= MAX_BATCH) break;
      batch.push(entry);
      batchTokens += entry.tokens;
    }
    const text = this.renderInjection(personaName, batch);
    const measured = this._measureText(text);
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      // Producer-owned kind; unknown kinds are admitted at create/append/replay
      // (phase6-contract.md item 2). 'recall' is the closest ContextForm.
      source: { kind: 'dsh-cast', form: 'recall' },
      dshCastMemoryIds: batch.map((e) => e.id),
    };

    try {
      agent.inject(message);
    } catch (err) {
      this.log(`agent.inject() threw, continuing without memory: ${err.message}`);
      this._noteInjection(sessionId, { queued: 0, reason: `inject threw: ${err.message}` });
      return 0;
    }

    const nextSeen = new Set(seen);
    for (const entry of batch) nextSeen.add(entry.id);
    const nextAccounted = new Set(accounted);
    for (const entry of ranked.selection) nextAccounted.add(entry.id);
    this.memoryUsage.set(sessionId, {
      seen: nextSeen,
      accounted: nextAccounted,
      lastIds: batch.map((e) => e.id),
      lastAt: Date.now(),
      lastTokens: measured.tokens,
    });
    this._noteInjection(sessionId, {
      queued: batch.length,
      reason: 'new/relevant memory delivered',
      ids: batch.map((e) => e.id),
      tokens: measured.tokens,
      estimatedTokens: batchTokens,
      budgetTokens,
      meter: measured.source,
    });
    return batch.length;
  }

  renderInjection(personaName, batch) {
    const lines = batch.map((entry) => `- [${entry.scope}] ${entry.text}`);
    return [
      `dsh-cast remembered context for persona "${personaName}" (retrieved, ranked, token-budgeted):`,
      ...lines,
      'Use only what is relevant to the current request; ignore the rest.',
    ].join('\n');
  }

  agentIsBusy(agent) {
    const status = agent?.status;
    if (typeof status === 'string') return status === 'running' || status === 'working';
    if (status && typeof status.state === 'string') return status.state === 'running';
    if (agent?.busy === true || agent?.running === true) return true;
    if (Number(agent?.pendingSteps) > 0) return true;
    // No invented idle signal here. An earlier version consulted
    // `agent.idleDelay` via safeIdleDelayMs(), but that field does not exist on a
    // real Agent (it appears nowhere in the DSH checkout), so it is gone
    // (review finding F5). "No positive evidence of work" is the only honest
    // answer for an agent exposing none of the fields above.
    return false;
  }

  // Live inbox contents, or null when they cannot be read. Returns the union of
  // whichever of nextStep / nextTurn / queued the agent exposes, plus the raw
  // `messages` array if that is all there is. MUST NOT throw.
  inboxMessages(agent) {
    try {
      const inbox = agent?.inbox;
      if (!inbox || typeof inbox !== 'object') return null;
      const keys = ['nextStep', 'nextTurn', 'queued', 'messages'];
      let found = false;
      const out = [];
      for (const key of keys) {
        const value = inbox[key];
        if (!Array.isArray(value)) continue;
        found = true;
        for (const item of value) out.push(inboxItemMessage(item));
      }
      return found ? out : null;
    } catch (err) {
      this.log(`inbox inspection failed: ${err.message}`);
      return null;
    }
  }

  _noteInjection(sessionId, note) {
    this.injectionLog.push({ at: Date.now(), sessionId, ...note });
    if (this.injectionLog.length > 100) this.injectionLog.splice(0, this.injectionLog.length - 100);
  }

  // Inspectable record of what the delivery path decided, for the UI inspector.
  injectionStatus(sessionId) {
    const usage = this.memoryUsage.get(sessionId);
    return {
      enabled: this.memoryInjection,
      sessionId: String(sessionId ?? ''),
      delivered: usage ? usage.seen.size : 0,
      lastDeliveredAt: usage?.lastAt ?? null,
      lastTokens: usage?.lastTokens ?? 0,
      attempts: this.injectionLog.filter((n) => n.sessionId === String(sessionId ?? '')),
    };
  }

  // Startup health, so a degradation is visible in the UI instead of only in the
  // console. `reportStale` means the on-disk report no longer reflects live state:
  // either the last write failed (`lastReportError` set) or no write has succeeded
  // at all. Deliberately reports rather than repairs — the caller decides.
  healthStatus() {
    return {
      ok: this.lastReportError === null && this.lastReportAt !== null,
      lastReportAt: this.lastReportAt ?? null,
      reportStale: this.lastReportError !== null,
      lastReportError: this.lastReportError
        ? { at: this.lastReportError.at, message: this.lastReportError.message }
        : null,
    };
  }
  // =========================================================================
  // === END memory-engineer (B2) ===
  // =========================================================================

  clearMemory(scope, personaName) {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => {
      if (m.scope !== scope) return true;
      if (scope === 'global' || scope === 'user') return false;
      return m.persona !== personaName;
    });
    this.saveMemory();
    return before - this.memories.length;
  }

  // -- Phase 3: memory command ------------------------------------------------
  memoryCommand(parts, agent) {
    const [name, sub, ...rest] = parts;
    if (!name || !sub) {
      return { kind: 'success', text: 'Usage: /persona memory <name> add <text> | show | clear' };
    }
    if (sub === 'add') {
      const text = rest.join(' ').trim();
      if (!text) return { kind: 'error', text: 'Usage: /persona memory <name> add <text>' };
      try {
        this.addMemory('persona', name, text, agent?.id);
        return { kind: 'success', text: `Added memory to "${name}".` };
      } catch (err) {
        return { kind: 'error', text: err.message };
      }
    }
    if (sub === 'show') {
      const memories = this.listMemories(name, agent?.id);
      if (memories.length === 0) return { kind: 'success', text: `No memories visible to "${name}".` };
      return {
        kind: 'success',
        text: `Memories for "${name}":\n${memories.map((m) => `- [${m.scope}] ${m.text}`).join('\n')}`,
      };
    }
    if (sub === 'clear') {
      const removed = this.clearMemory('persona', name);
      return { kind: 'success', text: `Cleared ${removed} persona-scoped memories for "${name}".` };
    }
    return { kind: 'success', text: 'Usage: /persona memory <name> add <text> | show | clear' };
  }

  log(message) {
    // eslint-disable-next-line no-console
    console.error(`[dsh-cast] ${message}`);
  }
}
