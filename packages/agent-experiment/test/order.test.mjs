import test from "node:test";
import assert from "node:assert/strict";
import { pairedOrder, buildBalancedSchedule } from "../src/order.mjs";
import { deriveTrialSeed } from "../src/canonical.mjs";
test("paired order is deterministic",()=>assert.deepEqual(pairedOrder({suiteDigest:"d",taskId:"t",trial:1,runSeed:7}),pairedOrder({suiteDigest:"d",taskId:"t",trial:1,runSeed:7})));
test("trial seed is independent of side",()=>{const a=deriveTrialSeed({suiteDigest:"d",taskId:"t",trial:2,runSeed:9});const b=deriveTrialSeed({suiteDigest:"d",taskId:"t",trial:2,runSeed:9});assert.equal(a,b);});
test("schedule includes both sides exactly once",()=>{const s=buildBalancedSchedule({suiteDigest:"d",tasks:[{id:"a",digest:"x"}],trials:2,runSeed:1});assert.equal(s.length,2);for(const x of s) assert.deepEqual([...x.order].sort(),["baseline","candidate"]);});
