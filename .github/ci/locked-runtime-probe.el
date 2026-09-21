;;; locked-runtime-probe.el --- real package runtime acceptance -*- lexical-binding: t; -*-

(require 'cl-lib)
(require 'json)

(setq debug-on-error t)

(defun eo-probe--assert (condition format-string &rest args)
  (unless condition
    (error "%s" (apply #'format format-string args))))

(defun eo-probe--under-root-p (file root)
  (and file root
       (string-prefix-p
        (file-name-as-directory (file-truename root))
        (file-truename file))))

(defun eo-probe--source (symbol root)
  (let ((file (symbol-file symbol 'defun)))
    (eo-probe--assert file "No defining file for %S" symbol)
    (eo-probe--assert
     (eo-probe--under-root-p file root)
     "%S loaded from %s, outside locked root %s"
     symbol file root)
    (file-truename file)))

(defun eo-probe--wait (predicate seconds label)
  (let ((deadline (+ (float-time) seconds)))
    (while (and (< (float-time) deadline)
                (not (condition-case nil
                         (funcall predicate)
                       (error nil))))
      (accept-process-output nil 0.1))
    (eo-probe--assert
     (condition-case nil (funcall predicate) (error nil))
     "Timed out waiting for %s"
     label)))

(require 'compat)
(require 'paredit)
(require 'clojure-mode)
(require 'cider)
(setq sly-contribs nil)
(require 'sly)

(let* ((paredit-source
        (eo-probe--source
         'paredit-forward-slurp-sexp
         (getenv "PAREDIT_ROOT")))
       (cider-source
        (eo-probe--source
         'cider-connect-clj
         (getenv "CIDER_ROOT")))
       (sly-source
        (eo-probe--source
         'sly-connect
         (getenv "SLY_ROOT")))
       paredit-output
       cider-value
       cider-condition
       cider-repaired-value
       cider-middleware-version
       sly-value
       sly-condition
       sly-repaired-value
       sly-implementation-version)

  ;; Execute the real Paredit key through the active local keymap.
  (with-temp-buffer
    (emacs-lisp-mode)
    (paredit-mode 1)
    (insert "(foo (bar) baz)")
    (goto-char (point-min))
    (search-forward "bar")
    (eo-probe--assert
     (eq (key-binding (kbd "C-)"))
         #'paredit-forward-slurp-sexp)
     "Real Paredit key binding C-) is not active")
    (execute-kbd-macro (kbd "C-)"))
    (setq paredit-output (buffer-string))
    (eo-probe--assert
     (equal paredit-output "(foo (bar baz))")
     "Unexpected Paredit output: %S"
     paredit-output))

  ;; Connect the locked CIDER client to a real cider-nrepl server.
  (cider-connect-clj
   (list :host "127.0.0.1"
         :port 7888
         :project-dir default-directory))
  (eo-probe--wait
   (lambda ()
     (let ((repl (ignore-errors (cider-current-repl 'clj))))
       (and (buffer-live-p repl)
            (process-live-p (get-buffer-process repl)))))
   30
   "CIDER connection")

  (let* ((repl (cider-current-repl 'clj 'ensure))
         (response
          (cider-nrepl-sync-request:eval
           "(+ 20 22)" repl))
         (bad-response
          (cider-nrepl-sync-request:eval
           "(do (defn eo-probe-fn [] (/ 1 0)) (eo-probe-fn))"
           repl))
         (bad-ex
          (or (nrepl-dict-get bad-response "ex")
              (nrepl-dict-get bad-response "root-ex")))
         (bad-err
          (nrepl-dict-get bad-response "err"))
         (bad-status
          (nrepl-dict-get bad-response "status"))
         (version-dict
          (nrepl-aux-info "cider-version" repl)))
    (setq cider-value
          (nrepl-dict-get response "value"))
    (setq cider-condition
          (format "ex=%S err=%S status=%S"
                  bad-ex bad-err bad-status))
    (setq cider-middleware-version
          (nrepl-dict-get version-dict "version-string"))

    (eo-probe--assert
     (equal cider-value "42")
     "CIDER eval expected 42, got %S"
     cider-value)
    (eo-probe--assert
     (string-match-p
      "ArithmeticException\\|Divide by zero\\|eval-error\\|error"
      cider-condition)
     "CIDER did not expose the expected runtime condition: %s"
     cider-condition)
    (eo-probe--assert
     (equal cider-middleware-version "0.62.2")
     "Expected cider-nrepl 0.62.2, got %S"
     cider-middleware-version)

    (cider-nrepl-sync-request:eval
     "(defn eo-probe-fn [] 42)" repl)
    (setq cider-repaired-value
          (nrepl-dict-get
           (cider-nrepl-sync-request:eval
            "(eo-probe-fn)" repl)
           "value"))
    (eo-probe--assert
     (equal cider-repaired-value "42")
     "CIDER repair/rerun expected 42, got %S"
     cider-repaired-value))

  ;; Connect SLY to the Slynk server running on pinned private SBCL.
  (sly-connect "127.0.0.1" 4005)
  (eo-probe--wait #'sly-connected-p 30 "SLY connection")

  (setq sly-value
        (cl-second
         (sly-eval
          '(slynk:eval-and-grab-output "(+ 20 22)"))))
  (setq sly-condition
        (cl-second
         (sly-eval
          '(slynk:eval-and-grab-output
            "(handler-case (progn (error \"EO-PROBE-BOOM\") \"NO-ERROR\") (error (e) (format nil \"~A:~A\" (type-of e) e)))"))))
  (setq sly-implementation-version
        (cl-second
         (sly-eval
          '(slynk:eval-and-grab-output
            "(lisp-implementation-version)"))))

  (eo-probe--assert
   (and (stringp sly-value)
        (string-match-p "42" sly-value))
   "SLY eval expected 42, got %S"
   sly-value)
  (eo-probe--assert
   (and (stringp sly-condition)
        (string-match-p "EO-PROBE-BOOM" sly-condition))
   "SLY condition round-trip missing marker: %S"
   sly-condition)
  (eo-probe--assert
   (and (stringp sly-implementation-version)
        (string-match-p "2\\.6\\.8" sly-implementation-version))
   "Expected SBCL 2.6.8 through SLY, got %S"
   sly-implementation-version)

  (sly-eval
   '(slynk:eval-and-grab-output
     "(defun eo-probe-cl () 42)"))
  (setq sly-repaired-value
        (cl-second
         (sly-eval
          '(slynk:eval-and-grab-output "(eo-probe-cl)"))))
  (eo-probe--assert
   (and (stringp sly-repaired-value)
        (string-match-p "42" sly-repaired-value))
   "SLY repair/rerun expected 42, got %S"
   sly-repaired-value)

  (let ((result
         (list
          (cons 'status "PASS")
          (cons 'emacs_version emacs-version)
          (cons 'paredit_source paredit-source)
          (cons 'paredit_output paredit-output)
          (cons 'paredit_execution "execute-kbd-macro:C-)")
          (cons 'cider_source cider-source)
          (cons 'cider_value cider-value)
          (cons 'cider_condition cider-condition)
          (cons 'cider_repaired_value cider-repaired-value)
          (cons 'cider_middleware_version cider-middleware-version)
          (cons 'sly_source sly-source)
          (cons 'sly_value sly-value)
          (cons 'sly_condition sly-condition)
          (cons 'sly_repaired_value sly-repaired-value)
          (cons 'sly_implementation_version sly-implementation-version))))
    (with-temp-file (getenv "RUNTIME_PROBE_JSON")
      (insert (json-encode result) "\n"))
    (princ
     (concat "RUNTIME_PROBE_PASS "
             (json-encode result)
             "\n"))))

;;; locked-runtime-probe.el ends here
