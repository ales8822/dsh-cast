// dsh-cast client half:
//  - a "Personas" page under Settings (list/create/delete + trait sliders)
//  - a compact persona switcher in the composer tool row (session-scoped)
//  - Phase 6: a Session-header persona picker with identity preview, a
//    "what the model actually sees" composed-prompt inspector, and one-click A/B.
// Talks to the host over the authenticated /api/dsh-cast/* JSON routes.
window.__ModuleLoader__.load({
  id: '@ales8822/dsh-cast',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    // The six natural-language fields that now define a persona (host schema).
    // Five are free text; `examples` is an ordered list of user/assistant pairs.
    const DEFINITION_TEXT_FIELDS = ['identity', 'expertise', 'behavior', 'communication', 'rules'];
    const DEFINITION_FIELD_META = {
      identity: {
        label: 'Identity and role',
        hint: 'Who the persona is — its role, background, and defining characteristics.',
      },
      expertise: {
        label: 'Expertise and capabilities',
        hint: 'What the persona knows and is good at, and how it approaches tasks.',
      },
      behavior: {
        label: 'Behavior and personality',
        hint: 'How the persona thinks, reacts, challenges assumptions, and interacts with the user.',
      },
      communication: {
        label: 'Communication and response style',
        hint: 'Tone, conciseness, formatting, and how answers should be structured.',
      },
      rules: {
        label: 'Rules and preferences',
        hint: 'Recurring instructions, preferred behavior, and things to avoid.',
      },
    };
    // Layer name -> the token budget dimension it is capped by (host §A2).
    const LAYER_BUDGETS = {
      'deployment:persona-prefix': 'identity',
      'dsh-cast:voice': 'voice',
      'dsh-cast:behavior': 'behavior',
      'dsh-cast:expertise': 'expertise',
      'dsh-cast:rules': 'rules',
      'dsh-cast:state': 'state',
      'dsh-cast:memory': 'memory',
      'dsh-cast:examples': 'examples',
    };
    const errText = (e) => (e && e.message ? e.message : String(e));
    const emptyDefinition = () => ({ identity: '', expertise: '', behavior: '', communication: '', rules: '', examples: [] });
    const cloneDraft = (d) => ({
      identity: d.identity ?? '',
      expertise: d.expertise ?? '',
      behavior: d.behavior ?? '',
      communication: d.communication ?? '',
      rules: d.rules ?? '',
      examples: Array.isArray(d.examples) ? d.examples.map((p) => ({ user: p.user ?? '', assistant: p.assistant ?? '' })) : [],
    });

    // Inline-style vocabulary shared by the phase-6 surface (no CSS import).
    const panelStyle = {
      position: 'absolute', top: '120%', left: 0, minWidth: '240px', padding: '6px',
      background: 'var(--dsw-alias-surface, #1c1c1c)',
      border: '1px solid var(--dsw-alias-border, #333)',
      borderRadius: '6px', zIndex: 10, display: 'flex', flexDirection: 'column',
      maxHeight: '420px', overflowY: 'auto', fontSize: '13px',
    };
    const itemStyle = {
      display: 'block', width: '100%', textAlign: 'left', padding: '4px 8px',
      background: 'transparent', border: 'none', cursor: 'pointer',
      color: 'inherit', fontSize: '13px',
    };
    const rowStyle = { display: 'flex', alignItems: 'flex-start', gap: '6px' };
    const metaStyle = { fontSize: '11px', opacity: 0.65, margin: '2px 0 6px' };
    const buttonStyle = {
      fontSize: '12px', padding: '2px 8px', borderRadius: '4px', cursor: 'pointer',
      border: '1px solid var(--dsw-alias-border, #333)',
      background: 'transparent', color: 'inherit',
    };
    const errorStyle = { color: 'var(--dsw-alias-danger, #c44)', fontSize: '12px', marginTop: '4px' };

    // -- phase 6 data helpers -------------------------------------------------
    // Every call resolves and rejects with an Error that carries the host's
    // `{ error }` message (api() already does this), so callers just render it.
    function loadPersonaList() {
      return api('/dsh-cast/list').then((d) => d.personas ?? []);
    }

    // Startup health, so a degraded host is visible in the UI rather than only in
    // the host console. The host reports it on the same route the list comes from.
    // Absent `health` (older host) must read as "nothing to report", never as an
    // error — the field is additive.
    function loadHealth() {
      return api('/dsh-cast/list')
        .then((d) => (d && d.health ? d.health : null))
        .catch(() => null);
    }

    function loadPersonaDetail(name) {
      return api('/dsh-cast/get?name=' + encodeURIComponent(name)).then((d) => d.persona ?? null);
    }

    function loadPreview(name, sessionId) {
      let path = '/dsh-cast/preview?name=' + encodeURIComponent(name);
      if (sessionId) path += '&sessionId=' + encodeURIComponent(sessionId);
      return api(path);
    }

    function runCompare(a, b, prompt) {
      return api('/dsh-cast/compare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a, b, prompt }),
      });
    }

    function runTry(name, prompt) {
      return api('/dsh-cast/try', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, prompt }),
      });
    }

    // Active persona for a session. Resolves to a THREE-STATE result so "off" is
    // never collapsed into "error" (review finding F1):
    //   { state: 'active', name }  -> a named persona is active
    //   { state: 'off',    name: null } -> no persona is active
    //   { state: 'error',  message }    -> the read failed; NOT the same as 'off'
    //
    // This calls GET /dsh-cast/active, a pure read. It must never POST to
    // /dsh-cast/activate: that route mutates the session (it disposes and
    // re-registers prompt sections), so using it to *read* clobbers whatever the
    // user actually chose — and silently activates a persona that was off.
    function readActive(sessionId) {
      if (!sessionId) return Promise.resolve({ state: 'error', name: null, message: 'no sessionId' });
      return api('/dsh-cast/active?sessionId=' + encodeURIComponent(sessionId))
        .then((d) => {
          const name = d && d.active;
          return typeof name === 'string' && name
            ? { state: 'active', name }
            : { state: 'off', name: null };
        })
        .catch((e) => ({ state: 'error', name: null, message: errText(e) }));
    }

    // Back-compat shim for callers that only want the name (null when off/error).
    function activeFor(sessionId) {
      return readActive(sessionId).then((r) => (r.state === 'active' ? r.name : null));
    }

    // -- shared pieces --------------------------------------------------------
    // A degraded host (failed report write) is survivable but must not be silent.
    // Renders nothing when healthy or when the host is too old to report health.
    function HealthNotice(props) {
      const health = props.health;
      if (!health || !health.reportStale) return null;
      const msg = health.lastReportError && health.lastReportError.message
        ? health.lastReportError.message
        : 'unknown error';
      return h('div', {
        style: {
          fontSize: '11px', padding: '4px 6px', margin: '0 0 6px',
          border: '1px solid var(--dsw-alias-danger, #c44)', borderRadius: '4px',
          color: 'var(--dsw-alias-danger, #c44)',
        },
      }, `dsh-cast: last report write failed (${msg}). Personas still work; the on-disk report is stale.`);
    }

    function IdentityPreview(props) {
      const name = props.name;
      const persona = props.persona;
      const error = props.error;
      if (!name) return null;
      if (error) return h('div', { style: errorStyle }, error);
      if (!persona) return h('div', { style: metaStyle }, 'Loading\u2026');
      // The identity shown is the resolved natural-language definition, not the
      // legacy numeric traits. `definition` is attached to the persona by the host
      // on /get (migrated on the fly for legacy personas).
      const definition = persona.definition ?? {};
      const identity = typeof definition.identity === 'string' && definition.identity.trim()
        ? definition.identity.trim()
        : '';
      return h('div', { style: { borderTop: '1px solid var(--dsw-alias-border, #333)', marginTop: '4px', paddingTop: '6px' } },
        h('div', { style: { fontWeight: 600 } }, persona.name),
        identity
          ? h('div', {
              style: { ...metaStyle, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '120px', overflowY: 'auto' },
            }, identity)
          : h('div', { style: metaStyle }, 'identity: (none declared)'),
      );
    }

    // Copy resolved prompt text to the clipboard. Never throws synchronously;
    // prefers the async Clipboard API and falls back to a hidden textarea when it
    // is unavailable (older browsers / non-secure contexts). Returns a Promise.
    function copyPrompt(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(text).catch(() => { throw new Error('copy was rejected'); });
        }
        if (typeof document !== 'undefined') {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
          document.body.removeChild(ta);
          if (ok) return Promise.resolve();
        }
      } catch (err) {
        return Promise.reject(new Error(`copy unavailable: ${errText(err)}`));
      }
      return Promise.reject(new Error('copy unavailable'));
    }

    // Presentational resolved-prompt view: totals, per-section content with its
    // source field(s), warnings, and a copy control. Shared by the session picker
    // inspector and the settings editor's "Preview effective prompt" action, so the
    // two can never drift apart.
    function PromptLayersView(props) {
      const data = props.data;
      const [copied, setCopied] = useState('');
      const warnings = data && Array.isArray(data.warnings) ? data.warnings : [];
      const onCopy = () => {
        if (!data) return;
        const text = (data.layers ?? []).map((l) => `### ${l.name}\n${l.text}`).join('\n\n');
        copyPrompt(text).then(
          () => setCopied('Copied.'),
          (e) => setCopied(errText(e)),
        );
      };
      if (!data) return null;
      return h('div', null,
        h('div', { style: metaStyle },
          `${data.totals.layers} layers \u00b7 ${data.totals.chars} chars \u00b7 ~${data.totals.tokens} tokens (chars/4 estimate)`),
        warnings.length
          ? h('div', { style: { margin: '4px 0' } },
              warnings.map((w, i) => h('div', {
                key: i,
                style: { fontSize: '11px', color: 'var(--dsw-alias-warning, #ca8)' },
              }, `warning: ${w.field ? `${w.field}: ` : ''}${w.message}`)),
            )
          : null,
        h('button', { type: 'button', onClick: onCopy, style: buttonStyle }, copied || 'Copy prompt'),
        (data.layers ?? []).map((layer) => {
          const dim = LAYER_BUDGETS[layer.name];
          const pct = layer.capChars
            ? Math.min(100, Math.round((layer.chars / layer.capChars) * 100))
            : null;
          const sources = Array.isArray(layer.sources) && layer.sources.length
            ? ` (from: ${layer.sources.join(', ')})`
            : '';
          return h('div', { key: layer.name, style: { marginBottom: '8px', marginTop: '8px' } },
            h('div', { style: rowStyle },
              h('span', { style: { fontWeight: 600, fontSize: '12px' } }, layer.name),
              h('span', { style: { fontSize: '11px', opacity: 0.75 } },
                `${layer.chars} chars \u00b7 ~${layer.tokens} tok`),
              layer.budgetTokens != null
                ? h('span', { style: { fontSize: '11px', opacity: 0.55 } }, `budget ${layer.budgetTokens}`)
                : null,
              layer.overBudget
                ? h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-danger, #c44)' } }, 'OVER BUDGET')
                : null,
            ),
            h('div', { style: { fontSize: '10px', opacity: 0.6 } }, `${layer.order}${sources}`),
            pct != null
              ? h('div', { style: { height: '3px', background: 'var(--dsw-alias-border, #333)', borderRadius: '2px', margin: '3px 0' } },
                  h('div', {
                    style: {
                      width: `${pct}%`, height: '3px', borderRadius: '2px',
                      background: layer.overBudget ? 'var(--dsw-alias-danger, #c44)' : 'var(--dsw-alias-accent, #6a9)',
                    },
                  }),
                )
              : null,
            h('pre', {
              style: {
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '2px 0 0',
                fontSize: '11px', opacity: 0.85, maxHeight: '140px', overflowY: 'auto',
              },
            }, layer.text),
            dim && pct != null
              ? h('div', { style: { fontSize: '10px', opacity: 0.5 } }, `budgeted as "${dim}"`)
              : null,
          );
        }),
        h('div', { style: { fontSize: '10px', opacity: 0.55 } }, (data.notes ?? []).join(' ')),
      );
    }

    // "What the model actually sees": named layers with per-layer counts.
    function PromptInspector(props) {
      const name = props.name;
      const sessionId = props.sessionId;
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);

      const load = () => {
        if (!name) return;
        setBusy(true);
        setError('');
        loadPreview(name, sessionId)
          .then((d) => setData(d))
          .catch((e) => {
            setData(null);
            setError(errText(e));
          })
          .finally(() => setBusy(false));
      };
      useEffect(load, [name, sessionId]);

      if (!name) return h('div', { style: metaStyle }, 'Activate a persona to inspect its composed prompt.');
      return h('div', { style: { borderTop: '1px solid var(--dsw-alias-border, #333)', marginTop: '6px', paddingTop: '6px' } },
        h('div', { style: rowStyle },
          h('span', { style: { fontWeight: 600 } }, 'What the model sees'),
          h('button', { type: 'button', onClick: load, disabled: busy, style: buttonStyle }, busy ? 'Loading\u2026' : 'Refresh'),
        ),
        error ? h('div', { style: errorStyle }, error) : null,
        data ? h(PromptLayersView, { data }) : null,
      );
    }

    // A/B: both personas, both responses side by side, explicit pending + error.
    function AbPanel(props) {
      const names = props.personas ?? [];
      const [a, setA] = useState('');
      const [b, setB] = useState('');
      const [prompt, setPrompt] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [result, setResult] = useState(null);

      const ready = a && b && prompt.trim() && !busy;
      const run = () => {
        if (!ready) return;
        setBusy(true);
        setError('');
        setResult(null);
        runCompare(a, b, prompt.trim())
          .then((r) => setResult(r))
          .catch((e) => setError(errText(e)))
          .finally(() => setBusy(false));
      };
      const pick = (value, set) => h('select', {
        value, onChange: (e) => set(e.target.value),
        style: { fontSize: '12px', maxWidth: '110px' },
      },
        h('option', { value: '' }, '\u2014'),
        names.map((n) => h('option', { key: n, value: n }, n)),
      );
      const side = (label, name, text) => h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontWeight: 600, fontSize: '12px' } }, `${label}: ${name || '\u2014'}`),
        h('pre', {
          style: {
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '11px', margin: '2px 0 0',
            maxHeight: '180px', overflowY: 'auto',
          },
        }, text),
      );

      return h('div', { style: { borderTop: '1px solid var(--dsw-alias-border, #333)', marginTop: '6px', paddingTop: '6px' } },
        h('div', { style: { fontWeight: 600 } }, 'A/B compare'),
        h('div', { style: { ...rowStyle, margin: '4px 0' } },
          pick(a, setA),
          h('span', { style: { opacity: 0.6 } }, 'vs'),
          pick(b, setB),
        ),
        h('input', {
          placeholder: 'prompt', value: prompt,
          onChange: (e) => setPrompt(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') run(); },
          style: { width: '100%', fontSize: '12px' },
        }),
        h('button', {
          type: 'button', onClick: run, disabled: !ready,
          style: { ...buttonStyle, marginTop: '4px' },
        }, busy ? 'Running\u2026 (this calls the model twice)' : 'Run A/B'),
        error ? h('div', { style: errorStyle }, error) : null,
        busy ? h('div', { style: metaStyle }, 'Waiting on the host \u2014 compare() streams both personas in turn.') : null,
        result
          ? h('div', { style: { ...rowStyle, marginTop: '4px' } },
              side('A', result.a, result.responseA),
              side('B', result.b, result.responseB),
            )
          : null,
      );
    }

    // PersonaSwitcher's popover body, shared with the header picker so both
    // surfaces show the same list + identity preview.
    function PersonaPickerBody(props) {
      const { personas, active, onActivate, sessionId, loading, error } = props;
      const list = personas ?? [];
      // Three distinguishable active states (F1). "off" is its own state and is
      // NEVER rendered as an error; only a failed read shows an error line.
      const readState = props.readState ?? (active ? 'active' : 'off');
      const stateLine = readState === 'active'
        ? `active: ${active}`
        : readState === 'off'
          ? 'active: off (no persona)'
          : readState === 'error'
            ? 'active: unknown \u2014 could not read'
            : 'active: reading\u2026';
      return h('div', null,
        h('button', { type: 'button', onClick: () => onActivate('off'), style: itemStyle }, 'Off'),
        list.length === 0
          ? h('div', { style: metaStyle }, loading ? 'Loading personas\u2026' : 'No personas yet.')
          : list.map((name) => h('div', { key: name, style: { marginBottom: '2px' } },
              h('button', {
                type: 'button',
                onClick: () => onActivate(name),
                style: {
                  ...itemStyle,
                  fontWeight: name === active ? 600 : 400,
                  color: name === active ? 'var(--dsw-alias-accent, #6a9)' : 'inherit',
                },
              }, name === active ? `\u2713 ${name}` : name),
            )),
        loading ? h('div', { style: metaStyle }, 'Loading personas\u2026') : null,
        error ? h('div', { style: errorStyle }, error) : null,
        h('div', {
          style: {
            fontSize: '11px', marginTop: '4px',
            opacity: readState === 'error' ? 1 : 0.6,
            color: readState === 'error' ? 'var(--dsw-alias-danger, #c44)' : 'inherit',
          },
        }, stateLine),
        // Only a genuinely ACTIVE persona has details to preview or a prompt to
        // inspect; off and error must not fall through to a stale/misleading view.
        readState === 'active' ? h(ActivePersonaDetails, { name: active, sessionId }) : null,
        readState === 'active' ? h(PromptInspector, { name: active, sessionId }) : null,
        h(AbPanel, { personas: list }),
      );
    }

    // Fetches the active persona's own record and shows identity.role + traits.
    function ActivePersonaDetails(props) {
      const { name, sessionId } = props;
      const [persona, setPersona] = useState(null);
      const [error, setError] = useState('');
      useEffect(() => {
        let cancelled = false;
        setPersona(null);
        setError('');
        if (!name) return undefined;
        loadPersonaDetail(name)
          .then((p) => { if (!cancelled) setPersona(p); })
          .catch((e) => { if (!cancelled) setError(errText(e)); });
        return () => { cancelled = true; };
      }, [name, sessionId]);
      return h(IdentityPreview, { name, persona, error });
    }

    // -- composer switcher --------------------------------------------------
    function PersonaSwitcher(props) {
      const { sessionId } = props;
      const [personas, setPersonas] = useState(null);
      const [active, setActive] = useState(null);
      const [readState, setReadState] = useState('loading'); // loading|active|off|error
      const [open, setOpen] = useState(false);
      const [error, setError] = useState('');

      useEffect(() => {
        loadPersonaList()
          .then((names) => setPersonas(names))
          .catch((e) => setError(errText(e)));
        // A pure READ of the active persona — never a mutation (F1).
        readActive(sessionId).then((r) => {
          setActive(r.state === 'active' ? r.name : null);
          setReadState(r.state);
        });
      }, [sessionId]);

      const activate = (name) => {
        api('/dsh-cast/activate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, name }),
        })
          .then((r) => {
            setActive(r.active ?? null);
            setReadState(r.active ? 'active' : 'off');
            setOpen(false);
            setError('');
          })
          .catch((e) => setError(errText(e)));
      };

      const activateError = readState === 'error' ? 'could not read active persona' : '';

      return h('div', { style: { position: 'relative', display: 'inline-block' } },
        h('button', {
          type: 'button',
          onClick: () => setOpen(!open),
          title: 'Switch persona',
          style: { fontSize: '13px' },
        }, active ? `\u{1F3AD} ${active}` : '\u{1F3AD}'),
        open ? h('div', {
          style: {
            position: 'absolute', bottom: '120%', left: 0, minWidth: '170px', padding: '4px',
            background: 'var(--dsw-alias-surface, #1c1c1c)',
            border: '1px solid var(--dsw-alias-border, #333)',
            borderRadius: '6px', zIndex: 10, display: 'flex', flexDirection: 'column', maxHeight: '260px', overflowY: 'auto',
          },
        },
        h(PersonaPickerBody, { personas, active, readState, onActivate: activate, sessionId, loading: personas === null, error: error || activateError }),
        ) : null,
      );
    }

    // -- session-header picker (conversation.session.header.actions) ----------
    function PersonaHeaderPicker(props) {
      const { sessionId } = props;
      const [personas, setPersonas] = useState(null);
      const [active, setActive] = useState(null);
      const [readState, setReadState] = useState('loading');
      const [open, setOpen] = useState(false);
      const [error, setError] = useState('');
      const [loading, setLoading] = useState(true);

      const refresh = () => {
        setLoading(true);
        loadPersonaList()
          .then((names) => setPersonas(names))
          .catch((e) => setError(errText(e)))
          .finally(() => setLoading(false));
        // A pure READ of the active persona — never a mutation (F1).
        readActive(sessionId).then((r) => {
          setActive(r.state === 'active' ? r.name : null);
          setReadState(r.state);
        });
      };
      useEffect(refresh, [sessionId]);

      const activate = (name) => {
        setOpen(false);
        setError('');
        api('/dsh-cast/activate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, name }),
        })
          .then((r) => {
            setActive(r.active ?? null);
            setReadState(r.active ? 'active' : 'off');
            setLoading(false);
          })
          .catch((e) => {
            setError(errText(e));
            setLoading(false);
          });
      };

      return h('div', { style: { position: 'relative', display: 'inline-block' } },
        h('button', {
          type: 'button',
          onClick: () => setOpen(!open),
          title: 'Persona \u2014 pick one, preview its identity, inspect what the model sees, run an A/B',
          style: { fontSize: '13px' },
        }, active ? `\u{1F3AD} ${active}` : '\u{1F3AD} Persona'),
        open ? h('div', { style: panelStyle },
          h('div', { style: { ...rowStyle, justifyContent: 'space-between', marginBottom: '4px' } },
            h('span', { style: { fontWeight: 600 } }, 'Persona'),
            h('button', { type: 'button', onClick: refresh, disabled: loading, style: buttonStyle },
              loading ? 'Loading\u2026' : 'Refresh'),
          ),
          error ? h('div', { style: errorStyle }, error) : null,
          h(PersonaPickerBody, { personas, active, readState, onActivate: activate, sessionId, loading, error: '' }),
        ) : null,
      );
    }

    function api(path, options) {
      return fetch('api' + path, options).then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
        return data;
      });
    }

    // Confirm before discarding unsaved edits. Uses window.confirm when available;
    // a shim/test environment without it is treated as "allow" so the panel stays
    // testable, but the real browser always prompts.
    function confirmDiscard(msg) {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') return window.confirm(msg);
      return true;
    }

    // -- settings panel ------------------------------------------------------
    function PersonaPanel() {
      const [personas, setPersonas] = useState([]);
      const [error, setError] = useState('');
      const [name, setName] = useState('');
      const [busy, setBusy] = useState(false);
      const [selected, setSelected] = useState(null);
      const [draft, setDraft] = useState(emptyDefinition());
      const [savedDraft, setSavedDraft] = useState(emptyDefinition());
      const [health, setHealth] = useState(null);
      const [saveMsg, setSaveMsg] = useState('');
      const [previewOpen, setPreviewOpen] = useState(false);
      const [previewData, setPreviewData] = useState(null);
      const [previewError, setPreviewError] = useState('');
      const [previewBusy, setPreviewBusy] = useState(false);
      const [tryPrompt, setTryPrompt] = useState('');
      const [tryBusy, setTryBusy] = useState(false);
      const [tryError, setTryError] = useState('');
      const [tryResult, setTryResult] = useState(null);

      // Unsaved-change detection is derived from the draft vs the last saved draft,
      // so it can never drift out of sync with the actual editor state.
      const dirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);

      const refresh = () => {
        api('/dsh-cast/list')
          .then((d) => setPersonas(d.personas ?? []))
          .catch((e) => setError(errText(e)));
        // Reported separately so a health-read failure can never blank the persona
        // list, and a list failure can never hide a degraded host.
        loadHealth().then(setHealth);
      };
      useEffect(refresh, []);

      const create = () => {
        if (!name.trim()) return;
        setBusy(true);
        api('/dsh-cast/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: name.trim() }),
        })
          .then(() => {
            setName('');
            setError('');
            refresh();
          })
          .catch((e) => setError(errText(e)))
          .finally(() => setBusy(false));
      };

      const remove = (n) => {
        if (selected === n && dirty && !confirmDiscard('Discard unsaved edits and delete this persona?')) return;
        api('/dsh-cast/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: n }),
        })
          .then(() => {
            if (selected === n) {
              setSelected(null);
              setDraft(emptyDefinition());
              setSavedDraft(emptyDefinition());
              setSaveMsg('');
            }
            refresh();
          })
          .catch((e) => setError(errText(e)));
      };

      const select = (n) => {
        if (n === selected) return;
        if (dirty && !confirmDiscard('Discard unsaved edits and switch persona?')) return;
        api('/dsh-cast/get?name=' + encodeURIComponent(n))
          .then((d) => {
            const persona = d.persona ?? null;
            const def = persona && persona.definition ? cloneDraft(persona.definition) : emptyDefinition();
            setSelected(n);
            setDraft(def);
            setSavedDraft(def);
            setSaveMsg('');
            setPreviewOpen(false);
            setPreviewData(null);
            setError('');
          })
          .catch((e) => setError(errText(e)));
      };

      const setField = (key, value) => setDraft({ ...draft, [key]: value });
      const addExample = () => setDraft({ ...draft, examples: [...(draft.examples ?? []), { user: '', assistant: '' }] });
      const removeExample = (i) => setDraft({ ...draft, examples: (draft.examples ?? []).filter((_, j) => j !== i) });
      const setExample = (i, key, value) => setDraft({
        ...draft,
        examples: (draft.examples ?? []).map((p, j) => (j === i ? { ...p, [key]: value } : p)),
      });

      const save = () => {
        if (!selected) return;
        setBusy(true);
        setSaveMsg('');
        api('/dsh-cast/edit', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: selected, patch: { definition: draft } }),
        })
          .then(() => {
            setSavedDraft(cloneDraft(draft));
            setSaveMsg('Saved.');
            setError('');
            refresh();
          })
          .catch((e) => setSaveMsg(`Save failed: ${errText(e)}`))
          .finally(() => setBusy(false));
      };

      const preview = () => {
        if (!selected) return;
        setPreviewBusy(true);
        setPreviewError('');
        setPreviewOpen(true);
        loadPreview(selected)
          .then((d) => setPreviewData(d))
          .catch((e) => {
            setPreviewData(null);
            setPreviewError(errText(e));
          })
          .finally(() => setPreviewBusy(false));
      };

      const tryRun = () => {
        if (!selected || !tryPrompt.trim() || tryBusy) return;
        setTryBusy(true);
        setTryError('');
        setTryResult(null);
        runTry(selected, tryPrompt.trim())
          .then((r) => setTryResult(r))
          .catch((e) => setTryError(errText(e)))
          .finally(() => setTryBusy(false));
      };

      const fieldEditor = (key) => {
        const meta = DEFINITION_FIELD_META[key];
        return h('div', { key: key, style: { marginBottom: '10px' } },
          h('label', { style: { display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '2px' } }, meta.label),
          h('div', { style: { fontSize: '11px', opacity: 0.6, marginBottom: '4px' } }, meta.hint),
          h('textarea', {
            name: key,
            value: draft[key] ?? '',
            onChange: (e) => setField(key, e.target.value),
            maxLength: 8000,
            rows: 4,
            style: { width: '100%', fontSize: '12px', fontFamily: 'inherit', resize: 'vertical' },
          }),
        );
      };

      return h('div', { style: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' } },
        h(HealthNotice, { health }),
        h('div', null,
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '8px' } }, 'Create persona'),
          h('input', { placeholder: 'name', value: name, onChange: (e) => setName(e.target.value), style: { marginRight: '8px' } }),
          h('button', { onClick: create, disabled: busy || !name.trim() }, busy ? 'Creating\u2026' : 'Create'),
        ),
        h('div', null,
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '8px' } }, 'Personas'),
          personas.length === 0
            ? h('div', null, 'No personas yet.')
            : personas.map((n) => h('div', {
                key: n,
                style: {
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border, #333)',
                },
              },
              h('button', {
                onClick: () => select(n),
                style: {
                  background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0,
                  fontSize: '13px', fontWeight: n === selected ? 600 : 400,
                },
              }, n === selected ? `\u25B8 ${n}` : n),
              h('button', { onClick: () => remove(n) }, 'Delete'),
            )),
        ),
        selected ? h('div', { style: { border: '1px solid var(--dsw-alias-border, #333)', borderRadius: '6px', padding: '10px' } },
          h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '8px' } }, `Persona \u2014 ${selected}`),
          h('details', { open: true },
            h('summary', { style: { cursor: 'pointer', fontSize: '12px' } }, DEFINITION_FIELD_META.identity.label),
            fieldEditor('identity'),
          ),
          h('details', null,
            h('summary', { style: { cursor: 'pointer', fontSize: '12px' } }, DEFINITION_FIELD_META.expertise.label),
            fieldEditor('expertise'),
          ),
          h('details', null,
            h('summary', { style: { cursor: 'pointer', fontSize: '12px' } }, DEFINITION_FIELD_META.behavior.label),
            fieldEditor('behavior'),
          ),
          h('details', null,
            h('summary', { style: { cursor: 'pointer', fontSize: '12px' } }, DEFINITION_FIELD_META.communication.label),
            fieldEditor('communication'),
          ),
          h('details', null,
            h('summary', { style: { cursor: 'pointer', fontSize: '12px' } }, DEFINITION_FIELD_META.rules.label),
            fieldEditor('rules'),
          ),
          h('details', null,
            h('summary', { style: { cursor: 'pointer', fontSize: '12px' } }, 'Example responses'),
            h('div', { style: { fontSize: '11px', opacity: 0.6, margin: '4px 0' } }, 'Representative user/assistant exchanges that demonstrate the desired behavior.'),
            (draft.examples ?? []).map((pair, i) => h('div', {
              key: i,
              style: { border: '1px solid var(--dsw-alias-border, #333)', borderRadius: '4px', padding: '6px', marginBottom: '6px' },
            },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' } },
                h('span', { style: { fontSize: '11px', opacity: 0.7 } }, `Example ${i + 1}`),
                h('button', { type: 'button', onClick: () => removeExample(i), style: buttonStyle }, 'Remove'),
              ),
              h('label', { style: { display: 'block', fontSize: '11px' } }, 'User'),
              h('textarea', {
                name: `user-${i}`,
                value: pair.user ?? '',
                onChange: (e) => setExample(i, 'user', e.target.value),
                maxLength: 4000,
                rows: 2,
                style: { width: '100%', fontSize: '12px', fontFamily: 'inherit', resize: 'vertical', marginBottom: '4px' },
              }),
              h('label', { style: { display: 'block', fontSize: '11px' } }, 'Assistant'),
              h('textarea', {
                name: `assistant-${i}`,
                value: pair.assistant ?? '',
                onChange: (e) => setExample(i, 'assistant', e.target.value),
                maxLength: 4000,
                rows: 2,
                style: { width: '100%', fontSize: '12px', fontFamily: 'inherit', resize: 'vertical' },
              }),
            )),
            h('button', { type: 'button', onClick: addExample, style: buttonStyle }, 'Add example'),
          ),
          h('div', { style: { ...rowStyle, marginTop: '10px' } },
            h('button', { onClick: save, disabled: busy || !dirty }, busy ? 'Saving\u2026' : 'Save persona'),
            h('button', { onClick: preview, disabled: previewBusy }, previewBusy ? 'Loading\u2026' : 'Preview effective prompt'),
            dirty ? h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-warning, #ca8)' } }, 'Unsaved changes') : null,
          ),
          saveMsg ? h('div', {
            style: {
              fontSize: '12px', marginTop: '6px',
              color: /failed/i.test(saveMsg) ? 'var(--dsw-alias-danger, #c44)' : 'var(--dsw-alias-accent, #6a9)',
            },
          }, saveMsg) : null,
          previewOpen
            ? h('div', { style: { borderTop: '1px solid var(--dsw-alias-border, #333)', marginTop: '10px', paddingTop: '8px' } },
                h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } }, 'Effective prompt'),
                previewError ? h('div', { style: errorStyle }, previewError) : null,
                previewData ? h(PromptLayersView, { data: previewData }) : null,
              )
            : null,
          h('div', { style: { borderTop: '1px solid var(--dsw-alias-border, #333)', marginTop: '10px', paddingTop: '8px' } },
            h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '4px' } }, 'Try persona'),
            h('div', { style: { fontSize: '11px', opacity: 0.6, marginBottom: '4px' } },
              'Run a sample message through this persona without changing your active session or writing memory.'),
            h('div', { style: rowStyle },
              h('input', {
                placeholder: 'sample message', value: tryPrompt,
                onChange: (e) => setTryPrompt(e.target.value),
                style: { flex: 1, fontSize: '12px' },
              }),
              h('button', {
                type: 'button', onClick: tryRun, disabled: tryBusy || !tryPrompt.trim(), style: buttonStyle,
              }, tryBusy ? 'Running\u2026' : 'Try'),
            ),
            tryError ? h('div', { style: errorStyle }, tryError) : null,
            tryResult
              ? h('div', { style: { marginTop: '6px' } },
                  h('div', { style: { fontSize: '11px', opacity: 0.6 } },
                    `Isolated test with "${tryResult.name}" \u2014 this is a test response, not your conversation.`),
                  h('pre', {
                    style: {
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '12px',
                      maxHeight: '160px', overflowY: 'auto', margin: '4px 0 0',
                    },
                  }, tryResult.response),
                )
              : null,
          ),
        ) : null,
        error ? h('div', { style: { color: 'var(--dsw-alias-danger, #c44)', fontSize: '12px' } }, error) : null,
        h('div', { style: { fontSize: '12px', opacity: 0.65 } }, 'Activate a persona from the composer (\u{1F3AD}) or with /persona use <name>.'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-cast-personas',
          order: 50,
          label: 'Personas',
        }, PersonaPanel));
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-cast-switcher',
          order: 0,
          label: 'Persona',
        }, PersonaSwitcher));
        // Phase 6 (A1): the same picker + identity preview in the Session header.
        // `sessionId` arrives as a standard prop on this session-scope slot
        // (contract note §7); no `locale` is passed because dsh-cast ships no
        // dictionary (§6). Activating reuses POST /api/dsh-cast/activate.
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'dsh-cast-persona-picker',
          order: 15,
          label: 'Persona',
        }, PersonaHeaderPicker));
      },
    };
  },
});
