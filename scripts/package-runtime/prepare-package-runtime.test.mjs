import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..','..');
const script=path.join(projectRoot,'scripts','package-runtime','prepare-package-runtime.mjs');
const sha=(data)=>crypto.createHash('sha256').update(data).digest('hex');
function run(args,cwd=projectRoot){ return spawnSync(process.execPath,[script,...args],{cwd,encoding:'utf8'}); }
function writeSource(base,name,spec,files){
  const root=path.join(base,`${name}-${spec.commit.slice(0,12)}`); fs.mkdirSync(root,{recursive:true});
  const manifestFiles=[];
  for(const [rel,content] of Object.entries(files)){
    const file=path.join(root,rel); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,content);
    const bytes=fs.readFileSync(file); manifestFiles.push({path:rel,bytes:bytes.length,sha256:sha(bytes),mode:0o644});
  }
  fs.writeFileSync(path.join(root,'source-manifest.json'),JSON.stringify({schema_version:'1.0',name,repository:spec.repository,commit:spec.commit,version:spec.version??null,entrypoints:spec.entrypoints??[],files:manifestFiles},null,2)+'\n');
  return root;
}
function fixture(){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'emacs-operator-package-runtime-'));
  const sources=path.join(tmp,'sources'); fs.mkdirSync(sources);
  const specs={
    paredit:{kind:'git',repository:'https://github.com/example/paredit.git',commit:'1'.repeat(40),version:'1',entrypoints:['paredit.el'],load_paths:['.']},
    clojure:{kind:'git',repository:'https://github.com/example/clojure-mode.git',commit:'2'.repeat(40),version:'1',entrypoints:['clojure-mode.el'],load_paths:['.']},
    cider:{kind:'git',repository:'https://github.com/example/cider.git',commit:'3'.repeat(40),version:'2.0.1',entrypoints:['lisp/cider.el'],load_paths:['lisp']},
    sly:{kind:'git',repository:'https://github.com/example/sly.git',commit:'4'.repeat(40),version:'1',entrypoints:['sly.el','slynk/slynk-loader.lisp'],load_paths:['.']}
  };
  writeSource(sources,'paredit',specs.paredit,{'paredit.el':'(provide \'paredit)\n'});
  writeSource(sources,'clojure',specs.clojure,{'clojure-mode.el':'(provide \'clojure-mode)\n'});
  writeSource(sources,'cider',specs.cider,{'lisp/cider.el':'(provide \'cider)\n'});
  writeSource(sources,'sly',specs.sly,{'sly.el':'(provide \'sly)\n','slynk/slynk-loader.lisp':'(provide :slynk-loader)\n'});
  const lock={schema_version:'1.1',minimum_emacs_version:'29.2',sources:specs,runtime_plans:{test:{sources:['paredit','clojure','cider','sly']}}};
  const lockPath=path.join(tmp,'lock.json'); fs.writeFileSync(lockPath,JSON.stringify(lock));
  return {tmp,sources,specs,lockPath};
}

test('builds an offline package runtime with deterministic source provenance',()=>{
  const f=fixture();
  try{
    const outDir=path.join(f.tmp,'runtime');
    const r=run(['--lock',f.lockPath,'--sources',f.sources,'--out',outDir,'--plan','test','--nrepl-port','7888','--slynk-port','4005']);
    assert.equal(r.status,0,r.stderr); const out=JSON.parse(r.stdout);
    assert.match(out.plan_sha256,/^[a-f0-9]{64}$/);
    const manifest=JSON.parse(fs.readFileSync(out.manifest,'utf8'));
    assert.equal(manifest.minimum_emacs_version,'29.2');
    assert.equal(manifest.packages.cider.commit,'3'.repeat(40));
    assert.ok(manifest.packages.sly.entrypoints.includes('slynk/slynk-loader.lisp'));
    assert.ok(manifest.load_paths.some(p=>p.endsWith('/cider-333333333333/lisp')));
    const setup=fs.readFileSync(out.setup,'utf8');
    assert.match(setup,/require 'paredit/);
    assert.match(setup,/setq sly-contribs nil/);
    assert.match(setup,/defun emacs-operator-ci-connect-cider/);
    assert.match(setup,/cider-default-session/);
    assert.match(setup,/defun emacs-operator-ci-connect-sly/);
    assert.match(setup,/defun emacs-operator-ci-disconnect-package-runtimes/);
    assert.doesNotMatch(setup,/run-at-time/);
    const env=fs.readFileSync(out.env,'utf8');
    assert.match(env,/EMACS_OPERATOR_LINUX_PACKAGE_RUNTIME_MANIFEST=/);
    assert.match(env,/EMACS_OPERATOR_LINUX_CIDER_SOURCE_ROOT=/);
  }finally{fs.rmSync(f.tmp,{recursive:true,force:true});}
});

test('produces the same plan SHA for the same locked source manifests',()=>{
  const f=fixture();
  try{
    const one=run(['--lock',f.lockPath,'--sources',f.sources,'--out',path.join(f.tmp,'one'),'--plan','test']);
    const two=run(['--lock',f.lockPath,'--sources',f.sources,'--out',path.join(f.tmp,'two'),'--plan','test']);
    assert.equal(one.status,0,one.stderr); assert.equal(two.status,0,two.stderr);
    assert.equal(JSON.parse(one.stdout).plan_sha256,JSON.parse(two.stdout).plan_sha256);
  }finally{fs.rmSync(f.tmp,{recursive:true,force:true});}
});

test('rejects a missing source cache instead of downloading at assembly time',()=>{
  const f=fixture();
  try{
    fs.rmSync(path.join(f.sources,`cider-${'3'.repeat(12)}`),{recursive:true,force:true});
    const r=run(['--lock',f.lockPath,'--sources',f.sources,'--out',path.join(f.tmp,'runtime'),'--plan','test']);
    assert.notEqual(r.status,0); assert.match(r.stderr,/Missing source manifest/i);
  }finally{fs.rmSync(f.tmp,{recursive:true,force:true});}
});

test('rejects a tampered source cache during runtime assembly',()=>{
  const f=fixture();
  try{
    fs.appendFileSync(path.join(f.sources,`paredit-${'1'.repeat(12)}`,'paredit.el'),'; altered\n');
    const r=run(['--lock',f.lockPath,'--sources',f.sources,'--out',path.join(f.tmp,'runtime'),'--plan','test']);
    assert.notEqual(r.status,0); assert.match(r.stderr,/SHA-256 mismatch/i);
  }finally{fs.rmSync(f.tmp,{recursive:true,force:true});}
});

test('rejects a locked entrypoint that is not inside the acquired tree',()=>{
  const f=fixture();
  try{
    const lock=JSON.parse(fs.readFileSync(f.lockPath,'utf8')); lock.sources.sly.entrypoints.push('../escape.lisp'); fs.writeFileSync(f.lockPath,JSON.stringify(lock));
    const r=run(['--lock',f.lockPath,'--sources',f.sources,'--out',path.join(f.tmp,'runtime'),'--plan','test']);
    assert.notEqual(r.status,0); assert.match(r.stderr,/Unsafe sly entrypoint/i);
  }finally{fs.rmSync(f.tmp,{recursive:true,force:true});}
});
