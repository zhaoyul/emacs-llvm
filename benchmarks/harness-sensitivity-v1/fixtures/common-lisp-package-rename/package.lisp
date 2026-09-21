(defpackage #:demo
  (:use #:cl))
(in-package #:demo)

(defun app:sum (xs)
  (reduce #'+ xs))

(defun caller (xs)
  (list (app:sum xs) app::sum "app:sum"))

;; Keep app:sum in this comment.
