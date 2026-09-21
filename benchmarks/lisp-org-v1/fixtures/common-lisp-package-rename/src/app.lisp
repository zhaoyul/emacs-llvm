(defpackage #:bench.app
  (:use #:cl))

(in-package #:bench.app)

(defun invoice-total (values)
  (bench.math:sum values))

(defparameter *documentation* "bench.math:sum")
;; The example bench.math:sum must remain in this comment.
