(defpackage #:bench.math
  (:use #:cl)
  (:export #:sum))

(in-package #:bench.math)

(defun sum (values)
  "Return the sum of VALUES."
  (reduce #'+ values :initial-value 0))

(defun sum-internal (values)
  (sum values))
