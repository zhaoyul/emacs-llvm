;;; emacs-operator-keys.el --- Key and command execution -*- lexical-binding: t; -*-

(require 'cl-lib)
(require 'subr-x)
(require 'emacs-operator-observe)
(require 'emacs-operator-policy)

(defvar emacs-operator--safe-noninteractive-functions '(check-parens)
  "Allowlisted functions callable through command.execute with interactive=false.")

(defun emacs-operator-register-safe-noninteractive-function (function)
  (cl-pushnew function emacs-operator--safe-noninteractive-functions))

(defun emacs-operator--json-true-p (value)
  (and value (not (eq value :json-false))))


(defun emacs-operator--adapter-snapshot (target)
  (when (and (fboundp 'emacs-operator-adapters-observe)
             (fboundp 'emacs-operator-adapter-context))
    (emacs-operator-adapters-observe (emacs-operator-adapter-context target))))

(defun emacs-operator--adapter-verify (action before after target)
  (when (and (fboundp 'emacs-operator-adapters-verify)
             (fboundp 'emacs-operator-adapter-context))
    (emacs-operator-adapters-verify action before after
                                    (emacs-operator-adapter-context target))))

(defun emacs-operator--internal-key-name (key)
  (let ((name (downcase key)))
    (cond
     ((member name '("return" "ret" "enter")) "RET")
     ((member name '("escape" "esc")) "ESC")
     ((equal name "tab") "TAB")
     ((equal name "space") "SPC")
     ((member name '("backspace" "bs")) "DEL")
     ((equal name "delete") "<delete>")
     ((member name '("left" "right" "up" "down" "home" "end" "prior" "next" "pageup" "pagedown"))
      (format "<%s>" (pcase name ("pageup" "prior") ("pagedown" "next") (_ name))))
     ((string-match-p "\\`f\\([1-9]\\|1[0-2]\\)\\'" name) (format "<%s>" name))
     ((= (length key) 1) key)
     (t (format "<%s>" name)))))

(defun emacs-operator--modifier-prefix (modifier)
  (pcase (downcase modifier)
    ("control" "C-")
    ("meta" "M-")
    ("shift" "S-")
    ("super" "s-")
    ("hyper" "H-")
    ("alt" "A-")
    ;; Physical names are mapped to the conventional Emacs macOS semantics only
    ;; for internal events. Native input resolves actual bridge-reported mapping.
    ("command" "s-")
    ("option" "M-")
    ("fn" "")
    (_ (emacs-operator-signal "E_KEY_PARSE_FAILED" "Unknown key modifier." `(("modifier" . ,modifier))))))

(defun emacs-operator--event-to-vector (event)
  (let ((kind (emacs-operator--get event "kind"))
        (text (emacs-operator--get event "text"))
        (key (emacs-operator--get event "key"))
        (mods (or (emacs-operator--get event "modifiers") '()))
        (repeat (or (emacs-operator--get event "repeat") 1)))
    (cond
     ((equal kind "text")
      (unless (stringp text)
        (emacs-operator-signal "E_KEY_PARSE_FAILED" "Structured text event requires text."))
      (vconcat (apply #'vconcat (make-list repeat (string-to-vector text)))))
     ((equal kind "key_press")
      (unless (stringp key)
        (emacs-operator-signal "E_KEY_PARSE_FAILED" "Structured key_press requires key."))
      (let* ((notation (concat (mapconcat #'emacs-operator--modifier-prefix mods "")
                               (emacs-operator--internal-key-name key)))
             (vector (condition-case err
                         (kbd notation)
                       (error (emacs-operator-signal "E_KEY_PARSE_FAILED" (error-message-string err)
                                                     `(("notation" . ,notation)))))))
        (apply #'vconcat (make-list repeat vector))))
     ((member kind '("key_down" "key_up"))
      (emacs-operator-signal "E_INVALID_ARGUMENT" "internal_keys uses command events; key_down/key_up are native-channel concepts."))
     (t (emacs-operator-signal "E_KEY_PARSE_FAILED" "Unknown structured key event kind." `(("kind" . ,kind)))))))

(defun emacs-operator--step-to-vector (step)
  (let ((kind (emacs-operator--get step "kind")))
    (cond
     ((equal kind "keys")
      (let ((notation (emacs-operator--get step "value")))
        (unless (stringp notation)
          (emacs-operator-signal "E_KEY_PARSE_FAILED" "keys step requires a string value."))
        (condition-case err
            (kbd notation)
          (error (emacs-operator-signal "E_KEY_PARSE_FAILED" (error-message-string err)
                                        `(("notation" . ,notation)))))))
     ((equal kind "text")
      (let ((text (emacs-operator--get step "value")))
        (unless (stringp text)
          (emacs-operator-signal "E_KEY_PARSE_FAILED" "text step requires a string value."))
        (string-to-vector text)))
     ((equal kind "event")
      (emacs-operator--event-to-vector (emacs-operator--get step "event")))
     (t (emacs-operator-signal "E_KEY_PARSE_FAILED" "Step cannot be compiled to internal key events." `(("kind" . ,kind)))))))

(defun emacs-operator--compile-step-chunks (steps)
  (let ((current []) chunks)
    (dolist (step steps)
      (if (equal (emacs-operator--get step "kind") "expect")
          (progn
            (push (cons current (emacs-operator--get step "condition")) chunks)
            (setq current []))
        (setq current (vconcat current (emacs-operator--step-to-vector step)))))
    (when (> (length current) 0)
      (push (cons current nil) chunks))
    (nreverse chunks)))

(defun emacs-operator--expect-condition (condition buffer)
  (let ((mode (or (emacs-operator--get condition "major_mode")
                  (emacs-operator--get condition "mode")))
        (buffer-name-expected (emacs-operator--get condition "buffer_name"))
        (minibuffer-expected (emacs-operator--get condition "minibuffer_active")))
    (when mode
      (unless (equal mode (with-current-buffer buffer (symbol-name major-mode)))
        (emacs-operator-signal "E_COMMAND_FAILED" "Expected major mode was not reached."
                               `(("expected_major_mode" . ,mode)
                                 ("actual_major_mode" . ,(with-current-buffer buffer (symbol-name major-mode)))))))
    (when buffer-name-expected
      (unless (equal buffer-name-expected (buffer-name buffer))
        (emacs-operator-signal "E_COMMAND_FAILED" "Expected buffer was not reached."
                               `(("expected_buffer_name" . ,buffer-name-expected)
                                 ("actual_buffer_name" . ,(buffer-name buffer))))))
    (unless (null minibuffer-expected)
      (let ((active (and (active-minibuffer-window) t)))
        (unless (eq (emacs-operator--json-true-p minibuffer-expected) active)
          (emacs-operator-signal "E_MINIBUFFER_UNEXPECTED" "Minibuffer state did not match expectation."
                                 `(("expected" . ,minibuffer-expected) ("actual" . ,active))))))))

(defun emacs-operator--verify-postconditions (verify before-tick buffer)
  (when verify
    (let ((changed (emacs-operator--get verify "buffer_changed" 'unspecified))
          (balanced (emacs-operator--get verify "balanced_sexps"))
          (mode (emacs-operator--get verify "major_mode"))
          (expected-command (emacs-operator--get verify "expected_command")))
      (unless (eq changed 'unspecified)
        (let ((actual (/= before-tick (with-current-buffer buffer (buffer-chars-modified-tick)))))
          (unless (eq (emacs-operator--json-true-p changed) actual)
            (emacs-operator-signal "E_COMMAND_FAILED" "buffer_changed verification failed."
                                   `(("expected" . ,changed) ("actual" . ,actual))))))
      (when (emacs-operator--json-true-p balanced)
        (with-current-buffer buffer
          (condition-case err
              (save-excursion (check-parens))
            (error (emacs-operator-signal "E_COMMAND_FAILED" "check-parens failed after key execution."
                                          `(("error" . ,(error-message-string err))))))))
      (when mode
        (unless (equal mode (with-current-buffer buffer (symbol-name major-mode)))
          (emacs-operator-signal "E_COMMAND_FAILED" "major_mode verification failed."
                                 `(("expected" . ,mode)
                                   ("actual" . ,(with-current-buffer buffer (symbol-name major-mode)))))))
      (when expected-command
        (let ((actual (and last-command (symbol-name last-command))))
          (unless (equal expected-command actual)
            (emacs-operator-signal "E_COMMAND_FAILED" "expected_command verification failed."
                                   `(("expected" . ,expected-command)
                                     ("actual" . ,actual)))))))))

(defun emacs-operator--target-for-window (window)
  (let ((buffer (window-buffer window)))
    `(("frame_id" . ,(emacs-operator-frame-id (window-frame window)))
      ("window_id" . ,(emacs-operator-window-id window))
      ("buffer_id" . ,(emacs-operator-buffer-id buffer))
      ("buffer_name" . ,(buffer-name buffer))
      ("file" . ,(buffer-file-name buffer))
      ("project_root" . ,(emacs-operator--project-root buffer))
      ("major_mode" . ,(with-current-buffer buffer (symbol-name major-mode))))))

(defun emacs-operator-keys-execute (params)
  (let* ((target (emacs-operator--get params "target"))
         (steps (emacs-operator--get params "steps"))
         (precondition (emacs-operator--get params "precondition"))
         (verify (emacs-operator--get params "verify"))
         (policy (emacs-operator--get params "policy"))
         (preserve (not (eq (emacs-operator--get params "preserve_user_selection") :json-false))))
    (unless (listp steps)
      (emacs-operator-signal "E_INVALID_ARGUMENT" "keys.execute requires steps."))
    (emacs-operator-check-precondition target precondition)
    (emacs-operator-with-policy
     policy
     (lambda ()
       (emacs-operator-call-in-target
        target t preserve
        (lambda (buffer window _frame)
          (let* ((before-tick (with-current-buffer buffer (buffer-chars-modified-tick)))
                 (before-point (with-current-buffer buffer (point)))
                 (before-adapters (with-current-buffer buffer (emacs-operator--adapter-snapshot target)))
                 (chunks (emacs-operator--compile-step-chunks steps))
                 (emacs-operator--command-source 'internal-keys)
                 result-target)
            (undo-boundary)
            (condition-case err
                (progn
                  (dolist (chunk chunks)
                    (let ((events (car chunk))
                          (expect (cdr chunk)))
                      (when (> (length events) 0)
                        (execute-kbd-macro events))
                      (setq result-target (emacs-operator--target-for-window window))
                      (let ((current-buffer (window-buffer window)))
                        (when (active-minibuffer-window)
                          (emacs-operator-signal "E_MINIBUFFER_UNEXPECTED"
                                                 "Key sequence returned while a minibuffer is still active. Supply the complete prompt flow in one macro."))
                        (when expect (emacs-operator--expect-condition expect current-buffer)))))
                  (let* ((after-buffer (window-buffer window))
                         (after-point (with-current-buffer after-buffer (point)))
                         (after-tick (with-current-buffer after-buffer (buffer-chars-modified-tick)))
                         (resolved-target (or result-target (emacs-operator--target-for-window window)))
                         (after-adapters (with-current-buffer after-buffer
                                           (emacs-operator--adapter-snapshot resolved-target)))
                         (adapter-verification
                          (with-current-buffer after-buffer
                            (emacs-operator--adapter-verify
                             `(("last_command" . ,(and last-command (symbol-name last-command)))
                               ("channel" . "internal_keys"))
                             before-adapters after-adapters resolved-target))))
                    (emacs-operator--verify-postconditions verify before-tick after-buffer)
                    (emacs-operator--record-command 'internal-keys last-command
                                                    (mapconcat (lambda (step)
                                                                 (or (emacs-operator--get step "value")
                                                                     (emacs-operator--get step "kind") ""))
                                                               steps " ")
                                                    t nil before-point after-point before-tick after-tick)
                    `(("executed" . t)
                      ("last_command" . ,(and last-command (symbol-name last-command)))
                      ("buffer_tick_before" . ,before-tick)
                      ("buffer_tick_after" . ,after-tick)
                      ("point_before" . ,before-point)
                      ("point_after" . ,after-point)
                      ("adapter_verification" . ,adapter-verification)
                      ("target" . ,resolved-target))))
              (quit
               (emacs-operator--record-command 'internal-keys last-command nil nil "E_COMMAND_QUIT")
               (emacs-operator-signal "E_COMMAND_QUIT" "Internal key sequence was quit."))
              (emacs-operator-error (signal (car err) (cdr err)))
              (error
               (emacs-operator--record-command 'internal-keys last-command nil nil "E_COMMAND_FAILED")
               (emacs-operator-signal "E_COMMAND_FAILED" (error-message-string err)))))))))))

(defun emacs-operator-capabilities-query (params)
  (let* ((target (emacs-operator--get params "target"))
         (operation (emacs-operator--get params "operation")))
    (emacs-operator-call-in-target
     target nil t
     (lambda (buffer _window _frame)
       (with-current-buffer buffer
         (pcase operation
           ("resolve_key"
            (let* ((key (emacs-operator--get params "key"))
                   (vector (condition-case err (kbd key)
                             (error (emacs-operator-signal "E_KEY_PARSE_FAILED" (error-message-string err)))))
                   (command (key-binding vector t)))
              `(("key" . ,key)
                ("bound" . ,(if command t :json-false))
                ("command" . ,(and command (symbol-name command)))
                ("interactive" . ,(if (and command (commandp command)) t :json-false)))))
           ("describe_key"
            (let* ((key (emacs-operator--get params "key"))
                   (command (key-binding (kbd key) t)))
              `(("key" . ,key)
                ("command" . ,(and command (symbol-name command)))
                ("documentation" . ,(and command (documentation command t))))))
           ("where_is_command"
            (let* ((name (emacs-operator--get params "command"))
                   (symbol (and name (intern-soft name)))
                   (key (and symbol (where-is-internal symbol nil t))))
              `(("command" . ,name)
                ("key" . ,(and key (key-description key)))
                ("interactive" . ,(if (and symbol (commandp symbol)) t :json-false)))))
           ("describe_command"
            (let* ((name (emacs-operator--get params "command"))
                   (symbol (and name (intern-soft name))))
              (unless (and symbol (fboundp symbol))
                (emacs-operator-signal "E_COMMAND_NOT_FOUND" "Command/function is not defined." `(("command" . ,name))))
              (let ((doc (documentation symbol t)))
                `(("command" . ,name)
                  ("interactive" . ,(if (commandp symbol) t :json-false))
                  ("documentation" . ,(and doc (if (> (length doc) 8000) (substring doc 0 8000) doc)))))))
           ("check_feature"
            (let ((name (emacs-operator--get params "feature")))
              `(("feature" . ,name)
                ("loaded" . ,(if (and name (featurep (intern name))) t :json-false)))))
           ("list_adapters"
            `(("adapters" . ,(if (fboundp 'emacs-operator-active-adapters)
                                  (emacs-operator-active-adapters
                                   (emacs-operator-adapter-context target))
                                (list "generic")))))
           ("adapter_capabilities"
            (unless (fboundp 'emacs-operator-adapters-capabilities)
              (emacs-operator-signal "E_INTERNAL" "Adapter registry is not loaded."))
            `(("adapters" . ,(emacs-operator-adapters-capabilities
                               (emacs-operator-adapter-context target)
                               (emacs-operator--get params "adapter")))))
           ("adapter_observe"
            (unless (fboundp 'emacs-operator-adapters-observe)
              (emacs-operator-signal "E_INTERNAL" "Adapter registry is not loaded."))
            `(("adapters" . ,(emacs-operator-adapters-observe
                               (emacs-operator-adapter-context target)))))
           ("list_mode_commands"
            `(("major_mode" . ,(symbol-name major-mode))
              ("local_map_present" . ,(if (current-local-map) t :json-false))
              ("minor_modes" . ,(emacs-operator--minor-modes))))
           (_ (emacs-operator-signal "E_INVALID_ARGUMENT" "Unknown capabilities.query operation." `(("operation" . ,operation))))))))))

(defun emacs-operator-command-execute (params)
  (let* ((target (emacs-operator--get params "target"))
         (name (emacs-operator--get params "command"))
         (interactive (not (eq (emacs-operator--get params "interactive") :json-false)))
         (arguments (or (emacs-operator--get params "arguments") '()))
         (prefix (emacs-operator--get params "prefix"))
         (precondition (emacs-operator--get params "precondition"))
         (policy (emacs-operator--get params "policy"))
         (preserve (not (eq (emacs-operator--get params "preserve_user_selection") :json-false)))
         (command (and (stringp name) (intern-soft name))))
    (unless (and command (fboundp command))
      (emacs-operator-signal "E_COMMAND_NOT_FOUND" "Requested command is not defined." `(("command" . ,name))))
    (when (and interactive (not (commandp command)))
      (emacs-operator-signal "E_COMMAND_NOT_INTERACTIVE" "Requested symbol is not an interactive command." `(("command" . ,name))))
    (when (and (not interactive) (not (memq command emacs-operator--safe-noninteractive-functions)))
      (emacs-operator-signal "E_POLICY_DENIED" "Non-interactive function is not allowlisted." `(("command" . ,name))))
    (emacs-operator-check-precondition target precondition)
    (emacs-operator-with-policy
     policy
     (lambda ()
       (emacs-operator-call-in-target
        target interactive preserve
        (lambda (buffer window _frame)
          (with-current-buffer buffer
            (let ((before-point (point))
                  (before-tick (buffer-chars-modified-tick))
                  (before-adapters (emacs-operator--adapter-snapshot target))
                  (emacs-operator--command-source 'rpc)
                  (current-prefix-arg prefix)
                  command-result)
              (condition-case err
                  (progn
                    ;; Apply the same policy guard used by internal key command-loop hooks.
                    (let ((this-command command)) (emacs-operator-policy-pre-command))
                    (setq command-result
                          (if interactive
                              (call-interactively command)
                            (apply command arguments)))
                    (let* ((actual-buffer (if (window-live-p window) (window-buffer window) (current-buffer)))
                           (after-point (with-current-buffer actual-buffer (point)))
                           (after-tick (with-current-buffer actual-buffer (buffer-chars-modified-tick)))
                           (result-target (if (window-live-p window)
                                              (emacs-operator--target-for-window window)
                                            (emacs-operator-resolve-target `(("buffer_id" . ,(emacs-operator-buffer-id actual-buffer))))))
                           (after-adapters (with-current-buffer actual-buffer
                                             (emacs-operator--adapter-snapshot result-target)))
                           (adapter-verification
                            (with-current-buffer actual-buffer
                              (emacs-operator--adapter-verify
                               `(("command" . ,name) ("channel" . "semantic"))
                               before-adapters after-adapters result-target))))
                      (emacs-operator--record-command 'rpc command nil t nil before-point after-point before-tick after-tick)
                      `(("executed" . t)
                        ("command" . ,name)
                        ("return_value" . ,(and (not interactive) command-result))
                        ("buffer_tick_before" . ,before-tick)
                        ("buffer_tick_after" . ,after-tick)
                        ("point_before" . ,before-point)
                        ("point_after" . ,after-point)
                        ("adapter_verification" . ,adapter-verification)
                        ("target" . ,result-target))))
                (quit
                 (emacs-operator--record-command 'rpc command nil nil "E_COMMAND_QUIT")
                 (emacs-operator-signal "E_COMMAND_QUIT" "Command was quit." `(("command" . ,name))))
                (emacs-operator-error (signal (car err) (cdr err)))
                (error
                 (emacs-operator--record-command 'rpc command nil nil "E_COMMAND_FAILED")
                 (emacs-operator-signal "E_COMMAND_FAILED" (error-message-string err) `(("command" . ,name)))))))))))))

(provide 'emacs-operator-keys)
;;; emacs-operator-keys.el ends here
