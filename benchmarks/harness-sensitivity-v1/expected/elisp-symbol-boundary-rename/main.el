;;; main.el --- fixture -*- lexical-binding: t; -*-

(defun qux (x)
  (+ x 1))

(defun foo/bar (x)
  (qux x))

(defun call-foo ()
  (list (qux 1) foo/bar "foo"))

;; Keep the word foo in this comment.
(provide 'main)
