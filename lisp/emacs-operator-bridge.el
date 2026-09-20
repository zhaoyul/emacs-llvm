;;; emacs-operator-bridge.el --- Local JSON-RPC bridge -*- lexical-binding: t; -*-

(require 'cl-lib)
(require 'json)
(require 'subr-x)
(require 'emacs-operator-observe)
(require 'emacs-operator-policy)
(require 'emacs-operator-keys)
(require 'emacs-operator-transaction)
(require 'emacs-operator-adapter-generic)
(require 'emacs-operator-adapter-lisp)
(require 'emacs-operator-adapter-org)
(require 'emacs-operator-adapter-sly)
(require 'emacs-operator-adapter-cider)

(require 'emacs-operator-refactor-intelligence)
(defconst emacs-operator-bridge-protocol-version "1.0")
(defcustom emacs-operator-max-message-bytes (* 1024 1024)
  "Maximum single bridge request or response size in bytes."
  :type 'integer
  :group 'emacs-operator)
(defcustom emacs-operator-heartbeat-seconds 5
  "Instance-record heartbeat interval."
  :type 'integer
  :group 'emacs-operator)

(defvar emacs-operator--rpc-methods (make-hash-table :test #'equal))
(defvar emacs-operator--server nil)
(defvar emacs-operator--heartbeat-timer nil)
(defvar emacs-operator--instance-id nil)
(defvar emacs-operator--token nil)
(defvar emacs-operator--runtime-dir nil)
(defvar emacs-operator--instance-record-path nil)
(defvar emacs-operator--token-path nil)
(defvar emacs-operator--started-at nil)
(defvar emacs-operator--clients nil)

(defun emacs-operator-register-method (name function)
  (puthash name function emacs-operator--rpc-methods))

(defun emacs-operator--runtime-directory ()
  (let ((explicit (getenv "EMACS_OPERATOR_RUNTIME_DIR")))
    (cond
     (explicit (expand-file-name explicit))
     ((and (eq system-type 'gnu/linux) (getenv "XDG_RUNTIME_DIR"))
      (expand-file-name "emacs-operator" (getenv "XDG_RUNTIME_DIR")))
     ((eq system-type 'windows-nt)
      (expand-file-name "EmacsOperator/runtime" (or (getenv "LOCALAPPDATA") temporary-file-directory)))
     (t (expand-file-name (format "emacs-operator-%s" (user-uid)) temporary-file-directory)))))

(defun emacs-operator--ensure-runtime-directory ()
  (setq emacs-operator--runtime-dir (emacs-operator--runtime-directory))
  (make-directory emacs-operator--runtime-dir t)
  (unless (eq system-type 'windows-nt)
    (set-file-modes emacs-operator--runtime-dir #o700))
  emacs-operator--runtime-dir)

(defun emacs-operator--secure-random-token ()
  "Return a 256-bit hexadecimal bridge token.

The normal macOS/Linux path reads 32 bytes from /dev/urandom.  A guarded
PRNG fallback exists only for restricted test containers where the kernel
entropy device is deliberately absent.  Production callers must not enable
that fallback." 
  (cond
   ((file-readable-p "/dev/urandom")
    (let ((bytes (with-temp-buffer
                   (set-buffer-multibyte nil)
                   (insert-file-contents-literally "/dev/urandom" nil 0 32)
                   (buffer-string))))
      (mapconcat (lambda (byte) (format "%02x" byte))
                 (string-to-list bytes) "")))
   ((equal (getenv "EMACS_OPERATOR_ALLOW_PRNG_TOKEN") "1")
    ;; `random' with argument t asks Emacs to seed from the operating
    ;; system entropy pool when possible.  This path is intentionally
    ;; opt-in because the Lisp PRNG is not advertised as a CSPRNG.
    (random t)
    (display-warning
     'emacs-operator
     "Using the test-only PRNG bridge-token fallback because /dev/urandom is unavailable."
     :warning)
    (secure-hash
     'sha256
     (mapconcat
      (lambda (_index)
        (format "%x:%s:%s:%s"
                (random most-positive-fixnum)
                (current-time)
                (emacs-pid)
                (emacs-operator--uuid)))
      (number-sequence 1 16)
      "|")))
   (t
    (emacs-operator-signal
     "E_INTERNAL"
     (concat "Secure token generation requires /dev/urandom. "
             "Restricted acceptance containers may explicitly set "
             "EMACS_OPERATOR_ALLOW_PRNG_TOKEN=1; do not use that fallback in production.")))))

(defun emacs-operator--atomic-write-json (file object &optional mode)
  (let ((temp (make-temp-file (expand-file-name ".emacs-operator-" emacs-operator--runtime-dir))))
    (unwind-protect
        (progn
          (with-temp-file temp
            (insert (json-encode object)))
          (when (and mode (not (eq system-type 'windows-nt))) (set-file-modes temp mode))
          (rename-file temp file t)
          (when (and mode (not (eq system-type 'windows-nt))) (set-file-modes file mode)))
      (when (file-exists-p temp) (ignore-errors (delete-file temp))))))

(defun emacs-operator--instance-record ()
  (let* ((port (and (process-live-p emacs-operator--server)
                    (process-contact emacs-operator--server :service)))
         (port (if (stringp port) (string-to-number port) port)))
    `(("protocol_version" . ,emacs-operator-bridge-protocol-version)
      ("instance_id" . ,emacs-operator--instance-id)
      ("pid" . ,(emacs-pid))
      ("host" . "127.0.0.1")
      ("port" . ,port)
      ("token_file" . ,emacs-operator--token-path)
      ("emacs_version" . ,emacs-version)
      ("system_type" . ,(symbol-name system-type))
      ("window_system" . ,(and window-system (symbol-name window-system)))
      ("started_at" . ,emacs-operator--started-at)
      ("heartbeat_at" . ,(format-time-string "%FT%TZ" nil t))
      ("daemon" . ,(if (daemonp) t :json-false))
      ("gui_frame_count" . ,(cl-count-if #'display-graphic-p (frame-list)))
      ("available_adapters" . ,(if (boundp 'emacs-operator-adapters)
                                    (let (names)
                                      (maphash (lambda (name _entry) (push name names)) emacs-operator-adapters)
                                      (sort names #'string<))
                                  (list "generic"))))))

(defun emacs-operator--write-instance-record ()
  (when (and emacs-operator--instance-record-path (process-live-p emacs-operator--server))
    (emacs-operator--atomic-write-json emacs-operator--instance-record-path (emacs-operator--instance-record) #o600)))

(defun emacs-operator--pid-visible-via-process-attributes-p (pid)
  "Return non-nil when `process-attributes' can confirm PID exists."
  (condition-case nil
      (and (process-attributes pid) t)
    (error nil)))

(defun emacs-operator--pid-visible-via-signal-zero-p (pid)
  "Return non-nil when the kernel accepts signal 0 for PID.

Signal 0 performs an existence/permission probe without delivering a signal."
  (condition-case nil
      (progn
        (signal-process pid 0)
        t)
    (error nil)))

(defun emacs-operator--pid-alive-p (pid)
  "Return non-nil when PID can be verified as alive.

`process-attributes' is preferred because it is side-effect free, but it can
return nil in otherwise valid isolated/chroot environments where /proc is not
visible.  In that case fall back to signal 0, which asks the kernel to check
process existence without delivering a signal.  This prevents a second Emacs
instance from deleting the authentication token of a live first instance."
  (and (integerp pid)
       (> pid 0)
       (or (emacs-operator--pid-visible-via-process-attributes-p pid)
           (emacs-operator--pid-visible-via-signal-zero-p pid))))

(defun emacs-operator--stale-record-p (record)
  (let ((pid (emacs-operator--get record "pid"))
        (heartbeat (emacs-operator--get record "heartbeat_at")))
    (or (not (emacs-operator--pid-alive-p pid))
        (condition-case nil
            (> (- (float-time) (float-time (date-to-time heartbeat))) 30)
          (error t)))))

(defun emacs-operator--cleanup-stale-records ()
  (when (file-directory-p emacs-operator--runtime-dir)
    (dolist (file (directory-files emacs-operator--runtime-dir t "\\`instance-.*\\.json\\'"))
      (condition-case nil
          (let ((record (with-temp-buffer
                          (insert-file-contents file)
                          (json-parse-string (buffer-string) :object-type 'alist :array-type 'list
                                             :null-object nil :false-object :json-false))))
            (when (emacs-operator--stale-record-p record)
              (let ((token-file (emacs-operator--get record "token_file")))
                (ignore-errors (delete-file file))
                (when (and token-file (string-prefix-p (file-name-as-directory emacs-operator--runtime-dir)
                                                       (expand-file-name token-file)))
                  (ignore-errors (delete-file token-file))))))
        (error nil)))))

(defun emacs-operator--send-json (process object)
  (let* ((json (json-encode object))
         (body (encode-coding-string json 'utf-8 t))
         (length (string-bytes body))
         (header (format "Content-Length: %d\r\nContent-Type: application/json\r\n\r\n" length)))
    (when (> length emacs-operator-max-message-bytes)
      (error "Response exceeds emacs-operator-max-message-bytes"))
    (process-send-string process (concat (string-as-unibyte header) body))))

(defun emacs-operator--rpc-error-object (id code message &optional details rpc-code)
  `(("jsonrpc" . "2.0")
    ("id" . ,id)
    ("error" . (("code" . ,(or rpc-code -32000))
                 ("message" . ,message)
                 ("data" . (("code" . ,code)
                             ("details" . ,details)))))))

(defun emacs-operator--rpc-success-object (id result)
  `(("jsonrpc" . "2.0") ("id" . ,id) ("result" . ,result)))

(defun emacs-operator--dispatch-request (process request)
  (let* ((id (emacs-operator--get request "id"))
         (method (emacs-operator--get request "method"))
         (params (or (emacs-operator--get request "params") '())))
    (condition-case err
        (progn
          (unless (and (stringp method) (equal (emacs-operator--get request "jsonrpc") "2.0"))
            (emacs-operator-signal "E_INVALID_ARGUMENT" "Invalid JSON-RPC request."))
          (if (equal method "initialize")
              (let ((token (emacs-operator--get params "token")))
                (unless (and (stringp token) (string-equal token emacs-operator--token))
                  (emacs-operator-signal "E_AUTH_FAILED" "Bridge token is invalid."))
                (process-put process 'emacs-operator-authorized t)
                (emacs-operator--send-json process (emacs-operator--rpc-success-object id (emacs-operator-instance-describe params))))
            (unless (process-get process 'emacs-operator-authorized)
              (emacs-operator-signal "E_AUTH_FAILED" "Connection has not completed initialize authentication."))
            (let ((function (gethash method emacs-operator--rpc-methods)))
              (if (not function)
                  (emacs-operator--send-json process
                                             (emacs-operator--rpc-error-object id "E_COMMAND_NOT_FOUND"
                                                                               (format "Unknown bridge method: %s" method) nil -32601))
                (emacs-operator--send-json process
                                           (emacs-operator--rpc-success-object id (funcall function params)))))))
      (emacs-operator-error
       (let ((code (nth 1 err))
             (message (nth 2 err))
             (details (nth 3 err)))
         (ignore-errors (emacs-operator--send-json process (emacs-operator--rpc-error-object id code message details)))))
      (error
       (ignore-errors (emacs-operator--send-json process
                                                  (emacs-operator--rpc-error-object id "E_INTERNAL" (error-message-string err))))))))

(defun emacs-operator--parse-one-frame (data)
  "Return (BODY . REST), nil if incomplete, or signal on invalid framing. DATA is unibyte."
  (let ((header-end (string-match "\r\n\r\n" data)))
    (when header-end
      (let* ((body-start (+ header-end 4))
             (header (decode-coding-string (substring data 0 header-end) 'us-ascii))
             (case-fold-search t))
        (unless (string-match "Content-Length:[ \t]*\\([0-9]+\\)" header)
          (emacs-operator-signal "E_INVALID_ARGUMENT" "Missing Content-Length header."))
        (let ((length (string-to-number (match-string 1 header))))
          (when (> length emacs-operator-max-message-bytes)
            (emacs-operator-signal "E_INVALID_ARGUMENT" "Incoming bridge message exceeds size limit."
                                   `(("content_length" . ,length) ("max_message_bytes" . ,emacs-operator-max-message-bytes))))
          (when (>= (length data) (+ body-start length))
            (cons (substring data body-start (+ body-start length))
                  (substring data (+ body-start length)))))))))

(defun emacs-operator--client-filter (process chunk)
  (condition-case err
      (let ((data (concat (or (process-get process 'emacs-operator-pending) "")
                          (string-as-unibyte chunk)))
            frame)
        (while (setq frame (emacs-operator--parse-one-frame data))
          (let* ((body (decode-coding-string (car frame) 'utf-8))
                 (request (json-parse-string body :object-type 'alist :array-type 'list
                                             :null-object nil :false-object :json-false)))
            (setq data (cdr frame))
            (emacs-operator--dispatch-request process request)))
        (process-put process 'emacs-operator-pending data))
    (emacs-operator-error
     (let ((code (nth 1 err)) (message (nth 2 err)) (details (nth 3 err)))
       (ignore-errors (emacs-operator--send-json process (emacs-operator--rpc-error-object nil code message details)))
       (delete-process process)))
    (error
     (ignore-errors (emacs-operator--send-json process
                                                (emacs-operator--rpc-error-object nil "E_INTERNAL" (error-message-string err))))
     (delete-process process))))

(defun emacs-operator--client-sentinel (process _event)
  (unless (process-live-p process)
    (setq emacs-operator--clients (delq process emacs-operator--clients))))

(defun emacs-operator--accept-client (_server client _message)
  (set-process-coding-system client 'binary 'binary)
  (set-process-filter client #'emacs-operator--client-filter)
  (set-process-sentinel client #'emacs-operator--client-sentinel)
  (set-process-query-on-exit-flag client nil)
  (process-put client 'emacs-operator-pending "")
  (process-put client 'emacs-operator-authorized nil)
  (push client emacs-operator--clients))

(defun emacs-operator-instance-describe (_params)
  `(("protocol_version" . ,emacs-operator-bridge-protocol-version)
    ("instance" . ,(emacs-operator--instance-record))
    ("channels" . (("semantic" . t) ("internal_keys" . t) ("native_keys" . :json-false)))
    ("features" . (("transactions" . "single_buffer_snapshot")
                    ("adapter_registry" . t)
                    ("adapter_analysis" . t)
                    ("structured_eval" . t)
                    ("structured_lisp_edit" . t)
                    ("adapter_validation" . t)
                    ("project_rename_journal" . t)
                    ("verification_tickets" . t)
                    ("org_adapter" . ,(if (featurep 'org) t :json-false))
                    ("org_table" . ,(if (featurep 'org-table) t :json-false))
                    ("org_babel" . ,(if (featurep 'ob-core) t :json-false))
                    ("paredit" . ,(if (featurep 'paredit) t :json-false))
                    ("sly" . ,(if (featurep 'sly) t :json-false))
                    ("cider" . ,(if (featurep 'cider) t :json-false))
                    ("screen_capture" . :json-false)))))



(defun emacs-operator-adapter-analyze (params)
  "Run a read-only adapter analysis operation in the target buffer."
  (let* ((target (emacs-operator--get params "target"))
         (adapter (emacs-operator--get params "adapter"))
         (operation (emacs-operator--get params "operation"))
         (arguments (or (emacs-operator--get params "params") '())))
    (unless (and (stringp operation) (not (string-empty-p operation)))
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Adapter analysis requires an operation."))
    (emacs-operator-call-in-target
     target nil t
     (lambda (buffer _window _frame)
       (with-current-buffer buffer
         (unless (fboundp 'emacs-operator-adapters-analyze)
           (emacs-operator-signal "E_INTERNAL" "Adapter analysis registry is not loaded."))
         (let ((before-tick (buffer-chars-modified-tick))
               (before-modified (buffer-modified-p)))
           (let ((analysis (emacs-operator-adapters-analyze
                            operation arguments
                            (emacs-operator-adapter-context target)
                            adapter)))
             (when (or (/= before-tick (buffer-chars-modified-tick))
                       (not (eq before-modified (buffer-modified-p))))
               (emacs-operator-signal "E_COMMAND_FAILED"
                                      "Read-only adapter analysis changed the target buffer."))
             `(("operation" . ,operation)
               ("analysis" . ,analysis)
               ("buffer_id" . ,(emacs-operator-buffer-id buffer))
               ("buffer_tick" . ,(buffer-chars-modified-tick))))))))))

(defun emacs-operator-adapter-validate (params)
  "Run read-only adapter validation in the target buffer."
  (let* ((target (emacs-operator--get params "target"))
         (adapter (emacs-operator--get params "adapter"))
         (options (or (emacs-operator--get params "options") '())))
    (emacs-operator-call-in-target
     target nil t
     (lambda (buffer _window _frame)
       (with-current-buffer buffer
         (unless (fboundp 'emacs-operator-adapters-validate)
           (emacs-operator-signal "E_INTERNAL" "Adapter validation registry is not loaded."))
         (let* ((validations (emacs-operator-adapters-validate
                              (emacs-operator-adapter-context target) adapter options))
                (all-valid
                 (cl-every
                  (lambda (entry)
                    (emacs-operator--truthy-json-p
                     (emacs-operator--get (cdr entry) "valid")))
                  validations)))
           `(("valid" . ,(if all-valid t :json-false))
             ("adapter" . ,adapter)
             ("validations" . ,validations)
             ("buffer_id" . ,(emacs-operator-buffer-id buffer))
             ("buffer_tick" . ,(buffer-chars-modified-tick)))))))))

(defun emacs-operator-adapter-eval (params)
  "Execute a structured adapter evaluation operation.
Arbitrary source-string evaluation remains disabled in this phase."
  (let* ((target (emacs-operator--get params "target"))
         (precondition (emacs-operator--get params "precondition"))
         (policy (emacs-operator--get params "policy"))
         (profile (emacs-operator--get policy "profile"))
         (code (emacs-operator--get params "code")))
    (unless (equal profile "trusted_local")
      (emacs-operator-signal "E_POLICY_DENIED"
                             "Structured evaluation requires the trusted_local permission profile."))
    (when (and (stringp code) (not (string-empty-p code)))
      (emacs-operator-signal "E_POLICY_DENIED"
                             "Arbitrary source-string evaluation is disabled; use a structured operation on code already in the target buffer."))
    (emacs-operator-check-precondition target precondition)
    (emacs-operator-call-in-target
     target nil t
     (lambda (buffer _window _frame)
       (with-current-buffer buffer
         (let ((before-tick (buffer-chars-modified-tick))
               (before-point (point))
               (emacs-operator--command-source 'rpc))
           (condition-case err
               (let ((result (emacs-operator-adapter-eval-dispatch
                              params (emacs-operator-adapter-context target))))
                 `(("executed" . t)
                   ("operation" . ,(emacs-operator--get params "operation"))
                   ("buffer_tick_before" . ,before-tick)
                   ("buffer_tick_after" . ,(buffer-chars-modified-tick))
                   ("point_before" . ,before-point)
                   ("point_after" . ,(point))
                   ("evaluation" . ,result)))
             (emacs-operator-error (signal (car err) (cdr err)))
             (error
              (emacs-operator-signal "E_COMMAND_FAILED"
                                     (error-message-string err)
                                     `(("operation" . ,(emacs-operator--get params "operation"))))))))))))


(defun emacs-operator-project-rename-rpc (params)
  "Plan, preview, apply, inspect, rollback or commit a project-wide Lisp rename."
  (let* ((target (emacs-operator--get params "target"))
         (action (emacs-operator--get params "action"))
         (precondition (emacs-operator--get params "precondition"))
         (policy (emacs-operator--get params "policy")))
    (emacs-operator-check-precondition target precondition)
    (emacs-operator-call-in-target
     target nil t
     (lambda (buffer _window _frame)
       (with-current-buffer buffer
         (cond
          ((equal action "plan")
           (emacs-operator-project-rename-plan
            (emacs-operator--get params "old_symbol")
            (emacs-operator--get params "new_symbol")
            (emacs-operator--truthy-json-p
             (emacs-operator--get params "include_definitions"))
            (emacs-operator--get params "language")
            (emacs-operator--get params "qualification_policy")
            (emacs-operator--get params "requested_new_symbol")
            (emacs-operator--get params "symbol_semantics")))
          ((equal action "preview")
           (emacs-operator-project-rename-preview
            (emacs-operator--get params "plan_id")
            (emacs-operator--get params "max_preview_edits")))
          ((equal action "apply")
           (emacs-operator-project-rename-apply
            (emacs-operator--get params "plan_id") policy))
          ((equal action "status")
           (emacs-operator-project-rename-journal-status
            (emacs-operator--get params "journal_id")))
          ((equal action "rollback")
           (emacs-operator-project-rename-rollback
            (emacs-operator--get params "journal_id") policy))
          ((equal action "commit")
           (emacs-operator-project-rename-commit
            (emacs-operator--get params "journal_id")))
          (t
           (emacs-operator-signal
            "E_INVALID_ARGUMENT"
            "Project rename action must be plan, preview, apply, status, rollback or commit."
            `(("action" . ,action))))))))))

(defun emacs-operator-ping (_params)
  `(("pong" . t) ("state_seq" . ,emacs-operator--state-seq)
    ("time" . ,(format-time-string "%FT%TZ" nil t))))

(defun emacs-operator-session-target-resolve (params)
  (let ((selector (or (emacs-operator--get params "selector") params)))
    (emacs-operator-resolve-target selector)))

(defun emacs-operator-edit-apply (params)
  (let* ((target (emacs-operator--get params "target"))
         (operation (emacs-operator--get params "operation"))
         (precondition (emacs-operator--get params "precondition"))
         (policy (emacs-operator--get params "policy")))
    (emacs-operator-check-precondition target precondition)
    (emacs-operator-call-in-target
     target nil t
     (lambda (buffer _window _frame)
       (emacs-operator-policy-check-buffer-mutation policy buffer)
       (with-current-buffer buffer
         (when buffer-read-only (emacs-operator-signal "E_POLICY_DENIED" "Target buffer is read-only."))
         (let ((before-tick (buffer-chars-modified-tick))
               (before-point (point))
               (emacs-operator--command-source 'rpc)
               (inhibit-read-only nil))
           (atomic-change-group
             (pcase operation
               ("insert"
                (let ((position (or (emacs-operator--get params "position") (point))))
                  (unless (and (integerp position) (<= (point-min) position) (<= position (point-max)))
                    (emacs-operator-signal "E_INVALID_ARGUMENT" "insert position is outside the accessible buffer."))
                  (goto-char position)
                  (insert (or (emacs-operator--get params "text") ""))))
               ((or "replace_range" "delete_range")
                (let ((start (emacs-operator--get params "start"))
                      (end (emacs-operator--get params "end")))
                  (unless (and (integerp start) (integerp end)
                               (<= (point-min) start) (<= start end) (<= end (point-max)))
                    (emacs-operator-signal "E_INVALID_ARGUMENT" "Edit range is invalid or outside the accessible buffer."))
                  (goto-char start)
                  (delete-region start end)
                  (when (equal operation "replace_range")
                    (insert (or (emacs-operator--get params "text") "")))))
               (_ (emacs-operator-signal "E_INVALID_ARGUMENT" "Unsupported edit operation." `(("operation" . ,operation))))))
           `(("operation" . ,operation)
             ("buffer_id" . ,(emacs-operator-buffer-id buffer))
             ("buffer_tick_before" . ,before-tick)
             ("buffer_tick_after" . ,(buffer-chars-modified-tick))
             ("point_before" . ,before-point)
             ("point_after" . ,(point)))))))))

(defun emacs-operator-resource-read (params)
  (let* ((target (emacs-operator--get params "target"))
         (range (emacs-operator--get params "range")))
    (emacs-operator-call-in-target
     target nil t
     (lambda (buffer _window _frame)
       (with-current-buffer buffer
         (let* ((start (if (equal range "full") (point-min) (or (emacs-operator--get params "start") (point-min))))
                (end (if (equal range "full") (point-max) (or (emacs-operator--get params "end") (point-max)))))
           (unless (and (integerp start) (integerp end) (<= (point-min) start) (<= start end) (<= end (point-max)))
             (emacs-operator-signal "E_INVALID_ARGUMENT" "resource.read range is invalid."))
           (let ((text (buffer-substring-no-properties start end)))
             (when (> (string-bytes text) 750000)
               (emacs-operator-signal "E_INVALID_ARGUMENT" "Requested buffer resource is too large for a single bridge response; page the range."))
             `(("buffer_id" . ,(emacs-operator-buffer-id buffer))
               ("buffer_tick" . ,(buffer-chars-modified-tick))
               ("start" . ,start)
               ("end" . ,end)
               ("text" . ,text)))))))))

(defun emacs-operator--wait-condition-satisfied-p (condition target)
  (let ((buffer (emacs-operator-target-buffer target)))
    (with-current-buffer buffer
      (cond
       ((emacs-operator--get condition "buffer_tick_changed")
        (/= (buffer-chars-modified-tick) (emacs-operator--get condition "buffer_tick_changed")))
       ((emacs-operator--get condition "major_mode")
        (equal (symbol-name major-mode) (emacs-operator--get condition "major_mode")))
       ((emacs-operator--get condition "buffer_name_matches")
        (string-match-p (emacs-operator--get condition "buffer_name_matches") (buffer-name)))
       ((let ((value (emacs-operator--get condition "minibuffer_active" 'missing)))
          (when (not (eq value 'missing))
            (eq (emacs-operator--truthy-json-p value)
                (and (active-minibuffer-window) t)))))
       ((emacs-operator--get condition "process_output_contains")
        (let* ((pattern (emacs-operator--get condition "process_output_contains"))
               (from (max (point-min) (or (emacs-operator--get condition "from_position") (point-min))))
               (text (buffer-substring-no-properties from (point-max))))
          (and (stringp pattern) (string-match-p pattern text))))
       ((emacs-operator--get condition "message_contains")
        (let ((tail (or (emacs-operator--messages-tail 8000) "")))
          (string-match-p (regexp-quote (emacs-operator--get condition "message_contains")) tail)))
       (t (emacs-operator-signal "E_INVALID_ARGUMENT" "Unsupported wait condition."))))))

(defun emacs-operator-wait-condition (params)
  (let* ((target (emacs-operator--get params "target"))
         (condition (emacs-operator--get params "condition"))
         (timeout-ms (min 10000 (max 1 (or (emacs-operator--get params "timeout_ms") 5000))))
         (deadline (+ (float-time) (/ timeout-ms 1000.0))))
    (while (and (< (float-time) deadline)
                (not (emacs-operator--wait-condition-satisfied-p condition target)))
      (accept-process-output nil 0.05))
    (if (emacs-operator--wait-condition-satisfied-p condition target)
        (let ((buffer (emacs-operator-target-buffer target)))
          `(("satisfied" . t)
            ("state_seq" . ,emacs-operator--state-seq)
            ("output_cursor" . ,(with-current-buffer buffer (point-max)))))
      (emacs-operator-signal "E_WAIT_TIMEOUT" "Wait condition timed out." `(("timeout_ms" . ,timeout-ms))))))

(defun emacs-operator-bridge-start ()
  (unless (process-live-p emacs-operator--server)
    (emacs-operator--ensure-runtime-directory)
    (emacs-operator--cleanup-stale-records)
    (setq emacs-operator--instance-id (concat "emacs-" (substring (emacs-operator--uuid) 0 8))
          emacs-operator--token (emacs-operator--secure-random-token)
          emacs-operator--started-at (format-time-string "%FT%TZ" nil t)
          emacs-operator--token-path (expand-file-name (format "token-%s" emacs-operator--instance-id) emacs-operator--runtime-dir)
          emacs-operator--instance-record-path (expand-file-name (format "instance-%s.json" emacs-operator--instance-id) emacs-operator--runtime-dir))
    (with-temp-file emacs-operator--token-path (insert emacs-operator--token "\n"))
    (unless (eq system-type 'windows-nt) (set-file-modes emacs-operator--token-path #o600))
    (setq emacs-operator--server
          (make-network-process :name "emacs-operator-bridge"
                                :server t :host "127.0.0.1" :service 0 :family 'ipv4
                                :noquery t :coding 'binary :log #'emacs-operator--accept-client))
    (set-process-query-on-exit-flag emacs-operator--server nil)
    (emacs-operator--write-instance-record)
    (setq emacs-operator--heartbeat-timer
          (run-at-time emacs-operator-heartbeat-seconds emacs-operator-heartbeat-seconds
                       #'emacs-operator--write-instance-record))))

(defun emacs-operator-bridge-stop ()
  (when (timerp emacs-operator--heartbeat-timer)
    (cancel-timer emacs-operator--heartbeat-timer))
  (setq emacs-operator--heartbeat-timer nil)
  (dolist (client emacs-operator--clients) (when (process-live-p client) (delete-process client)))
  (setq emacs-operator--clients nil)
  (when (process-live-p emacs-operator--server) (delete-process emacs-operator--server))
  (setq emacs-operator--server nil)
  (when emacs-operator--instance-record-path (ignore-errors (delete-file emacs-operator--instance-record-path)))
  (when emacs-operator--token-path (ignore-errors (delete-file emacs-operator--token-path)))
  (setq emacs-operator--token nil))

(emacs-operator-register-method "ping" #'emacs-operator-ping)
(emacs-operator-register-method "instance.describe" #'emacs-operator-instance-describe)
(emacs-operator-register-method "session.target.resolve" #'emacs-operator-session-target-resolve)
(emacs-operator-register-method "state.observe" #'emacs-operator-observe)
(emacs-operator-register-method "capabilities.query" #'emacs-operator-capabilities-query)
(emacs-operator-register-method "keys.execute" #'emacs-operator-keys-execute)
(emacs-operator-register-method "command.execute" #'emacs-operator-command-execute)
(emacs-operator-register-method "edit.apply" #'emacs-operator-edit-apply)
(emacs-operator-register-method "checkpoint.create" #'emacs-operator-checkpoint-create)
(emacs-operator-register-method "checkpoint.commit" #'emacs-operator-checkpoint-commit)
(emacs-operator-register-method "checkpoint.rollback" #'emacs-operator-checkpoint-rollback)
(emacs-operator-register-method "wait.condition" #'emacs-operator-wait-condition)
(emacs-operator-register-method "resource.read" #'emacs-operator-resource-read)
(emacs-operator-register-method "navigation.execute" #'emacs-operator-navigation-execute)
(emacs-operator-register-method "adapter.analyze" #'emacs-operator-adapter-analyze)
(emacs-operator-register-method "refactor.project_rename" #'emacs-operator-project-rename-rpc)
(emacs-operator-register-method "adapter.eval" #'emacs-operator-adapter-eval)
(emacs-operator-register-method "adapter.validate" #'emacs-operator-adapter-validate)

(provide 'emacs-operator-bridge)
;;; emacs-operator-bridge.el ends here
