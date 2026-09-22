import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fetch-maven-artifacts.mjs');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function fixture(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eo-maven-test-'));
  const jar = path.join(dir, 'demo-1.0.0.jar');
  const body = Buffer.from('PK\u0003\u0004 demo jar');
  fs.writeFileSync(jar, body);
  const artifact = { group: 'org.example', artifact: 'demo', version: '1.0.0', url: pathToFileURL(jar).href, sha256: sha(body), ...overrides };
  const lock = path.join(dir, 'jvm.lock.json');
  fs.writeFileSync(lock, JSON.stringify({ schema_version: '1.0', main: 'clojure.main', artifacts: [artifact] }));
  return { dir, lock, dest: path.join(dir, 'out') };
}
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('fetches, verifies, and reuses a verified cache', () => {
  const f = fixture();
  const first = run(['--lock', f.lock, '--dest', f.dest, '--allow-local-repo']);
  assert.equal(first.status, 0, first.stderr);
  const out = JSON.parse(first.stdout);
  assert.equal(out.fetched, 1);
  assert.ok(out.classpath.endsWith('org.example__demo-1.0.0.jar'));
  const second = JSON.parse(run(['--lock', f.lock, '--dest', f.dest, '--allow-local-repo']).stdout);
  assert.equal(second.fetched, 0);
});

test('rejects a SHA-256 mismatch without leaving a file behind', () => {
  const f = fixture({ sha256: '0'.repeat(64) });
  const r = run(['--lock', f.lock, '--dest', f.dest, '--allow-local-repo']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SHA-256 mismatch/);
  assert.deepEqual(fs.existsSync(f.dest) ? fs.readdirSync(f.dest) : [], []);
});

test('rejects a tampered cached artifact', () => {
  const f = fixture();
  assert.equal(run(['--lock', f.lock, '--dest', f.dest, '--allow-local-repo']).status, 0);
  fs.appendFileSync(path.join(f.dest, 'org.example__demo-1.0.0.jar'), 'tamper');
  const r = run(['--lock', f.lock, '--dest', f.dest, '--allow-local-repo']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Cached artifact hash mismatch/);
});

test('rejects non-Maven hosts and local URLs without the explicit flag', () => {
  const evil = fixture({ url: 'https://example.com/demo-1.0.0.jar' });
  assert.match(run(['--lock', evil.lock, '--dest', evil.dest]).stderr, /Maven Central or Clojars/);
  const local = fixture();
  assert.match(run(['--lock', local.lock, '--dest', local.dest]).stderr, /Maven Central or Clojars/);
});

test('rejects unsafe coordinates', () => {
  const f = fixture({ artifact: '../escape' });
  assert.match(run(['--lock', f.lock, '--dest', f.dest, '--allow-local-repo']).stderr, /Unsafe artifact/);
});
