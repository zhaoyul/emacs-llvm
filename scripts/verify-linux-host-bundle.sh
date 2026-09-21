#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "verify-linux-host-bundle.sh must run on Linux." >&2
  exit 64
fi

BUNDLE="${1:-}"
REPORT="${2:-}"
if [[ -z "$BUNDLE" || ! -f "$BUNDLE" ]]; then
  echo "Usage: $0 BUNDLE.tar.gz [REPORT.json]" >&2
  exit 64
fi
for command in python3 node xvfb-run tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing required command: $command" >&2; exit 69; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/emacs-operator-linux-bundle.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM
mkdir -p "$WORK/extract" "$WORK/home" "$WORK/prefix"
chmod 700 "$WORK" "$WORK/home" "$WORK/prefix"

# Validate member names and reject links before extraction. The release bundle
# intentionally contains regular files and directories only.
python3 - "$BUNDLE" <<'PY'
import sys, tarfile
from pathlib import PurePosixPath
bundle=sys.argv[1]
with tarfile.open(bundle, 'r:gz') as archive:
    members=archive.getmembers()
    if not members:
        raise SystemExit('bundle is empty')
    roots=set()
    for member in members:
        p=PurePosixPath(member.name)
        if p.is_absolute() or '..' in p.parts:
            raise SystemExit(f'unsafe archive member: {member.name}')
        if member.issym() or member.islnk() or member.isdev():
            raise SystemExit(f'unsupported archive member type: {member.name}')
        if p.parts:
            roots.add(p.parts[0])
    if len(roots) != 1:
        raise SystemExit(f'bundle must have one top-level directory, found {sorted(roots)}')
PY

tar -xzf "$BUNDLE" -C "$WORK/extract"
ROOT="$(find "$WORK/extract" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -n "$ROOT" && -x "$ROOT/install.sh" && -x "$ROOT/uninstall.sh" ]] || { echo "Malformed Linux Host bundle." >&2; exit 65; }

MANIFEST_JSON="$WORK/manifest-check.json"
python3 - "$ROOT" "$MANIFEST_JSON" <<'PY'
from pathlib import Path
import hashlib, json, sys
root=Path(sys.argv[1])
out=Path(sys.argv[2])
manifest=json.loads((root/'manifest.json').read_text())
verified=[]
for item in manifest.get('files', []):
    rel=Path(item['path'])
    if rel.is_absolute() or '..' in rel.parts:
        raise SystemExit(f'unsafe manifest path: {rel}')
    file=root/rel
    if not file.is_file() or file.is_symlink():
        raise SystemExit(f'manifest entry is not a regular file: {rel}')
    digest=hashlib.sha256(file.read_bytes()).hexdigest()
    if file.stat().st_size != item['bytes'] or digest != item['sha256']:
        raise SystemExit(f'manifest mismatch: {rel}')
    verified.append(rel.as_posix())
result={
    'manifest_ok': True,
    'version': manifest.get('version'),
    'platform': manifest.get('platform'),
    'architecture': manifest.get('architecture'),
    'backend': manifest.get('backend'),
    'verified_files': len(verified),
}
out.write_text(json.dumps(result, indent=2)+'\n')
PY

HOME="$WORK/home" EMACS_OPERATOR_LINUX_PREFIX="$WORK/prefix" "$ROOT/install.sh" >"$WORK/install.log" 2>&1
[[ -x "$WORK/prefix/bin/emacs-operator-linux-host" ]] || { echo "Installed launcher is missing." >&2; exit 66; }

cat > "$WORK/inside-xvfb.sh" <<'INNER'
#!/usr/bin/env bash
set -Eeuo pipefail
WORK="$1"
PREFIX="$2"
RUNTIME="$WORK/runtime"
CAPTURES="$WORK/captures"
mkdir -p "$RUNTIME" "$CAPTURES"
chmod 700 "$RUNTIME" "$CAPTURES"
EMACS_OPERATOR_DRIVER_RUNTIME_DIR="$RUNTIME" \
EMACS_OPERATOR_CAPTURE_DIR="$CAPTURES" \
EMACS_OPERATOR_LINUX_BACKEND=x11 \
  "$PREFIX/bin/emacs-operator-linux-host" >"$WORK/host.stdout" 2>"$WORK/host.stderr" &
