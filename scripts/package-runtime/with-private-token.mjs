import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { generatePrivateTokenFile } from "./private-token.mjs";

const sep = process.argv.indexOf("--");
if (sep < 0 || sep === process.argv.length - 1) {
  process.stderr.write("Usage: with-private-token.mjs -- <command> [args...]\n");
  process.exit(64);
}
const command = process.argv[sep + 1];
const args = process.argv.slice(sep + 2);
const directory = await mkdtemp(join(tmpdir(), "emacs-operator-token-"));
const tokenPath = join(directory, "token");
try {
  await generatePrivateTokenFile(tokenPath);
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, EMACS_OPERATOR_TOKEN_FILE: tokenPath },
    detached: process.platform !== "win32",
  });
  const forward = (signal) => { try { child.kill(signal); } catch {} };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  const code = await new Promise((resolve) => child.once("exit", (value, signal) => resolve(value ?? (signal ? 128 : 1))));
  process.exitCode = code;
} finally {
  await rm(directory, { recursive: true, force: true });
}
