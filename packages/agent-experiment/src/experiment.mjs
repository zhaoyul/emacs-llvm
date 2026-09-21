import fs from "node:fs";
import path from "node:path";
import { EXPERIMENT_SCHEMA_VERSION } from "./constants.mjs";
import { deriveTrialSeed, sha256, stableId } from "./canonical.mjs";
import { buildBalancedSchedule } from "./order.mjs";
import { createFilesystemBaselineAgent, createEmacsOperatorCandidateAgent } from "./wrapper.mjs";
import { invariant } from "./errors.mjs";
function safeMkdir(directory) { fs.mkdirSync(directory, { recursive: true }); return directory; }
function loadJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function writeJson(file, value) { safeMkdir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}
`); }
export function validatePairConfig(config) {
  invariant(config?.schema_version === EXPERIMENT_SCHEMA_VERSION, "E_EXPERIMENT_SCHEMA", `schema_version must be ${EXPERIMENT_SCHEMA_VERSION}`);
  invariant(typeof config.run_seed === "number" && Number.isInteger(config.run_seed), "E_RUN_SEED", "run_seed must be an integer");
  invariant(Number.isInteger(config.trials) && config.trials >= 1 && config.trials <= 100, "E_TRIALS", "trials must be 1..100");
  invariant(config.suite && typeof config.suite.id === "string" && typeof config.suite.digest === "string" && Array.isArray(config.suite.tasks), "E_SUITE", "suite id, digest and tasks are required");
  invariant(config.baseline?.profile && config.candidate?.profile, "E_PROFILES", "baseline.profile and candidate.profile are required");
  const b=config.baseline.profile, c=config.candidate.profile;
  for (const key of ["provider","model","model_version","prompt_policy","temperature","top_p","max_context_tokens","cross_trial_memory","network_access","pairing_key"]) {
    invariant(JSON.stringify(b[key]) === JSON.stringify(c[key]), "E_PROFILE_PAIRING", `Paired profile field differs: ${key}`);
  }
  invariant(b.tool_profile !== c.tool_profile, "E_PROFILE_PAIRING", "Only tool_profile should distinguish baseline and candidate");
  return config;
}
export async function runPairedExperiment(config, { onTrial } = {}) {
  validatePairConfig(config);
  const outputDir=path.resolve(config.output_dir);
  safeMkdir(outputDir);
  const baseline=createFilesystemBaselineAgent(config.baseline.profile);
  const candidate=createEmacsOperatorCandidateAgent(config.candidate.profile);
  const schedule=buildBalancedSchedule({ suiteDigest: config.suite.digest, tasks: config.suite.tasks, trials: config.trials, runSeed: config.run_seed });
  const runId=config.run_id ?? stableId("run", { suite: config.suite.digest, seed: config.run_seed, started: new Date().toISOString() });
  const records=[];
  for (const item of schedule) {
    const task=config.suite.tasks.find((entry)=>entry.id===item.task_id);
    const trialSeed=deriveTrialSeed({ suiteDigest: config.suite.digest, taskId: item.task_id, trial: item.trial, runSeed: config.run_seed });
    const pair=[];
    for (const side of item.order) {
      const workspace=path.resolve(config.workspace_factory.root, `${item.task_id}-trial-${item.trial}-${side}`);
      const source=path.resolve(config.workspace_factory.fixtures_root, task.fixture);
      fs.rmSync(workspace,{recursive:true,force:true});
      fs.cpSync(source,workspace,{recursive:true});
      const tracePath=path.join(outputDir,"traces",`${item.task_id}-${item.trial}-${side}.jsonl`);
      const base={
        run_id:runId, suite_id:config.suite.id, suite_revision:config.suite.revision,
        suite_digest:config.suite.digest, task_id:item.task_id, task_digest:item.task_digest,
        trial:item.trial, trial_seed:trialSeed, prompt:task.prompt, workspace, trace_path:tracePath,
        timeout_ms:config.timeout_ms
      };
      const agent=side==="baseline"?baseline:candidate;
      const started=Date.now();
      let outcome;
      try { outcome={ok:true,value:await agent.run(base)}; }
      catch(error){ outcome={ok:false,error:{name:error?.name??"Error",code:error?.code??"E_UNEXPECTED",message:String(error?.message??error)}}; }
      const record={side,task_id:item.task_id,trial:item.trial,trial_seed:trialSeed,order:item.order,outcome,duration_ms:Date.now()-started,workspace};
      pair.push(record); records.push(record); await onTrial?.(record);
    }
    writeJson(path.join(outputDir,"trials",`${item.task_id}-${item.trial}.json`),{task_id:item.task_id,trial:item.trial,trial_seed:trialSeed,order:item.order,results:pair});
  }
  const manifest={
    schema_version:EXPERIMENT_SCHEMA_VERSION, experiment_id:stableId("exp",{suite:config.suite.digest,seed:config.run_seed,profiles:[config.baseline.profile.id,config.candidate.profile.id]}),
    run_id:runId, suite:{id:config.suite.id,revision:config.suite.revision,digest:config.suite.digest}, run_seed:config.run_seed,
    trials:config.trials, schedule, profiles:{baseline:sanitizeProfile(config.baseline.profile),candidate:sanitizeProfile(config.candidate.profile)}, records,
    note:"Agent outcomes are execution evidence only. Independent benchmark scoring remains authoritative."
  };
  manifest.manifest_sha256=sha256(manifest);
  writeJson(path.join(outputDir,"experiment.json"),manifest);
  return manifest;
}
function sanitizeProfile(profile){ const {command,args,secret_env_names,env_passthrough,mcp,...safe}=profile; return {...safe,command_basename:path.basename(command),args_count:(args??[]).length,secret_env_names:[...(secret_env_names??[])],env_passthrough:[...(env_passthrough??[])],mcp:mcp?{command_basename:path.basename(mcp.command??""),args_count:(mcp.args??[]).length}:undefined}; }
export function loadExperimentConfig(file){ return validatePairConfig(loadJson(file)); }
