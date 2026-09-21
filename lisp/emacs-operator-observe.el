;;; emacs-operator-observe.el --- Structured state for Emacs Operator -*- lexical-binding: t; -*-

(require 'cl-lib)
(require 'subr-x)
(require 'seq)
(require 'project nil t)

(defvar emacs-operator--state-seq 0)
(defvar emacs-operator--command-source 'human)
(defvar emacs-operator--command-log nil)
(defvar emacs-operator--max-command-log 200)
(defvar-local emacs-operator--buffer-id nil)
(defvar-local emacs-operator--human-change-seq 0)
(put 'emacs-operator--buffer-id 'permanent-local t)
(put 'emacs-operator--human-change-seq 'permanent-local t)
(defvar emacs-operator--frame-ids (make-hash-table :test #'eq :weakness 'key))
(defvar emacs-operator--window-ids (make-hash-table :test #'eq :weakness 'key))
(defvar emacs-operator--state-hooks-enabled nil)

(defun emacs-operator--uuid ()
  (let* ((seed (format "%s:%s:%s:%s:%s" (float-time) (emacs-pid) (random) (garbage-collect) (current-time-string)))
         (hex (secure-hash 'sha256 seed)))
    (format "%s-%s-%s-%s-%s"
            (substring hex 0 8) (substring hex 8 12) (substring hex 12 16)
            (substring hex 16 20) (substring hex 20 32))))

(defun emacs-operator--bump-state (&rest _)
  (setq emacs-operator--state-seq (1+ emacs-operator--state-seq)))

(defun emacs-operator--after-change (&rest _)
  (emacs-operator--bump-state)
  (when (eq emacs-operator--command-source 'human)
    (setq emacs-operator--human-change-seq (1+ emacs-operator--human-change-seq))))

(defun emacs-operator--pre-command ()
  (emacs-operator--bump-state))

(defun emacs-operator--post-command ()
  (emacs-operator--bump-state)
  (emacs-operator--record-command emacs-operator--command-source this-command nil t nil))

(defun emacs-operator--record-command (source command key success &optional error-code before-point after-point before-tick after-tick)
  (let ((entry `(("timestamp" . ,(format-time-string "%FT%TZ" nil t))
                 ("source" . ,(symbol-name (or source 'unknown)))
                 ("command" . ,(and command (symbol-name command)))
                 ("key" . ,key)
                 ("success" . ,(if success t :json-false))
                 ("error_code" . ,error-code)
                 ("point_before" . ,before-point)
                 ("point_after" . ,after-point)
                 ("buffer_tick_before" . ,before-tick)
                 ("buffer_tick_after" . ,after-tick))))
    (push entry emacs-operator--command-log)
    (when (> (length emacs-operator--command-log) emacs-operator--max-command-log)
      (setcdr (nthcdr (1- emacs-operator--max-command-log) emacs-operator--command-log) nil))))

(defun emacs-operator-buffer-id (&optional buffer)
  (with-current-buffer (or buffer (current-buffer))
    (or emacs-operator--buffer-id
        (setq emacs-operator--buffer-id (concat "buf_" (emacs-operator--uuid))))))

(defun emacs-operator-frame-id (&optional frame)
  (let ((frame (or frame (selected-frame))))
    (or (gethash frame emacs-operator--frame-ids)
        (let ((id (concat "frm_" (emacs-operator--uuid))))
          (puthash frame id emacs-operator--frame-ids)
          id))))

(defun emacs-operator-window-id (&optional window)
  (let ((window (or window (selected-window))))
    (or (gethash window emacs-operator--window-ids)
        (let ((id (concat "win_" (emacs-operator--uuid))))
          (puthash window id emacs-operator--window-ids)
          id))))

(defun emacs-operator-find-buffer (id)
  (cl-find-if (lambda (buffer)
                (with-current-buffer buffer
                  (equal (emacs-operator-buffer-id buffer) id)))
              (buffer-list)))

(defun emacs-operator-find-frame (id)
  (cl-find-if (lambda (frame) (equal (emacs-operator-frame-id frame) id)) (frame-list)))

(defun emacs-operator-find-window (id)
  (cl-loop for frame in (frame-list)
           thereis (cl-find-if (lambda (window) (equal (emacs-operator-window-id window) id))
                               (window-list frame 'nomini))))

(defun emacs-operator--get (object key &optional default)
  (cond
   ((hash-table-p object) (gethash key object default))
   ((listp object)
    (let ((cell (or (assoc key object)
                    (assoc (intern-soft key) object))))
      (if cell (cdr cell) default)))
   (t default)))

(defun emacs-operator--project-root (buffer)
  (with-current-buffer buffer
    (or (when (featurep 'project)
          (condition-case nil
              (let ((project (project-current nil default-directory)))
                (when project (expand-file-name (project-root project))))
            (error nil)))
        (and buffer-file-name (file-name-directory (expand-file-name buffer-file-name)))
        (and default-directory (expand-file-name default-directory)))))

(defun emacs-operator--resolve-buffer-selector (selector)
  (let ((buffer-id (emacs-operator--get selector "buffer_id"))
        (buffer-name (emacs-operator--get selector "buffer_name"))
        (file (emacs-operator--get selector "file")))
    (cond
     (buffer-id
      (or (emacs-operator-find-buffer buffer-id)
          (emacs-operator-signal "E_TARGET_NOT_FOUND" "Buffer handle is stale or unknown." `(("buffer_id" . ,buffer-id)))))
     (buffer-name
      (or (get-buffer buffer-name)
          (emacs-operator-signal "E_TARGET_NOT_FOUND" "Buffer name does not exist." `(("buffer_name" . ,buffer-name)))))
     (file
      (find-file-noselect (expand-file-name file)))
     (t (if (window-live-p (selected-window))
            (window-buffer (selected-window))
          (current-buffer))))))

(defun emacs-operator-resolve-target (selector)
  (let* ((buffer (emacs-operator--resolve-buffer-selector selector))
         (frame-id (emacs-operator--get selector "frame_id"))
         (window-id (emacs-operator--get selector "window_id"))
         (window (cond
                  (window-id (emacs-operator-find-window window-id))
                  (t (get-buffer-window buffer t))))
         (frame (cond
                 (frame-id (emacs-operator-find-frame frame-id))
                 ((window-live-p window) (window-frame window))
                 (t (selected-frame))))
         (requested-root (emacs-operator--get selector "project_root"))
         (project-root (or (and requested-root (expand-file-name requested-root))
                           (emacs-operator--project-root buffer))))
    (when (and window-id (not (window-live-p window)))
      (emacs-operator-signal "E_TARGET_STALE" "Window handle is stale." `(("window_id" . ,window-id))))
    (when (and frame-id (not (frame-live-p frame)))
      (emacs-operator-signal "E_TARGET_STALE" "Frame handle is stale." `(("frame_id" . ,frame-id))))
    `(("frame_id" . ,(and (frame-live-p frame) (emacs-operator-frame-id frame)))
      ("frame_title" . ,(and (frame-live-p frame)
                              (with-selected-frame frame
                                (or (frame-parameter frame 'title)
                                    (format-mode-line frame-title-format)))))
      ("native_window_identifier" . ,(and (frame-live-p frame)
                                           (let ((outer (frame-parameter frame 'outer-window-id)))
                                             (and outer (format "%s" outer)))))
      ("window_id" . ,(and (window-live-p window) (emacs-operator-window-id window)))
      ("buffer_id" . ,(emacs-operator-buffer-id buffer))
      ("buffer_name" . ,(buffer-name buffer))
      ("file" . ,(buffer-file-name buffer))
      ("project_root" . ,project-root)
      ("major_mode" . ,(with-current-buffer buffer (symbol-name major-mode))))))

(defun emacs-operator-target-buffer (target)
  (let ((id (emacs-operator--get target "buffer_id")))
    (if id
        (or (emacs-operator-find-buffer id)
            (emacs-operator-signal "E_TARGET_STALE" "Target buffer no longer exists." `(("buffer_id" . ,id))))
      (emacs-operator--resolve-buffer-selector target))))

(defun emacs-operator-target-window (target buffer)
  (let ((id (emacs-operator--get target "window_id")))
    (cond
     (id (or (emacs-operator-find-window id)
             (emacs-operator-signal "E_TARGET_STALE" "Target window no longer exists." `(("window_id" . ,id)))))
     ((get-buffer-window buffer t))
     (t nil))))

(defun emacs-operator-call-in-target (target needs-window preserve-user-selection function)
  (let* ((buffer (emacs-operator-target-buffer target))
         (requested-window (emacs-operator-target-window target buffer))
         (window (if needs-window (or requested-window (selected-window)) requested-window))
         (frame (if (window-live-p window) (window-frame window) (selected-frame))))
    (if (not needs-window)
        (with-current-buffer buffer (funcall function buffer nil frame))
      (unless (window-live-p window)
        (emacs-operator-signal "E_TARGET_NOT_FOUND" "Internal key/interactive operation requires a live Emacs window."))
      (let ((original-current-buffer (current-buffer))
            (original-selected-frame (selected-frame))
            (original-selected-window (selected-window))
            (original-window-buffer (window-buffer window))
            (original-window-start (window-start window)))
        (unwind-protect
            (progn
              (select-frame frame 'norecord)
              (select-window window 'norecord)
              (unless (eq (window-buffer window) buffer)
                (set-window-buffer window buffer))
              ;; `set-window-buffer' does not change the current buffer, even
              ;; when WINDOW is selected.  Keyboard macros and local keymaps
              ;; resolve through both the selected window and current buffer,
              ;; so keep those two views of the target synchronized.
              (set-buffer buffer)
              (funcall function buffer window frame))
          (when preserve-user-selection
            (when (and (window-live-p window) (buffer-live-p original-window-buffer))
              (set-window-buffer window original-window-buffer)
              (set-window-start window original-window-start t))
            (when (frame-live-p original-selected-frame)
              (select-frame original-selected-frame 'norecord))
            (when (window-live-p original-selected-window)
              (select-window original-selected-window 'norecord))
            ;; `select-window' changes the current buffer.  RPC callbacks and
            ;; batch ERT callers must return to the buffer they entered from.
            (when (buffer-live-p original-current-buffer)
              (set-buffer original-current-buffer))))))))

(defun emacs-operator--bounded-substring (buffer start end max-chars)
  (with-current-buffer buffer
    (let* ((safe-start (max (point-min) start))
           (safe-end (min (point-max) end))
           (text (buffer-substring-no-properties safe-start safe-end)))
      (if (> (length text) max-chars) (substring text 0 max-chars) text))))

(defun emacs-operator--syntax-state ()
  (condition-case nil
      (let* ((ppss (syntax-ppss))
             (sexp (bounds-of-thing-at-point 'sexp))
             defun-start defun-end)
        (save-excursion
          (condition-case nil
              (progn
                (end-of-defun)
                (setq defun-end (point))
                (beginning-of-defun)
                (setq defun-start (point)))
            (error nil)))
        `(("parse_depth" . ,(car ppss))
          ("in_string" . ,(if (nth 3 ppss) t :json-false))
          ("in_comment" . ,(if (nth 4 ppss) t :json-false))
          ("sexp_bounds" . ,(and sexp (vector (car sexp) (cdr sexp))))
          ("defun_bounds" . ,(and defun-start defun-end (vector defun-start defun-end)))))
    (error `(("parse_depth" . nil) ("in_string" . :json-false) ("in_comment" . :json-false)))))

(defun emacs-operator--minor-modes ()
  (let (enabled)
    (dolist (mode minor-mode-list)
      (when (and (boundp mode) (symbol-value mode))
        (push (symbol-name mode) enabled)))
    (nreverse enabled)))

(defun emacs-operator--messages-tail (&optional max-chars)
  (let ((buffer (get-buffer "*Messages*"))
        (max-chars (or max-chars 4000)))
    (when buffer
      (with-current-buffer buffer
        (buffer-substring-no-properties (max (point-min) (- (point-max) max-chars)) (point-max))))))

(defun emacs-operator-observe (params)
  (let* ((target (emacs-operator--get params "target" params))
         (around (min 16384 (max 0 (or (emacs-operator--get params "around_chars") 1600))))
         (scope (or (emacs-operator--get params "scope") '("compact" "context")))
         (buffer (emacs-operator-target-buffer target))
         (window (emacs-operator-target-window target buffer))
         (frame (if (window-live-p window) (window-frame window) (selected-frame)))
         (include-context (member "context" scope))
         (include-messages (member "messages" scope))
         (include-adapters (member "adapters" scope)))
    (with-current-buffer buffer
      (let* ((pt (point))
             (mark-pos (and (mark t) (mark t)))
             (region-active (and mark-active mark-pos))
             (visible-start (and (window-live-p window) (eq (window-buffer window) buffer) (window-start window)))
             (visible-end (and (window-live-p window) (eq (window-buffer window) buffer) (window-end window t)))
             (minibuffer-window (active-minibuffer-window))
             (minibuffer-buffer (and minibuffer-window (window-buffer minibuffer-window)))
             (buffer-process (get-buffer-process buffer)))
        `(("state_seq" . ,emacs-operator--state-seq)
          ("instance" . (("pid" . ,(emacs-pid))
                          ("version" . ,emacs-version)
                          ("system_type" . ,(symbol-name system-type))
                          ("window_system" . ,(and window-system (symbol-name window-system)))))
          ("frame" . (("id" . ,(emacs-operator-frame-id frame))
                       ("name" . ,(frame-parameter frame 'name))
                       ("title" . ,(with-selected-frame frame
                                      (or (frame-parameter frame 'title)
                                          (format-mode-line frame-title-format))))
                       ("native_window_identifier" . ,(let ((outer (frame-parameter frame 'outer-window-id)))
                                                         (and outer (format "%s" outer))))
                       ("visible" . ,(if (frame-visible-p frame) t :json-false))
                       ("selected" . ,(if (eq frame (selected-frame)) t :json-false))
                       ("width" . ,(frame-width frame))
                       ("height" . ,(frame-height frame))))
          ("window" . (("id" . ,(and (window-live-p window) (emacs-operator-window-id window)))
                        ("selected" . ,(if (eq window (selected-window)) t :json-false))
                        ("start" . ,visible-start)
                        ("end" . ,visible-end)))
          ("buffer" . (("id" . ,(emacs-operator-buffer-id buffer))
                        ("name" . ,(buffer-name buffer))
                        ("file" . ,buffer-file-name)
                        ("project_root" . ,(emacs-operator--project-root buffer))
                        ("size" . ,(buffer-size))
                        ("point_min" . ,(point-min))
                        ("point_max" . ,(point-max))
                        ("modified" . ,(if (buffer-modified-p) t :json-false))
                        ("read_only" . ,(if buffer-read-only t :json-false))
                        ("major_mode" . ,(symbol-name major-mode))
                        ("minor_modes" . ,(emacs-operator--minor-modes))
                        ("buffer_tick" . ,(buffer-chars-modified-tick))
                        ("human_change_seq" . ,emacs-operator--human-change-seq)
                        ("narrowed" . ,(if (buffer-narrowed-p) t :json-false))))
          ("cursor" . (("point" . ,pt)
                        ("line" . ,(line-number-at-pos pt t))
                        ("column" . ,(current-column))
                        ("mark" . ,mark-pos)
                        ("region_active" . ,(if region-active t :json-false))
                        ("region_bounds" . ,(and region-active (vector (min pt mark-pos) (max pt mark-pos))))))
          ("context" . ,(and include-context
                             `(("before" . ,(emacs-operator--bounded-substring buffer (- pt around) pt around))
                               ("after" . ,(emacs-operator--bounded-substring buffer pt (+ pt around) around))
                               ("visible_start" . ,visible-start)
                               ("visible_end" . ,visible-end))))
          ("syntax" . ,(emacs-operator--syntax-state))
          ("interaction" . (("minibuffer_active" . ,(if minibuffer-window t :json-false))
                              ("minibuffer_prompt" . ,(and minibuffer-buffer
                                                        (with-current-buffer minibuffer-buffer
                                                          (condition-case nil (minibuffer-prompt) (error nil)))))
                              ("minibuffer_contents" . ,(and minibuffer-buffer
                                                              (with-current-buffer minibuffer-buffer
                                                                (minibuffer-contents-no-properties))))
                              ("current_command" . ,(and this-command (symbol-name this-command)))
                              ("last_command" . ,(and last-command (symbol-name last-command)))
                              ("prefix" . ,current-prefix-arg)))
          ("process" . ,(and buffer-process
                            `(("name" . ,(process-name buffer-process))
                              ("status" . ,(symbol-name (process-status buffer-process)))
                              ("mark" . ,(marker-position (process-mark buffer-process)))
                              ("output_cursor" . ,(point-max)))))
          ("recent_commands" . ,(seq-take emacs-operator--command-log 20))
          ("adapters" . ,(and include-adapters
                               (fboundp 'emacs-operator-adapters-observe)
                               (emacs-operator-adapters-observe
                                (emacs-operator-adapter-context target))))
          ("messages" . ,(and include-messages (emacs-operator--messages-tail))))))))

(defun emacs-operator--install-buffer-state-hooks ()
  (add-hook 'after-change-functions #'emacs-operator--after-change nil t))

(defun emacs-operator-state-start ()
  (unless emacs-operator--state-hooks-enabled
    (setq emacs-operator--state-hooks-enabled t)
    (add-hook 'pre-command-hook #'emacs-operator--pre-command)
    (add-hook 'post-command-hook #'emacs-operator--post-command)
    (add-hook 'after-change-major-mode-hook #'emacs-operator--install-buffer-state-hooks)
    (dolist (buffer (buffer-list))
      (with-current-buffer buffer (emacs-operator--install-buffer-state-hooks)))
    (add-hook 'window-configuration-change-hook #'emacs-operator--bump-state)
    (add-hook 'buffer-list-update-hook #'emacs-operator--bump-state)
    (add-hook 'minibuffer-setup-hook #'emacs-operator--bump-state)
    (add-hook 'minibuffer-exit-hook #'emacs-operator--bump-state)))

(defun emacs-operator-state-stop ()
  (when emacs-operator--state-hooks-enabled
    (setq emacs-operator--state-hooks-enabled nil)
    (remove-hook 'pre-command-hook #'emacs-operator--pre-command)
    (remove-hook 'post-command-hook #'emacs-operator--post-command)
    (remove-hook 'after-change-major-mode-hook #'emacs-operator--install-buffer-state-hooks)
    (dolist (buffer (buffer-list))
      (with-current-buffer buffer (remove-hook 'after-change-functions #'emacs-operator--after-change t)))
    (remove-hook 'window-configuration-change-hook #'emacs-operator--bump-state)
    (remove-hook 'buffer-list-update-hook #'emacs-operator--bump-state)
    (remove-hook 'minibuffer-setup-hook #'emacs-operator--bump-state)
    (remove-hook 'minibuffer-exit-hook #'emacs-operator--bump-state)))

(provide 'emacs-operator-observe)
;;; emacs-operator-observe.el ends here
