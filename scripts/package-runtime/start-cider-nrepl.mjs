#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function fail(message,code=1){ process.stderr.write(`ERROR: ${message}\n`); process.exit(code); }
function arg(name,fallback=null){ const i=process.argv.indexOf(name); return i>=0&&i+1<process.argv.length?process.argv[i+1]:fallback; }
function has(name){ return process.argv.includes(name); }
function sha256File(file){ return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function safeJarName(name){ return typeof name==='string'&&/^[-A-Za-z0-9_.+]+\.jar$/.test(name); }
function verifyRuntime(root){
  const manifestPath=path.join(root,'cider-jvm-runtime-manifest.json'); if(!fs.existsSync(manifestPath)) throw new Error(`Missing CIDER JVM runtime manifest: ${manifestPath}`);
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')); if(manifest.schema_version!=='1.0'||manifest.runtime!=='cider-jvm'||!Array.isArray(manifest.jars)) throw new Error('Invalid CIDER JVM runtime manifest.');
  const expected=new Set(); const classpath=[];
  for(const jar of manifest.jars){ if(!jar||!safeJarName(jar.name)||typeof jar.bytes!=='number'||typeof jar.sha256!=='string') throw new Error('Invalid JAR manifest entry.'); if(expected.has(jar.name)) throw new Error(`Duplicate JAR manifest entry: ${jar.name}`); expected.add(jar.name); const file=path.join(root,'jars',jar.name); const st=fs.lstatSync(file); if(!st.isFile()||st.isSymbolicLink()) throw new Error(`Runtime JAR is not a regular file: ${jar.name}`); if(st.size!==jar.bytes||sha256File(file)!==jar.sha256) throw new Error(`Runtime JAR failed SHA-256 verification: ${jar.name}`); classpath.push(file); }
  const actual=fs.readdirSync(path.join(root,'jars')).filter(name=>name.endsWith('.jar')).sort(); for(const name of actual) if(!expected.has(name)) throw new Error(`Runtime contains untracked JAR: ${name}`); for(const name of expected) if(!actual.includes(name)) throw new Error(`Runtime is missing locked JAR: ${name}`);
  return {manifest,manifestPath,classpath};
}
try{
  const runtime=path.resolve(arg('--runtime')??fail('--runtime is required',64));
  const java=arg('--java',process.env.JAVA??'java'); const host=arg('--host','127.0.0.1'); const port=Number(arg('--port','7888'));
  if(host!=='127.0.0.1') throw new Error('CIDER nREPL runtime may only bind to 127.0.0.1.'); if(!Number.isInteger(port)||port<1||port>65535) throw new Error('CIDER nREPL port must be an integer in 1..65535.');
  const verified=verifyRuntime(runtime); const args=['-cp',verified.classpath.join(path.delimiter),'clojure.main','-m','nrepl.cmdline','--bind',host,'--port',String(port),'--middleware','[cider.nrepl/cider-middleware]'];
  if(has('--dry-run')){ process.stdout.write(`${JSON.stringify({ok:true,java,args,manifest:verified.manifestPath,plan_sha256:verified.manifest.plan_sha256,host,port},null,2)}\n`); process.exit(0); }
  const child=spawn(java,args,{stdio:'inherit',shell:false,env:{...process.env}});
  const forward=(signal)=>{ if(!child.killed) child.kill(signal); }; process.on('SIGTERM',()=>forward('SIGTERM')); process.on('SIGINT',()=>forward('SIGINT'));
  child.on('error',error=>{ process.stderr.write(`ERROR: failed to start CIDER nREPL JVM: ${error.message}\n`); process.exitCode=1; });
  child.on('exit',(code,signal)=>{ if(signal) process.exitCode=128+(signal==='SIGTERM'?15:signal==='SIGINT'?2:1); else process.exitCode=code??1; });
}catch(error){ fail(error instanceof Error?error.message:String(error)); }
