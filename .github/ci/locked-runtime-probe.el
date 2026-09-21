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
       cider-middleware-version
       sly-value)

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
    (call-interactively #'paredit-forward-slurp-sexp)
    (setq paredit-output (buffer-string))
    (eo-probe--assert
     (equal paredit-output "(foo (bar baz))")
     "Unexpected Paredit output: %S"
     paredit-output))

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
         (version-dict
          (nrepl-aux-info "cider-version" repl)))
    (setq cider-value
          (nrepl-dict-get response "value"))
    (setq cider-middleware-version
          (nrepl-dict-get version-dict "version-string"))
    (eo-probe--assert
     (equal cider-value "42")
     "CIDER eval expected 42, got %S"
     cider-value)
    (eo-probe--assert
     (equal cider-middleware-version "0.62.2")
     "Expected cider-nrepl 0.62.2, got %S"
     cider-middleware-version))

  (sly-connect "127.0.0.1" 4005)
  (eo-probe--wait #'sly-connected-p 30 "SLY connection")
  (setq sly-value
        (cl-second
         (sly-eval
          '(slynk:eval-and-grab-output "(+ 20 22)"))))
  (eo-probe--assert
   (and (stringp sly-value)
        (string-match-p "42" sly-value))
   "SLY eval expected 42, got %S"
   sly-value)

  (let ((result
         (list
          (cons 'status "PASS")
          (cons 'emacs_version emacs-version)
          (cons 'paredit_source paredit-source)
          (cons 'paredit_output paredit-output)
          (cons 'cider_source cider-source)
          (cons 'cider_value cider-value)
          (cons 'cider_middleware_version cider-middleware-version)
          (cons 'sly_source sly-source)
          (cons 'sly_value sly-value))))
    (with-temp-file (getenv "RUNTIME_PROBE_JSON")
      (insert (json-encode result) "\n"))
    (princ
     (concat "RUNTIME_PROBE_PASS "
             (json-encode result)
             "\n"))))

;;; locked-runtime-probe.el ends here
