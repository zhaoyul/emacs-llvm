#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadExperimentConfig, runPairedExperiment } from "./experiment.mjs";
import { preflight } from "./preflight.mjs";
import { createFilesystemBaselineAgent, createEmacsOperatorCandidateAgent } from "./wrapper.mjs";
function arg(name){ const i=process.argv.indexOf(name); return i>=0?process.argv[i+1]:undefined; }
function write(value,file){ const text=`${JSON.stringify(value,null,2)}
`; if(file){fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});fs.writeFileSync(path.resolve(file),text);} else process.stdout.write(text); }
async function main(){
  const command=process.argv[2];
  if(command==="preflight"){
    const configPath=arg("--config"); if(!configPath) throw new Error("--config is required");
    const config=loadExperimentConfig(path.resolve(configPath)); const report=preflight(config); write(report,arg("--output")); if(!report.ok) process.exitCode=1; return;
  }
  if(command==="pair"){
    const configPath=arg("--config"); if(!configPath) throw new Error("--config is required");
    const manifest=await runPairedExperiment(loadExperimentConfig(path.resolve(configPath))); write({ok:true,experiment_id:manifest.experiment_id,run_id:manifest.run_id,records:manifest.records.length,manifest:path.resolve(manifest.records.length?path.dirname(manifest.records[0].outcome?.value?.trace_path??arg("--config")):arg("--config"))}); return;
  }
  if(command==="invoke"){
    const profilePath=arg("--profile"),requestPath=arg("--request"),side=arg("--side"),output=arg("--output");
    if(!profilePath||!requestPath||!["baseline","candidate"].includes(side)) throw new Error("invoke requires --profile, --request and --side baseline|candidate");
    const profile=JSON.parse(fs.readFileSync(path.resolve(profilePath),"utf8")); const request=JSON.parse(fs.readFileSync(path.resolve(requestPath),"utf8"));
    const agent=side==="baseline"?createFilesystemBaselineAgent(profile):createEmacsOperatorCandidateAgent(profile);
    write(await agent.run(request),output); return;
  }
  throw new Error("Usage: cli.mjs preflight|invoke|pair ...");
}
main().catch((error)=>{ process.stderr.write(`${error.stack??error}
`); process.exitCode=1; });
