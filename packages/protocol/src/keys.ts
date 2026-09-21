import { OperatorError } from "./errors.js";
import type { CanonicalKeyEvent, InternalKeyStep } from "./types.js";

const modifiers = new Set(["control", "meta", "shift", "super", "hyper", "alt", "command", "option", "fn"]);

export function validateCanonicalKeyEvent(value: unknown): CanonicalKeyEvent {
  if (!value || typeof value !== "object") throw new OperatorError("E_SCHEMA_VALIDATION", "Key event must be an object.");
  const event = value as Record<string, unknown>;
  if (!new Set(["key_down", "key_up", "key_press", "text"]).has(String(event.kind))) {
    throw new OperatorError("E_SCHEMA_VALIDATION", "Invalid key event kind.");
  }
  if (event.kind === "text" && typeof event.text !== "string") {
    throw new OperatorError("E_SCHEMA_VALIDATION", "Text key event requires text.");
  }
  if (event.modifiers !== undefined) {
    if (!Array.isArray(event.modifiers) || event.modifiers.some((item) => typeof item !== "string" || !modifiers.has(item))) {
      throw new OperatorError("E_SCHEMA_VALIDATION", "Invalid key modifiers.");
    }
  }
  return event as unknown as CanonicalKeyEvent;
}

export function validateInternalKeySteps(value: unknown): InternalKeyStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new OperatorError("E_SCHEMA_VALIDATION", "steps must be a non-empty array.");
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new OperatorError("E_SCHEMA_VALIDATION", `steps[${index}] must be an object.`);
    const step = raw as Record<string, unknown>;
    if (step.kind === "keys" || step.kind === "text") {
      if (typeof step.value !== "string") throw new OperatorError("E_SCHEMA_VALIDATION", `steps[${index}].value must be a string.`);
      return step as unknown as InternalKeyStep;
    }
    if (step.kind === "event") {
      validateCanonicalKeyEvent(step.event);
      return step as unknown as InternalKeyStep;
    }
    if (step.kind === "expect") {
      if (!step.condition || typeof step.condition !== "object") {
        throw new OperatorError("E_SCHEMA_VALIDATION", `steps[${index}].condition must be an object.`);
      }
      return step as unknown as InternalKeyStep;
    }
    throw new OperatorError("E_SCHEMA_VALIDATION", `Unsupported key step kind at index ${index}.`);
  });
}
