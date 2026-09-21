import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { X11Backend } from "../src/x11-backend.mjs";

test("stateful X11 desktop operations are serialized across concurrent callers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "emacs-linux-serialize-"));
  const helper = path.join(directory, "helper.mjs");
  const log = path.join(directory, "operations.log");
  fs.writeFileSync(helper, `#!/usr/bin/env node\nimport fs from "node:fs";\nconst log=${JSON.stringify(log)};\nconst command=process.argv[2];\nfs.appendFileSync(log, \`start:\${command}\\n\`);\nawait new Promise(r=>setTimeout(r,80));\nfs.appendFileSync(log, \`end:\${command}\\n\`);\nif(command==="frontmost") console.log(JSON.stringify({ok:true,application:{pid:1,name:"probe"}}));\nelse if(command==="capabilities") console.log(JSON.stringify({ok:true,xtest:true,window_focus:true,window_capture:true,frontmost_query:true,unicode_dynamic_mapping:true,display:":test"}));\nelse console.log(JSON.stringify({ok:false,code:"E_INVALID_ARGUMENT",message:"unexpected"}));\n`);
  fs.chmodSync(helper, 0o700);
  const backend = new X11Backend({ helperPath: helper, runtimeDirectory: directory });
  try {
    const started = Date.now();
    const [first, second] = await Promise.all([backend.frontmostApplication(), backend.frontmostApplication()]);
    const elapsed = Date.now() - started;
    assert.equal(first.pid, 1);
    assert.equal(second.pid, 1);
    assert.ok(elapsed >= 140, `expected serialized operations, elapsed=${elapsed}`);
    assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), [
      "start:frontmost", "end:frontmost", "start:frontmost", "end:frontmost"
    ]);
  } finally {
    backend.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
