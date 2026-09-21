import test from "node:test"; import assert from "node:assert/strict"; import {decideVerificationRerun} from "../src/index.js";
const failure=(hash,condition='error')=>({completed:false,source_sha256:hash,condition,adapter:'cider',operation:'eval_defun'});
test("does not automatically repeat unknown side effects",()=>{assert.equal(decideVerificationRerun([failure('a')]).reason,'runtime_side_effect_risk');});
test("allows one rerun after source changed",()=>{const r=decideVerificationRerun([failure('a'),failure('b')],{sideEffectRisk:'low'});assert.equal(r.action,'rerun');assert.equal(r.attempt,3);});
test("stops identical failures",()=>{const a=failure('a');assert.equal(decideVerificationRerun([a,a],{sideEffectRisk:'low'}).reason,'repeated_failure');});
test("caps attempts at three",()=>{assert.equal(decideVerificationRerun([failure('a'),failure('b'),failure('c')],{sideEffectRisk:'low'}).reason,'max_attempts');});
