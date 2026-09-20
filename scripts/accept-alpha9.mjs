#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {readdirSync,readFileSync,writeFileSync,existsSync} from "node:fs";
import path from "node:path";
import process from "node:process";

const root=process.cwd();
const reportPath=process.env.EMACS_OPERATOR_ALPHA9_REPORT || path.join(root,"artifacts","alpha9-acceptance.json");
const results=[];
function run(name,command,args,{required=true}={}) {
  const started=Date.now();
  const cp=spawnSync(command,args,{cwd:root,encoding:"utf8",env:{...process.env,CI:"1"}});
  const output=`${cp.stdout ?? ""}${cp.stderr ?? ""}`;
  const item={name,command:[command,...args],exit_code:cp.status ?? 125,ok:cp.status===0,required,seconds:(Date.now()-started)/1000,output_tail:output.slice(-4000)};
  results.push(item); return item;
}
const testDir=path.join(root,"packages","refactor-intelligence","test");
const tests=readdirSync(testDir).filter((name)=>name.endsWith(".test.js")).sort().map((name)=>path.relative(root,path.join(testDir,name)));
run("refactor-intelligence",process.execPath,["--test",...tests]);

const elispFiles=[];
function walk(directory) {
  for (const entry of readdirSync(directory,{withFileTypes:true})) {
    const full=path.join(directory,entry.name);
    if (entry.isDirectory() && !["node_modules",".git",".build","dist"].includes(entry.name)) walk(full);
    else if (entry.isFile() && entry.name.endsWith(".el")) elispFiles.push(full);
  }
}
walk(path.join(root,"lisp"));
const combined=elispFiles.map((file)=>readFileSync(file,"utf8")).join("\n");
const staticChecks={
  module_loaded:combined.includes("(require 'emacs-operator-refactor-intelligence)"),
  analyzer_entry:combined.includes("emacs-operator-lisp-analyze"),
  rename_plan:combined.includes("emacs-operator-project-rename-plan"),
  rename_apply:combined.includes("emacs-operator-project-rename-apply")
};
results.push({name:"static-integration",ok:Object.values(staticChecks).every(Boolean),required:true,checks:staticChecks});

const emacsProbe=spawnSync("emacs",["--version"],{encoding:"utf8"});
if (emacsProbe.status===0) {
  run("ert","emacs",["-Q","--batch","-L","lisp","-L","lisp/test","-l","emacs-operator-refactor-intelligence","-l","emacs-operator-refactor-intelligence-test","-f","ert-run-tests-batch-and-exit"]);
} else {
  results.push({name:"ert",ok:false,required:false,status:"not_run",reason:"GNU Emacs is unavailable"});
}
const ok=results.filter((r)=>r.required).every((r)=>r.ok);
const report={version:"0.1.0-alpha.9",ok,generated_at:new Date().toISOString(),results};
const reportDir=path.dirname(reportPath);
await import("node:fs/promises").then(({mkdir})=>mkdir(reportDir,{recursive:true}));
writeFileSync(reportPath,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
process.exit(ok?0:1);
