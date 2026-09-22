#!/usr/bin/env bash
# Provision and start the pinned Paredit/CIDER/SLY package runtime.
#
#   bash scripts/package-runtime/start-package-runtimes.sh [RUNTIME_DIR]
#
# - acquires every source in sources.lock.json at its exact commit;
# - fetches the SHA-256-pinned JVM closure in jvm.lock.json;
# - starts nREPL (cider-nrepl middleware) and Slynk on 127.0.0.1;
# - waits for both ports (a state predicate, not a fixed sleep);
# - writes RUNTIME_DIR/package-runtime.env for `npm run accept:linux`.
# Stop with: bash scripts/package-runtime/stop-package-runtimes.sh [RUNTIME_DIR]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNTIME_DIR="${1:-$ROOT/.runtime/package-runtime}"
SOURCES_DIR="$ROOT/.runtime/sources"
JVM_DIR="$ROOT/.runtime/jvm"
NREPL_PORT="${EMACS_OPERATOR_CI_NREPL_PORT:-7888}"
SLYNK_PORT="${EMACS_OPERATOR_CI_SLYNK_PORT:-4005}"
WAIT_SECONDS="${EMACS_OPERATOR_PACKAGE_RUNTIME_WAIT_SECONDS:-180}"

for tool in git node java sbcl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: $tool is required." >&2; exit 127; }
done
mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"

source_path() {
  node "$ROOT/scripts/package-runtime/acquire-git-source.mjs" --name "$1" --dest "$SOURCES_DIR" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).path))'
}

echo "== Acquiring pinned Emacs package sources"
names="$(node -e 'const l=require(process.argv[1]);process.stdout.write(Object.keys(l.sources).join(" "))' "$ROOT/scripts/package-runtime/sources.lock.json")"
load_paths=""
sly_dir=""
for name in $names; do
  dir="$(source_path "$name")"
  case "$name" in
    cider) dir="$dir/lisp" ;;
    sly) sly_dir="$dir" ;;
  esac
  echo "  $name -> $dir"
  load_paths="${load_paths:+$load_paths:}$dir"
done
[[ -n "$sly_dir" ]] || { echo "ERROR: sly is missing from sources.lock.json" >&2; exit 1; }

echo "== Fetching pinned JVM runtime"
jvm_json="$(node "$ROOT/scripts/package-runtime/fetch-maven-artifacts.mjs" --dest "$JVM_DIR")"
classpath="$(printf '%s' "$jvm_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).classpath))')"
middleware="$(printf '%s' "$jvm_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).nrepl_middleware||""))')"

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }
for port in "$NREPL_PORT" "$SLYNK_PORT"; do
  if port_open "$port"; then echo "ERROR: 127.0.0.1:$port is already in use." >&2; exit 1; fi
done

echo "== Starting nREPL on 127.0.0.1:$NREPL_PORT"
nohup java -cp "$classpath" clojure.main -m nrepl.cmdline \
  --bind 127.0.0.1 --port "$NREPL_PORT" --middleware "$middleware" \
  >"$RUNTIME_DIR/nrepl.log" 2>&1 &
echo $! >"$RUNTIME_DIR/nrepl.pid"

echo "== Starting Slynk on 127.0.0.1:$SLYNK_PORT"
cat >"$RUNTIME_DIR/start-slynk.lisp" <<LISP
(load "$sly_dir/slynk/slynk-loader.lisp")
(slynk-loader:init)
(slynk:create-server :port $SLYNK_PORT :interface "127.0.0.1" :dont-close t)
(loop (sleep 60))
LISP
nohup sbcl --noinform --disable-debugger --load "$RUNTIME_DIR/start-slynk.lisp" \
  >"$RUNTIME_DIR/slynk.log" 2>&1 &
echo $! >"$RUNTIME_DIR/slynk.pid"

deadline=$(( $(date +%s) + WAIT_SECONDS ))
for label in nrepl:"$NREPL_PORT" slynk:"$SLYNK_PORT"; do
  name="${label%%:*}"; port="${label##*:}"
  until port_open "$port"; do
    if ! kill -0 "$(cat "$RUNTIME_DIR/$name.pid")" 2>/dev/null; then
      echo "ERROR: $name exited before listening; see $RUNTIME_DIR/$name.log" >&2; tail -n 20 "$RUNTIME_DIR/$name.log" >&2; exit 1
    fi
    if (( $(date +%s) >= deadline )); then
      echo "ERROR: $name did not listen on $port within ${WAIT_SECONDS}s" >&2; tail -n 20 "$RUNTIME_DIR/$name.log" >&2; exit 1
    fi
    sleep 0.25
  done
  echo "  $name listening on 127.0.0.1:$port"
done

cat >"$RUNTIME_DIR/package-runtime.env" <<ENV
EMACS_OPERATOR_LINUX_EMACS_EXTRA_LOAD_PATHS=$load_paths
EMACS_OPERATOR_LINUX_EMACS_SETUP_FILE=$ROOT/.github/ci/linux-package-acceptance.el
EMACS_OPERATOR_CI_NREPL_PORT=$NREPL_PORT
EMACS_OPERATOR_CI_SLYNK_PORT=$SLYNK_PORT
EMACS_OPERATOR_LINUX_PACKAGE_WAIT_MS=30000
ENV
echo "Package runtime ready. Environment: $RUNTIME_DIR/package-runtime.env"
