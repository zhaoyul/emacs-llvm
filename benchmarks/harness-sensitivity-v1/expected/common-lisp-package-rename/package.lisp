(defpackage #:demo
  (:use #:cl))
(in-package #:demo)

(defun app:add (xs)
  (reduce #'+ xs))

(defun caller (xs)
  (list (app:add xs) app::sum "app:sum"))

;; Keep app:sum in this comment.
