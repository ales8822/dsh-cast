#!/usr/bin/env node
// canonicalize-personas.mjs — upgrade persona files to the canonical v2 shape,
// PROMPT-PRESERVINGLY.
//
// A legacy persona file (no `definition` key) is migrated in memory by the plugin
// on every read. "Canonical" means persisting that migration, so the file carries
// the six definition fields plus `schemaVersion: 2` and no longer depends on the
// runtime migration path.
//
// The conversion is deliberately NON-DESTRUCTIVE and PROMPT-PRESERVING:
//   * every existing key is left byte-identical (the legacy fields are still read
//     by trait routing, `mix`, `tune`, and the markdown / character-card exports),
//   * the added `definition` is exactly what the plugin's own resolver produces
//     right now — nothing is paraphrased or "improved",
//   * the composed prompt is compared before and after, and the tool REFUSES to
//     write a file whose prompt would change.
//
// Usage:
//   node tools/canonicalize-personas.mjs                 # dry run on ./personas
//   node tools/canonicalize-personas.mjs --dir <path>
//   node tools/canonicalize-personas.mjs --dir <path> --write
//   node tools/canonicalize-personas.mjs --dir <path> --write --backup <dir>
//
// Exit codes: 0 = all files canonical or convertible; 1 = at least one file was
// skipped (unparseable / would change the prompt).
import { readdir, readFile, writeFile, mkdir, cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { dir: path.join(pluginDir, 'personas'), write: false, backup: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') out.dir = path.resolve(argv[++i]);
    else if (a === '--write') out.write = true;
    else if (a === '--backup') out.backup = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!out.backup) {
    out.backup = path.resolve(pluginDir, '..', 'dsh-cast-backups');
  }
  return out;
}

// A service instance whose personasDir is a throwaway temp dir: we only need its
// pure resolver (resolvePrompt / composePersonaSystem). It must never write into
// the directory we are canonicalizing.
function makeMockCtx() {
  const reg = { provided: {} };
  return {
    reg,
    ctx: {
      effect(fn) { const d = fn(); return () => (typeof d === 'function' ? d() : undefined); },
      on() { return () => {}; },
      provide(name, value) { reg.provided[name] = value; return () => {}; },
      get(name) { return reg.provided[name]; },
      commands: { register() { return () => {}; } },
      tools: { register() { return () => {}; } },
      agents: { get() { return undefined; }, currentInitiator() { return undefined; } },
      connection: { fetch: { register() { return async () => {}; } } },
      systemPrompt: { section() { return () => {}; }, getSectionOrder() { return 0; } },
      sessions: { get() { return { deriveMessages() { return []; } }; } },
      llm: {
        listProviders() { return [{ id: 'mock' }]; },
        async listModels() { return [{ id: 'mock-model' }]; },
        async *stream() { yield { type: 'text-delta', text: 'MOCK' }; },
      },
    },
  };
}

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node tools/canonicalize-personas.mjs [--dir <dir>] [--write] [--backup <dir>]');
    return 0;
  }

  const { ctx, reg } = makeMockCtx();
  // A throwaway personasDir: the service's own side files (report/state) must land
  // in temp, never in the directory being canonicalized.
  apply(ctx, { personasDir: await mkdtemp(path.join(tmpdir(), 'dsh-cast-canon-')), autoActivate: '' });
  const service = reg.provided.personas;
  if (!service) throw new Error('the plugin did not provide ctx.personas');

  const files = (await readdir(args.dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  const results = [];
  const planned = [];

  for (const file of files.sort()) {
    const full = path.join(args.dir, file);
    let raw;
    try {
      raw = JSON.parse(await readFile(full, 'utf8'));
    } catch (err) {
      results.push({ file, status: 'SKIP (unparseable)', detail: err.message });
      continue;
    }
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      results.push({ file, status: 'SKIP (not an object)', detail: '' });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'definition')) {
      results.push({
        file,
        status: 'already canonical',
        detail: `schemaVersion=${raw.schemaVersion ?? '(none)'}, name=${raw.name ?? '(none)'}`,
      });
      continue;
    }

    const before = service.composePersonaSystem(raw);
    const resolved = service.resolvePrompt(raw);
    if (!resolved.valid) {
      results.push({ file, status: 'SKIP (migrated definition is invalid)', detail: JSON.stringify(resolved.warnings) });
      continue;
    }
    const canonical = { ...raw, schemaVersion: 2, definition: resolved.definition };
    const after = service.composePersonaSystem(canonical);
    if (after !== before) {
      results.push({ file, status: 'SKIP (prompt would change)', detail: `${before.length} -> ${after.length} chars` });
      continue;
    }
    // name/filename agreement: the store keys by `name`, so a mismatch leaves a ghost.
    const expectedFile = `${raw.name}.json`;
    if (file !== expectedFile) {
      results.push({ file, status: 'SKIP (name does not match filename)', detail: `name="${raw.name}" expects ${expectedFile}` });
      continue;
    }
    planned.push({ file, full, canonical });
    results.push({
      file,
      status: 'convertible',
      detail: `prompt unchanged (${before.length} chars), ${resolved.definition.identity ? 'identity + ' : ''}${resolved.definition.examples.length} example(s)`,
    });
  }

  for (const r of results) console.log(`${r.status.padEnd(42)} ${r.file}${r.detail ? `  —  ${r.detail}` : ''}`);

  if (!args.write) {
    console.log(`\nDRY RUN — ${planned.length} file(s) would be canonicalized. Re-run with --write.`);
    return results.some((r) => r.status.startsWith('SKIP')) ? 1 : 0;
  }

  if (planned.length) {
    const backupDir = path.join(args.backup, `pre-canonical-${stamp()}`);
    await mkdir(backupDir, { recursive: true });
    for (const p of planned) await cp(p.full, path.join(backupDir, p.file));
    console.log(`\nbackup: ${backupDir}`);
    for (const p of planned) {
      await writeFile(p.full, `${JSON.stringify(p.canonical, null, 2)}\n`, 'utf8');
      console.log(`wrote:  ${p.full}`);
    }
  }

  return results.some((r) => r.status.startsWith('SKIP')) ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err);
  process.exit(1);
});
