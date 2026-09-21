# Task

Append a Project section with OWNER property, Data table, and Computation Emacs Lisp source block exactly as requested. Preserve the existing title and introduction.

BENCHMARK_DIRECTIVE: {"operation":"org_author","file":"notes.org","append_lines":["","* Project",":PROPERTIES:",":OWNER: Kevin",":END:","","** Data","","| Metric | Value |","|--------+-------|","| Answer |    42 |","","** Computation","","#+begin_src emacs-lisp :results value","(+ 40 2)","#+end_src"]}
