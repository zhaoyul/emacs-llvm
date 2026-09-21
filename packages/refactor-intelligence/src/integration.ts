// @ts-nocheck
import {decideVerificationRerun} from "./rerun.js";

export function normalizeAnalysisEnvelope(value) {
  if (value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value,"analysis")) return value.analysis;
  return value;
}

export function buildExtractFunctionArguments({analysis,explicitParameters,newName,bounds,language="auto"}={}) {
  const normalized=normalizeAnalysisEnvelope(analysis) ?? {};
  const unresolved=Array.isArray(normalized.unresolved) ? normalized.unresolved : [];
  const inferred=Array.isArray(normalized.parameters) ? normalized.parameters : [];
  const parameters=explicitParameters ?? inferred;
  if (!Array.isArray(bounds)||bounds.length!==2||!bounds.every(Number.isInteger)) throw new TypeError("bounds must be [start,end]");
  if (typeof newName!=="string"||newName.length===0) throw new TypeError("newName is required");
  if (explicitParameters===undefined && unresolved.length>0) {
    const error=new Error("parameter inference is unresolved; provide explicitParameters or narrow the selection");
    error.code="E_ANALYSIS_UNRESOLVED"; error.unresolved=unresolved; throw error;
  }
  return {operation:"extract_function",new_name:newName,bounds,parameters,language,analysis_source_sha256:normalized.source_sha256 ?? null};
}

export function projectRenameCommandSequence({oldSymbol,newSymbol,includeDefinitions=true,planId}={}) {
  if (!planId) return [{tool:"emacs_command",command:"emacs-operator-project-rename-plan",arguments:[oldSymbol,newSymbol,includeDefinitions],mutates:false}];
  return [{tool:"emacs_command",command:"emacs-operator-project-rename-apply",arguments:[planId],mutates:true,save:false}];
}

export async function runGuardedVerification({evaluate,repair,initialAttempt,maxAttempts=3,sideEffectRisk="unknown",allowRiskyRerun=false}={}) {
  if (typeof evaluate!=="function") throw new TypeError("evaluate callback is required");
  const attempts=[];
  if (initialAttempt) attempts.push(initialAttempt);
  while (true) {
    const decision=decideVerificationRerun(attempts,{maxAttempts,sideEffectRisk,allowRiskyRerun});
    if (decision.action==="stop") return {status:decision.reason==="completed"?"completed":"stopped",reason:decision.reason,attempts};
    if (decision.action==="rerun" && typeof repair==="function") await repair({attempts:[...attempts],decision});
    const result=await evaluate({attempt:decision.attempt,previous:attempts.at(-1) ?? null});
    attempts.push(result);
  }
}
