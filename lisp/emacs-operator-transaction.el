;;; emacs-operator-transaction.el --- Checkpoints for Emacs Operator -*- lexical-binding: t; -*-

(require 'cl-lib)
(require 'emacs-operator-observe)
(require 'emacs-operator-policy)

(defvar emacs-operator--checkpoints (make-hash-table :test #'equal))

(defun emacs-operator--file-sha256 (file)
  (when (and file (file-exists-p file))
    (with-temp-buffer
      (set-buffer-multibyte nil)
      (insert-file-contents-literally file)
      (secure-hash 'sha256 (current-buffer)))))

(defun emacs-operator-checkpoint-create (params)
  (let* ((target (emacs-operator--get params "target"))
         (scope (or (emacs-operator--get params "scope") "buffer")))
    (unless (equal scope "buffer")
      (emacs-operator-signal
       "E_INVALID_ARGUMENT"
       "MVP checkpoint.create currently supports scope=buffer only."
       `(("scope" . ,scope))))
    (let ((buffer (emacs-operator-target-buffer target)))
      (with-current-buffer buffer
        (let* ((id (concat "chk_" (emacs-operator--uuid)))
               (file buffer-file-name)
               (snapshot
                `(("id" . ,id)
                  ("buffer_id" . ,(emacs-operator-buffer-id buffer))
                  ("content" . ,(buffer-substring-no-properties (point-min) (point-max)))
                  ("point" . ,(point))
                  ("mark" . ,(mark t))
                  ("mark_active" . ,(if mark-active t :json-false))
                  ("modified" . ,(if (buffer-modified-p) t :json-false))
                  ("buffer_tick" . ,(buffer-chars-modified-tick))
                  ("human_change_seq" . ,emacs-operator--human-change-seq)
                  ("file" . ,file)
                  ("file_hash" . ,(emacs-operator--file-sha256 file))
                  ("created_at" . ,(format-time-string "%FT%TZ" nil t)))))
          (puthash id snapshot emacs-operator--checkpoints)
          `(("checkpoint_id" . ,id)
            ("scope" . "buffer")
            ("buffer_id" . ,(emacs-operator-buffer-id buffer))
            ("buffer_tick" . ,(buffer-chars-modified-tick))
            ("file_hash" . ,(emacs-operator--get snapshot "file_hash"))))))))

(defun emacs-operator-checkpoint-commit (params)
  (let* ((id (emacs-operator--get params "checkpoint_id"))
         (snapshot (and id (gethash id emacs-operator--checkpoints))))
    (unless snapshot
      (emacs-operator-signal "E_TRANSACTION_NOT_FOUND" "Checkpoint does not exist." `(("checkpoint_id" . ,id))))
    (remhash id emacs-operator--checkpoints)
    `(("checkpoint_id" . ,id) ("committed" . t))))

(defun emacs-operator-checkpoint-rollback (params)
  (let* ((id (emacs-operator--get params "checkpoint_id"))
         (snapshot (and id (gethash id emacs-operator--checkpoints))))
    (unless snapshot
      (emacs-operator-signal "E_TRANSACTION_NOT_FOUND" "Checkpoint does not exist." `(("checkpoint_id" . ,id))))
    (let* ((buffer-id (emacs-operator--get snapshot "buffer_id"))
           (buffer (emacs-operator-find-buffer buffer-id)))
      (unless (buffer-live-p buffer)
        (emacs-operator-signal "E_TARGET_STALE" "Checkpoint buffer no longer exists." `(("buffer_id" . ,buffer-id))))
      (with-current-buffer buffer
        (let* ((expected-human (emacs-operator--get snapshot "human_change_seq"))
               (actual-human emacs-operator--human-change-seq)
               (file (emacs-operator--get snapshot "file"))
               (expected-file-hash (emacs-operator--get snapshot "file_hash"))
               (actual-file-hash (emacs-operator--file-sha256 file)))
          (unless (= expected-human actual-human)
            (emacs-operator-signal "E_TRANSACTION_CONFLICT" "Human/external buffer changes occurred after the checkpoint."
                                   `(("expected_human_change_seq" . ,expected-human) ("actual_human_change_seq" . ,actual-human))))
          (unless (equal expected-file-hash actual-file-hash)
            (emacs-operator-signal "E_TRANSACTION_CONFLICT" "The visited file changed externally after the checkpoint."
                                   `(("expected_file_hash" . ,expected-file-hash) ("actual_file_hash" . ,actual-file-hash))))
          (let ((emacs-operator--command-source 'rpc)
                (inhibit-read-only t))
            (atomic-change-group
              (erase-buffer)
              (insert (emacs-operator--get snapshot "content"))
              (goto-char (min (point-max) (max (point-min) (or (emacs-operator--get snapshot "point") (point-min)))))
              (let ((mark-pos (emacs-operator--get snapshot "mark")))
                (when mark-pos (set-mark (min (point-max) (max (point-min) mark-pos)))))
              (setq mark-active (emacs-operator--truthy-json-p (emacs-operator--get snapshot "mark_active")))
              (set-buffer-modified-p (emacs-operator--truthy-json-p (emacs-operator--get snapshot "modified")))))
          (remhash id emacs-operator--checkpoints)
          `(("checkpoint_id" . ,id)
            ("rolled_back" . t)
            ("buffer_id" . ,buffer-id)
            ("buffer_tick" . ,(buffer-chars-modified-tick))))))))

(defun emacs-operator-transaction-clear ()
  (clrhash emacs-operator--checkpoints))

(provide 'emacs-operator-transaction)
;;; emacs-operator-transaction.el ends here
