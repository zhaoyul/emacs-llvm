import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..','..');
const script=path.join(projectRoot,'scripts','package-runtime','acquire-git-source.mjs');
function cmd(c,args,cwd){ const r=spawnSync(c,args,{cwd,encoding:'utf8'}); assert.equal(r.status,0,r.stderr); return (r.stdout||'').trim(); }
function run(args,cwd=projectRoot){ return spawnSync(process.execPath,[script,...args],{cwd,encoding:'utf8'}); }
function fixture(){
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'emacs-operator-git-source-'));
  const repo=path.join(tmp,'origin'); fs.mkdirSync(repo);
  cmd('git',['init','-q'],repo); cmd('git',['config','user.email','test@example.invalid'],repo); cmd('git',['config','user.name','Test'],repo);
  fs.writeFileSync(path.join(repo,'paredit.el'),'(provide \'paredit)\n');
  cmd('git',['add','paredit.el'],repo); cmd('git',['commit','-q','-m','fixture'],repo);
  const commit=cmd('git',['rev-parse','HEAD'],repo);
  return {tmp,repo,commit};
}

test('acquires an exact pinned git commit into a provenance cache',()=>{
  const f=fixture();
  try{
    const lock=path.join(f.tmp,'lock.json');
    fs.writeFileSync(lock,JSON.stringify({schema_version:'1.0',sources:{paredit:{kind:'git',repository:f.repo,commit:f.commit,version:'fixture',entrypoints:['paredit.el']}}}));
    const dest=path.join(f.tmp,'sources');
    const r=run(['--lock',lock,'--name','paredit','--dest',dest,'--allow-local-repo']);
    assert.equal(r.status,0,r.stderr);
    const out=JSON.parse(r.stdout); assert.equal(out.commit,f.commit); assert.equal(out.cached,false);
    const manifest=JSON.parse(fs.readFileSync(path.join(out.path,'source-manifest.json'),'utf8'));
    assert.equal(manifest.commit,f.commit); assert.ok(manifest.files.some(x=>x.path==='paredit.el'));
    const second=run(['--lock',lock,'--name','paredit','--dest',dest,'--allow-local-repo']);
    assert.equal(second.status,0,second.stderr); assert.equal(JSON.parse(second.stdout).cached,true);
  }finally{fs.rmSync(f.tmp,{recursive:true,force:true});}
});

test('rejects an unpinned/missing git commit',()=>{
  const f=fixture();
  try{
    const lock=path.join(f.tmp,'lock.json');
    fs.writeFileSync(lock,JSON.stringify({schema_version:'1.0',sources:{paredit:{kind:'git',repository:f.repo,commit:'0'.repeat(40),entrypoints:['paredit.el']}}}));
    const r=run(['--lock',lock,'--name','paredit','--dest',path.join(f.tmp,'sources'),'--allow-local-repo']);
    assert.notEqual(r.status,0); assert.match(r.stderr,/fetch|commit/i);
  }finally{fs.rmSync(f.tmp,{recursive:true,force:true});}
});

test('rejects non-GitHub network repositories by default',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'emacs-operator-git-source-'));
  try{
    const lock=path.join(tmp,'lock.json');
    fs.writeFileSync(lock,JSON.stringify({schema_version:'1.0',sources:{x:{kind:'git',repository:'https://example.com/x/y.git',commit:'a'.repeat(40),entrypoints:[]}}}));
    const r=run(['--lock',lock,'--name','x','--dest',path.join(tmp,'sources')]);
    assert.notEqual(r.status,0); assert.match(r.stderr,/github.com/);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});


test('rejects a cached source whose locked file was modified',()=>{
  const f=fixture();
  try{
    const lock=path.join(f.tmp,'lock.json');
    fs.writeFileSync(lock,JSON.stringify({schema_version:'1.0',sources:{paredit:{kind:'git',repository:f.repo,commit:f.commit,version:'fixture',entrypoints:['paredit.el']}}}));
    const dest=path.join(f.tmp,'sources');
    const first=run(['--lock',lock,'--name','paredit','--dest',dest,'--allow-local-repo']);
    assert.equal(first.status,0,first.stderr);
    const sourcePath=JSON.parse(first.stdout).path;
    fs.appendFileSync(path.join(sourcePath,'paredit.el'),'; tampered\n');
    const second=run(['--lock',lock,'--name','paredit','--dest',dest,'--allow-local-repo']);
    assert.notEqual(second.status,0);
    assert.match(second.stderr,/SHA-256 verification/i);
  }finally{fs.rmSync(f.tmp,{recursive:true,force:true});}
});

test('rejects an extra untracked file in a cached source',()=>{
  const f=fixture();
  try{
    const lock=path.join(f.tmp,'lock.json');
    fs.writeFileSync(lock,JSON.stringify({schema_version:'1.0',sources:{paredit:{kind:'git',repository:f.repo,commit:f.commit,version:'fixture',entrypoints:['paredit.el']}}}));
    const dest=path.join(f.tmp,'sources');
    const first=run(['--lock',lock,'--name','paredit','--dest',dest,'--allow-local-repo']);
    assert.equal(first.status,0,first.stderr);
    const sourcePath=JSON.parse(first.stdout).path;
    fs.writeFileSync(path.join(sourcePath,'injected.el'),'(provide \'injected)\n');
    const second=run(['--lock',lock,'--name','paredit','--dest',dest,'--allow-local-repo']);
    assert.notEqual(second.status,0);
    assert.match(second.stderr,/untracked file/i);
  }finally{fs.rmSync(f.tmp,{recursive:true,force:true});}
});
