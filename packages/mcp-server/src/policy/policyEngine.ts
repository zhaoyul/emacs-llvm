import path from "node:path";
import { OperatorError } from "../../../protocol/src/errors.js";
import type { EmacsSession, ExecutionChannel } from "../../../protocol/src/types.js";

export interface PermissionProfile {
  name: string;
  mutations: boolean;
  nativeKeys: boolean;
  nativeCapture: boolean;
  arbitraryElisp: boolean;
  structuredEval: boolean;
  saveOutsideWorkspace: boolean;
}

const profiles: Record<string, PermissionProfile> = {
  read_only: {
    name: "read_only",
    mutations: false,
    nativeKeys: false,
    nativeCapture: false,
    arbitraryElisp: false,
    structuredEval: false,
    saveOutsideWorkspace: false
  },
  workspace_edit: {
    name: "workspace_edit",
    mutations: true,
    nativeKeys: false,
    nativeCapture: false,
    arbitraryElisp: false,
    structuredEval: false,
    saveOutsideWorkspace: false
  },
  trusted_local: {
    name: "trusted_local",
    mutations: true,
    nativeKeys: true,
    nativeCapture: true,
    arbitraryElisp: false,
    structuredEval: true,
    saveOutsideWorkspace: true
  }
};

export class PolicyEngine {
  profile(name: string): PermissionProfile {
    const profile = profiles[name];
    if (!profile) throw new OperatorError("E_POLICY_DENIED", `Unknown permission profile: ${name}.`);
    return profile;
  }

  assertMutation(session: EmacsSession): void {
    if (!this.profile(session.permissionProfile).mutations) {
      throw new OperatorError("E_POLICY_DENIED", `Permission profile ${session.permissionProfile} is read-only.`);
    }
  }

  assertChannel(session: EmacsSession, channel: ExecutionChannel): void {
    if (!session.capabilities.channels[channel]) {
      throw new OperatorError("E_POLICY_DENIED", `Execution channel ${channel} is unavailable for this session.`);
    }
    if (channel === "native_keys" && !this.profile(session.permissionProfile).nativeKeys) {
      throw new OperatorError("E_POLICY_DENIED", "Native key injection is not authorized by this permission profile.");
    }
  }

  assertCapture(session: EmacsSession): void {
    if (!this.profile(session.permissionProfile).nativeCapture) {
      throw new OperatorError("E_POLICY_DENIED", "Screen capture requires the trusted_local permission profile.");
    }
  }

  assertArbitraryElisp(session: EmacsSession): void {
    if (!this.profile(session.permissionProfile).arbitraryElisp) {
      throw new OperatorError("E_POLICY_DENIED", "Arbitrary Emacs Lisp evaluation is disabled by policy.");
    }
  }

  assertStructuredEval(session: EmacsSession): void {
    if (!this.profile(session.permissionProfile).structuredEval) {
      throw new OperatorError("E_POLICY_DENIED", "Structured language evaluation requires the trusted_local permission profile.");
    }
  }

  assertFilePath(session: EmacsSession, file: string): void {
    const profile = this.profile(session.permissionProfile);
    if (profile.saveOutsideWorkspace) return;
    const root = session.target.projectRoot;
    if (!root) throw new OperatorError("E_POLICY_DENIED", "No workspace/project root is associated with this session.");
    const resolvedRoot = path.resolve(root);
    const resolvedFile = path.resolve(file);
    const relative = path.relative(resolvedRoot, resolvedFile);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
    throw new OperatorError("E_POLICY_DENIED", "File mutation is outside the authorized workspace.", {
      project_root: resolvedRoot,
      file: resolvedFile
    });
  }
}
