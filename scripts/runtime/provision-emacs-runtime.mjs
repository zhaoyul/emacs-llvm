#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(message, code = 1) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
}
function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout ?? '';
}
function argValue(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function hasArg(name) { return process.argv.includes(name); }
function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._+-]{1,120}$/.test(value)) throw new Error(`Unsafe runtime id: ${value}`);
  return value;
}
function parseControl(file) {
  const text = run('dpkg-deb', ['-f', file, 'Package', 'Version', 'Architecture']);
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 3) throw new Error(`Unable to read Debian package metadata: ${file}`);
  return { package: lines[0], version: lines[1], architecture: lines[2] };
}
function validateLock(lock) {
  if (!lock || lock.schema_version !== '1.0') throw new Error('Lock schema_version must be 1.0.');
  safeId(lock.id);
  if (!Array.isArray(lock.packages) || lock.packages.length === 0) throw new Error('Lock packages must be non-empty.');
  const seen = new Set();
  for (const pkg of lock.packages) {
    for (const field of ['package', 'version', 'architecture', 'filename', 'sha256']) {
      if (typeof pkg[field] !== 'string' || pkg[field].length === 0) throw new Error(`Package lock field ${field} is required.`);
    }
    if (!/^[a-f0-9]{64}$/.test(pkg.sha256)) throw new Error(`Invalid SHA-256 for ${pkg.filename}.`);
    if (pkg.filename !== path.basename(pkg.filename) || pkg.filename.includes('..')) throw new Error(`Unsafe package filename: ${pkg.filename}`);
    if (seen.has(pkg.package)) throw new Error(`Duplicate package in lock: ${pkg.package}`);
    seen.add(pkg.package);
  }
  return lock;
}
function discoverEmacsBinary(root, candidates = []) {
  const preferred = [
    ...candidates,
    'usr/bin/emacs-gtk', 'usr/bin/emacs-pgtk', 'usr/bin/emacs-lucid', 'usr/bin/emacs-nox', 'usr/bin/emacs'
  ];
  for (const rel of preferred) {
    if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.includes('..')) continue;
    const file = path.join(root, rel);
    try { if (fs.statSync(file).isFile() && (fs.statSync(file).mode & 0o111)) return { file, rel }; } catch {}
  }
  throw new Error('No executable Emacs binary found in extracted runtime.');
}
function discoverVersionDir(root) {
  const base = path.join(root, 'usr', 'share', 'emacs');
  try {
    const dirs = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory() && /^\d+(?:\.\d+)+$/.test(d.name)).map(d => d.name);
    dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return dirs[0] ?? null;
  } catch { return null; }
}
function writeWrapper(dest, root, binary, versionDir) {
  const binDir = path.join(dest, 'bin');
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const wrapper = path.join(binDir, 'emacs');
  const lines = [
    '#!/usr/bin/env bash', 'set -euo pipefail',
    'HERE="$(cd "$(dirname "$0")/.." && pwd -P)"',
    'ROOT="$HERE/root"'
  ];
  if (versionDir) {
    lines.push(`export EMACSDATA="$ROOT/usr/share/emacs/${versionDir}/etc"`);
    lines.push(`export EMACSDOC="$ROOT/usr/share/emacs/${versionDir}/etc"`);
    lines.push(`export EMACSLOADPATH="$ROOT/usr/share/emacs/${versionDir}/lisp:$ROOT/usr/share/emacs/site-lisp:"`);
  }
  lines.push(`exec "$ROOT/${binary.rel}" "$@"`);
  fs.writeFileSync(wrapper, `${lines.join('\n')}\n`, { mode: 0o755 });
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}
function lockFromDir(sourceDir, outPath, id) {
  const files = fs.readdirSync(sourceDir).filter(f => f.endsWith('.deb')).sort();
  if (!files.length) throw new Error(`No .deb files found in ${sourceDir}`);
  const packages = files.map(filename => {
    const full = path.join(sourceDir, filename);
    const meta = parseControl(full);
    return { ...meta, filename, sha256: sha256File(full) };
  });
  const lock = { schema_version: '1.0', id: safeId(id), platform: 'linux', packages, binary_candidates: [] };
  fs.writeFileSync(outPath, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  return lock;
}
function provision(lockPath, sourceDir, destBase, activate) {
  const lock = validateLock(JSON.parse(fs.readFileSync(lockPath, 'utf8')));
  const finalDir = path.resolve(destBase, lock.id);
  const stage = fs.mkdtempSync(path.join(path.resolve(destBase), `.${lock.id}.stage-`));
  fs.chmodSync(stage, 0o700);
  const root = path.join(stage, 'root');
  fs.mkdirSync(root, { mode: 0o755 });
  const provenance = [];
  try {
    for (const spec of lock.packages) {
      const file = path.resolve(sourceDir, spec.filename);
      if (path.dirname(file) !== path.resolve(sourceDir)) throw new Error(`Package escaped source directory: ${spec.filename}`);
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Package is not a regular file: ${spec.filename}`);
      const digest = sha256File(file);
      if (digest !== spec.sha256) throw new Error(`SHA-256 mismatch for ${spec.filename}: ${digest}`);
      const meta = parseControl(file);
      for (const key of ['package', 'version', 'architecture']) {
        if (meta[key] !== spec[key]) throw new Error(`${spec.filename} ${key} mismatch: ${meta[key]} != ${spec[key]}`);
      }
      run('dpkg-deb', ['-x', file, root]);
      provenance.push({ ...spec, bytes: st.size });
    }
    const binary = discoverEmacsBinary(root, lock.binary_candidates ?? []);
    const versionDir = discoverVersionDir(root);
    const wrapper = writeWrapper(stage, root, binary, versionDir);
    const probe = spawnSync(wrapper, ['-Q', '--batch', '--eval', '(princ emacs-major-version)'], { encoding: 'utf8', timeout: 15000 });
    if (probe.status !== 0 || !/^\d+$/.test((probe.stdout ?? '').trim())) {
      throw new Error(`Provisioned Emacs did not pass batch probe: status=${probe.status}, stderr=${(probe.stderr ?? '').trim()}`);
    }
    const major = Number(probe.stdout.trim());
    if (major < 29) throw new Error(`Provisioned Emacs is too old: ${major}`);
    const manifest = {
      schema_version: '1.0', runtime_id: lock.id, created_at: new Date().toISOString(),
      emacs_major: major, binary: binary.rel, version_dir: versionDir, packages: provenance
    };
    fs.writeFileSync(path.join(stage, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    if (fs.existsSync(finalDir)) throw new Error(`Runtime destination already exists: ${finalDir}`);
    fs.renameSync(stage, finalDir);
    if (activate) {
      const current = path.resolve(destBase, 'current');
      const tmpLink = path.resolve(destBase, `.current-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      const relative = path.relative(path.dirname(tmpLink), finalDir);
      fs.symlinkSync(relative, tmpLink, 'dir');
      fs.renameSync(tmpLink, current);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, runtime: finalDir, emacs: path.join(finalDir, 'bin', 'emacs'), emacs_major: major }, null, 2)}\n`);
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}

try {
  const command = process.argv[2];
  if (command === 'lock') {
    const source = path.resolve(argValue('--source-dir') ?? fail('--source-dir is required', 64));
    const out = path.resolve(argValue('--out') ?? fail('--out is required', 64));
    const id = argValue('--id', `emacs-runtime-${process.platform}-${process.arch}`);
    const lock = lockFromDir(source, out, id);
    process.stdout.write(`${JSON.stringify({ ok: true, lock: out, packages: lock.packages.length }, null, 2)}\n`);
  } else if (command === 'provision') {
    const lock = path.resolve(argValue('--lock') ?? fail('--lock is required', 64));
    const source = path.resolve(argValue('--source-dir') ?? fail('--source-dir is required', 64));
    const dest = path.resolve(argValue('--dest', path.join(process.cwd(), '.runtime', 'emacs')));
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    provision(lock, source, dest, hasArg('--activate'));
  } else {
    fail('Usage: provision-emacs-runtime.mjs lock|provision ...', 64);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}