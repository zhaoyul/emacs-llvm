;;; emacs-operator-sly-test.el --- SLY adapter ERT tests -*- lexical-binding: t; -*-

(require 'ert)
(require 'cl-lib)
(require 'emacs-operator)
(require 'emacs-operator-adapter-sly)

(ert-deftest emacs-operator-sly-sync-eval-unpacks-output-value-pair ()
  "Normalize the (stdout value) pair returned by Slynk eval-and-grab-output."
  (cl-letf (((symbol-function 'emacs-operator-sly--ready-state)
             (lambda () '(t . nil)))
            ((symbol-function 'emacs-operator-sly--package)
             (lambda () "COMMON-LISP-USER"))
            ((symbol-function 'emacs-operator-repl-source-metadata)
             (lambda (&rest _args) '(("operation" . "eval_last_sexp"))))
            ((symbol-function 'sly-eval)
             (lambda (&rest _args) '("hello" "42"))))
    (let ((result
           (emacs-operator-sly--eval-source
            "(+ 40 2)"
            '(("operation" . "eval_last_sexp") ("timeout_ms" . 1000)))))
      (should (eq (emacs-operator--get result "completed") t))
      (should (equal (emacs-operator--get result "stdout") "hello"))
      (should (equal (emacs-operator--get result "value") "42")))))

(provide 'emacs-operator-sly-test)
;;; emacs-operator-sly-test.el ends here
