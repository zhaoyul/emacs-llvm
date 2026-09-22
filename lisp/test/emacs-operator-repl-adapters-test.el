;;; emacs-operator-repl-adapters-test.el --- CIDER/SLY adapter contract tests -*- lexical-binding: t; -*-

;; These tests stub the CIDER/SLY entry points, so they run in plain
;; `emacs -Q --batch' without nREPL or Slynk.  The real-runtime contract is
;; exercised by `npm run accept:linux' with the package gates required.

(require 'ert)
(require 'cl-lib)
(require 'emacs-operator)
(require 'emacs-operator-adapter-repl)
(require 'emacs-operator-adapter-cider)
(require 'emacs-operator-adapter-sly)

(defun emacs-operator-repl-test--defun-source-at (text needle &optional after)
  "Return the eval_defun source with point at NEEDLE in TEXT (lisp-mode)."
  (with-temp-buffer
    (lisp-mode)
    (insert text)
    (goto-char (point-min))
    (search-forward needle)
    (unless after (goto-char (match-beginning 0)))
    (emacs-operator-repl-current-defun-source)))

(ert-deftest emacs-operator-repl-defun-source-at-defun-start ()
  "Point at the start of a defun must select that defun, not the previous form.
This is where structured `beginning_of_defun' navigation leaves point."
  (let ((text "(in-package #:cl-user)\n(defun probe-add (x) (+ x 1))\n(probe-add 41)\n"))
    (should (string-prefix-p "(defun probe-add"
                             (emacs-operator-repl-test--defun-source-at text "(defun")))
    (should (string-prefix-p "(defun probe-add"
                             (emacs-operator-repl-test--defun-source-at text "(+ x")))
    (should (string-prefix-p "(defun probe-add"
                             (emacs-operator-repl-test--defun-source-at text "(+ x 1))" t)))
    (should (string-prefix-p "(in-package"
                             (emacs-operator-repl-test--defun-source-at text "(in-package")))))

;;; CIDER

(defvar emacs-operator-repl-test--cider-calls nil)

(defmacro emacs-operator-repl-test-with-cider (responder &rest body)
  "Run BODY with CIDER stubbed; RESPONDER maps (INPUT CONNECTION NS) to a dict."
  (declare (indent 1))
  `(let ((emacs-operator-repl-test--cider-calls nil)
         (responder ,responder))
     (cl-letf (((symbol-function 'nrepl-dict-p)
                (lambda (x) (eq (car-safe x) 'dict)))
               ((symbol-function 'nrepl-dict-get)
                (lambda (dict key) (lax-plist-get (cdr dict) key)))
               ((symbol-function 'cider-current-connection) (lambda () 'fake-connection))
               ((symbol-function 'cider-current-ns) (lambda () "demo.core"))
               ((symbol-function 'cider-ns-form) (lambda () "(ns demo.core)"))
               ((symbol-function 'cider-nrepl-sync-request:eval)
                (lambda (input &optional connection ns)
                  (push (list input connection ns) emacs-operator-repl-test--cider-calls)
                  (funcall responder input connection ns))))
       (with-temp-buffer
         (lisp-data-mode)
         (insert "(ns demo.core)\n(+ 40 2)")
         (goto-char (point-max))
         ,@body))))

(ert-deftest emacs-operator-cider-reads-nrepl-dict-and-passes-connection-then-ns ()
  (emacs-operator-repl-test-with-cider
      (lambda (_input _connection _ns) '(dict "value" "42" "status" ("done")))
    (let ((result (emacs-operator-cider-eval '(("operation" . "eval_last_sexp")) nil)))
      (should (equal (emacs-operator--get result "value") "42"))
      (should (eq (emacs-operator--get result "completed") t))
      (should (equal (car emacs-operator-repl-test--cider-calls)
                     '("(+ 40 2)" fake-connection "demo.core"))))))

(ert-deftest emacs-operator-cider-bootstraps-unloaded-namespace-once ()
  (emacs-operator-repl-test-with-cider
      (let ((ns-loaded nil))
        (lambda (input _connection ns)
          (cond ((equal input "(ns demo.core)") (setq ns-loaded t) '(dict "value" "nil" "status" ("done")))
                ((and ns (not ns-loaded)) '(dict "status" ("namespace-not-found" "done" "error")))
                (t '(dict "value" "42" "status" ("done"))))))
    (let* ((result (emacs-operator-cider-eval '(("operation" . "eval_last_sexp")) nil))
           (metadata (emacs-operator--get result "metadata")))
      (should (equal (emacs-operator--get result "value") "42"))
      (should (eq (emacs-operator--get result "completed") t))
      (should (eq (emacs-operator--get metadata "ns_form_evaluated") t))
      (should (= (length emacs-operator-repl-test--cider-calls) 3)))))

(ert-deftest emacs-operator-cider-error-status-is-not-success ()
  (emacs-operator-repl-test-with-cider
      (lambda (_input _connection _ns) '(dict "status" ("eval-error" "done")))
    (let ((result (emacs-operator-cider-eval '(("operation" . "eval_last_sexp")) nil)))
      (should (eq (emacs-operator--get result "completed") :json-false))
      (should (equal (emacs-operator--get result "condition") "nrepl-error"))))
  (emacs-operator-repl-test-with-cider
      (lambda (input _connection _ns)
        (if (equal input "(ns demo.core)")
            '(dict "ex" "class clojure.lang.Compiler$CompilerException" "status" ("eval-error" "done"))
          '(dict "status" ("namespace-not-found" "done" "error"))))
    (let ((result (emacs-operator-cider-eval '(("operation" . "eval_last_sexp")) nil)))
      (should (eq (emacs-operator--get result "completed") :json-false))
      (should (equal (emacs-operator--get result "condition") "namespace-not-found")))))

(ert-deftest emacs-operator-cider-exception-is-structured-failure ()
  (emacs-operator-repl-test-with-cider
      (lambda (_input _connection _ns)
        '(dict "ex" "class java.lang.ArithmeticException" "err" "Divide by zero" "status" ("eval-error" "done")))
    (let ((result (emacs-operator-cider-eval '(("operation" . "eval_last_sexp")) nil)))
      (should (eq (emacs-operator--get result "completed") :json-false))
      (should (equal (emacs-operator--get result "condition") "class java.lang.ArithmeticException"))
      (should (equal (emacs-operator--get result "stderr") "Divide by zero")))))

;;; SLY

(defmacro emacs-operator-repl-test-with-sly (reply &rest body)
  (declare (indent 1))
  `(let ((sent nil))
     (cl-letf (((symbol-function 'sly-current-connection) (lambda () 'fake-connection))
               ((symbol-function 'sly-current-package) (lambda () ":cl-user"))
               ((symbol-function 'sly-eval)
                (lambda (form &optional package &rest _)
                  (setq sent (list form package))
                  ,reply)))
       (with-temp-buffer
         (lisp-mode)
         (insert "(in-package #:cl-user)\n(+ 40 2)")
         (goto-char (point-max))
         (let ((result (emacs-operator-sly-eval '(("operation" . "eval_last_sexp")) nil)))
           ,@body)))))

(ert-deftest emacs-operator-sly-request-avoids-debugger-and-number-decoration ()
  (emacs-operator-repl-test-with-sly '(:ok ("" "42"))
    (should (equal (emacs-operator--get result "value") "42"))
    (should (eq (emacs-operator--get result "completed") t))
    (let ((form (car sent)))
      (should (eq (car form) 'cl:handler-case))
      (should (string-match-p "slynk::\\*echo-number-alist\\*" (format "%S" form)))
      (should (string-match-p "slynk:eval-and-grab-output \"(\\+ 40 2)\"" (format "%S" form))))
    (should (equal (cadr sent) ":cl-user"))))

(ert-deftest emacs-operator-sly-lisp-error-is-structured-failure ()
  (emacs-operator-repl-test-with-sly '(:error "DIVISION-BY-ZERO" "arithmetic error DIVISION-BY-ZERO signalled")
    (should (eq (emacs-operator--get result "completed") :json-false))
    (should (equal (emacs-operator--get result "condition") "DIVISION-BY-ZERO"))
    (should (string-prefix-p "sly:" (emacs-operator--get result "backtrace_handle")))))

(ert-deftest emacs-operator-sly-unexpected-reply-is-not-success ()
  (emacs-operator-repl-test-with-sly '(:weird)
    (should (eq (emacs-operator--get result "completed") :json-false))
    (should (equal (emacs-operator--get result "condition") "unexpected_reply"))))

(provide 'emacs-operator-repl-adapters-test)
;;; emacs-operator-repl-adapters-test.el ends here
