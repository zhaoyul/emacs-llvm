// @ts-nocheck
import {sha256} from "./scanner.js";

export function attemptFingerprint(attempt) {
  return sha256(JSON.stringify({adapter:attempt.adapter ?? null,operation:attempt.operation ?? null,source_sha256:attempt.source_sha256 ?? null,condition:attempt.condition ?? null,stderr:attempt.stderr ?? null,value:attempt.value ?? null,completed:Boolean(attempt.completed)}));
}
export function decideVerificationRerun(attempts,{maxAttempts=3,sideEffectRisk="unknown",allowRiskyRerun=false}={}) {
  if (!Array.isArray(attempts)||attempts.length===0) return {action:"run",reason:"no_attempt_yet",attempt:1};
  if (!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>3) throw new RangeError("maxAttempts must be between 1 and 3");
  const last=attempts.at(-1);
  if (last.completed===true) return {action:"stop",reason:"completed",attempt:attempts.length};
  if (attempts.length>=maxAttempts) return {action:"stop",reason:"max_attempts",attempt:attempts.length};
  if (["high","unknown"].includes(sideEffectRisk)&&!allowRiskyRerun) return {action:"stop",reason:"runtime_side_effect_risk",attempt:attempts.length};
  const fp=attemptFingerprint(last);
  if (attempts.slice(0,-1).some((a)=>attemptFingerprint(a)===fp)) return {action:"stop",reason:"repeated_failure",attempt:attempts.length};
  const previous=attempts.at(-2);
  if (previous && previous.source_sha256===last.source_sha256 && previous.condition===last.condition) return {action:"stop",reason:"unchanged_source_and_condition",attempt:attempts.length};
  return {action:"rerun",reason:"changed_source_after_failure",attempt:attempts.length+1};
}
