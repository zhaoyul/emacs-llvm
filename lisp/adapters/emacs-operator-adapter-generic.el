;;; emacs-operator-adapter-generic.el --- Adapter registry for Emacs Operator -*- lexical-binding: t; -*-

(require 'cl-lib)
(require 'subr-x)
(require 'emacs-operator-observe)

(cl-defstruct (emacs-operator-adapter-entry
               (:constructor emacs-operator--make-adapter-entry))
  name priority predicate observer capability-provider verifier evaluator validator analyzer metadata)

(defvar emacs-operator-adapters (make-hash-table :test #'equal)
  "Registry of mode/package adapters keyed by string name.")

(defun emacs-operator-register-adapter (name predicate capabilities &rest options)
  "Register adapter NAME.
PREDICATE is called with a context plist. CAPABILITIES may be a value or function.
OPTIONS accepts :priority, :observe, :verify, :eval, :validate, :analyze and :metadata."
  (unless (and (stringp name) (functionp predicate))
    (error "Invalid Emacs Operator adapter registration: %S" name))
  (let ((entry (emacs-operator--make-adapter-entry
                :name name
                :priority (or (plist-get options :priority) 0)
                :predicate predicate
                :observer (plist-get options :observe)
                :capability-provider capabilities
                :verifier (plist-get options :verify)
                :evaluator (plist-get options :eval)
                :validator (plist-get options :validate)
                :analyzer (plist-get options :analyze)
                :metadata (plist-get options :metadata))))
    (puthash name entry emacs-operator-adapters)
    entry))

(defun emacs-operator-unregister-adapter (name)
  (remhash name emacs-operator-adapters))

(defun emacs-operator-adapter-context (&optional target)
  "Return an internal adapter context for the current buffer."
  (list :buffer (current-buffer)
        :target target
        :major-mode major-mode
        :minor-modes (emacs-operator--minor-modes)
        :point (point)
        :buffer-tick (buffer-chars-modified-tick)))

(defun emacs-operator--adapter-applicable-p (entry context)
  (condition-case nil
      (funcall (emacs-operator-adapter-entry-predicate entry) context)
    (error nil)))

(defun emacs-operator-active-adapter-entries (&optional context)
  (let ((context (or context (emacs-operator-adapter-context))) result)
    (maphash (lambda (_name entry)
               (when (emacs-operator--adapter-applicable-p entry context)
                 (push entry result)))
             emacs-operator-adapters)
    (sort result (lambda (a b)
                   (if (= (emacs-operator-adapter-entry-priority a)
                          (emacs-operator-adapter-entry-priority b))
                       (string< (emacs-operator-adapter-entry-name a)
                                (emacs-operator-adapter-entry-name b))
                     (> (emacs-operator-adapter-entry-priority a)
                        (emacs-operator-adapter-entry-priority b)))))))

(defun emacs-operator-active-adapters (&optional context)
  (mapcar #'emacs-operator-adapter-entry-name
          (emacs-operator-active-adapter-entries context)))

(defun emacs-operator--adapter-call-provider (provider context)
  (cond
   ((functionp provider) (funcall provider context))
   (t provider)))

(defun emacs-operator-adapter-describe (entry context)
  `(("name" . ,(emacs-operator-adapter-entry-name entry))
    ("priority" . ,(emacs-operator-adapter-entry-priority entry))
    ("capabilities" . ,(emacs-operator--adapter-call-provider
                         (emacs-operator-adapter-entry-capability-provider entry) context))
    ("has_observer" . ,(if (functionp (emacs-operator-adapter-entry-observer entry)) t :json-false))
    ("has_verifier" . ,(if (functionp (emacs-operator-adapter-entry-verifier entry)) t :json-false))
    ("has_evaluator" . ,(if (functionp (emacs-operator-adapter-entry-evaluator entry)) t :json-false))
    ("has_validator" . ,(if (functionp (emacs-operator-adapter-entry-validator entry)) t :json-false))
    ("has_analyzer" . ,(if (functionp (emacs-operator-adapter-entry-analyzer entry)) t :json-false))
    ("metadata" . ,(emacs-operator-adapter-entry-metadata entry))))

(defun emacs-operator-adapters-capabilities (&optional context adapter-name)
  "Return JSON-friendly capability descriptions for applicable adapters."
  (let* ((context (or context (emacs-operator-adapter-context)))
         (entries (if adapter-name
                      (let ((entry (gethash adapter-name emacs-operator-adapters)))
                        (unless entry
                          (emacs-operator-signal "E_INVALID_ARGUMENT" "Unknown adapter."
                                                 `(("adapter" . ,adapter-name))))
                        (if (emacs-operator--adapter-applicable-p entry context) (list entry) nil))
                    (emacs-operator-active-adapter-entries context))))
    (mapcar (lambda (entry) (emacs-operator-adapter-describe entry context)) entries)))

