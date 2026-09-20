#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(message, code=1){ process.stderr.write(`ERROR: ${message}\n`); process.exit(code); }
function arg(name,fallback=null){ const i=process.argv.indexOf(name); return i>=0&&i+1<process.argv.length?process.argv[i+1]:fallback; }
function has(name){ return process.argv.includes(name); }

try{
  const root=process.cwd();
  const lockPath=path.resolve(arg('--lock')??path.join(root,'scripts/package-runtime/sources.lock.json'));
  const dest=path.resolve(arg('--dest')??path.join(root,'.runtime','sources'));
  const planName=arg('--plan','linux-package-runtime');
  const allowLocal=has('--allow-local-repo');
  const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));
  const plan=lock.runtime_plans?.[planName];
  if(!plan||!Array.isArray(plan.sources)||plan.sources.length===0) throw new Error(`Runtime plan is missing or empty: ${planName}`);
  const script=path.join(root,'scripts/package-runtime/acquire-git-source.mjs');
  const results=[];
  for(const name of plan.sources){
    const args=[script,'--lock',lockPath,'--name',name,'--dest',dest];
    if(allowLocal) args.push('--allow-local-repo');
    const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
    if(r.status!==0) throw new Error(`Source acquisition failed for ${name}: ${(r.stderr||r.stdout||'').trim()}`);
    results.push(JSON.parse(r.stdout));
  }
  process.stdout.write(`${JSON.stringify({ok:true,plan:planName,dest,sources:results},null,2)}\n`);
}catch(error){ fail(error instanceof Error?error.message:String(error)); }
