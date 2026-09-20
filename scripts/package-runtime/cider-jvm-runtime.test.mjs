import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..','..');
const prepare=path.join(root,'scripts/package-runtime/prepare-cider-jvm-runtime.mjs');
const start=path.join(root,'scripts/package-runtime/start-cider-nrepl.mjs');
function run(script,args){ return spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8'}); }
function fixture(){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'emacs-operator-cider-jvm-test-')); const artifacts=path.join(tmp,'artifacts'); fs.mkdirSync(artifacts);
  for(const name of ['clojure-1.12.0.jar','nrepl-1.7.0.jar','cider-nrepl-0.62.2.jar','orchard-0.44.0.jar']) fs.writeFileSync(path.join(artifacts,name),`fixture:${name}\n`);
  const lock={schema_version:'1.1',sources:{cider:{runtime_dependencies:{clojure:'1.12.0',nrepl:'1.7.0','cider-nrepl':'0.62.2'}}}}; const lockPath=path.join(tmp,'lock.json'); fs.writeFileSync(lockPath,JSON.stringify(lock));
  return {tmp,artifacts,lockPath};
}

test('prepares a hashed offline CIDER JVM classpath',()=>{ const f=fixture(); try{ const out=path.join(f.tmp,'runtime'); const r=run(prepare,['--lock',f.lockPath,'--artifact-dir',f.artifacts,'--out',out]); assert.equal(r.status,0,r.stderr); const result=JSON.parse(r.stdout); assert.equal(result.jars,4); const manifest=JSON.parse(fs.readFileSync(result.manifest,'utf8')); assert.equal(manifest.versions['cider-nrepl'],'0.62.2'); assert.equal(manifest.jars.length,4); assert.ok(manifest.jars.every(j=>/^[a-f0-9]{64}$/.test(j.sha256))); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });

test('dry-run verifies every JAR and emits a shell-free loopback command',()=>{ const f=fixture(); try{ const out=path.join(f.tmp,'runtime'); const p=run(prepare,['--lock',f.lockPath,'--artifact-dir',f.artifacts,'--out',out]); assert.equal(p.status,0,p.stderr); const r=run(start,['--runtime',out,'--port','7888','--dry-run']); assert.equal(r.status,0,r.stderr); const result=JSON.parse(r.stdout); assert.equal(result.host,'127.0.0.1'); assert.ok(result.args.includes('clojure.main')); assert.ok(result.args.includes('[cider.nrepl/cider-middleware]')); assert.ok(!result.args.join(' ').includes('bash -c')); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });

test('refuses a tampered runtime JAR',()=>{ const f=fixture(); try{ const out=path.join(f.tmp,'runtime'); const p=run(prepare,['--lock',f.lockPath,'--artifact-dir',f.artifacts,'--out',out]); assert.equal(p.status,0,p.stderr); fs.appendFileSync(path.join(out,'jars','nrepl-1.7.0.jar'),'tamper'); const r=run(start,['--runtime',out,'--dry-run']); assert.notEqual(r.status,0); assert.match(r.stderr,/SHA-256 verification/i); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });

test('refuses an untracked JAR added after bundle creation',()=>{ const f=fixture(); try{ const out=path.join(f.tmp,'runtime'); const p=run(prepare,['--lock',f.lockPath,'--artifact-dir',f.artifacts,'--out',out]); assert.equal(p.status,0,p.stderr); fs.writeFileSync(path.join(out,'jars','injected.jar'),'bad'); const r=run(start,['--runtime',out,'--dry-run']); assert.notEqual(r.status,0); assert.match(r.stderr,/untracked JAR/i); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });

test('refuses non-loopback binding',()=>{ const f=fixture(); try{ const out=path.join(f.tmp,'runtime'); const p=run(prepare,['--lock',f.lockPath,'--artifact-dir',f.artifacts,'--out',out]); assert.equal(p.status,0,p.stderr); const r=run(start,['--runtime',out,'--host','0.0.0.0','--dry-run']); assert.notEqual(r.status,0); assert.match(r.stderr,/only bind to 127\.0\.0\.1/i); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });

test('rejects an empty artifact directory instead of producing a partial runtime',()=>{ const f=fixture(); try{ for(const name of fs.readdirSync(f.artifacts)) fs.rmSync(path.join(f.artifacts,name)); const r=run(prepare,['--lock',f.lockPath,'--artifact-dir',f.artifacts,'--out',path.join(f.tmp,'runtime')]); assert.notEqual(r.status,0); assert.match(r.stderr,/No JARs/i); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });
