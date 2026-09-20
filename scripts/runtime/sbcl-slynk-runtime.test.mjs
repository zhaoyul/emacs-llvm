import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..','..');
const provision=path.join(root,'scripts/runtime/provision-sbcl-runtime.mjs');
const startSlynk=path.join(root,'scripts/package-runtime/start-slynk.mjs');
const sha=(file)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(script,args){ return spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8'}); }
function makeArchive(tmp,{unsafe=null}={}){
  const dist=path.join(tmp,'dist','sbcl-fixture');
  fs.mkdirSync(path.join(dist,'src','runtime'),{recursive:true}); fs.mkdirSync(path.join(dist,'output'),{recursive:true}); fs.mkdirSync(path.join(dist,'obj','sbcl-home','contrib'),{recursive:true});
  fs.writeFileSync(path.join(dist,'src','runtime','sbcl'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  fs.writeFileSync(path.join(dist,'src','runtime','sbcl.mk'),'LIBSBCL=libfixture.so\n'); fs.writeFileSync(path.join(dist,'src','runtime','libfixture.so'),'fixture-lib\n');
  fs.writeFileSync(path.join(dist,'output','sbcl.core'),'fixture-core\n'); fs.writeFileSync(path.join(dist,'obj','sbcl-home','contrib','asdf.fasl'),'fixture-contrib\n');
  const archive=path.join(tmp,'sbcl.tar.bz2');
  const py=unsafe==='traversal'
    ? `import io,tarfile; t=tarfile.open(${JSON.stringify(archive)},'w:bz2'); i=tarfile.TarInfo('../escape'); b=b'x'; i.size=len(b); t.addfile(i,io.BytesIO(b)); t.close()`
    : unsafe==='symlink'
      ? `import tarfile; t=tarfile.open(${JSON.stringify(archive)},'w:bz2'); i=tarfile.TarInfo('sbcl-fixture/link'); i.type=tarfile.SYMTYPE; i.linkname='/tmp/target'; t.addfile(i); t.close()`
      : `import tarfile; t=tarfile.open(${JSON.stringify(archive)},'w:bz2'); t.add(${JSON.stringify(dist)},arcname='sbcl-fixture',recursive=True); t.close()`;
  const r=spawnSync('python3',['-c',py],{encoding:'utf8'}); assert.equal(r.status,0,r.stderr); return archive;
}
function makeSlySource(tmp){ const source=path.join(tmp,'sly-123456789abc'); fs.mkdirSync(path.join(source,'slynk'),{recursive:true}); fs.writeFileSync(path.join(source,'sly.el'),'(provide \'sly)\n'); fs.writeFileSync(path.join(source,'slynk','slynk-loader.lisp'),'(provide :slynk-loader)\n'); const files=[]; for(const rel of ['sly.el','slynk/slynk-loader.lisp']){ const f=path.join(source,rel),b=fs.readFileSync(f); files.push({path:rel,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex'),mode:0o644}); } fs.writeFileSync(path.join(source,'source-manifest.json'),JSON.stringify({schema_version:'1.0',name:'sly',repository:'https://github.com/example/sly.git',commit:'1'.repeat(40),files},null,2)+'\n'); return source; }
function fixture(){ const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'emacs-operator-sbcl-test-')); const archive=makeArchive(tmp); return {tmp,archive}; }
function provisionFixture(f){ const out=path.join(f.tmp,'runtime'); const r=run(provision,['--archive',f.archive,'--expected-sha256',sha(f.archive),'--version','fixture','--out',out]); assert.equal(r.status,0,r.stderr); return {out,result:JSON.parse(r.stdout)}; }

test('provisions a minimal private SBCL runtime from a verified binary archive',()=>{ const f=fixture(); try{ const {out,result}=provisionFixture(f); assert.equal(result.version,'fixture'); assert.ok(fs.existsSync(path.join(out,'bin','sbcl'))); assert.ok(fs.existsSync(path.join(out,'lib','sbcl','sbcl.core'))); assert.ok(fs.existsSync(path.join(out,'lib','sbcl','contrib','asdf.fasl'))); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });

test('rejects an SBCL archive with the wrong SHA-256',()=>{ const f=fixture(); try{ const r=run(provision,['--archive',f.archive,'--expected-sha256','0'.repeat(64),'--version','fixture','--out',path.join(f.tmp,'runtime')]); assert.notEqual(r.status,0); assert.match(r.stderr,/SHA-256 mismatch/i); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });

test('rejects path traversal in an SBCL archive',()=>{ const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'emacs-operator-sbcl-test-')); try{ const archive=makeArchive(tmp,{unsafe:'traversal'}); const r=run(provision,['--archive',archive,'--expected-sha256',sha(archive),'--out',path.join(tmp,'runtime')]); assert.notEqual(r.status,0); assert.match(r.stderr,/unsafe archive path/i); }finally{fs.rmSync(tmp,{recursive:true,force:true});} });

test('rejects symlinks in an SBCL archive',()=>{ const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'emacs-operator-sbcl-test-')); try{ const archive=makeArchive(tmp,{unsafe:'symlink'}); const r=run(provision,['--archive',archive,'--expected-sha256',sha(archive),'--out',path.join(tmp,'runtime')]); assert.notEqual(r.status,0); assert.match(r.stderr,/unsafe archive entry type/i); }finally{fs.rmSync(tmp,{recursive:true,force:true});} });

test('records SHA-256 provenance for every installed SBCL runtime file',()=>{ const f=fixture(); try{ const {out,result}=provisionFixture(f); const manifest=JSON.parse(fs.readFileSync(result.manifest,'utf8')); assert.equal(manifest.runtime,'sbcl'); assert.match(manifest.plan_sha256,/^[a-f0-9]{64}$/); assert.ok(manifest.files.length>=5); for(const item of manifest.files) assert.equal(sha(path.join(out,item.path)),item.sha256); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });

test('Slynk supervisor dry-run verifies locked SLY and SBCL provenance',()=>{ const f=fixture(); try{ const {out}=provisionFixture(f); const sly=makeSlySource(f.tmp); const r=run(startSlynk,['--sly-source',sly,'--sbcl-runtime',out,'--port','4005','--dry-run']); assert.equal(r.status,0,r.stderr); const result=JSON.parse(r.stdout); assert.equal(result.host,'127.0.0.1'); assert.equal(result.sbcl_version,'fixture'); assert.ok(result.args.includes('--disable-debugger')); assert.ok(result.env.SBCL_HOME.endsWith('/lib/sbcl')); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });

test('Slynk supervisor rejects a modified SBCL core',()=>{ const f=fixture(); try{ const {out}=provisionFixture(f); const sly=makeSlySource(f.tmp); fs.appendFileSync(path.join(out,'lib','sbcl','sbcl.core'),'tamper'); const r=run(startSlynk,['--sly-source',sly,'--sbcl-runtime',out,'--dry-run']); assert.notEqual(r.status,0); assert.match(r.stderr,/SBCL runtime SHA-256 mismatch/i); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });

test('Slynk supervisor rejects a modified locked SLY source',()=>{ const f=fixture(); try{ const {out}=provisionFixture(f); const sly=makeSlySource(f.tmp); fs.appendFileSync(path.join(sly,'slynk','slynk-loader.lisp'),';tamper'); const r=run(startSlynk,['--sly-source',sly,'--sbcl-runtime',out,'--dry-run']); assert.notEqual(r.status,0); assert.match(r.stderr,/SLY source SHA-256 mismatch/i); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });

test('Slynk supervisor refuses non-loopback binding',()=>{ const f=fixture(); try{ const {out}=provisionFixture(f); const sly=makeSlySource(f.tmp); const r=run(startSlynk,['--sly-source',sly,'--sbcl-runtime',out,'--host','0.0.0.0','--dry-run']); assert.notEqual(r.status,0); assert.match(r.stderr,/only bind to 127\.0\.0\.1/i); }finally{fs.rmSync(f.tmp,{recursive:true,force:true});} });
