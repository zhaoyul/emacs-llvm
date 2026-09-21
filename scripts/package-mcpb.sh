#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(python3 -c 'import json; print(json.load(open("packaging/mcpb/manifest.json"))["version"])' 2>/dev/null || true)"
if [[ -z "$VERSION" ]]; then
  cd "$ROOT"
  VERSION="$(python3 -c 'import json; print(json.load(open("packaging/mcpb/manifest.json"))["version"])')"
fi
OUT="${1:-$ROOT/dist/emacs-operator-$VERSION.mcpb}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cd "$ROOT"
npm run build >/dev/null

mkdir -p "$STAGE/server" "$STAGE/companion/lisp" "$STAGE/companion/skill"
cp packaging/mcpb/manifest.json "$STAGE/manifest.json"
cp packaging/mcpb/README.md "$STAGE/README.md"
cp -R dist/packages "$STAGE/server/packages"
# Development, acceptance, and test assets are not production MCP dependencies.
rm -rf "$STAGE/server/packages/benchmark" "$STAGE/server/packages/test-harness"
find "$STAGE/server/packages" -type d -name test -prune -exec rm -rf {} +
find "$STAGE/server/packages/mcp-server/src" -maxdepth 1 -type f -name '*Acceptance.js' -delete
cat > "$STAGE/server/package.json" <<'JSON'
{
  "name": "emacs-operator-mcpb-server",
  "version": "__EMACS_OPERATOR_VERSION__",
  "private": true,
  "type": "module"
}
JSON
cp lisp/*.el "$STAGE/companion/lisp/"
cp -R lisp/adapters "$STAGE/companion/lisp/adapters"
cp -R skills/emacs-native-operator "$STAGE/companion/skill/emacs-native-operator"
sed -i.bak "s/__EMACS_OPERATOR_VERSION__/$VERSION/g" "$STAGE/server/package.json" && rm -f "$STAGE/server/package.json.bak"

python3 - "$STAGE" "$OUT" <<'PY'
import json, os, pathlib, re, sys, zipfile
stage = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
manifest = json.loads((stage / 'manifest.json').read_text(encoding='utf-8'))
required = ['manifest_version', 'name', 'version', 'description', 'author', 'server']
missing = [key for key in required if key not in manifest]
if missing:
    raise SystemExit(f'MCPB manifest missing required fields: {missing}')
if manifest['manifest_version'] != '0.3':
    raise SystemExit('MCPB alpha packaging expects manifest_version 0.3')
if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?', manifest['version']):
    raise SystemExit('MCPB manifest version is not SemVer-like')
server = manifest['server']
if server.get('type') != 'node':
    raise SystemExit('MCPB server.type must be node for this package')
entry = stage / server.get('entry_point', '')
if not entry.is_file():
    raise SystemExit(f'MCPB entry point does not exist: {entry}')
if not isinstance(manifest.get('author'), dict) or not manifest['author'].get('name'):
    raise SystemExit('MCPB author.name is required')
out.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for path in sorted(stage.rglob('*')):
        if path.is_file():
            zf.write(path, path.relative_to(stage).as_posix())
with zipfile.ZipFile(out, 'r') as zf:
    names = set(zf.namelist())
    if 'manifest.json' not in names or server['entry_point'] not in names:
        raise SystemExit('MCPB archive validation failed')
print(out)
PY

if command -v mcpb >/dev/null 2>&1; then
  echo "mcpb CLI detected. Bundle created with the project packer; run 'mcpb verify' or your host's validator as an additional release gate." >&2
fi

echo "Built MCPB: $OUT"
