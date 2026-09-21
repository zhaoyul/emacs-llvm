import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generatePrivateTokenFile, validatePrivateTokenFile } from "./private-token.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "emacs-operator-token-test-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("generates 256-bit lowercase hex token without exposing it", async (t) => {
  const root = await fixture(t);
  const path = join(root, "token");
  const metadata = await generatePrivateTokenFile(path);
  assert.equal(Object.hasOwn(metadata, "token"), false);
  const value = (await readFile(path, "utf8")).trim();
  assert.match(value, /^[0-9a-f]{64}$/);
  const checked = await validatePrivateTokenFile(path);
  assert.equal(checked.token, value);
  assert.equal(checked.mode & 0o077, 0);
});

test("refuses to overwrite an existing token", async (t) => {
  const root = await fixture(t);
  const path = join(root, "token");
  await generatePrivateTokenFile(path);
  await assert.rejects(() => generatePrivateTokenFile(path), { code: "E_TOKEN_FILE_EXISTS" });
});

test("rejects permissive token modes", async (t) => {
  const root = await fixture(t);
  const path = join(root, "token");
  await writeFile(path, `${"a".repeat(64)}\n`, { mode: 0o644 });
  await chmod(path, 0o644);
  await assert.rejects(() => validatePrivateTokenFile(path), { code: "E_TOKEN_FILE_MODE" });
});

test("rejects malformed token contents", async (t) => {
  const root = await fixture(t);
  const path = join(root, "token");
  await writeFile(path, "not-a-token\n", { mode: 0o600 });
  await assert.rejects(() => validatePrivateTokenFile(path), { code: "E_TOKEN_FILE_SIZE" });
});

test("rejects symlink token paths", async (t) => {
  const root = await fixture(t);
  const real = join(root, "real");
  const link = join(root, "token");
  await writeFile(real, `${"b".repeat(64)}\n`, { mode: 0o600 });
  await symlink(real, link);
  await assert.rejects(() => validatePrivateTokenFile(link), { code: "E_TOKEN_FILE_INVALID" });
});

test("creates distinct tokens for distinct instances", async (t) => {
  const root = await fixture(t);
  const first = join(root, "one");
  const second = join(root, "two");
  await Promise.all([generatePrivateTokenFile(first), generatePrivateTokenFile(second)]);
  assert.notEqual((await readFile(first, "utf8")).trim(), (await readFile(second, "utf8")).trim());
});
