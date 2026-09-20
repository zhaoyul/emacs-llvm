import fs from "node:fs";
import path from "node:path";
import type { BenchmarkTask } from "./types.js";

export function findExecutable(name: string, envPath = process.env.PATH ?? ""): string | null {
  if (name.includes("/") || name.includes("\\")) {
    const full = path.resolve(name);
    try { fs.accessSync(full, fs.constants.X_OK); return fs.statSync(full).isFile() ? full : null; } catch { return null; }
  }
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const directory of envPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, process.platform === "win32" ? `${name}${extension}` : name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* continue */ }
    }
  }
  return null;
}

export function taskAvailability(task: BenchmarkTask): { available: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const requirements = task.requirements;
  if (requirements?.platforms && !requirements.platforms.includes(process.platform)) reasons.push(`platform ${process.platform} is not in ${requirements.platforms.join(", ")}`);
  for (const executable of requirements?.executables ?? []) if (!findExecutable(executable)) reasons.push(`missing executable: ${executable}`);
  for (const variable of requirements?.environment ?? []) if (!process.env[variable]) reasons.push(`missing environment variable: ${variable}`);
  return { available: reasons.length === 0, reasons };
}
