import fs from "node:fs";
import path from "node:path";
import { sha256Bytes } from "./hash.js";
import { isProtectedPath, pathMatchesAny } from "./pathSafety.js";
import type { WorkspaceDiffSummary, WorkspaceFileRecord, WorkspaceSnapshot } from "./types.js";

export const BENCHMARK_PRIVATE_DIRECTORY = ".emacs-operator-benchmark";

function shouldIgnore(relative: string): boolean {
  return relative === BENCHMARK_PRIVATE_DIRECTORY || relative.startsWith(`${BENCHMARK_PRIVATE_DIRECTORY}/`);
}

export function copyFixtureTree(source: string, destination: string, maxBytes: number): number {
  let total = 0;
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const visit = (from: string, to: string): void => {
    const entries = fs.readdirSync(from, { withFileTypes: true }).sort((left: any, right: any) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      const stat = fs.lstatSync(src);
      if (stat.isSymbolicLink()) throw new TypeError(`Fixture contains a symbolic link: ${path.relative(source, src)}`);
      if (entry.isDirectory()) {
        fs.mkdirSync(dst, { recursive: true, mode: stat.mode & 0o777 });
        visit(src, dst);
      } else if (entry.isFile()) {
        total += stat.size;
        if (total > maxBytes) throw new TypeError(`Fixture exceeds max_workspace_bytes (${maxBytes}).`);
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(dst, stat.mode & 0o777);
      } else {
        throw new TypeError(`Fixture contains a non-regular file: ${path.relative(source, src)}`);
      }
    }
  };
  visit(source, destination);
  return total;
}

export function snapshotWorkspace(root: string, maxBytes: number): WorkspaceSnapshot {
  const files: WorkspaceFileRecord[] = [];
  let total = 0;
  const visit = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left: any, right: any) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).replaceAll(path.sep, "/");
      if (shouldIgnore(relative)) continue;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new TypeError(`Workspace contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        total += stat.size;
        if (total > maxBytes) throw new TypeError(`Workspace exceeds max_workspace_bytes (${maxBytes}).`);
        const bytes = fs.readFileSync(full);
        files.push({ path: relative, bytes: stat.size, sha256: sha256Bytes(bytes), mode: stat.mode & 0o777 });
      } else throw new TypeError(`Workspace contains a non-regular file: ${relative}`);
    }
  };
  visit(root);
  const digest = sha256Bytes(files.map((item) => `${item.path}:${item.bytes}:${item.mode}:${item.sha256}`).join("\n"));
  return { digest, total_bytes: total, files };
}

export function diffWorkspace(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDiffSummary {
  const left = new Map(before.files.map((item) => [item.path, item]));
  const right = new Map(after.files.map((item) => [item.path, item]));
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  let unchanged = 0;
  for (const [file, record] of right) {
    const previous = left.get(file);
    if (!previous) added.push(file);
    else if (previous.sha256 !== record.sha256 || previous.mode !== record.mode) modified.push(file);
    else unchanged += 1;
  }
  for (const file of left.keys()) if (!right.has(file)) deleted.push(file);
  added.sort(); modified.sort(); deleted.sort();
  return { added, modified, deleted, unchanged, changed_files: added.length + modified.length + deleted.length, bytes_before: before.total_bytes, bytes_after: after.total_bytes };
}

export function protectedPathViolations(diff: WorkspaceDiffSummary, protectedPaths: string[]): string[] {
  if (protectedPaths.length === 0) return [];
  return [...diff.added, ...diff.modified, ...diff.deleted].filter((item) => isProtectedPath(item, protectedPaths)).sort();
}

export function unauthorizedPathViolations(diff: WorkspaceDiffSummary, allowedPaths: string[]): string[] {
  if (allowedPaths.length === 0) return [];
  return [...diff.added, ...diff.modified, ...diff.deleted].filter((item) => !pathMatchesAny(item, allowedPaths)).sort();
}
