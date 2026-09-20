# Task

Rename only the exact Emacs Lisp symbol `foo` to `qux`. Preserve `foo/bar`, strings, comments, formatting, and every other file.

BENCHMARK_DIRECTIVE: {"operation":"rename_symbol","file":"main.el","old_symbol":"foo","new_symbol":"qux","language":"elisp","qualification_policy":"exact"}
