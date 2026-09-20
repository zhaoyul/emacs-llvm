#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_VERSION='2.6.8';
const DEFAULT_URL='https://sourceforge.net/projects/sbcl/files/sbcl/2.6.8/sbcl-2.6.8-x86-64-linux-binary.tar.bz2/download';
const DEFAULT_SHA256='5391773774b94554a015db9f992370d06937fb6f0cdb0b2142281aebef9e96c1';
function fail(message,code=1){ process.stderr.write(`ERROR: ${message}\n`); process.exit(code); }
function arg(name,fallback=null){ const i=process.argv.indexOf(name); return i>=0&&i+1<process.argv.length?process.argv[i+1]:fallback; }
function sha256File(file){ return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sha256Text(text){ return crypto.createHash('sha256').update(text).digest('hex'); }
function canonical(value){ if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if(value&&typeof value==='object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`; return JSON.stringify(value); }
function run(cmd,args,options={}){ const r=spawnSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],...options}); if(r.status!==0) throw new Error(`${cmd} failed (${r.status}): ${(r.stderr||r.stdout||'').trim()}`); return (r.stdout||'').trim(); }
function safeCopyTree(source,dest){
  const walk=(src,dst)=>{ fs.mkdirSync(dst,{recursive:true,mode:0o755}); for(const ent of fs.readdirSync(src,{withFileTypes:true})){ const s=path.join(src,ent.name),d=path.join(dst,ent.name); const st=fs.lstatSync(s); if(st.isSymbolicLink()) throw new Error(`SBCL bundle contains symlink in installed tree: ${s}`); if(st.isDirectory()) walk(s,d); else if(st.isFile()){ fs.copyFileSync(s,d); fs.chmodSync(d,st.mode&0o777); } else throw new Error(`Unsupported SBCL bundle entry: ${s}`); } }; walk(source,dest);
}
function manifestFiles(root){ const files=[]; const walk=(dir,rel='')=>{ for(const ent of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){ const r=rel?`${rel}/${ent.name}`:ent.name; if(r==='sbcl-runtime-manifest.json') continue; const f=path.join(dir,ent.name); const st=fs.lstatSync(f); if(st.isSymbolicLink()) throw new Error(`SBCL runtime contains symlink: ${r}`); if(st.isDirectory()) walk(f,r); else if(st.isFile()) files.push({path:r,bytes:st.size,sha256:sha256File(f),mode:st.mode&0o777}); else throw new Error(`Unsupported SBCL runtime entry: ${r}`); } }; walk(root); return files; }
function findDistribution(root){ const candidates=[]; const walk=(dir,depth=0)=>{ if(depth>3) return; if(fs.existsSync(path.join(dir,'src','runtime','sbcl'))&&fs.existsSync(path.join(dir,'output','sbcl.core'))) candidates.push(dir); for(const ent of fs.readdirSync(dir,{withFileTypes:true})){ if(ent.isDirectory()&&!ent.isSymbolicLink()) walk(path.join(dir,ent.name),depth+1); } }; walk(root); if(candidates.length!==1) throw new Error(`Expected exactly one SBCL binary distribution root, found ${candidates.length}`); return candidates[0]; }
function safeExtract(archive,dest){
  const code=String.raw`import os,sys,tarfile
archive,dest=sys.argv[1],sys.argv[2]
with tarfile.open(archive,'r:bz2') as tf:
    members=tf.getmembers()
    seen=set()
    for m in members:
        n=m.name.replace('\\','/')
        parts=[p for p in n.split('/') if p not in ('','.')]
        if n.startswith('/') or '..' in parts: raise SystemExit('unsafe archive path: '+m.name)
        if m.issym() or m.islnk() or m.isdev() or m.isfifo(): raise SystemExit('unsafe archive entry type: '+m.name)
        norm='/'.join(parts)
        if norm in seen: raise SystemExit('duplicate archive path: '+norm)
        seen.add(norm)
    tf.extractall(dest,filter='data')
`;
  run('python3',['-c',code,archive,dest]);
}
try{
  if(process.platform!=='linux'||process.arch!=='x64') throw new Error(`Private SBCL runtime currently supports linux/x64 only, found ${process.platform}/${process.arch}`);
  const version=arg('--version',DEFAULT_VERSION); const url=arg('--url',DEFAULT_URL); const expectedSha=arg('--expected-sha256',DEFAULT_SHA256);
  if(!/^[a-f0-9]{64}$/.test(expectedSha)) throw new Error('Expected SBCL SHA-256 must be 64 lowercase hex characters.');
  const outDir=path.resolve(arg('--out')??path.join(process.cwd(),'.runtime','sbcl'));
  const provided=arg('--archive'); const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'emacs-operator-sbcl-'));
  try{
    const archive=provided?path.resolve(provided):path.join(tmp,`sbcl-${version}.tar.bz2`);
    if(!provided){ run('curl',['--fail','--location','--proto','=https','--tlsv1.2','--output',archive,url]); }
    const actualSha=sha256File(archive); if(actualSha!==expectedSha) throw new Error(`SBCL archive SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}`);
    const extracted=path.join(tmp,'extracted'); fs.mkdirSync(extracted); safeExtract(archive,extracted); const dist=findDistribution(extracted);
    const stage=`${outDir}.stage-${process.pid}-${crypto.randomBytes(4).toString('hex')}`; fs.rmSync(stage,{recursive:true,force:true});
    const bin=path.join(stage,'bin'),lib=path.join(stage,'lib','sbcl'); fs.mkdirSync(bin,{recursive:true,mode:0o755}); fs.mkdirSync(lib,{recursive:true,mode:0o755});
    const runtime=path.join(dist,'src','runtime'); fs.copyFileSync(path.join(runtime,'sbcl'),path.join(bin,'sbcl')); fs.chmodSync(path.join(bin,'sbcl'),0o755); fs.copyFileSync(path.join(dist,'output','sbcl.core'),path.join(lib,'sbcl.core')); fs.copyFileSync(path.join(runtime,'sbcl.mk'),path.join(lib,'sbcl.mk'));
    if(fs.existsSync(path.join(runtime,'libsbcl.so'))) fs.copyFileSync(path.join(runtime,'libsbcl.so'),path.join(stage,'lib','libsbcl.so'));
    const mk=fs.readFileSync(path.join(runtime,'sbcl.mk'),'utf8'); const match=mk.match(/^LIBSBCL=(.*)$/m); if(match){ for(const name of match[1].trim().split(/\s+/).filter(Boolean)){ if(!/^[-A-Za-z0-9_.+]+$/.test(name)) throw new Error(`Unsafe LIBSBCL entry: ${name}`); const source=path.join(runtime,name); if(!fs.existsSync(source)||!fs.statSync(source).isFile()) throw new Error(`Missing LIBSBCL runtime file: ${name}`); fs.copyFileSync(source,path.join(lib,name)); } }
    const contrib=path.join(dist,'obj','sbcl-home','contrib'); if(!fs.existsSync(contrib)||!fs.statSync(contrib).isDirectory()) throw new Error('SBCL binary distribution has no contrib tree.'); safeCopyTree(contrib,path.join(lib,'contrib'));
    const files=manifestFiles(stage); const planSha=sha256Text(canonical({version,platform:'linux-x86_64',source:{url,sha256:expectedSha},files:files.map(({path,bytes,sha256,mode})=>({path,bytes,sha256,mode}))}));
    const manifest={schema_version:'1.0',runtime:'sbcl',version,platform:'linux-x86_64',source:{url,sha256:expectedSha},created_at:new Date().toISOString(),plan_sha256:planSha,executable:'bin/sbcl',core:'lib/sbcl/sbcl.core',home:'lib/sbcl',files}; fs.writeFileSync(path.join(stage,'sbcl-runtime-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
    fs.rmSync(outDir,{recursive:true,force:true}); fs.renameSync(stage,outDir); process.stdout.write(`${JSON.stringify({ok:true,runtime:outDir,manifest:path.join(outDir,'sbcl-runtime-manifest.json'),version,plan_sha256:planSha,source_sha256:expectedSha,files:files.length},null,2)}\n`);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}catch(error){ fail(error instanceof Error?error.message:String(error)); }
