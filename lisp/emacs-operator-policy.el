;;; emacs-operator-policy.el --- Preconditions and runtime policy -*- lexical-binding: t; -*-

(require 'cl-lib)
(require 'subr-x)
(require 'emacs-operator-observe)

(defvar emacs-operator--active-policy nil)

(defconst emacs-operator--unsafe-commands
  '(eval-expression eval-region eval-buffer eval-defun eval-last-sexp
    shell-command async-shell-command shell-command-on-region
    compile recompile
    org-archive-subtree org-babel-execute-src-block org-export-dispatch
    cider-eval-last-sexp cider-eval-defun-at-point cider-test-run-ns-tests
    sly-eval-last-expression sly-eval-defun
    write-file set-visited-file-name
    delete-file rename-file copy-file make-directory delete-directory
    dired-do-delete dired-do-rename dired-do-copy
    kill-emacs save-buffers-kill-emacs suspend-emacs)
  "Commands blocked for workspace_edit internal-key execution.")

(defun emacs-operator-signal (code message &optional details)
  (signal 'emacs-operator-error (list code message details)))

(define-error 'emacs-operator-error "Emacs Operator error")

(defun emacs-operator--truthy-json-p (value)
  (and value (not (eq value :json-false))))

(defun emacs-operator--path-inside-p (root file)
  (let* ((root (file-name-as-directory (expand-file-name root)))
         (file (expand-file-name file)))
    (or (equal (directory-file-name root) file)
        (string-prefix-p root file))))

(defun emacs-operator-policy-pre-command ()
  (when (and emacs-operator--active-policy
             (memq emacs-operator--command-source '(internal-keys rpc)))
    (let* ((profile (emacs-operator--get emacs-operator--active-policy "profile"))
           (root (emacs-operator--get emacs-operator--active-policy "project_root"))
           (command this-command))
      (when (equal profile "read_only")
        (emacs-operator-signal "E_POLICY_DENIED" "The active permission profile is read-only."))
      (when (and (equal profile "workspace_edit") (memq command emacs-operator--unsafe-commands))
        (emacs-operator-signal "E_POLICY_DENIED"
                               (format "Command %s is blocked by workspace_edit policy." command)
                               `(("command" . ,(symbol-name command)))))
      (when (and (equal profile "workspace_edit")
                 (memq command '(save-buffer basic-save-buffer save-some-buffers))
                 buffer-file-name)
        (unless (and root (emacs-operator--path-inside-p root buffer-file-name))
          (emacs-operator-signal "E_POLICY_DENIED" "Saving outside the authorized workspace is blocked."
                                 `(("file" . ,buffer-file-name) ("project_root" . ,root))))))))

(defun emacs-operator-policy-check-buffer-mutation (policy buffer)
  (when policy
    (let ((profile (emacs-operator--get policy "profile"))
          (root (emacs-operator--get policy "project_root")))
      (when (equal profile "read_only")
        (emacs-operator-signal "E_POLICY_DENIED" "The active permission profile is read-only."))
      (when (and (equal profile "workspace_edit")
                 (buffer-file-name buffer)
                 (not (and root (emacs-operator--path-inside-p root (buffer-file-name buffer)))))
        (emacs-operator-signal "E_POLICY_DENIED" "Buffer mutation is outside the authorized workspace."
                               `(("file" . ,(buffer-file-name buffer)) ("project_root" . ,root)))))))

(defun emacs-operator-check-precondition (target precondition)
  (when precondition
    (let* ((buffer (emacs-operator-target-buffer target))
           (expected-state (emacs-operator--get precondition "expected_state_seq"))
           (expected-buffer (emacs-operator--get precondition "expected_buffer_id"))
           (expected-tick (emacs-operator--get precondition "expected_buffer_tick"))
           (expected-mode (emacs-operator--get precondition "expected_major_mode"))
           (actual-buffer (emacs-operator-buffer-id buffer))
           (actual-tick (with-current-buffer buffer (buffer-chars-modified-tick)))
           (actual-mode (with-current-buffer buffer (symbol-name major-mode))))
      (when (and expected-state (/= expected-state emacs-operator--state-seq))
        (emacs-operator-signal "E_STATE_CONFLICT" "Global Emacs state changed after observation."
                               `(("expected_state_seq" . ,expected-state) ("actual_state_seq" . ,emacs-operator--state-seq))))
      (when (and expected-buffer (not (equal expected-buffer actual-buffer)))
        (emacs-operator-signal "E_STATE_CONFLICT" "Target buffer changed after observation."
                               `(("expected_buffer_id" . ,expected-buffer) ("actual_buffer_id" . ,actual-buffer))))
      (when (and expected-tick (/= expected-tick actual-tick))
        (emacs-operator-signal "E_STATE_CONFLICT" "Buffer changed after the agent observed it."
                               `(("expected_buffer_tick" . ,expected-tick) ("actual_buffer_tick" . ,actual-tick))))
      (when (and expected-mode (not (equal expected-mode actual-mode)))
        (emacs-operator-signal "E_STATE_CONFLICT" "Major mode changed after observation."
                               `(("expected_major_mode" . ,expected-mode) ("actual_major_mode" . ,actual-mode)))))))

(defun emacs-operator-with-policy (policy function)
  (let ((emacs-operator--active-policy policy))
    (funcall function)))

(defun emacs-operator-policy-start ()
  (add-hook 'pre-command-hook #'emacs-operator-policy-pre-command))

(defun emacs-operator-policy-stop ()
  (remove-hook 'pre-command-hook #'emacs-operator-policy-pre-command))

(provide 'emacs-operator-policy)
;;; emacs-operator-policy.el ends here
