import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validatePairConfig } from "./experiment.mjs";
import { sha256 } from "./canonical.mjs";
function commandAvailable(command, env=process.env) {
  if (path.isAbsolute(command) || command.includes(path.sep)) return fs.existsSync(command);
  const finder=process.platform==="win32"?"where":"which";
  return spawnSync(finder,[command],{env,stdio:"ignore"}).status===0;
}
export function preflight(config) {
  const checks=[];
  try { validatePairConfig(config); checks.push({name:"config",status:"pass"}); }
  catch(error){ checks.push({name:"config",status:"fail",message:error.message}); return finish(checks); }
  for (const [side,entry] of [["baseline",config.baseline],["candidate",config.candidate]]) {
    checks.push({name:`${side}.driver_command`,status:commandAvailable(entry.profile.command)?"pass":"fail",command:path.basename(entry.profile.command)});
  }
  if (config.candidate.profile.mcp?.command) checks.push({name:"candidate.mcp_command",status:commandAvailable(config.candidate.profile.mcp.command)?"pass":"fail",command:path.basename(config.candidate.profile.mcp.command)});
  checks.push({name:"fixtures_root",status:fs.existsSync(config.workspace_factory.fixtures_root)?"pass":"fail"});
  for (const task of config.suite.tasks) checks.push({name:`fixture:${task.id}`,status:fs.existsSync(path.resolve(config.workspace_factory.fixtures_root,task.fixture))?"pass":"fail"});
  return finish(checks);
}
function finish(checks){ return {schema_version:"1.0",generated_at:new Date().toISOString(),ok:checks.every((c)=>c.status==="pass"),checks,digest:sha256(checks)}; }
