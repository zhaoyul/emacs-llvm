#!/usr/bin/env bash
# Resolve and validate the GNU Emacs executable used by acceptance/test scripts.
# Usage: source scripts/resolve-emacs.sh; resolve_emacs_bin

_emacs_operator_resolver_root() {
  if [[ -n "${ROOT:-}" && -d "${ROOT:-}" ]]; then
    printf '%s\n' "$ROOT"
    return 0
  fi
  local source_path="${BASH_SOURCE[0]}"
  (cd "$(dirname "$source_path")/.." && pwd -P)
}

_emacs_operator_version_of() {
  local candidate="$1"
  local timeout_bin=""
  if command -v timeout >/dev/null 2>&1; then timeout_bin="timeout"; fi
  local output=""
  if [[ -n "$timeout_bin" ]]; then
    output="$(timeout 10 "$candidate" -Q --batch --eval '(princ emacs-major-version)' 2>/dev/null || true)"
  else
    output="$("$candidate" -Q --batch --eval '(princ emacs-major-version)' 2>/dev/null || true)"
  fi
  if [[ "$output" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$output"
    return 0
  fi
  return 1
}

_emacs_operator_accept_candidate() {
  local candidate="$1"
  [[ -n "$candidate" && -x "$candidate" && ! -d "$candidate" ]] || return 1
  local version=""
  version="$(_emacs_operator_version_of "$candidate")" || return 1
  (( version >= 29 )) || return 1
  EMACS_OPERATOR_RESOLVED_EMACS="$(cd "$(dirname "$candidate")" && pwd -P)/$(basename "$candidate")"
  EMACS_OPERATOR_RESOLVED_EMACS_MAJOR="$version"
  export EMACS_OPERATOR_RESOLVED_EMACS EMACS_OPERATOR_RESOLVED_EMACS_MAJOR
  return 0
}

resolve_emacs_bin() {
  local explicit="${EMACS_OPERATOR_EMACS_BIN:-}"
  if [[ -n "$explicit" ]]; then
    if ! _emacs_operator_accept_candidate "$explicit"; then
      printf 'ERROR: EMACS_OPERATOR_EMACS_BIN is not an executable GNU Emacs 29+: %s\n' "$explicit" >&2
      return 127
    fi
    return 0
  fi

  local project_root runtime_root candidate
  project_root="$(_emacs_operator_resolver_root)"
  runtime_root="${EMACS_OPERATOR_EMACS_RUNTIME_ROOT:-}"
  if [[ -n "$runtime_root" ]]; then
    for candidate in \
      "$runtime_root/bin/emacs" \
      "$runtime_root/usr/bin/emacs" \
      "$runtime_root/usr/bin/emacs-gtk" \
      "$runtime_root/usr/bin/emacs-nox"; do
      if _emacs_operator_accept_candidate "$candidate"; then return 0; fi
    done
  fi

  for candidate in \
    "$project_root/.runtime/emacs/current/bin/emacs" \
    "$project_root/.runtime/emacs/current/usr/bin/emacs" \
    "$project_root/.runtime/emacs/current/usr/bin/emacs-gtk" \
    "$project_root/.runtime/emacs/current/usr/bin/emacs-nox"; do
    if _emacs_operator_accept_candidate "$candidate"; then return 0; fi
  done

  if command -v emacs >/dev/null 2>&1; then
    candidate="$(command -v emacs)"
    if _emacs_operator_accept_candidate "$candidate"; then return 0; fi
  fi
  if command -v emacs-gtk >/dev/null 2>&1; then
    candidate="$(command -v emacs-gtk)"
    if _emacs_operator_accept_candidate "$candidate"; then return 0; fi
  fi
  if command -v emacs-nox >/dev/null 2>&1; then
    candidate="$(command -v emacs-nox)"
    if _emacs_operator_accept_candidate "$candidate"; then return 0; fi
  fi
  return 127
}
