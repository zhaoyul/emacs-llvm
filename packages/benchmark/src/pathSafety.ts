import fs from "node:fs";
import path from "node:path";

export function normalizeRelativePath(value: string, label = "path"): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  if (value.includes("\0")) throw new TypeError(`${label} contains a NUL byte.`);
  const portable = value.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//u.test(portable)) throw new TypeError(`${label} must be relative.`);
  const normalized = path.posix.normalize(portable);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) throw new TypeError(`${label} escapes its root.`);
  return normalized;
}

export function resolveInside(root: string, relative: string, label = "path"): string {
  const safe = normalizeRelativePath(relative, label);
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, safe);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) throw new TypeError(`${label} escapes its root.`);
  return candidate;
}

export function assertNoSymlinkPath(root: string, target: string, label = "path"): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) throw new TypeError(`${label} escapes its root.`);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new TypeError(`${label} traverses a symbolic link: ${path.relative(resolvedRoot, current)}`);
  }
}


function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

export function pathMatchesPattern(relative: string, pattern: string): boolean {
  const target = normalizeRelativePath(relative);
  const normalized = normalizeRelativePath(pattern, "path pattern");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      if (normalized[index + 2] === "/") { source += "(?:.*/)?"; index += 2; }
      else { source += ".*"; index += 1; }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`, "u").test(target);
}

export function pathMatchesAny(relative: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pathMatchesPattern(relative, pattern));
}

export function isProtectedPath(relative: string, protectedPaths: string[]): boolean {
  const normalized = normalizeRelativePath(relative);
  return protectedPaths.some((item) => {
    const protectedPath = normalizeRelativePath(item, "protected path");
    return normalized === protectedPath || normalized.startsWith(`${protectedPath}/`) || pathMatchesPattern(normalized, protectedPath);
  });
}
