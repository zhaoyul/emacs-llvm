#!/usr/bin/env node
// Fetch SHA-256-pinned Maven artifacts from scripts/package-runtime/jvm.lock.json.
// Only https Maven Central / Clojars URLs are accepted (or file:// with
// --allow-local-repo for tests). Every jar is verified before it is moved
// into place; an existing cached jar is re-verified, never trusted by name.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ALLOWED_HOSTS = new Set(['repo1.maven.org', 'repo.clojars.org']);
function arg(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback; }
function fail(msg, code = 1) { process.stderr.write(`ERROR: ${msg}\n`); process.exit(code); }
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const safe = (s, what) => { if (typeof s !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(s)) throw new Error(`Unsafe ${what}: ${s}`); return s; };

function validateUrl(url, allowLocal) {
  if (allowLocal && url.startsWith('file://')) return;
  let u; try { u = new URL(url); } catch { throw new Error(`Invalid artifact URL: ${url}`); }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new Error(`Artifact URL must be https Maven Central or Clojars: ${url}`);
}

async function download(url) {
  if (url.startsWith('file://')) return fs.readFileSync(new URL(url));
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

try {
  const lockPath = path.resolve(arg('--lock') ?? path.join(process.cwd(), 'scripts/package-runtime/jvm.lock.json'));
  const dest = path.resolve(arg('--dest') ?? path.join(process.cwd(), '.runtime', 'jvm'));
  const allowLocal = process.argv.includes('--allow-local-repo');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (lock.schema_version !== '1.0' || !Array.isArray(lock.artifacts) || lock.artifacts.length === 0) throw new Error('Invalid JVM lock.');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const classpath = [];
  let fetched = 0;
  for (const a of lock.artifacts) {
    const name = `${safe(a.group, 'group')}__${safe(a.artifact, 'artifact')}-${safe(a.version, 'version')}.jar`;
    if (!/^[0-9a-f]{64}$/.test(a.sha256 ?? '')) throw new Error(`Invalid sha256 for ${name}`);
    validateUrl(a.url, allowLocal);
    const file = path.join(dest, name);
    if (fs.existsSync(file)) {
      const st = fs.lstatSync(file);
      if (!st.isFile()) throw new Error(`Cached artifact is not a regular file: ${file}`);
      if (sha256(fs.readFileSync(file)) !== a.sha256) throw new Error(`Cached artifact hash mismatch: ${file}`);
    } else {
      const body = await download(a.url);
      const got = sha256(body);
      if (got !== a.sha256) throw new Error(`SHA-256 mismatch for ${a.url}: expected ${a.sha256}, got ${got}`);
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, file);
      fetched += 1;
    }
    classpath.push(file);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, dest, fetched, artifacts: classpath.length, classpath: classpath.join(path.delimiter), main: lock.main ?? null, nrepl_middleware: lock.nrepl_middleware ?? null }, null, 2)}\n`);
} catch (e) { fail(e instanceof Error ? e.message : String(e)); }
