# Task

Rename the exact external Common Lisp package symbol `app:sum` to leaf name `add`. Preserve external package qualification, `app::sum`, strings, and comments.

BENCHMARK_DIRECTIVE: {"operation":"rename_symbol","file":"package.lisp","old_symbol":"app:sum","new_symbol":"add","language":"common_lisp","qualification_policy":"leaf_only"}
