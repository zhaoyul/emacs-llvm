#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "package-linux-host.sh must run on Linux." >&2
  exit 64
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version' 2>/dev/null || true)"
if [[ -z "$VERSION" ]]; then
  cd "$ROOT"
  VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version')"
fi
ARCH="$(uname -m)"
OUT="${1:-$ROOT/dist/emacs-operator-linux-host-$VERSION-linux-$ARCH.tar.gz}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
BUNDLE="$STAGE/emacs-operator-linux-host-$VERSION"

cd "$ROOT"
make -C apps/linux-host clean all >/dev/null
mkdir -p \
  "$BUNDLE/bin" \
  "$BUNDLE/lib/emacs-operator-linux-host/src" \
  "$BUNDLE/lib/emacs-operator-linux-host/build" \
  "$BUNDLE/share/doc/emacs-operator-linux-host" \
  "$BUNDLE/share/systemd/user"

cp apps/linux-host/src/*.mjs "$BUNDLE/lib/emacs-operator-linux-host/src/"
cp apps/linux-host/build/x11-helper "$BUNDLE/lib/emacs-operator-linux-host/build/"
cp apps/linux-host/build/x11-probe "$BUNDLE/lib/emacs-operator-linux-host/build/"
chmod 755 "$BUNDLE/lib/emacs-operator-linux-host/build/"*
cp docs/linux-host.md docs/linux-acceptance.md "$BUNDLE/share/doc/emacs-operator-linux-host/"
cp packaging/systemd/emacs-operator-linux-host.service "$BUNDLE/share/systemd/user/"

cat > "$BUNDLE/bin/emacs-operator-linux-host" <<'WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$HERE/lib/emacs-operator-linux-host/src/host.mjs" "$@"
WRAPPER
chmod 755 "$BUNDLE/bin/emacs-operator-linux-host"

cat > "$BUNDLE/install.sh" <<'INSTALL'
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${EMACS_OPERATOR_LINUX_PREFIX:-$HOME/.local}"
LIB="$PREFIX/lib/emacs-operator-linux-host"
mkdir -p "$PREFIX/bin" "$PREFIX/lib"
rm -rf "$LIB"
cp -R "$HERE/lib/emacs-operator-linux-host" "$LIB"
cp "$HERE/bin/emacs-operator-linux-host" "$PREFIX/bin/emacs-operator-linux-host"
chmod 755 "$PREFIX/bin/emacs-operator-linux-host" "$LIB/build/x11-helper" "$LIB/build/x11-probe"
if [[ "${EMACS_OPERATOR_INSTALL_SYSTEMD_USER:-0}" == "1" ]]; then
  if [[ "$PREFIX" != "$HOME/.local" ]]; then
    echo "Systemd user installation requires EMACS_OPERATOR_LINUX_PREFIX=$HOME/.local." >&2
    exit 64
  fi
  mkdir -p "$HOME/.config/systemd/user"
  cp "$HERE/share/systemd/user/emacs-operator-linux-host.service" "$HOME/.config/systemd/user/"
  systemctl --user daemon-reload
  systemctl --user enable --now emacs-operator-linux-host.service
fi
echo "Installed: $PREFIX/bin/emacs-operator-linux-host"
INSTALL
chmod 755 "$BUNDLE/install.sh"

cat > "$BUNDLE/uninstall.sh" <<'UNINSTALL'
#!/usr/bin/env bash
set -euo pipefail
PREFIX="${EMACS_OPERATOR_LINUX_PREFIX:-$HOME/.local}"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now emacs-operator-linux-host.service >/dev/null 2>&1 || true
fi
rm -f "$HOME/.config/systemd/user/emacs-operator-linux-host.service"
rm -f "$PREFIX/bin/emacs-operator-linux-host"
rm -rf "$PREFIX/lib/emacs-operator-linux-host"
if command -v systemctl >/dev/null 2>&1; then systemctl --user daemon-reload >/dev/null 2>&1 || true; fi
echo "Removed Emacs Operator Linux Host from $PREFIX."
UNINSTALL
chmod 755 "$BUNDLE/uninstall.sh"

cat > "$BUNDLE/VERSION" <<EOF_VERSION
$VERSION
EOF_VERSION

python3 - "$BUNDLE" "$VERSION" "$ARCH" <<'PY'
from pathlib import Path
import hashlib, json, platform, sys
root=Path(sys.argv[1])
version=sys.argv[2]
arch=sys.argv[3]
files=[]
for p in sorted(root.rglob('*')):
    if not p.is_file() or p.name == 'manifest.json':
        continue
    files.append({
        'path': p.relative_to(root).as_posix(),
        'bytes': p.stat().st_size,
        'sha256': hashlib.sha256(p.read_bytes()).hexdigest(),
    })
manifest={
    'schema_version':'1.0',
    'name':'emacs-operator-linux-host',
    'version':version,
    'platform':'linux',
    'architecture':arch,
    'libc':platform.libc_ver()[0] or 'unknown',
    'backend':'x11_xtest',
    'runtime_dependencies':['node >= 22','libX11','libXtst.so.6','libpng16'],
    'files':files,
}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
PY

mkdir -p "$(dirname "$OUT")"
tar --sort=name --mtime='UTC 2026-08-31' --owner=0 --group=0 --numeric-owner \
  -C "$STAGE" -czf "$OUT" "$(basename "$BUNDLE")"
echo "$OUT"
