export class AgentExperimentError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "AgentExperimentError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
export function invariant(condition, code, message, details) {
  if (!condition) throw new AgentExperimentError(code, message, details);
}
export function errorToObject(error) {
  if (error instanceof AgentExperimentError) {
    return { name: error.name, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  return { name: error?.name ?? "Error", code: "E_UNEXPECTED", message: String(error?.message ?? error) };
}
