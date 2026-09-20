import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPairedExperiment, validatePairConfig } from "../src/experiment.mjs";
const mock=path.resolve("packages/agent-experiment/fixtures/mock-agent.mjs");
function profile(id,tool){return{id,command:process.execPath,args:[mock],tool_profile:tool,provider:"p",model:"m",model_version:"1",prompt_policy:"identical",temperature:0,top_p:1,max_context_tokens:100,cross_trial_memory:"disabled",network_access:"disabled",pairing_key:"pair",mcp:{command:process.execPath,args:[mock]}};}
test("profile mismatch is rejected",()=>{const c={schema_version:"1.0",run_seed:1,trials:1,suite:{id:"s",digest:"d",tasks:[]},baseline:{profile:profile("b","fs")},candidate:{profile:{...profile("c","emacs"),model:"other"}}};assert.throws(()=>validatePairConfig(c),/model/);});
test("paired runner executes both isolated sides with same seed",async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),"pair-"));const fixtures=path.join(root,"fixtures");fs.mkdirSync(path.join(fixtures,"task"),{recursive:true});fs.writeFileSync(path.join(fixtures,"task","input.txt"),"x");const out=path.join(root,"out");try{const cfg={schema_version:"1.0",run_seed:7,trials:1,timeout_ms:5000,output_dir:out,suite:{id:"s",revision:"1",digest:"digest",tasks:[{id:"t",digest:"td",fixture:"task",prompt:"p"}]},baseline:{profile:profile("b","filesystem")},candidate:{profile:profile("c","emacs")},workspace_factory:{root:path.join(root,"work"),fixtures_root:fixtures}};const m=await runPairedExperiment(cfg);assert.equal(m.records.length,2);assert.equal(m.records[0].trial_seed,m.records[1].trial_seed);assert.notEqual(m.records[0].workspace,m.records[1].workspace);assert.ok(fs.existsSync(path.join(out,"experiment.json")));assert.equal(m.records.every((r)=>r.outcome.ok),true);}finally{fs.rmSync(root,{recursive:true,force:true});}});
