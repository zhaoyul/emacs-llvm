#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function fail(message,code=1){ process.stderr.write(`ERROR: ${message}\n`); process.exit(code); }
function arg(name,fallback=null){ const i=process.argv.indexOf(name); return i>=0&&i+1<process.argv.length?process.argv[i+1]:fallback; }
function sha256Buffer(value){ return crypto.createHash('sha256').update(value).digest('hex'); }
function sha256File(file){ return sha256Buffer(fs.readFileSync(file)); }
function canonical(value){ if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if(value&&typeof value==='object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`; return JSON.stringify(value); }
function quoteShell(value){ return `'${String(value).replaceAll("'",`'"'"'`)}'`; }
function ensureSafeRelative(value,label){ if(typeof value!=='string'||path.isAbsolute(value)||value.split(/[\\/]/).includes('..')) throw new Error(`Unsafe ${label}: ${value}`); return value; }
function readManifest(sourceRoot){
  const manifestPath=path.join(sourceRoot,'source-manifest.json');
  if(!fs.existsSync(manifestPath)) throw new Error(`Missing source manifest: ${manifestPath}`);
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  if(manifest.schema_version!=='1.0'||typeof manifest.repository!=='string'||typeof manifest.commit!=='string'||!Array.isArray(manifest.files)) throw new Error(`Invalid source manifest: ${manifestPath}`);
  const expected=new Map(manifest.files.map(item=>[item.path,item]));
  const actual=[];
  const walk=(dir,rel='')=>{
    for(const ent of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const r=rel?`${rel}/${ent.name}`:ent.name;
      if(r==='source-manifest.json'||ent.name==='.git') continue;
      const full=path.join(dir,ent.name); const st=fs.lstatSync(full);
      if(st.isSymbolicLink()) throw new Error(`Source cache contains symlink: ${r}`);
      if(st.isDirectory()) walk(full,r);
      else if(st.isFile()) actual.push({path:r,bytes:st.size,sha256:sha256File(full)});
      else throw new Error(`Unsupported source cache entry: ${r}`);
    }
  };
  walk(sourceRoot);
  const actualPaths=new Set(actual.map(item=>item.path));
  for(const item of actual){ const locked=expected.get(item.path); if(!locked) throw new Error(`Source cache contains untracked file: ${item.path}`); if(locked.bytes!==item.bytes||locked.sha256!==item.sha256) throw new Error(`Source cache SHA-256 mismatch: ${item.path}`); }
  for(const lockedPath of expected.keys()) if(!actualPaths.has(lockedPath)) throw new Error(`Source cache missing locked file: ${lockedPath}`);
  return {manifest,manifestPath};
}

try{
  const root=process.cwd();
  const lockPath=path.resolve(arg('--lock')??path.join(root,'scripts/package-runtime/sources.lock.json'));
  const sourcesDir=path.resolve(arg('--sources')??path.join(root,'.runtime','sources'));
  const outDir=path.resolve(arg('--out')??path.join(root,'.runtime','package-runtime'));
  const planName=arg('--plan','linux-package-runtime');
  const nreplPort=Number(arg('--nrepl-port','7888'));
  const slynkPort=Number(arg('--slynk-port','4005'));
  if(!Number.isInteger(nreplPort)||nreplPort<1||nreplPort>65535||!Number.isInteger(slynkPort)||slynkPort<1||slynkPort>65535) throw new Error('Runtime ports must be integers in 1..65535.');
  const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));
  const plan=lock.runtime_plans?.[planName];
  if(!plan||!Array.isArray(plan.sources)||plan.sources.length===0) throw new Error(`Runtime plan is missing or empty: ${planName}`);
  const packages={}; const loadPaths=[]; const planIdentity=[];
  for(const name of plan.sources){
    const spec=lock.sources?.[name];
    if(!spec||spec.kind!=='git'||typeof spec.commit!=='string') throw new Error(`Invalid locked source: ${name}`);
    const sourceRoot=path.join(sourcesDir,`${name}-${spec.commit.slice(0,12)}`);
    const {manifest,manifestPath}=readManifest(sourceRoot);
    if(manifest.commit!==spec.commit||manifest.repository!==spec.repository) throw new Error(`Source provenance mismatch for ${name}`);
    const paths=[];
    for(const rel of spec.load_paths??['.']){
      ensureSafeRelative(rel,`${name} load path`);
      const full=path.resolve(sourceRoot,rel);
      if(!full.startsWith(path.resolve(sourceRoot)+path.sep) && full!==path.resolve(sourceRoot)) throw new Error(`Load path escapes source root for ${name}: ${rel}`);
      if(!fs.existsSync(full)||!fs.statSync(full).isDirectory()) throw new Error(`Locked load path is missing for ${name}: ${rel}`);
      paths.push(full); loadPaths.push(full);
    }
    for(const entrypoint of spec.entrypoints??[]){ ensureSafeRelative(entrypoint,`${name} entrypoint`); const full=path.join(sourceRoot,entrypoint); if(!fs.existsSync(full)||!fs.statSync(full).isFile()) throw new Error(`Locked entrypoint is missing for ${name}: ${entrypoint}`); }
    packages[name]={source_root:sourceRoot,repository:spec.repository,commit:spec.commit,version:spec.version??null,source_manifest:manifestPath,load_paths:paths,entrypoints:spec.entrypoints??[]};
    planIdentity.push({name,repository:spec.repository,commit:spec.commit,version:spec.version??null,source_manifest_sha256:sha256File(manifestPath)});
  }
  const uniqueLoadPaths=[...new Set(loadPaths)];
  fs.mkdirSync(outDir,{recursive:true,mode:0o700});
  const planSha=sha256Buffer(canonical({schema_version:lock.schema_version,minimum_emacs_version:lock.minimum_emacs_version??'29',plan:planName,sources:planIdentity}));
  const runtimeManifest={schema_version:'1.0',plan:planName,plan_sha256:planSha,minimum_emacs_version:lock.minimum_emacs_version??'29',created_at:new Date().toISOString(),packages,load_paths:uniqueLoadPaths,runtimes:{cider:{host:'127.0.0.1',port:nreplPort},sly:{host:'127.0.0.1',port:slynkPort}}};
  const manifestPath=path.join(outDir,'package-runtime-manifest.json');
  fs.writeFileSync(manifestPath,`${JSON.stringify(runtimeManifest,null,2)}\n`,{mode:0o600});
  const setupPath=path.join(outDir,'package-runtime-setup.el');
  const setup=`;;; package-runtime-setup.el --- generated locked package runtime -*- lexical-binding: t; -*-\n\n(unless (version<= "${String(runtimeManifest.minimum_emacs_version).replaceAll('\\','\\\\').replaceAll('"','\\"')}" emacs-version)\n  (error "Locked package runtime requires GNU Emacs %s+, found %s" "${runtimeManifest.minimum_emacs_version}" emacs-version))\n\n(require 'paredit)\n(require 'clojure-mode)\n(require 'cider)\n;; Package acceptance only exercises core SLY/Slynk evaluation. Loading the\n;; default sly-fancy contrib can compile Slynk extensions on first connection\n;; and block the Emacs main thread beyond a bounded bridge timeout.\n(setq sly-contribs nil)\n(require 'sly)\n\n(defvar emacs-operator-ci-nrepl-port ${nreplPort})\n(defvar emacs-operator-ci-slynk-port ${slynkPort})\n(defvar emacs-operator-ci-project-directory\n  (file-name-as-directory (expand-file-name default-directory)))\n(defvar emacs-operator-ci-cider-connect-state 'idle)\n(defvar emacs-operator-ci-cider-connect-error nil)\n(defvar emacs-operator-ci-sly-connect-state 'idle)\n(defvar emacs-operator-ci-sly-connect-error nil)\n\n(defun emacs-operator-ci--cider-connected ()\n  "Record the single CIDER CI session as the default session."\n  (when-let ((session (car (cider-sessions))))\n    (setq cider-default-session (car session)\n          emacs-operator-ci-cider-connect-state 'ready\n          emacs-operator-ci-cider-connect-error nil)))\n\n(add-hook 'cider-connected-hook #'emacs-operator-ci--cider-connected)\n\n(defun emacs-operator-ci-connect-cider ()\n  "Explicitly connect the isolated acceptance Emacs to loopback nREPL."\n  (interactive)\n  (setq emacs-operator-ci-cider-connect-state 'connecting\n        emacs-operator-ci-cider-connect-error nil)\n  (condition-case err\n      (progn\n        (cider-connect-clj\n         (list :host "127.0.0.1"\n               :port emacs-operator-ci-nrepl-port\n               :project-dir emacs-operator-ci-project-directory))\n        ;; The sesman session is created synchronously by cider-nrepl-connect.\n        ;; Pin it immediately so CI source buffers do not depend on project\n        ;; discovery heuristics while the nREPL init callback is completing.\n        (when-let ((session (car (cider-sessions))))\n          (setq cider-default-session (car session)))\n        (setq emacs-operator-ci-cider-connect-state 'requested)\n        t)\n    (error\n     (setq emacs-operator-ci-cider-connect-state 'failed\n           emacs-operator-ci-cider-connect-error (error-message-string err))\n     (signal (car err) (cdr err)))))\n\n(defun emacs-operator-ci-connect-sly ()\n  "Explicitly connect the isolated acceptance Emacs to loopback Slynk."\n  (interactive)\n  (setq emacs-operator-ci-sly-connect-state 'connecting\n        emacs-operator-ci-sly-connect-error nil\n        sly-contribs nil)\n  (condition-case err\n      (progn\n        (sly-connect "127.0.0.1" emacs-operator-ci-slynk-port)\n        (setq emacs-operator-ci-sly-connect-state 'requested)\n        t)\n    (error\n     (setq emacs-operator-ci-sly-connect-state 'failed\n           emacs-operator-ci-sly-connect-error (error-message-string err))\n     (signal (car err) (cdr err)))))\n\n(defun emacs-operator-ci-disconnect-cider ()\n  "Disconnect CIDER REPLs created by package acceptance."\n  (interactive)\n  (when (featurep 'cider)\n    (dolist (repl (ignore-errors (cider-repls nil t)))\n      (ignore-errors (cider-quit repl))))\n  (setq cider-default-session nil\n        emacs-operator-ci-cider-connect-state 'idle)\n  t)\n\n(defun emacs-operator-ci-disconnect-sly ()\n  "Disconnect SLY connections created by package acceptance."\n  (interactive)\n  (when (and (featurep 'sly) (fboundp 'sly-disconnect-all))\n    (ignore-errors (sly-disconnect-all)))\n  (setq emacs-operator-ci-sly-connect-state 'idle)\n  t)\n\n(defun emacs-operator-ci-disconnect-package-runtimes ()\n  "Best-effort cleanup for the isolated package runtime."\n  (interactive)\n  (emacs-operator-ci-disconnect-cider)\n  (emacs-operator-ci-disconnect-sly)\n  t)\n\n(add-hook 'kill-emacs-hook #'emacs-operator-ci-disconnect-package-runtimes)\n(provide 'emacs-operator-package-runtime-setup)\n;;; package-runtime-setup.el ends here\n`;
  fs.writeFileSync(setupPath,setup,{mode:0o600});
  const envPath=path.join(outDir,'package-runtime.env');
  const env={
    EMACS_OPERATOR_LINUX_EMACS_EXTRA_LOAD_PATHS:uniqueLoadPaths.join(':'),
    EMACS_OPERATOR_LINUX_EMACS_SETUP_FILE:setupPath,
    EMACS_OPERATOR_LINUX_PACKAGE_RUNTIME_MANIFEST:manifestPath,
    EMACS_OPERATOR_LINUX_PACKAGE_RUNTIME_PLAN_SHA256:planSha,
    EMACS_OPERATOR_LINUX_PAREDIT_SOURCE_ROOT:packages.paredit?.source_root??'',
    EMACS_OPERATOR_LINUX_CIDER_SOURCE_ROOT:packages.cider?.source_root??'',
    EMACS_OPERATOR_LINUX_SLY_SOURCE_ROOT:packages.sly?.source_root??'',
    EMACS_OPERATOR_CI_NREPL_PORT:String(nreplPort),
    EMACS_OPERATOR_CI_SLYNK_PORT:String(slynkPort)
  };
  fs.writeFileSync(envPath,Object.entries(env).map(([key,value])=>`${key}=${quoteShell(value)}`).join('\n')+'\n',{mode:0o600});
  process.stdout.write(`${JSON.stringify({ok:true,plan:planName,plan_sha256:planSha,manifest:manifestPath,setup:setupPath,env:envPath,load_paths:uniqueLoadPaths},null,2)}\n`);
}catch(error){ fail(error instanceof Error?error.message:String(error)); }
