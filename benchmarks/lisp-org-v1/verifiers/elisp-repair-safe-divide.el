;;; elisp-repair-safe-divide.el --- Benchmark verifier -*- lexical-binding: t; -*-
(require 'safe-math)
(unless (equal (safe-divide 10 2) 5)
  (error "safe-divide returned the wrong quotient"))
(unless (null (safe-divide 10 0))
  (error "safe-divide must return nil for a zero denominator"))
(unless (equal (safe-divide-demo) '(5 nil))
  (error "safe-divide-demo no longer preserves representative behavior"))
(princ "BENCHMARK_PASS elisp-repair-safe-divide\n")
