#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(message,code=1){ process.stderr.write(`ERROR: ${message}\n`); process.exit(code); }
function arg(name,fallback=null){ const i=process.argv.indexOf(name); return i>=0&&i+1<process.argv.length?process.argv[i+1]:fallback; }
function has(name){ return process.argv.includes(name); }
function sha256File(file){ return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sha256Text(text){ return crypto.createHash('sha256').update(text).digest('hex'); }
function canonical(value){ if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if(value&&typeof value==='object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`; return JSON.stringify(value); }
function safeJarName(name){ if(typeof name!=='string'||!/^[-A-Za-z0-9_.+]+\.jar$/.test(name)) throw new Error(`Unsafe JAR name: ${name}`); return name; }
function copyJars(source,dest){
  if(!fs.existsSync(source)||!fs.statSync(source).isDirectory()) throw new Error(`JAR source directory does not exist: ${source}`);
  const entries=fs.readdirSync(source,{withFileTypes:true}).filter(e=>e.name.endsWith('.jar')).sort((a,b)=>a.name.localeCompare(b.name));
  if(entries.length===0) throw new Error(`No JARs were found in ${source}`);
  fs.mkdirSync(dest,{recursive:true,mode:0o700}); const names=new Set();
  for(const entry of entries){
    safeJarName(entry.name); if(names.has(entry.name)) throw new Error(`Duplicate JAR name: ${entry.name}`); names.add(entry.name);
    const src=path.join(source,entry.name); const st=fs.lstatSync(src); if(!st.isFile()||st.isSymbolicLink()) throw new Error(`JAR must be a regular non-symlink file: ${src}`);
    fs.copyFileSync(src,path.join(dest,entry.name));
  }
}
function mavenPom(versions){ return `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>local.emacs-operator</groupId><artifactId>cider-runtime-lock</artifactId><version>1</version>\n  <repositories><repository><id>clojars</id><url>https://repo.clojars.org/</url></repository></repositories>\n  <dependencies>\n    <dependency><groupId>org.clojure</groupId><artifactId>clojure</artifactId><version>${versions.clojure}</version></dependency>\n    <dependency><groupId>nrepl</groupId><artifactId>nrepl</artifactId><version>${versions.nrepl}</version></dependency>\n    <dependency><groupId>cider</groupId><artifactId>cider-nrepl</artifactId><version>${versions['cider-nrepl']}</version></dependency>\n  </dependencies>\n</project>\n`; }

try{
  const root=process.cwd();
  const lockPath=path.resolve(arg('--lock')??path.join(root,'scripts/package-runtime/sources.lock.json'));
  const outDir=path.resolve(arg('--out')??path.join(root,'.runtime','cider-jvm'));
  const artifactDirArg=arg('--artifact-dir');
  const mavenBin=arg('--maven','mvn');
  const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));
  const deps=lock.sources?.cider?.runtime_dependencies;
  if(!deps||typeof deps.clojure!=='string'||typeof deps.nrepl!=='string'||typeof deps['cider-nrepl']!=='string') throw new Error('CIDER JVM runtime versions are missing from source lock.');
  const versions={clojure:deps.clojure,nrepl:deps.nrepl,'cider-nrepl':deps['cider-nrepl']};
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'emacs-operator-cider-jvm-'));
  try{
    const resolved=path.join(tmp,'resolved'); fs.mkdirSync(resolved);
    if(artifactDirArg){ copyJars(path.resolve(artifactDirArg),resolved); }
    else{
      const pom=path.join(tmp,'pom.xml'); fs.writeFileSync(pom,mavenPom(versions));
      const result=spawnSync(mavenBin,['-q','-f',pom,'dependency:copy-dependencies','-DincludeScope=runtime',`-DoutputDirectory=${resolved}`],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
      if(result.status!==0) throw new Error(`Maven dependency resolution failed (${result.status}): ${(result.stderr||result.stdout||'').trim()}`);
    }
    const stage=`${outDir}.stage-${process.pid}-${crypto.randomBytes(4).toString('hex')}`; fs.rmSync(stage,{recursive:true,force:true}); fs.mkdirSync(stage,{recursive:true,mode:0o700});
    const jarDir=path.join(stage,'jars'); copyJars(resolved,jarDir);
    const jars=fs.readdirSync(jarDir).filter(name=>name.endsWith('.jar')).sort().map(name=>{
      const file=path.join(jarDir,name); const st=fs.statSync(file); return {name,bytes:st.size,sha256:sha256File(file)};
    });
    const coordinates=[`org.clojure:clojure:${versions.clojure}`,`nrepl:nrepl:${versions.nrepl}`,`cider:cider-nrepl:${versions['cider-nrepl']}`];
    const planSha=sha256Text(canonical({schema_version:'1.0',coordinates,jars:jars.map(({name,bytes,sha256})=>({name,bytes,sha256}))}));
    const manifest={schema_version:'1.0',runtime:'cider-jvm',created_at:new Date().toISOString(),versions,coordinates,plan_sha256:planSha,jars};
    const manifestPath=path.join(stage,'cider-jvm-runtime-manifest.json'); fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
    const pomPath=path.join(stage,'pom.xml'); fs.writeFileSync(pomPath,mavenPom(versions),{mode:0o600});
    fs.rmSync(outDir,{recursive:true,force:true}); fs.renameSync(stage,outDir);
    process.stdout.write(`${JSON.stringify({ok:true,runtime:outDir,manifest:path.join(outDir,'cider-jvm-runtime-manifest.json'),plan_sha256:planSha,jars:jars.length,versions},null,2)}\n`);
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}catch(error){ fail(error instanceof Error?error.message:String(error)); }
