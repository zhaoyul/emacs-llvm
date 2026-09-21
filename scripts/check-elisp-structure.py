#!/usr/bin/env python3
"""Lightweight lexical delimiter sanity check for project Emacs Lisp sources.

This is intentionally not a Lisp parser and does not replace Emacs byte compilation
or ERT. It catches unbalanced ()/[] delimiters while ignoring strings, line comments,
and character literals well enough to be useful in environments without GNU Emacs.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
SEARCH_ROOTS = [ROOT / "lisp"]
OPEN_TO_CLOSE = {"(": ")", "[": "]"}
CLOSE_TO_OPEN = {v: k for k, v in OPEN_TO_CLOSE.items()}


@dataclass
class Delimiter:
    char: str
    line: int
    column: int


def advance_char_literal(text: str, i: int) -> int:
    """Skip an Emacs Lisp ?CHAR literal beginning at text[i] == '?'."""
    i += 1
    if i >= len(text):
        return i
    if text[i] != "\\":
        return i + 1
    i += 1
    if i >= len(text):
        return i
    # Common escaped literal, control/meta notation, or named escape prefix. We only
    # need to ensure delimiter-looking characters inside the literal are not counted.
    if text[i] in "CMASHsNuxU":
        i += 1
        while i < len(text) and text[i] not in " \t\r\n()[];\"'`":
            i += 1
        return i
    return i + 1


def check_file(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    stack: list[Delimiter] = []
    errors: list[str] = []
    i = 0
    line = 1
    column = 1
    in_string = False
    escaped = False
    in_comment = False

    while i < len(text):
        ch = text[i]

        if ch == "\n":
            line += 1
            column = 1
            in_comment = False
            if in_string and escaped:
                escaped = False
            i += 1
            continue

        if in_comment:
            i += 1
            column += 1
            continue

        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            i += 1
            column += 1
            continue

        if ch == ";":
            in_comment = True
            i += 1
            column += 1
            continue

        if ch == '"':
            in_string = True
            i += 1
            column += 1
            continue

        if ch == "?":
            new_i = advance_char_literal(text, i)
            column += max(1, new_i - i)
            i = new_i
            continue

        if ch in OPEN_TO_CLOSE:
            stack.append(Delimiter(ch, line, column))
        elif ch in CLOSE_TO_OPEN:
            if not stack:
                errors.append(f"{path.relative_to(ROOT)}:{line}:{column}: unexpected {ch}")
            else:
                top = stack[-1]
                if top.char != CLOSE_TO_OPEN[ch]:
                    errors.append(
                        f"{path.relative_to(ROOT)}:{line}:{column}: {ch} closes {top.char} "
                        f"opened at {top.line}:{top.column}"
                    )
                    stack.pop()
                else:
                    stack.pop()

        i += 1
        column += 1

    if in_string:
        errors.append(f"{path.relative_to(ROOT)}:{line}:{column}: unterminated string")
    for item in reversed(stack):
        errors.append(
            f"{path.relative_to(ROOT)}:{item.line}:{item.column}: unclosed {item.char}"
        )
    return errors


def main() -> int:
    files = sorted(path for root in SEARCH_ROOTS for path in root.rglob("*.el"))
    if not files:
        print("No Emacs Lisp files found", file=sys.stderr)
        return 2
    errors: list[str] = []
    for path in files:
        errors.extend(check_file(path))
    if errors:
        print("Elisp lexical delimiter sanity check: FAIL", file=sys.stderr)
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print(f"Elisp lexical delimiter sanity check: PASS ({len(files)} files)")
    print("NOTE: lexical sanity only; GNU Emacs byte compilation and ERT remain authoritative.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
