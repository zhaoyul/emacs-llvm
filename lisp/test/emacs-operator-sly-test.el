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
             (lambda (&rest _args) '(:ok ("hello" "42")))))
    (let ((result
           (emacs-operator-sly--eval-source
            "(+ 40 2)"
            '(("operation" . "eval_last_sexp") ("timeout_ms" . 1000)))))
      (should (eq (emacs-operator--get result "completed") t))
      (should (equal (emacs-operator--get result "stdout") "hello"))
      (should (equal (emacs-operator--get result "value") "42")))))

(ert-deftest emacs-operator-sly-guarded-form-disables-number-presentations ()
  "Canonical SLY values should not include Slynk's alternate numeric presentations."
  (let ((form (emacs-operator-sly--guarded-eval-form "(+ 40 2)")))
    (should (equal (car form) 'handler-case))
    (should (string-match-p "echo-number-alist" (prin1-to-string form)))
    (should (string-match-p "eval-and-grab-output" (prin1-to-string form)))))

(ert-deftest emacs-operator-sly-sync-eval-returns-structured-condition ()
  "Convert a guarded Slynk condition into the common REPL result contract."
  (cl-letf (((symbol-function 'emacs-operator-sly--ready-state)
             (lambda () '(t . nil)))
            ((symbol-function 'emacs-operator-sly--package)
             (lambda () "COMMON-LISP-USER"))
            ((symbol-function 'emacs-operator-repl-source-metadata)
             (lambda (&rest _args) '(("operation" . "eval_last_sexp"))))
            ((symbol-function 'sly-eval)
             (lambda (&rest _args)
               '(:error "DIVISION-BY-ZERO" "arithmetic error DIVISION-BY-ZERO"))))
    (let ((result
           (emacs-operator-sly--eval-source
            "(/ 1 0)"
            '(("operation" . "eval_last_sexp") ("timeout_ms" . 1000)))))
      (should-not (eq (emacs-operator--get result "completed") t))
      (should (equal (emacs-operator--get result "condition") "DIVISION-BY-ZERO"))
      (should (string-match-p "arithmetic error"
                              (emacs-operator--get result "stderr"))))))

(provide 'emacs-operator-sly-test)
;;; emacs-operator-sly-test.el ends here