(defun emacs-operator-adapters-observe (&optional context)
  "Collect mode-specific observation blocks from all active adapters."
  (let ((context (or context (emacs-operator-adapter-context))) result)
    (dolist (entry (emacs-operator-active-adapter-entries context))
      (let ((observer (emacs-operator-adapter-entry-observer entry)))
        (when (functionp observer)
          (condition-case err
              (push (cons (emacs-operator-adapter-entry-name entry)
                          (funcall observer context)) result)
            (error
             (push (cons (emacs-operator-adapter-entry-name entry)
                         `(("error" . ,(error-message-string err)))) result))))))
    (nreverse result)))

(defun emacs-operator-adapters-verify (action before after &optional context)
  "Run applicable adapter postcondition verifiers.
A verifier should return a JSON-friendly object and signal emacs-operator-error only
for a hard invariant violation."
  (let ((context (or context (emacs-operator-adapter-context))) result)
    (dolist (entry (emacs-operator-active-adapter-entries context))
      (let ((verifier (emacs-operator-adapter-entry-verifier entry)))
        (when (functionp verifier)
          (let* ((name (emacs-operator-adapter-entry-name entry))
                 (before-state (and before (emacs-operator--get before name)))
                 (after-state (and after (emacs-operator--get after name))))
            (push (cons name
                        (funcall verifier action before-state after-state context)) result)))))
    (nreverse result)))

(defun emacs-operator-adapters-validate (&optional context adapter-name options)
  "Run read-only structural validators for applicable adapters.
ADAPTER-NAME limits validation to one adapter. OPTIONS is passed through to
the validator. Invalid structure is returned as data rather than signaled, so
an agent can diagnose and repair a buffer without losing the diagnostic."
  (let* ((context (or context (emacs-operator-adapter-context)))
         (entries (if adapter-name
                      (let ((entry (gethash adapter-name emacs-operator-adapters)))
                        (unless entry
                          (emacs-operator-signal "E_INVALID_ARGUMENT" "Unknown validation adapter."
                                                 `(("adapter" . ,adapter-name))))
                        (if (emacs-operator--adapter-applicable-p entry context) (list entry) nil))
                    (emacs-operator-active-adapter-entries context)))
         result)
    (dolist (entry entries)
      (let ((validator (emacs-operator-adapter-entry-validator entry)))
        (when (functionp validator)
          (push (cons (emacs-operator-adapter-entry-name entry)
                      (funcall validator options context))
                result))))
    (when (null result)
      (emacs-operator-signal
       "E_COMMAND_NOT_FOUND"
       (if adapter-name
           "The requested adapter is not applicable to the target buffer or does not provide structural validation."
         "No active adapter provides structural validation for the target buffer.")
       (and adapter-name `(("adapter" . ,adapter-name)))))
    (nreverse result)))


(defun emacs-operator-adapters-analyze (operation params &optional context adapter-name)
  "Run a read-only analyzer OPERATION with PARAMS.
ADAPTER-NAME optionally selects one applicable adapter. Analyzers are required
to leave buffer text unchanged; accidental mutations are rejected."
  (let* ((context (or context (emacs-operator-adapter-context)))
         (entries (if adapter-name
                      (let ((entry (gethash adapter-name emacs-operator-adapters)))
                        (unless entry
                          (emacs-operator-signal "E_INVALID_ARGUMENT" "Unknown analysis adapter."
                                                 `(("adapter" . ,adapter-name))))
                        (if (emacs-operator--adapter-applicable-p entry context) (list entry) nil))
                    (emacs-operator-active-adapter-entries context)))
         result)
    (while (and entries (not result))
      (let* ((entry (pop entries))
             (analyzer (emacs-operator-adapter-entry-analyzer entry)))
        (when (and (functionp analyzer)
                   (emacs-operator--adapter-applicable-p entry context))
          (let ((before-tick (buffer-chars-modified-tick))
                (before-modified (buffer-modified-p)))
            (setq result (funcall analyzer operation params context))
            (when (or (/= before-tick (buffer-chars-modified-tick))
                      (not (eq before-modified (buffer-modified-p))))
              (emacs-operator-signal
               "E_COMMAND_FAILED"
               "Adapter analyzer mutated the target buffer; analysis must be read-only."
               `(("adapter" . ,(emacs-operator-adapter-entry-name entry))
                 ("operation" . ,operation))))
            (when result
              (setq result `(("adapter" . ,(emacs-operator-adapter-entry-name entry))
                             ("analysis" . ,result))))))))
    (or result
        (emacs-operator-signal
         "E_COMMAND_NOT_FOUND"
         "No active adapter can handle the requested analysis operation."
         `(("operation" . ,operation) ("adapter" . ,adapter-name))))))

(defun emacs-operator-adapter-eval-dispatch (params &optional context)
  "Dispatch a structured evaluation request to an applicable adapter."
  (let* ((context (or context (emacs-operator-adapter-context)))
         (requested (emacs-operator--get params "adapter"))
         (entries (if requested
                      (let ((entry (gethash requested emacs-operator-adapters)))
                        (unless entry
                          (emacs-operator-signal "E_INVALID_ARGUMENT" "Unknown evaluation adapter."
                                                 `(("adapter" . ,requested))))
                        (list entry))
                    (emacs-operator-active-adapter-entries context)))
         result)
    (while (and entries (not result))
      (let* ((entry (pop entries))
             (evaluator (emacs-operator-adapter-entry-evaluator entry)))
        (when (and (functionp evaluator)
                   (emacs-operator--adapter-applicable-p entry context))
          (setq result (funcall evaluator params context))
          (when result
            (setq result `(("adapter" . ,(emacs-operator-adapter-entry-name entry))
                           ("result" . ,result)))))))
    (or result
        (emacs-operator-signal "E_COMMAND_NOT_FOUND"
                               "No active adapter can handle the requested evaluation operation."
                               `(("operation" . ,(emacs-operator--get params "operation")))))))

(defun emacs-operator-generic-observe (_context)
  `(("major_mode" . ,(symbol-name major-mode))
    ("minor_modes" . ,(emacs-operator--minor-modes))
    ("point" . ,(point))
    ("buffer_tick" . ,(buffer-chars-modified-tick))))

(defun emacs-operator-generic-capabilities (_context)
  '(("operations" .
     ((("name" . "observe") ("channel" . "semantic") ("mutation" . :json-false))
      (("name" . "command") ("channel" . "semantic") ("mutation" . t))
      (("name" . "edit") ("channel" . "semantic") ("mutation" . t))
      (("name" . "keys") ("channel" . "internal_keys") ("mutation" . t))))))

(emacs-operator-register-adapter
 "generic"
 (lambda (_context) t)
 #'emacs-operator-generic-capabilities
 :priority 0
 :observe #'emacs-operator-generic-observe
 :metadata '(("kind" . "core")))

(provide 'emacs-operator-adapter-generic)
;;; emacs-operator-adapter-generic.el ends here
