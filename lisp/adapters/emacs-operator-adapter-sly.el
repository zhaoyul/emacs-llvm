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
          ((not (or (fboundp 'sly-eval-and-grab-output) (fboundp 'sly-eval))) '(nil . "This SLY version does not expose a supported synchronous evaluation API."))
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
(defun emacs-operator-sly--guarded-eval-form (source)
  "Build a Slynk form that returns canonical values or structured conditions."
  `(handler-case
       (list :ok
             (let ((slynk:*echo-number-alist* nil))
               (slynk:eval-and-grab-output ,source)))
     (condition (condition)
       (list :error
             (princ-to-string (type-of condition))
             (princ-to-string condition)))))

(defun emacs-operator-sly--eval-source (source params)
  (let* ((package (emacs-operator-sly--package))
         (ready (emacs-operator-sly--ready-state))
         (timeout (emacs-operator-repl-timeout-seconds params))
         (operation (or (emacs-operator--get params "operation") "evaluation"))
         (metadata (emacs-operator-repl-source-metadata source operation)))
    (unless (car ready) (emacs-operator-signal "E_COMMAND_FAILED" (cdr ready)))
    (condition-case err
        (with-timeout (timeout (emacs-operator-repl-timeout-result "SLY" package metadata))
          (cond
           ((fboundp 'sly-eval-and-grab-output)
            (let* ((pair (sly-eval-and-grab-output `(slynk:eval-and-grab-output ,source) package))
                   (stdout (if (consp pair) (or (car pair) "") ""))
                   (value (if (consp pair) (cadr pair) pair)))
              (emacs-operator-repl-result
               :stdout stdout :value value :namespace-or-package package
               :metadata metadata :completed t)))
           ((fboundp 'sly-eval)
            (let* ((response (sly-eval (emacs-operator-sly--guarded-eval-form source) package))
                   (status (car-safe response)))
              (pcase status
                (:ok
                 (let* ((pair (cadr response))
                        (stdout (if (consp pair) (or (car pair) "") ""))
                        (value (if (consp pair) (cadr pair) pair)))
                   (emacs-operator-repl-result
                    :stdout stdout :value value :namespace-or-package package
                    :metadata metadata :completed t)))
                (:error
                 (emacs-operator-repl-result
                  :stderr (or (nth 2 response) "")
                  :condition (or (nth 1 response) "condition")
                  :backtrace-handle (format "sly:%sx" (sxhash-equal response))
                  :namespace-or-package package :metadata metadata :completed nil))
                (_
                 (let* ((pair response)
                        (stdout (if (consp pair) (or (car pair) "") ""))
                        (value (if (consp pair) (cadr pair) pair)))
                   (emacs-operator-repl-result
                    :stdout stdout :value value :namespace-or-package package
                    :metadata metadata :completed t))))))))
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
