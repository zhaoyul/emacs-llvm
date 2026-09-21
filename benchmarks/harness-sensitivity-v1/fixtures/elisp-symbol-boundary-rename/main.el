;;; main.el --- fixture -*- lexical-binding: t; -*-

(defun foo (x)
  (+ x 1))

(defun foo/bar (x)
  (foo x))

(defun call-foo ()
  (list (foo 1) foo/bar "foo"))

;; Keep the word foo in this comment.
(provide 'main)
