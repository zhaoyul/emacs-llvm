import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function driverRuntimeDirectory(env = process.env) {
  if (env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR) return path.resolve(env.EMACS_OPERATOR_DRIVER_RUNTIME_DIR);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `emacs-operator-driver-${uid}`);
}

export function captureRuntimeDirectory(env = process.env) {
  if (env.EMACS_OPERATOR_CAPTURE_DIR) return path.resolve(env.EMACS_OPERATOR_CAPTURE_DIR);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return path.join(os.tmpdir(), `emacs-operator-captures-${uid}`);
}

function assertPrivateDirectory(directory) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Runtime path is not a private directory: ${directory}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    stat = fs.lstatSync(directory);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Runtime directory is not owned by the current user: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
  stat = fs.lstatSync(directory);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Runtime directory permissions are too broad: ${directory}`);
}

function unlinkIfPresent(file) {
  try { fs.unlinkSync(file); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function atomicPrivateJSON(file, value) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.driver-${process.pid}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function acquireRuntimeLock(lockFile) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
      fs.chmodSync(lockFile, 0o600);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = 0;
      try { owner = Number.parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10); } catch { /* stale or malformed */ }
      if (processAlive(owner)) throw new Error(`A Linux Host is already active for this runtime directory (PID ${owner}).`);
      try { fs.unlinkSync(lockFile); } catch (unlinkError) { if (unlinkError?.code !== "ENOENT") throw unlinkError; }
    }
  }
  throw new Error(`Unable to acquire Linux Host runtime lock: ${lockFile}`);
}

export function createDriverRuntime(env = process.env) {
  const directory = driverRuntimeDirectory(env);
  assertPrivateDirectory(directory);
  const lockFile = path.join(directory, "host.lock");
  const tokenFile = path.join(directory, "token");
  const recordFile = path.join(directory, "driver.json");
  acquireRuntimeLock(lockFile);
  let token;
  try {
    // A crashed previous host can leave stale discovery files behind. Remove
    // them only after acquiring the runtime lock, and create the new token
    // exclusively so a pre-existing symlink is never followed.
    unlinkIfPresent(recordFile);
    unlinkIfPresent(tokenFile);
    token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
    fs.chmodSync(tokenFile, 0o600);
  } catch (error) {
    try { fs.unlinkSync(lockFile); } catch { /* best effort */ }
    throw error;
  }
  const startedAt = new Date().toISOString();

  return {
    directory,
    token,
    tokenFile,
    recordFile,
    lockFile,
    startedAt,
    writeRecord(port) {
      atomicPrivateJSON(recordFile, {
        protocol_version: "1.0",
        pid: process.pid,
        host: "127.0.0.1",
        port,
        token_file: tokenFile,
        started_at: startedAt,
        heartbeat_at: new Date().toISOString(),
        platform: "linux"
      });
    },
    cleanup() {
      for (const file of [recordFile, tokenFile]) {
        try { fs.unlinkSync(file); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
      try {
        const owner = Number.parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
        if (owner === process.pid) fs.unlinkSync(lockFile);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  };
}

export function ensurePrivateCaptureDirectory(env = process.env) {
  const directory = captureRuntimeDirectory(env);
  assertPrivateDirectory(directory);
  return directory;
}
