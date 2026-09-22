;;; emacs-operator-adapter-sly.el --- SLY runtime adapter -*- lexical-binding: t; -*-
(require 'emacs-operator-adapter-generic)
(require 'emacs-operator-adapter-repl)
(defun emacs-operator-sly-applicable-p (_context)
  (and (featurep 'sly) (or (derived-mode-p 'lisp-mode) (bound-and-true-p sly-mode) (bound-and-true-p sly-mrepl-mode))))
(defun emacs-operator-sly--connection () (when (fboundp 'sly-current-connection) (condition-case nil (sly-current-connection) (error nil))))
(defun emacs-operator-sly--package ()
  (cond ((fboundp 'sly-current-package) (condition-case nil (sly-current-package) (error nil))) ((boundp 'sly-buffer-package) sly-buffer-package)))
(defun emacs-operator-sly--ready-state ()
  (let ((connection (emacs-operator-sly--connection)))
    (cond ((not connection) '(nil . "SLY has no active connection."))
          ((and (processp connection) (not (process-live-p connection))) '(nil . "The SLY connection process is not alive."))
          ((not (fboundp 'sly-eval)) '(nil . "This SLY version does not expose the synchronous `sly-eval' API."))
          (t '(t . nil)))))
(defun emacs-operator-sly-observe (_context)
  (let* ((connection (emacs-operator-sly--connection)) (package (emacs-operator-sly--package)) (ready (emacs-operator-sly--ready-state)))
    `(("feature_loaded" . t) ("connected" . ,(if connection t :json-false)) ("connection_name" . ,(and connection (format "%s" connection)))
      ("process_alive" . ,(if (and (processp connection) (process-live-p connection)) t :json-false)) ("package" . ,package)
      ("prompt_ready" . ,(if (car ready) t :json-false)) ("ready_reason" . ,(cdr ready)))))
(defun emacs-operator-sly-capabilities (_context)
  (let ((ready (car (emacs-operator-sly--ready-state))))
    `(("operations" .
       ((("name" . "eval_last_sexp")
         ("available" . ,(if ready t :json-false))
         ("channel" . "repl"))
        (("name" . "eval_defun")
         ("available" . ,(if ready t :json-false))
         ("channel" . "repl"))
        (("name" . "eval_region")
         ("available" . ,(if (and ready (use-region-p)) t :json-false))
         ("channel" . "repl"))))
      ("requires_connection" . t)
      ("result_contract" . ("stdout" "stderr" "value" "condition" "backtrace_handle")))))
;; Slynk evaluates the request inside `handler-case', so a Lisp error is
;; returned as data instead of entering SLY's interactive debugger (which
;; would leave the synchronous request waiting until the adapter timeout).
;; `slynk:eval-and-grab-output' replies with (STDOUT VALUES-STRING).  Its echo
;; formatting decorates numbers ("42 (6 bits, #x2A, ...)") through
;; `slynk::*echo-number-alist*'; bind that to nil so the structured result
;; carries the plain printed value, only for this request.
(defun emacs-operator-sly--request-form (source)
  "Return the Slynk request form that evaluates SOURCE without the debugger."
  `(cl:handler-case
       (cl:let ((slynk::*echo-number-alist* cl:nil))
         (cl:list :ok (slynk:eval-and-grab-output ,source)))
     (cl:error (condition)
       (cl:list :error
                (cl:prin1-to-string (cl:type-of condition))
                (cl:princ-to-string condition)))))

(defun emacs-operator-sly--reply-result (reply package metadata)
  "Convert a Slynk REPLY from `emacs-operator-sly--request-form' to a result."
  (pcase reply
    (`(:ok (,stdout ,values))
     (emacs-operator-repl-result
      :stdout (or stdout "") :value values :namespace-or-package package
      :metadata metadata :completed t))
    (`(:error ,type ,message)
     (emacs-operator-repl-result
      :stderr message :condition type
      :backtrace-handle (format "sly:%sx" (sxhash-equal (list type message)))
      :namespace-or-package package :metadata metadata :completed nil))
    (_
     (emacs-operator-repl-result
      :stderr (format "Unexpected Slynk reply: %S" reply)
      :condition "unexpected_reply"
      :namespace-or-package package :metadata metadata :completed nil))))

(defun emacs-operator-sly--eval-source (source params)
  (let* ((package (emacs-operator-sly--package))
         (ready (emacs-operator-sly--ready-state))
         (timeout (emacs-operator-repl-timeout-seconds params))
         (operation (or (emacs-operator--get params "operation") "evaluation"))
         (metadata (emacs-operator-repl-source-metadata source operation)))
    (unless (car ready) (emacs-operator-signal "E_COMMAND_FAILED" (cdr ready)))
    (condition-case err
        (with-timeout (timeout (emacs-operator-repl-timeout-result "SLY" package metadata))
          (emacs-operator-sly--reply-result
           (sly-eval (emacs-operator-sly--request-form source) package)
           package metadata))
      (error
       (emacs-operator-repl-result
        :stderr (error-message-string err)
        :condition (symbol-name (car err))
        :backtrace-handle (format "sly:%sx" (sxhash-equal err))
        :namespace-or-package package :metadata metadata :completed nil)))))

(defun emacs-operator-sly-eval (params _context)
  (pcase (emacs-operator--get params "operation")
    ((or "eval_last_sexp" "eval_last_expression") (emacs-operator-sly--eval-source (emacs-operator-repl-current-sexp-source) params))
    ("eval_defun" (emacs-operator-sly--eval-source (emacs-operator-repl-current-defun-source) params))
    ("eval_region" (emacs-operator-sly--eval-source (emacs-operator-repl-current-region-source) params)) (_ nil)))
(emacs-operator-register-adapter "sly" #'emacs-operator-sly-applicable-p #'emacs-operator-sly-capabilities :priority 80 :observe #'emacs-operator-sly-observe :eval #'emacs-operator-sly-eval :metadata '(("kind" . "repl") ("status" . "implemented") ("runtime" . "slynk")))
(provide 'emacs-operator-adapter-sly)
