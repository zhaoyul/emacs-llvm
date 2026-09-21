import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

const TOKEN_RE = /^[0-9a-f]{64}$/;

function fail(message, code = "E_TOKEN_FILE_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function assertPrivateDirectory(directory) {
  const absolute = resolve(directory);
  const attrs = await lstat(absolute);
  if (!attrs.isDirectory() || attrs.isSymbolicLink()) {
    fail(`Token parent is not a real directory: ${absolute}`, "E_TOKEN_PARENT_INVALID");
  }
  if (typeof process.getuid === "function" && attrs.uid !== process.getuid()) {
    fail(`Token parent is not owned by the current user: ${absolute}`, "E_TOKEN_PARENT_OWNER");
  }
  if ((attrs.mode & 0o077) !== 0) {
    fail(`Token parent permissions are too broad: ${absolute}`, "E_TOKEN_PARENT_MODE");
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) {
    fail(`Token parent contains a symbolic-link component: ${absolute}`, "E_TOKEN_PARENT_SYMLINK");
  }
  return absolute;
}

export async function validatePrivateTokenFile(filePath) {
  const absolute = resolve(filePath);
  const parent = await assertPrivateDirectory(dirname(absolute));
  if (resolve(dirname(absolute)) !== parent) {
    fail("Token file escaped its private parent", "E_TOKEN_PATH_ESCAPE");
  }
  const attrs = await lstat(absolute);
  if (!attrs.isFile() || attrs.isSymbolicLink()) {
    fail(`Token path is not a regular non-symlink file: ${absolute}`);
  }
  if (typeof process.getuid === "function" && attrs.uid !== process.getuid()) {
    fail(`Token file is not owned by the current user: ${absolute}`, "E_TOKEN_FILE_OWNER");
  }
  if ((attrs.mode & 0o077) !== 0) {
    fail(`Token file permissions are too broad: ${absolute}`, "E_TOKEN_FILE_MODE");
  }
  if (attrs.size < 64 || attrs.size > 66) {
    fail(`Token file has an invalid size: ${attrs.size}`, "E_TOKEN_FILE_SIZE");
  }
  const value = (await readFile(absolute, "utf8")).trim();
  if (!TOKEN_RE.test(value)) {
    fail("Token file must contain exactly 64 lowercase hexadecimal characters", "E_TOKEN_FILE_FORMAT");
  }
  return { path: absolute, token: value, mode: attrs.mode & 0o777, bytes: attrs.size };
}

export async function generatePrivateTokenFile(filePath) {
  const absolute = resolve(filePath);
  const parent = dirname(absolute);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await assertPrivateDirectory(parent);

  try {
    await lstat(absolute);
    fail(`Refusing to overwrite an existing token path: ${absolute}`, "E_TOKEN_FILE_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("hex");
  const temporary = `${absolute}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;
  let handle;
  try {
    handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);

    // link(2) gives no-replace atomic publication on the same filesystem.
    await link(temporary, absolute);
    await unlink(temporary);
    const dirHandle = await open(parent, fsConstants.O_RDONLY);
    try {
      try { await dirHandle.sync(); }
      catch (error) { if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error?.code)) throw error; }
    } finally { await dirHandle.close(); }
    const result = await validatePrivateTokenFile(absolute);
    return { path: result.path, mode: result.mode, bytes: result.bytes };
  } catch (error) {
    try { if (handle) await handle.close(); } catch {}
    try { await rm(temporary, { force: true }); } catch {}
    throw error;
  }
}

async function main(argv) {
  const [command, filePath] = argv;
  if (!filePath || !["generate", "validate"].includes(command)) {
    process.stderr.write("Usage: private-token.mjs <generate|validate> <absolute-path>\n");
    process.exitCode = 64;
    return;
  }
  const result = command === "generate"
    ? await generatePrivateTokenFile(filePath)
    : await validatePrivateTokenFile(filePath);
  // Never print the token itself.
  process.stdout.write(`${JSON.stringify({ ok: true, path: result.path, mode: result.mode, bytes: result.bytes })}\n`);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? "E_TOKEN", message: error.message })}\n`);
    process.exitCode = 1;
  });
}
