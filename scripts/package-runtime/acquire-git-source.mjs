#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

function fail(msg, code=1){ process.stderr.write(`ERROR: ${msg}\n`); process.exit(code); }
function arg(name, fallback=null){ const i=process.argv.indexOf(name); return i>=0 && i+1<process.argv.length ? process.argv[i+1] : fallback; }
function has(name){ return process.argv.includes(name); }
function run(cmd,args,cwd){ const r=spawnSync(cmd,args,{cwd,encoding:'utf8'}); if(r.status!==0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${(r.stderr||r.stdout||'').trim()}`); return (r.stdout||'').trim(); }
function sha256(file){ return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function safeName(s){ if(typeof s!=='string'||!/^[A-Za-z0-9._+-]{1,80}$/.test(s)) throw new Error(`Unsafe source name: ${s}`); return s; }
function validateRepo(url, allowLocal){
  if(allowLocal && (url.startsWith('/') || url.startsWith('file://'))) return;
  let u; try { u=new URL(url); } catch { throw new Error(`Invalid repository URL: ${url}`); }
  if(u.protocol!=='https:' || u.hostname!=='github.com') throw new Error(`Repository must be https://github.com unless --allow-local-repo is used: ${url}`);
  if(!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(u.pathname)) throw new Error(`Unsafe GitHub repository path: ${u.pathname}`);
}
function treeManifest(root){
  const out=[];
  const walk=(dir,rel='')=>{
    for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(e.name==='.git') continue;
      const r=rel?`${rel}/${e.name}`:e.name; const f=path.join(dir,e.name);
      const st=fs.lstatSync(f);
      if(st.isSymbolicLink()) throw new Error(`Source tree contains symlink: ${r}`);
      if(st.isDirectory()) walk(f,r);
      else if(st.isFile()) out.push({path:r,bytes:st.size,sha256:sha256(f),mode:st.mode & 0o777});
      else throw new Error(`Unsupported source tree entry: ${r}`);
    }
  }; walk(root); return out;
}
try{
  const lockPath=path.resolve(arg('--lock')??path.join(process.cwd(),'scripts/package-runtime/sources.lock.json'));
  const name=safeName(arg('--name')??fail('--name is required',64));
  const destBase=path.resolve(arg('--dest')??path.join(process.cwd(),'.runtime','sources'));
  const allowLocal=has('--allow-local-repo');
  const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));
  if(lock.schema_version!=='1.0'||!lock.sources||typeof lock.sources!=='object') throw new Error('Invalid source lock.');
  const spec=lock.sources[name]; if(!spec) throw new Error(`Source not found in lock: ${name}`);
  if(spec.kind!=='git') throw new Error(`Unsupported source kind: ${spec.kind}`);
  if(typeof spec.commit!=='string'||!/^[a-f0-9]{40}$/.test(spec.commit)) throw new Error(`Invalid pinned commit for ${name}`);
  validateRepo(spec.repository,allowLocal);
  fs.mkdirSync(destBase,{recursive:true,mode:0o700});
  const finalDir=path.join(destBase,`${name}-${spec.commit.slice(0,12)}`);
  if(fs.existsSync(finalDir)){
    const manifest=JSON.parse(fs.readFileSync(path.join(finalDir,'source-manifest.json'),'utf8'));
    if(manifest.commit!==spec.commit||manifest.repository!==spec.repository) throw new Error(`Existing source cache has mismatched provenance: ${finalDir}`);
    process.stdout.write(`${JSON.stringify({ok:true,cached:true,path:finalDir,commit:spec.commit},null,2)}\n`); process.exit(0);
  }
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),`emacs-operator-source-${name}-`));
  const repo=path.join(tmp,'repo');
  try{
    run('git',['init','-q',repo]);
    run('git',['-c','protocol.file.allow=always','fetch','--quiet','--depth=1',spec.repository,spec.commit],repo);
    run('git',['checkout','--quiet','--detach','FETCH_HEAD'],repo);
    const head=run('git',['rev-parse','HEAD'],repo); if(head!==spec.commit) throw new Error(`Fetched commit mismatch: ${head}`);
    for(const ep of spec.entrypoints??[]){
      if(typeof ep!=='string'||path.isAbsolute(ep)||ep.includes('..')) throw new Error(`Unsafe entrypoint: ${ep}`);
      if(!fs.statSync(path.join(repo,ep)).isFile()) throw new Error(`Locked entrypoint is missing: ${ep}`);
    }
    const stage=path.join(destBase,`.${name}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(stage,{mode:0o700});
    const archived=spawnSync('bash',['-lc',`set -euo pipefail; git -C "$1" archive --format=tar HEAD | tar -xf - -C "$2"`,'_',repo,stage],{encoding:'utf8'});
    if(archived.status!==0) throw new Error(`git archive export failed: ${(archived.stderr||'').trim()}`);
    const files=treeManifest(stage);
    const manifest={schema_version:'1.0',name,repository:spec.repository,commit:spec.commit,version:spec.version??null,entrypoints:spec.entrypoints??[],created_at:new Date().toISOString(),files};
    fs.writeFileSync(path.join(stage,'source-manifest.json'),`${JSON.stringify(manifest,null,2)}\n`,{mode:0o600});
    fs.renameSync(stage,finalDir);
    process.stdout.write(`${JSON.stringify({ok:true,cached:false,path:finalDir,commit:spec.commit,files:files.length},null,2)}\n`);
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
}catch(e){ fail(e instanceof Error?e.message:String(e)); }
