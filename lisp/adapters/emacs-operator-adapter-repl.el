;;; emacs-operator-adapter-repl.el --- Shared REPL adapter helpers -*- lexical-binding: t; -*-

(require 'cl-lib)
(require 'subr-x)
(require 'emacs-operator-adapter-generic)

(defcustom emacs-operator-repl-default-timeout-ms 10000
  "Default structured REPL timeout in milliseconds."
  :type 'integer :group 'emacs-operator)

(defcustom emacs-operator-repl-max-timeout-ms 30000
  "Maximum structured REPL timeout in milliseconds."
  :type 'integer :group 'emacs-operator)

(defcustom emacs-operator-repl-max-source-bytes 262144
  "Maximum bytes accepted from a buffer-derived structured evaluation source."
  :type 'integer :group 'emacs-operator)

(defun emacs-operator-repl-timeout-seconds (params)
  (let ((ms (or (emacs-operator--get params "timeout_ms")
                emacs-operator-repl-default-timeout-ms)))
    (unless (and (integerp ms) (> ms 0))
      (emacs-operator-signal "E_INVALID_ARGUMENT" "timeout_ms must be a positive integer."))
    (/ (float (min ms emacs-operator-repl-max-timeout-ms)) 1000.0)))

(defun emacs-operator-repl--bounded-source (source operation)
  (when (> (string-bytes source) emacs-operator-repl-max-source-bytes)
    (emacs-operator-signal "E_INVALID_ARGUMENT"
                           "Buffer-derived evaluation source exceeds the configured safety bound."
                           `(("operation" . ,operation)
                             ("bytes" . ,(string-bytes source))
                             ("max_bytes" . ,emacs-operator-repl-max-source-bytes))))
  source)

(defun emacs-operator-repl-source-bounds (operation)
  "Return the buffer bounds for structured evaluation OPERATION.
The returned vector is derived from the current target buffer and is used both
for evaluation and for verification-ticket target identity."
  (pcase operation
    ((or "eval_last_sexp" "eval_last_expression")
     (let ((end (point)) start)
       (save-excursion
         (condition-case err
             (progn (backward-sexp) (setq start (point)))
           (error
            (emacs-operator-signal "E_COMMAND_FAILED"
                                   "No complete expression exists immediately before point."
                                   `(("condition" . ,(error-message-string err)))))))
       (vector start end)))
    ("eval_defun"
     (save-excursion
       (condition-case err
           (let ((bounds (emacs-operator-repl--enclosing-defun-bounds (point))))
             (unless bounds
               (emacs-operator-signal "E_COMMAND_FAILED" "No enclosing defun could be resolved."))
             bounds)
         (emacs-operator-error (signal (car err) (cdr err)))
         (error
          (emacs-operator-signal "E_COMMAND_FAILED"
                                 "No enclosing defun could be resolved."
                                 `(("condition" . ,(error-message-string err))))))))
    ("eval_region"
     (unless (use-region-p)
       (emacs-operator-signal "E_COMMAND_FAILED"
                              "eval_region requires an active region in the target buffer."))
     (vector (region-beginning) (region-end)))
    (_
     (emacs-operator-signal "E_INVALID_ARGUMENT"
                            "Unsupported structured evaluation operation."
                            `(("operation" . ,operation))))))

;; `beginning-of-defun' moves to the *previous* top-level form when point is
;; already at the start of a defun, which is exactly where structured
;; navigation (`beginning_of_defun') leaves it.  Resolve forward first, the
;; way `eval-defun' does, and only accept a form that actually contains ORIG.
(defun emacs-operator-repl--enclosing-defun-bounds (orig)
  "Return [START END] of the top-level form containing ORIG, or nil."
  (let ((contains (lambda (start end)
                    (and start end (< start end) (<= start orig) (<= orig end)))))
    (or (save-excursion
          (goto-char orig)
          (let (start end)
            (end-of-defun)
            (setq end (point))
            (beginning-of-defun)
            (setq start (point))
            (when (funcall contains start end) (vector start end))))
        (save-excursion
          (goto-char orig)
          (let (start end)
            (beginning-of-defun)
            (setq start (point))
            (end-of-defun)
            (setq end (point))
            (when (funcall contains start end) (vector start end)))))))

(defun emacs-operator-repl-source-from-bounds (bounds operation)
  "Return bounded source for BOUNDS and OPERATION."
  (let ((start (aref bounds 0))
        (end (aref bounds 1)))
    (unless (and (integerp start) (integerp end)
                 (<= (point-min) start) (< start end) (<= end (point-max)))
      (emacs-operator-signal "E_COMMAND_FAILED"
                             "Structured evaluation source bounds are invalid."
                             `(("operation" . ,operation))))
    (emacs-operator-repl--bounded-source
     (buffer-substring-no-properties start end) operation)))

(defun emacs-operator-repl-current-sexp-source ()
  "Return source for the expression before point, only from the target buffer."
  (emacs-operator-repl-source-from-bounds
   (emacs-operator-repl-source-bounds "eval_last_sexp") "eval_last_sexp"))

(defun emacs-operator-repl-current-defun-source ()
  "Return source for the defun containing point, only from the target buffer."
  (emacs-operator-repl-source-from-bounds
   (emacs-operator-repl-source-bounds "eval_defun") "eval_defun"))

(defun emacs-operator-repl-current-region-source ()
  "Return source from the active region, only from the target buffer."
  (emacs-operator-repl-source-from-bounds
   (emacs-operator-repl-source-bounds "eval_region") "eval_region"))

(defun emacs-operator-repl-source-metadata (source operation &optional bounds)
  "Return bounded JSON-friendly metadata for buffer-derived SOURCE.
BOUNDS defaults to the same structured evaluation target used for OPERATION.
The start position is intentionally stable across ordinary in-target repairs,
while a moved point/region that selects a different target changes it."
  (let* ((resolved-bounds (or bounds (emacs-operator-repl-source-bounds operation)))
         (start (aref resolved-bounds 0)))
    `(("operation" . ,operation)
      ("source_bounds" . ,resolved-bounds)
      ("source_start" . ,start)
      ("source_sha256" . ,(secure-hash 'sha256 source))
      ("source_bytes" . ,(string-bytes source)))))

(defun emacs-operator-repl-result (&rest plist)
  (let ((result
         `(("stdout" . ,(or (plist-get plist :stdout) ""))
           ("stderr" . ,(or (plist-get plist :stderr) ""))
           ("value" . ,(plist-get plist :value))
           ("condition" . ,(plist-get plist :condition))
           ("backtrace_handle" . ,(plist-get plist :backtrace-handle))
           ("namespace_or_package" . ,(plist-get plist :namespace-or-package))
           ("completed" . ,(if (plist-get plist :completed) t :json-false)))))
    (if (plist-member plist :metadata)
        (append result `(("metadata" . ,(plist-get plist :metadata))))
      result)))

(defun emacs-operator-repl-timeout-result (runtime namespace &optional metadata)
  (emacs-operator-repl-result
   :stderr (format "%s evaluation timed out." runtime)
   :condition "timeout"
   :namespace-or-package namespace
   :metadata metadata
   :completed nil))

(provide 'emacs-operator-adapter-repl)
;;; emacs-operator-adapter-repl.el ends here