HOST_PID=$!
cleanup_host() {
  kill "$HOST_PID" 2>/dev/null || true
  wait "$HOST_PID" 2>/dev/null || true
}
trap cleanup_host EXIT INT TERM
for _ in $(seq 1 200); do
  [[ -s "$RUNTIME/driver.json" ]] && break
  sleep 0.05
done
[[ -s "$RUNTIME/driver.json" ]] || { echo "Installed Host did not publish driver.json." >&2; exit 67; }
node --input-type=module - "$RUNTIME" "$WORK/rpc-check.json" <<'NODE'
import fs from "node:fs";
import net from "node:net";
const runtime = process.argv[2];
const output = process.argv[3];
const record = JSON.parse(fs.readFileSync(`${runtime}/driver.json`, "utf8"));
const token = fs.readFileSync(record.token_file, "utf8").trim();
const request = { jsonrpc: "2.0", id: 1, method: "driver.initialize", params: { token } };
const body = Buffer.from(JSON.stringify(request));
const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\nContent-Type: application/json\r\n\r\n`), body]);
const socket = net.createConnection({ host: record.host, port: record.port });
let received = Buffer.alloc(0);
const finish = (code, value) => {
  clearTimeout(timer);
  socket.destroy();
  if (value) fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  process.exit(code);
};
const timer = setTimeout(() => finish(2, { ok: false, reason: "Driver RPC timeout" }), 5000);
socket.once("connect", () => socket.write(frame));
socket.on("data", (chunk) => {
  received = Buffer.concat([received, chunk]);
  const delimiter = received.indexOf("\r\n\r\n");
  if (delimiter < 0) return;
  const header = received.subarray(0, delimiter).toString("ascii");
  const match = /Content-Length:\s*(\d+)/i.exec(header);
  if (!match) return;
  const length = Number(match[1]);
  const bodyStart = delimiter + 4;
  if (received.length < bodyStart + length) return;
  const response = JSON.parse(received.subarray(bodyStart, bodyStart + length).toString("utf8"));
  const capabilities = response.result;
  const ok = response.jsonrpc === "2.0" && response.id === 1 && capabilities?.backend === "x11_xtest" &&
    capabilities?.native_keyboard === true && capabilities?.window_focus === true && capabilities?.window_capture === true;
  finish(ok ? 0 : 3, { ok, capabilities });
});
socket.once("error", (error) => finish(4, { ok: false, reason: error.message }));
NODE
INNER
chmod 700 "$WORK/inside-xvfb.sh"
xvfb-run -a -s '-screen 0 1024x768x24 -ac -nolisten tcp' "$WORK/inside-xvfb.sh" "$WORK" "$WORK/prefix"

HOME="$WORK/home" EMACS_OPERATOR_LINUX_PREFIX="$WORK/prefix" "$ROOT/uninstall.sh" >>"$WORK/install.log" 2>&1
[[ ! -e "$WORK/prefix/bin/emacs-operator-linux-host" && ! -e "$WORK/prefix/lib/emacs-operator-linux-host" ]] || {
  echo "Linux Host bundle uninstall left installed files behind." >&2
  exit 68
}

if [[ -n "$REPORT" ]]; then
  mkdir -p "$(dirname "$REPORT")"
  python3 - "$MANIFEST_JSON" "$WORK/rpc-check.json" "$BUNDLE" "$REPORT" <<'PY'
import hashlib, json, sys
from pathlib import Path
manifest=json.loads(Path(sys.argv[1]).read_text())
rpc=json.loads(Path(sys.argv[2]).read_text())
bundle=Path(sys.argv[3])
out=Path(sys.argv[4])
report={
    'schema_version':'1.0',
    'ok': bool(manifest.get('manifest_ok') and rpc.get('ok')),
    'bundle': bundle.name,
    'bundle_bytes': bundle.stat().st_size,
    'bundle_sha256': hashlib.sha256(bundle.read_bytes()).hexdigest(),
    'manifest': manifest,
    'driver_rpc': rpc,
    'install': 'pass',
    'uninstall': 'pass',
}
out.write_text(json.dumps(report, indent=2)+'\n')
PY
  chmod 600 "$REPORT"
fi

echo "Linux Host bundle verification passed: $BUNDLE"
