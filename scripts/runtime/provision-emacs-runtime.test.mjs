import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const script = path.join(root, 'scripts', 'runtime', 'provision-emacs-runtime.mjs');

function run(args, cwd = root) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function buildFakeDeb(base, { packageName='emacs-gtk', version='1:30.1+fixture-1', arch='amd64' } = {}) {
  const pkgDir = path.join(base, 'pkg');
  fs.mkdirSync(path.join(pkgDir, 'DEBIAN'), { recursive: true });
  fs.mkdirSync(path.join(pkgDir, 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'DEBIAN', 'control'), `Package: ${packageName}\nVersion: ${version}\nArchitecture: ${arch}\nMaintainer: Test <test@example.invalid>\nDescription: fixture\n`);
  const binary = path.join(pkgDir, 'usr', 'bin', 'emacs-gtk');
  fs.writeFileSync(binary, `#!/usr/bin/env bash\nif [[ "${'$'}*" == *"emacs-major-version"* ]]; then printf '30'; exit 0; fi\nprintf 'fixture emacs\\n'\n`, { mode: 0o755 });
  fs.chmodSync(binary, 0o755);
  const deb = path.join(base, `${packageName}_${version.replaceAll(':','%3a')}_${arch}.deb`);
  const built = spawnSync('dpkg-deb', ['--build', pkgDir, deb], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  return deb;
}

test('locks local .debs and provisions an activated private runtime', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emacs-operator-runtime-test-'));
  try {
    const source = path.join(tmp, 'source'); fs.mkdirSync(source);
    buildFakeDeb(source);
    const lock = path.join(tmp, 'runtime.lock.json');
    const locked = run(['lock', '--source-dir', source, '--out', lock, '--id', 'fixture-emacs-30']);
    assert.equal(locked.status, 0, locked.stderr);
    const lockObj = JSON.parse(fs.readFileSync(lock, 'utf8'));
    assert.equal(lockObj.packages.length, 1);
    assert.match(lockObj.packages[0].sha256, /^[a-f0-9]{64}$/);
    const dest = path.join(tmp, 'runtimes');
    const installed = run(['provision', '--lock', lock, '--source-dir', source, '--dest', dest, '--activate']);
    assert.equal(installed.status, 0, installed.stderr);
    const wrapper = path.join(dest, 'current', 'bin', 'emacs');
    assert.equal(fs.existsSync(wrapper), true);
    const probe = spawnSync(wrapper, ['-Q', '--batch', '--eval', '(princ emacs-major-version)'], { encoding: 'utf8' });
    assert.equal(probe.status, 0);
    assert.equal(probe.stdout, '30');
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'current', 'runtime-manifest.json'), 'utf8'));
    assert.equal(manifest.emacs_major, 30);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('rejects tampered deb after lock creation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emacs-operator-runtime-test-'));
  try {
    const source = path.join(tmp, 'source'); fs.mkdirSync(source);
    const deb = buildFakeDeb(source);
    const lock = path.join(tmp, 'runtime.lock.json');
    assert.equal(run(['lock', '--source-dir', source, '--out', lock, '--id', 'fixture-tamper']).status, 0);
    fs.appendFileSync(deb, 'tamper');
    const result = run(['provision', '--lock', lock, '--source-dir', source, '--dest', path.join(tmp, 'runtimes')]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SHA-256 mismatch/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('rejects a lock with unsafe package filename', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emacs-operator-runtime-test-'));
  try {
    const lock = path.join(tmp, 'bad.json');
    fs.writeFileSync(lock, JSON.stringify({ schema_version:'1.0', id:'bad', packages:[{ package:'emacs-gtk', version:'1', architecture:'amd64', filename:'../evil.deb', sha256:'0'.repeat(64) }] }));
    const result = run(['provision', '--lock', lock, '--source-dir', tmp, '--dest', path.join(tmp, 'runtimes')]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsafe package filename/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
