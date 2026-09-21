;;; emacs-operator-test.el --- ERT tests -*- lexical-binding: t; -*-

(require 'ert)
(require 'cl-lib)
(require 'json)
(require 'emacs-operator)
(emacs-operator-state-start)
(emacs-operator-policy-start)

(defmacro emacs-operator-test-with-buffer (&rest body)
  `(with-temp-buffer
     (emacs-lisp-mode)
     (let ((emacs-operator--command-source 'rpc))
       ,@body)))

(ert-deftest emacs-operator-framing-split-and-utf8 ()
  (let* ((payload (encode-coding-string (json-encode '(("text" . "中文λ"))) 'utf-8 t))
         (frame (concat (string-as-unibyte (format "Content-Length: %d\r\n\r\n" (string-bytes payload))) payload))
         (parsed (emacs-operator--parse-one-frame frame)))
    (should parsed)
    (should (equal (decode-coding-string (car parsed) 'utf-8)
                   (json-encode '(("text" . "中文λ")))))
    (should (equal (cdr parsed) ""))
    (should-not (emacs-operator--parse-one-frame (substring frame 0 8)))
    (should-not (emacs-operator--parse-one-frame (substring frame 0 (1- (length frame)))))))

(ert-deftest emacs-operator-stable-buffer-handle ()
  (with-temp-buffer
    (let ((one (emacs-operator-buffer-id)))
      (should (string-prefix-p "buf_" one))
      (should (equal one (emacs-operator-buffer-id)))
      (should (eq (current-buffer) (emacs-operator-find-buffer one))))))

(ert-deftest emacs-operator-observe-compact-fields ()
  (emacs-operator-test-with-buffer
   (insert "(defun demo ()\n  (+ 1 2))\n")
   (goto-char (point-min))
   (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
          (state (emacs-operator-observe `(("target" . ,target) ("scope" . ("compact" "context")) ("around_chars" . 40))))
          (buffer (emacs-operator--get state "buffer"))
          (cursor (emacs-operator--get state "cursor")))
     (should (numberp (emacs-operator--get state "state_seq")))
     (should (equal (emacs-operator--get buffer "major_mode") "emacs-lisp-mode"))
     (should (equal (emacs-operator--get buffer "id") (emacs-operator-buffer-id)))
     (should (= (emacs-operator--get cursor "point") (point))))))

(ert-deftest emacs-operator-precondition-detects-buffer-conflict ()
  (emacs-operator-test-with-buffer
   (insert "abc")
   (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
          (tick (buffer-chars-modified-tick)))
     (insert "d")
     (should-error
      (emacs-operator-check-precondition target `(("expected_buffer_tick" . ,tick)))
      :type 'emacs-operator-error))))

(ert-deftest emacs-operator-semantic-edit-is-atomic ()
  (emacs-operator-test-with-buffer
   (insert "abc")
   (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
          (tick (buffer-chars-modified-tick)))
     (emacs-operator-edit-apply
      `(("target" . ,target)
        ("operation" . "replace_range")
        ("start" . 2) ("end" . 3) ("text" . "XYZ")
        ("precondition" . (("expected_buffer_tick" . ,tick)))
        ("policy" . (("profile" . "workspace_edit") ("project_root" . ,default-directory)))))
     (should (equal (buffer-string) "aXYZc")))))

(ert-deftest emacs-operator-checkpoint-rolls-back-agent-only-changes ()
  (emacs-operator-test-with-buffer
   (insert "before")
   (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
          (created (emacs-operator-checkpoint-create `(("target" . ,target) ("scope" . "buffer"))))
          (checkpoint (emacs-operator--get created "checkpoint_id")))
     (let ((emacs-operator--command-source 'rpc))
       (erase-buffer)
       (insert "after"))
     (emacs-operator-checkpoint-rollback `(("target" . ,target) ("checkpoint_id" . ,checkpoint)))
     (should (equal (buffer-string) "before")))))

(ert-deftest emacs-operator-checkpoint-refuses-human-change ()
  (emacs-operator-test-with-buffer
   (insert "before")
   (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
          (created (emacs-operator-checkpoint-create `(("target" . ,target) ("scope" . "buffer"))))
          (checkpoint (emacs-operator--get created "checkpoint_id")))
     (let ((emacs-operator--command-source 'human))
       (insert " human"))
     (should-error
      (emacs-operator-checkpoint-rollback `(("target" . ,target) ("checkpoint_id" . ,checkpoint)))
      :type 'emacs-operator-error))))

(ert-deftest emacs-operator-internal-key-resolves-custom-binding ()
  (emacs-operator-test-with-buffer
   (let ((map (make-sparse-keymap)) called)
     (use-local-map map)
     (fset 'emacs-operator-test-command (lambda () (interactive) (setq called t) (insert "OK")))
     (define-key map (kbd "C-c z") #'emacs-operator-test-command)
     (unwind-protect
         (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))
                          ("window_id" . ,(emacs-operator-window-id (selected-window)))))
                (cap (emacs-operator-capabilities-query `(("target" . ,target) ("operation" . "resolve_key") ("key" . "C-c z")))))
           (should (equal (emacs-operator--get cap "command") "emacs-operator-test-command"))
           (emacs-operator-keys-execute
            `(("target" . ,target)
              ("steps" . ((("kind" . "keys") ("value" . "C-c z"))))
              ("verify" . (("buffer_changed" . t)))
              ("policy" . (("profile" . "workspace_edit") ("project_root" . ,default-directory)))
              ("preserve_user_selection" . t)))
           (should called)
           (should (equal (buffer-string) "OK")))
       (fmakunbound 'emacs-operator-test-command)))))

(ert-deftest emacs-operator-internal-unicode-text-event ()
  (emacs-operator-test-with-buffer
   (let ((target `(("buffer_id" . ,(emacs-operator-buffer-id))
                   ("window_id" . ,(emacs-operator-window-id (selected-window))))))
     (emacs-operator-keys-execute
      `(("target" . ,target)
        ("steps" . ((("kind" . "text") ("value" . "中文λ"))))
        ("verify" . (("buffer_changed" . t)))
        ("policy" . (("profile" . "workspace_edit") ("project_root" . ,default-directory)))
        ("preserve_user_selection" . t)))
     (should (equal (buffer-string) "中文λ")))))


(ert-deftest emacs-operator-phase5-lisp-adapter-observes-structure ()
  (emacs-operator-test-with-buffer
   (insert "(defun demo (x)\n  (+ x 1))\n")
   (goto-char (point-min))
   (search-forward "x)")
   (let* ((context (emacs-operator-adapter-context))
          (active (emacs-operator-active-adapters context))
          (observed (emacs-operator-adapters-observe context))
          (lisp (emacs-operator--get observed "lisp")))
     (should (member "generic" active))
     (should (member "lisp" active))
     (should (emacs-operator--truthy-json-p (emacs-operator--get lisp "balanced")))
     (should (vectorp (emacs-operator--get lisp "defun_bounds")))
     (should (equal (emacs-operator--get lisp "defun_name") "demo")))))

(ert-deftest emacs-operator-phase5-lisp-capabilities-expose-structural-provider ()
  (emacs-operator-test-with-buffer
   (let* ((caps (emacs-operator-adapters-capabilities (emacs-operator-adapter-context) "lisp"))
          (entry (car caps))
          (payload (emacs-operator--get entry "capabilities"))
          (operations (emacs-operator--get payload "operations")))
     (should (listp operations))
     (should (cl-find-if (lambda (op) (equal (emacs-operator--get op "name") "forward_sexp")) operations))
     (should (cl-find-if (lambda (op) (equal (emacs-operator--get op "name") "slurp_forward")) operations)))))

(ert-deftest emacs-operator-phase5-lisp-verifier-detects-structural-breakage ()
  (emacs-operator-test-with-buffer
   (insert "(alpha beta)")
   (delete-char -1)
   (should-error
    (emacs-operator-lisp-verify
     '(("command" . "paredit-forward-slurp-sexp")) nil nil (emacs-operator-adapter-context))
    :type 'emacs-operator-error)))

(ert-deftest emacs-operator-phase5-org-adapter-observes-tree ()
  (with-temp-buffer
    (org-mode)
    (insert "* TODO Parent :tag:\n:PROPERTIES:\n:OWNER: Kevin\n:END:\n** Child\nBody\n")
    (goto-char (point-min))
    (let* ((context (emacs-operator-adapter-context))
           (active (emacs-operator-active-adapters context))
           (observed (emacs-operator-adapters-observe context))
           (org-state (emacs-operator--get observed "org"))
           (heading (emacs-operator--get org-state "heading")))
      (should (member "org" active))
      (should (equal (emacs-operator--get heading "title") "Parent"))
      (should (= (emacs-operator--get heading "level") 1))
      (should (equal (emacs-operator--get heading "todo") "TODO"))
      (should (member "tag" (emacs-operator--get heading "tags")))
      (should (emacs-operator--truthy-json-p (emacs-operator--get org-state "parse_valid"))))))

(ert-deftest emacs-operator-phase5-org-semantic-workflow ()
  (with-temp-buffer
    (org-mode)
    (setq-local org-todo-keywords '((sequence "TODO" "DOING" "|" "DONE")))
    (org-set-regexps-and-options)
    (insert "* First\n* Second\n")
    (goto-char (point-min))
    (emacs-operator-org-set-todo "TODO")
    (emacs-operator-org-set-property "OWNER" "Kevin")
    (should (equal (org-entry-get nil "OWNER") "Kevin"))
    (should (equal (org-get-todo-state) "TODO"))
    (emacs-operator-org-demote nil)
    (should (= (org-outline-level) 2))
    (emacs-operator-org-promote nil)
    (should (= (org-outline-level) 1))
    (emacs-operator-org-move-subtree-down 1)
    (goto-char (point-min))
    (should (looking-at "\\* Second"))
    (re-search-forward "^\\* TODO First")
    (beginning-of-line)
    (emacs-operator-org-insert-heading 1)
    (insert "Inserted")
    (should (emacs-operator-org--parse-valid-p))
    (should (string-match-p "^\\* Inserted" (buffer-string)))))

(ert-deftest emacs-operator-phase5-command-runs-adapter-verification ()
  (with-temp-buffer
    (org-mode)
    (insert "* Heading\n")
    (goto-char (point-min))
    (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
           (result (emacs-operator-command-execute
                    `(("target" . ,target)
                      ("command" . "emacs-operator-org-set-property")
                      ("interactive" . :json-false)
                      ("arguments" . ("OWNER" "Agent"))
                      ("policy" . (("profile" . "workspace_edit")
                                    ("project_root" . ,default-directory)))))))
      (should (equal (org-entry-get nil "OWNER") "Agent"))
      (should (emacs-operator--get result "adapter_verification")))))

(ert-deftest emacs-operator-phase5-structured-eval-rejects-source-string ()
  (emacs-operator-test-with-buffer
   (insert "(+ 1 2)")
   (goto-char (point-max))
   (let ((target `(("buffer_id" . ,(emacs-operator-buffer-id)))))
     (should-error
      (emacs-operator-adapter-eval
       `(("target" . ,target)
         ("operation" . "eval_last_sexp")
         ("code" . "(+ 2 3)")
         ("policy" . (("profile" . "trusted_local")))))
      :type 'emacs-operator-error))))

(ert-deftest emacs-operator-phase5-structured-elisp-buffer-eval ()
  (emacs-operator-test-with-buffer
   (insert "(+ 40 2)")
   (goto-char (point-max))
   (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
          (result (emacs-operator-adapter-eval
                   `(("target" . ,target)
                     ("operation" . "eval_last_sexp")
                     ("language" . "buffer_language")
                     ("code" . "")
                     ("policy" . (("profile" . "trusted_local"))))))
          (evaluation (emacs-operator--get result "evaluation"))
          (adapter-result (emacs-operator--get evaluation "result")))
     (should (equal (emacs-operator--get evaluation "adapter") "lisp"))
     (should (equal (emacs-operator--get adapter-result "value") "42")))))

(ert-deftest emacs-operator-phase5-paredit-workflow-when-installed ()
  (skip-unless (require 'paredit nil t))
  (emacs-operator-test-with-buffer
   (paredit-mode 1)
   (insert "(foo (bar) baz)")
   (goto-char (point-min))
   (search-forward "bar")
   (paredit-forward-slurp-sexp)
   (should (emacs-operator-lisp--balanced-p))
   (paredit-forward-barf-sexp)
   (should (emacs-operator-lisp--balanced-p))
   (paredit-wrap-round)
   (should (emacs-operator-lisp--balanced-p))
   (paredit-splice-sexp)
   (should (emacs-operator-lisp--balanced-p))))


(ert-deftest emacs-operator-phase5-repl-source-is-buffer-derived ()
  (with-temp-buffer
    (emacs-lisp-mode)
    (insert "(message \"first\")\n(+ 20 22)")
    (goto-char (point-max))
    (should (equal (emacs-operator-repl-current-sexp-source) "(+ 20 22)"))))

(ert-deftest emacs-operator-phase5-repl-defun-source-is-buffer-derived ()
  (with-temp-buffer
    (emacs-lisp-mode)
    (insert "(defun emacs-operator-test-repl ()\n  (+ 1 2))\n")
    (goto-char (point-min))
    (search-forward "+")
    (should (string-match-p "defun emacs-operator-test-repl" (emacs-operator-repl-current-defun-source)))))

(ert-deftest emacs-operator-phase5-repl-timeout-is-bounded ()
  (should (= (emacs-operator-repl-timeout-seconds '(("timeout_ms" . 999999))) 30.0))
  (should-error (emacs-operator-repl-timeout-seconds '(("timeout_ms" . 0))) :type 'emacs-operator-error))


(ert-deftest emacs-operator-alpha4-lisp-structural-facade-uses-builtin-navigation ()
  (emacs-operator-test-with-buffer
   (insert "(alpha) (beta)")
   (goto-char (point-min))
   (let ((result (emacs-operator-lisp-structural-edit "forward_sexp" 1)))
     (should (equal (emacs-operator--get result "provider") "builtin"))
     (should (equal (emacs-operator--get result "resolved_command") "forward-sexp"))
     (should (= (point) 8))
     (should (emacs-operator-lisp--balanced-p)))))

(ert-deftest emacs-operator-alpha4-lisp-structural-facade-rejects-unknown-operation ()
  (emacs-operator-test-with-buffer
   (insert "(alpha beta)")
   (goto-char (point-min))
   (should-error
    (emacs-operator-lisp-structural-edit "teleport_sexp" 1)
    :type 'emacs-operator-error)))

(ert-deftest emacs-operator-alpha4-structured-elisp-region-eval ()
  (emacs-operator-test-with-buffer
   (insert "(setq emacs-operator-test-alpha4-value 41)\n(setq emacs-operator-test-alpha4-value (1+ emacs-operator-test-alpha4-value))")
   (goto-char (point-min))
   (set-mark (point-min))
   (goto-char (point-max))
   (setq mark-active t transient-mark-mode t)
   (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
          (result (emacs-operator-adapter-eval
                   `(("target" . ,target)
                     ("operation" . "eval_region")
                     ("language" . "buffer_language")
                     ("code" . "")
                     ("policy" . (("profile" . "trusted_local"))))))
          (evaluation (emacs-operator--get result "evaluation"))
          (adapter-result (emacs-operator--get evaluation "result")))
     (should (equal (emacs-operator--get evaluation "adapter") "lisp"))
     (should (equal (emacs-operator--get adapter-result "value") "evaluated"))
     (should (= emacs-operator-test-alpha4-value 42)))
   (makunbound 'emacs-operator-test-alpha4-value)))

(ert-deftest emacs-operator-alpha4-org-table-observe-and-edit ()
  (with-temp-buffer
    (org-mode)
    (insert "| Name | Value |\n|------+-------|\n| A    | 1     |\n")
    (goto-char (point-min))
    (forward-line 2)
    (search-forward "A")
    (let* ((observed (emacs-operator-org-observe (emacs-operator-adapter-context)))
           (table (emacs-operator--get observed "table"))
           (dimensions (emacs-operator--get table "dimensions")))
      (should (vectorp dimensions))
      (should (= (aref dimensions 0) 2))
      (should (= (aref dimensions 1) 2)))
    (emacs-operator-org-table-set-cell 2 2 "42")
    (goto-char (point-min))
    (should (equal (substring-no-properties (org-table-get 2 2)) "42"))
    (should (emacs-operator-org--parse-valid-p))))

(ert-deftest emacs-operator-alpha4-org-babel-buffer-derived-eval ()
  (with-temp-buffer
    (org-mode)
    (insert "#+begin_src emacs-lisp :results value\n(+ 40 2)\n#+end_src\n")
    (goto-char (point-min))
    (forward-line 1)
    (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
           (result (emacs-operator-adapter-eval
                    `(("target" . ,target)
                      ("operation" . "execute_babel")
                      ("language" . "buffer_language")
                      ("code" . "")
                      ("timeout_ms" . 5000)
                      ("policy" . (("profile" . "trusted_local"))))))
           (evaluation (emacs-operator--get result "evaluation"))
           (adapter-result (emacs-operator--get evaluation "result")))
      (should (equal (emacs-operator--get evaluation "adapter") "org"))
      (should (emacs-operator--truthy-json-p (emacs-operator--get adapter-result "completed")))
      (should (equal (emacs-operator--get adapter-result "value") "42"))
      (goto-char (point-min))
      (should (re-search-forward "^#\\+RESULTS:" nil t)))))

(ert-deftest emacs-operator-alpha4-org-babel-still-rejects-caller-source ()
  (with-temp-buffer
    (org-mode)
    (insert "#+begin_src emacs-lisp\n(+ 1 2)\n#+end_src\n")
    (goto-char (point-min))
    (forward-line 1)
    (let ((target `(("buffer_id" . ,(emacs-operator-buffer-id)))))
      (should-error
       (emacs-operator-adapter-eval
        `(("target" . ,target)
          ("operation" . "execute_babel")
          ("language" . "buffer_language")
          ("code" . "(delete-file \"/tmp/nope\")")
          ("policy" . (("profile" . "trusted_local")))))
       :type 'emacs-operator-error))))

(ert-deftest emacs-operator-alpha4-org-babel-respects-eval-never ()
  (with-temp-buffer
    (org-mode)
    (insert "#+begin_src emacs-lisp :eval never :results value\n(+ 40 2)\n#+end_src\n")
    (goto-char (point-min))
    (forward-line 1)
    (let ((target `(("buffer_id" . ,(emacs-operator-buffer-id)))))
      (should-error
       (emacs-operator-adapter-eval
        `(("target" . ,target)
          ("operation" . "execute_babel")
          ("language" . "buffer_language")
          ("code" . "")
          ("policy" . (("profile" . "trusted_local")))))
       :type 'emacs-operator-error))))


(ert-deftest emacs-operator-alpha5-navigation-search-does-not-mutate-buffer ()
  (emacs-operator-test-with-buffer
   (insert "(alpha)\n(beta)\n(gamma)\n")
   (goto-char (point-min))
   (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
          (tick (buffer-chars-modified-tick))
          (result (emacs-operator-navigation-execute
                   `(("target" . ,target)
                     ("operation" . "search_forward")
                     ("query" . "beta")
                     ("case_sensitive" . t)))))
     (should (= (emacs-operator--get result "point_after") 14))
     (should (= (buffer-chars-modified-tick) tick))
     (should (looking-back "beta" (- (point) 4))))))

(ert-deftest emacs-operator-alpha5-navigation-structural-and-line-addressing ()
  (emacs-operator-test-with-buffer
   (insert "(one)\n(two three)\n")
   (goto-char (point-min))
   (let ((target `(("buffer_id" . ,(emacs-operator-buffer-id)))))
     (let ((forward (emacs-operator-navigation-execute
                     `(("target" . ,target) ("operation" . "forward_sexp")))))
       (should (= (emacs-operator--get forward "point_after") 6)))
     (let ((line (emacs-operator-navigation-execute
                  `(("target" . ,target) ("operation" . "goto_line") ("line" . 2)))))
       (should (= (emacs-operator--get line "line") 2))
       (should (looking-at "(two three)"))))))

(ert-deftest emacs-operator-alpha5-observe-exposes-readable-buffer-bounds ()
  (emacs-operator-test-with-buffer
   (insert "abcdef")
   (narrow-to-region 2 6)
   (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
          (observed (emacs-operator-observe `(("target" . ,target) ("scope" . ("compact")))))
          (buffer (emacs-operator--get observed "buffer")))
     (should (= (emacs-operator--get buffer "point_min") 2))
     (should (= (emacs-operator--get buffer "point_max") 6)))))


(ert-deftest emacs-operator-alpha5-default-selector-follows-selected-window-buffer ()
  (save-window-excursion
    (let ((buffer (generate-new-buffer " *emacs-operator-alpha5-visible*")))
      (unwind-protect
          (progn
            (set-window-buffer (selected-window) buffer)
            (with-current-buffer buffer (emacs-lisp-mode) (insert "(+ 1 2)"))
            (let ((target (emacs-operator-resolve-target nil)))
              (should (equal (emacs-operator--get target "buffer_id")
                             (emacs-operator-buffer-id buffer)))))
        (when (buffer-live-p buffer) (kill-buffer buffer))))))


(ert-deftest emacs-operator-alpha5-capabilities-work-for-background-buffer ()
  (let ((buffer (generate-new-buffer " *emacs-operator-alpha5-background*")))
    (unwind-protect
        (with-current-buffer buffer
          (emacs-lisp-mode)
          (insert "(+ 1 2)")
          (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id buffer))))
                 (result (emacs-operator-capabilities-query
                          `(("target" . ,target)
                            ("operation" . "adapter_observe"))))
                 (adapters (emacs-operator--get result "adapters")))
            (should (emacs-operator--get adapters "lisp"))))
      (when (buffer-live-p buffer) (kill-buffer buffer)))))

(ert-deftest emacs-operator-alpha5-internal-key-verifies-expected-command ()
  (save-window-excursion
    (let ((buffer (generate-new-buffer " *emacs-operator-alpha5-key*")))
      (unwind-protect
          (progn
            (set-window-buffer (selected-window) buffer)
            (with-current-buffer buffer
              (emacs-lisp-mode)
              (insert "  abc")
              (goto-char (point-max)))
            (let ((target `(("buffer_id" . ,(emacs-operator-buffer-id buffer))
                            ("window_id" . ,(emacs-operator-window-id (selected-window))))))
              (should (emacs-operator--get
                       (emacs-operator-keys-execute
                        `(("target" . ,target)
                          ("steps" . ((("kind" . "keys") ("value" . "C-a"))))
                          ("verify" . (("expected_command" . "move-beginning-of-line")))
                          ("policy" . (("profile" . "workspace_edit")))))
                       "executed"))
              (should-error
               (emacs-operator-keys-execute
                `(("target" . ,target)
                  ("steps" . ((("kind" . "keys") ("value" . "C-a"))))
                  ("verify" . (("expected_command" . "end-of-line")))
                  ("policy" . (("profile" . "workspace_edit")))))
               :type 'emacs-operator-error)))
        (when (buffer-live-p buffer) (kill-buffer buffer))))))


(ert-deftest emacs-operator-alpha6-lisp-validator-reports-repairable-position ()
  (emacs-operator-test-with-buffer
   (insert "(defun broken (x)\n  (+ x 1)\n")
   (let ((validation (emacs-operator-lisp-validate nil (emacs-operator-adapter-context))))
     (should-not (emacs-operator--truthy-json-p (emacs-operator--get validation "valid")))
     (let* ((diagnostics (emacs-operator--get validation "diagnostics"))
            (first (and (vectorp diagnostics) (> (length diagnostics) 0) (aref diagnostics 0))))
       (should first)
       (should (integerp (emacs-operator--get first "position")))
       (should (stringp (emacs-operator--get first "message")))))))

(ert-deftest emacs-operator-alpha6-elisp-runtime-error-is-data-not-transport-failure ()
  (emacs-operator-test-with-buffer
   (insert "(/ 1 0)")
   (goto-char (point-max))
   (let ((result (emacs-operator-lisp-eval '(("operation" . "eval_last_sexp")) nil)))
     (should result)
     (should-not (emacs-operator--truthy-json-p (emacs-operator--get result "completed")))
     (should (stringp (emacs-operator--get result "condition")))
     (should (stringp (emacs-operator--get result "stderr"))))))

(ert-deftest emacs-operator-alpha6-org-structured-document-build ()
  (with-temp-buffer
    (org-mode)
    (emacs-operator-org-create-heading "Project" 1)
    (goto-char (point-max))
    (emacs-operator-org-create-heading "Data" 2)
    (goto-char (point-max))
    (emacs-operator-org-insert-table ["Name" "Value"] [["A" "1"] ["B" "2"]])
    (emacs-operator-org-table-set-cell 3 2 "42")
    (goto-char (point-max))
    (emacs-operator-org-create-heading "Computation" 2)
    (goto-char (point-max))
    (emacs-operator-org-insert-src-block "emacs-lisp" "(+ 40 2)" ":results value")
    (let ((validation (emacs-operator-org-validate nil (emacs-operator-adapter-context))))
      (should (emacs-operator--truthy-json-p (emacs-operator--get validation "valid"))))
    (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
           (evaluated (emacs-operator-adapter-eval
                       `(("target" . ,target)
                         ("operation" . "execute_babel")
                         ("language" . "buffer_language")
                         ("code" . "")
                         ("policy" . (("profile" . "trusted_local"))))))
           (evaluation (emacs-operator--get evaluated "evaluation"))
           (result (emacs-operator--get evaluation "result")))
      (should (emacs-operator--truthy-json-p (emacs-operator--get result "completed")))
      (should (equal (emacs-operator--get result "value") "42")))
    (goto-char (point-min))
    (should (re-search-forward "^\\* Project$" nil t))
    (should (re-search-forward "^\\*\\* Data$" nil t))
    (should (re-search-forward "| B[ ]+|[ ]*42[ ]*|" nil t))
    (should (re-search-forward "^#\\+RESULTS:" nil t))))

(ert-deftest emacs-operator-alpha6-org-validator-detects-unclosed-block ()
  (with-temp-buffer
    (org-mode)
    (insert "* Broken\n#+begin_src emacs-lisp\n(+ 1 2)\n")
    (let* ((validation (emacs-operator-org-validate nil (emacs-operator-adapter-context)))
           (diagnostics (emacs-operator--get validation "diagnostics")))
      (should-not (emacs-operator--truthy-json-p (emacs-operator--get validation "valid")))
      (should (vectorp diagnostics))
      (should (> (length diagnostics) 0)))))


(ert-deftest emacs-operator-alpha6-command-exposes-safe-noninteractive-return-value ()
  (emacs-operator-test-with-buffer
   (insert "(alpha) (beta)")
   (goto-char (point-min))
   (let* ((target `(("buffer_id" . ,(emacs-operator-buffer-id))))
          (result (emacs-operator-command-execute
                   `(("target" . ,target)
                     ("command" . "emacs-operator-lisp-structural-edit")
                     ("interactive" . :json-false)
                     ("arguments" . ("forward_sexp" 1))
                     ("policy" . (("profile" . "workspace_edit"))))))
          (value (emacs-operator--get result "return_value")))
     (should (equal (emacs-operator--get value "operation") "forward_sexp"))
     (should (equal (emacs-operator--get value "provider") "builtin"))
     (should (= (point) 8)))))

(ert-deftest emacs-operator-alpha6-elisp-runtime-error-carries-source-diagnostic-metadata ()
  (emacs-operator-test-with-buffer
   (insert "(/ 1 0)")
   (goto-char (point-max))
   (let* ((result (emacs-operator-lisp-eval '(("operation" . "eval_last_sexp")) nil))
          (metadata (emacs-operator--get result "metadata")))
     (should-not (emacs-operator--truthy-json-p (emacs-operator--get result "completed")))
     (should (stringp (emacs-operator--get result "backtrace_handle")))
     (should (vectorp (emacs-operator--get metadata "source_bounds")))
     (should (stringp (emacs-operator--get metadata "source_sha256")))
     (should (= (emacs-operator--get metadata "source_bytes") 7)))))

(ert-deftest emacs-operator-alpha6-elisp-validator-adds-reader-diagnostics ()
  (emacs-operator-test-with-buffer
   ;; Delimiters are balanced, but this printed-object syntax is not readable
   ;; as source code and should be caught by the Emacs Lisp reader pass.
   (insert "#<not-readable>")
   (let* ((validation (emacs-operator-lisp-validate nil (emacs-operator-adapter-context)))
          (diagnostics (emacs-operator--get validation "diagnostics")))
     (should (emacs-operator--truthy-json-p (emacs-operator--get validation "balanced")))
     (should (emacs-operator--truthy-json-p (emacs-operator--get validation "reader_checked")))
     (should-not (emacs-operator--truthy-json-p (emacs-operator--get validation "valid")))
     (should (> (length diagnostics) 0))
     (should (equal (emacs-operator--get (aref diagnostics 0) "kind") "reader")))))

(ert-deftest emacs-operator-alpha6-org-validation-includes-bounded-document-summary ()
  (with-temp-buffer
    (org-mode)
    (insert "* Project\n** Data\n| Name | Value |\n|------+-------|\n| A | 1 |\n** Computation\n#+begin_src emacs-lisp\n(+ 1 2)\n#+end_src\n")
    (goto-char (point-min))
    (let* ((validation (emacs-operator-org-validate '(("max_nodes" . 10)) (emacs-operator-adapter-context)))
           (summary (emacs-operator--get validation "document_summary"))
           (counts (emacs-operator--get summary "counts"))
           (headings (emacs-operator--get summary "headings")))
      (should (emacs-operator--truthy-json-p (emacs-operator--get validation "valid")))
      (should (= (emacs-operator--get counts "headings") 3))
      (should (= (emacs-operator--get counts "tables") 1))
      (should (= (emacs-operator--get counts "src_blocks") 1))
      (should (= (length headings) 3))
      (should (equal (emacs-operator--get (aref headings 0) "title") "Project")))))



(ert-deftest emacs-operator-alpha6-buffer-derived-eval-enforces-byte-bound ()
  (with-temp-buffer
    (emacs-lisp-mode)
    (insert "(progn \"")
    (insert (make-string 262145 ?x))
    (insert "\")")
    (goto-char (point-max))
    (let ((caught nil))
      (condition-case err
          (emacs-operator-lisp-eval '(("operation" . "eval_last_sexp")) nil)
        (emacs-operator-error (setq caught err)))
      (should caught)
      (should (equal (nth 1 caught) "E_INVALID_ARGUMENT")))))

(ert-deftest emacs-operator-alpha6-org-babel-query-is-one-shot-authorized-without-prompt ()
  (with-temp-buffer
    (org-mode)
    (let ((org-confirm-babel-evaluate t)
          (org-babel-load-languages '((emacs-lisp . t))))
      (insert "#+begin_src emacs-lisp :eval query :results value\n(+ 40 2)\n#+end_src\n")
      (goto-char (point-min))
      (forward-line 1)
      (let ((org-confirm-babel-evaluate
             (lambda (&rest _args)
               (ert-fail "Babel query attempted an interactive confirmation"))))
        (let* ((result (emacs-operator-org-eval '(("operation" . "execute_babel")) nil))
               (completed (emacs-operator--get result "completed")))
          (should (emacs-operator--truthy-json-p completed))
          (should (equal (emacs-operator--get result "value") "42")))))))

(ert-deftest emacs-operator-alpha8-rename-symbol-skips-comments-strings-and-partial-symbols ()
  (emacs-operator-test-with-buffer
   (insert "(defun demo (foo foo/bar)\n  ;; foo must stay in the comment\n  (list foo foo/bar \"foo\" 'foo))\n")
   (goto-char (point-min))
   (search-forward "(list")
   (let ((result (emacs-operator-lisp-rename-symbol "foo" "qux" "current_defun" 100)))
     (should (= (emacs-operator--get result "replacements") 3))
     (should (string-match-p "(defun demo (qux foo/bar)" (buffer-string)))
     (should (string-match-p ";; foo must stay in the comment" (buffer-string)))
     (should (string-match-p "(list qux foo/bar \\\"foo\\\" 'qux)" (buffer-string)))
     (should-not (string-match-p "qux/bar" (buffer-string)))
     (should (emacs-operator-lisp--balanced-p)))))

(ert-deftest emacs-operator-alpha8-extract-function-is-buffer-derived-and-balanced ()
  (emacs-operator-test-with-buffer
   (insert "(defun demo (x)\n  (+ x 1)\n  (* x 2))\n")
   (goto-char (point-min))
   (search-forward "(+ x 1)")
   (let ((end (point))
         (start (match-beginning 0)))
     (goto-char start)
     (let ((result (emacs-operator-lisp-extract-function start end "emacs-operator-test-increment" ["x"])))
       (should (equal (emacs-operator--get result "name") "emacs-operator-test-increment"))
       (should (vectorp (emacs-operator--get result "new_definition_bounds")))
       (should (vectorp (emacs-operator--get result "call_bounds")))
       (should (string-match-p "\\`(defun emacs-operator-test-increment (x)" (buffer-string)))
       (should (string-match-p "(emacs-operator-test-increment x)" (buffer-string)))
       (should (string-match-p "(\\* x 2)" (buffer-string)))
       (should (emacs-operator-lisp--balanced-p))))))

(ert-deftest emacs-operator-alpha8-move-top-level-form-preserves-separator-and-balance ()
  (emacs-operator-test-with-buffer
   (insert "(defun one () 1)\n\n(defun two () 2)\n")
   (goto-char (point-min))
   (search-forward "one")
   (let ((result (emacs-operator-lisp-move-top-level-form "down" 1)))
     (should (equal (emacs-operator--get result "direction") "down"))
     (should (string-match-p "\\`(defun two () 2)\n\n(defun one () 1)" (buffer-string)))
     (should (emacs-operator-lisp--balanced-p)))))

(ert-deftest emacs-operator-alpha8-org-rewrite-section-preserves-metadata-and-child-subtrees ()
  (with-temp-buffer
    (org-mode)
    (insert "* Parent :old:\n:PROPERTIES:\n:OWNER: Kevin\n:END:\nOld body\n** Child\nKeep child\n")
    (goto-char (point-min))
    (emacs-operator-org-set-title "Renamed")
    (emacs-operator-org-set-tags ["agent" "alpha8"])
    (emacs-operator-org-rewrite-section-body "New body")
    (goto-char (point-min))
    (should (looking-at "\\* Renamed[ ]+:agent:alpha8:"))
    (should (equal (org-entry-get nil "OWNER") "Kevin"))
    (should (string-match-p "New body" (buffer-string)))
    (should-not (string-match-p "Old body" (buffer-string)))
    (should (string-match-p "\\*\\* Child\nKeep child" (buffer-string)))
    (should (emacs-operator-org--parse-valid-p))))

(ert-deftest emacs-operator-alpha8-org-rewrite-section-rejects-raw-heading-injection ()
  (with-temp-buffer
    (org-mode)
    (insert "* Parent\nBody\n** Child\nKeep\n")
    (goto-char (point-min))
    (should-error
     (emacs-operator-org-rewrite-section-body "Replacement\n** Injected child")
     :type 'emacs-operator-error)
    (should (string-match-p "\\*\\* Child\nKeep" (buffer-string)))))

(ert-deftest emacs-operator-alpha8-extract-function-rejects-name-collision-before-mutation ()
  (emacs-operator-test-with-buffer
   (insert "(defun existing (x) x)\n\n(defun demo (x)\n  (+ x 1)\n  (* x 2))\n")
   (goto-char (point-min))
   (search-forward "(+ x 1)")
   (let ((end (point))
         (start (match-beginning 0))
         (before (buffer-string)))
     (goto-char start)
     (should-error
      (emacs-operator-lisp-extract-function start end "existing" ["x"])
      :type 'emacs-operator-error)
     (should (equal (buffer-string) before)))))

(ert-deftest emacs-operator-alpha8-extract-function-rejects-reader-like-generated-parameters ()
  (emacs-operator-test-with-buffer
   (insert "(defun demo (x)\n  (+ x 1)\n  (* x 2))\n")
   (goto-char (point-min))
   (search-forward "(+ x 1)")
   (let ((end (point))
         (start (match-beginning 0))
         (before (buffer-string)))
     (goto-char start)
     (should-error
      (emacs-operator-lisp-extract-function start end "safe-helper" ["#."])
      :type 'emacs-operator-error)
     (should (equal (buffer-string) before)))))

(ert-deftest emacs-operator-alpha8-org-tags-reject-colon-injection ()
  (with-temp-buffer
    (org-mode)
    (insert "* Parent\n")
    (goto-char (point-min))
    (let ((before (buffer-string)))
      (should-error
       (emacs-operator-org-set-tags ["safe:injected"])
       :type 'emacs-operator-error)
      (should (equal (buffer-string) before)))))


(ert-deftest emacs-operator-alpha10-evaluation-fingerprint-carries-source-locator ()
  (emacs-operator-test-with-buffer
   (insert "(defun locator-demo (x)\n  (+ x 1))\n")
   (goto-char (point-min))
   (search-forward "(+ x 1)")
   (let* ((analysis (emacs-operator-lisp-analyze
                     "evaluation_source_fingerprint"
                     '(("evaluation_operation" . "eval_defun")) nil))
          (bounds (emacs-operator--get analysis "source_bounds")))
     (should (vectorp bounds))
     (should (= (length bounds) 2))
     (should (= (emacs-operator--get analysis "source_start") (aref bounds 0)))
     (should (= (emacs-operator--get analysis "source_start") (point-min)))
     (should (stringp (emacs-operator--get analysis "source_sha256"))))))


(ert-deftest emacs-operator-bridge-pid-alive-falls-back-to-signal-zero ()
  (let (signal-call)
    (cl-letf (((symbol-function 'emacs-operator--pid-visible-via-process-attributes-p)
               (lambda (_pid) nil))
              ((symbol-function 'emacs-operator--pid-visible-via-signal-zero-p)
               (lambda (pid)
                 (setq signal-call pid)
                 t)))
      (should (emacs-operator--pid-alive-p 4242))
      (should (= signal-call 4242)))))

(ert-deftest emacs-operator-bridge-pid-alive-rejects-dead-process-when-both-probes-fail ()
  (cl-letf (((symbol-function 'emacs-operator--pid-visible-via-process-attributes-p)
             (lambda (_pid) nil))
            ((symbol-function 'emacs-operator--pid-visible-via-signal-zero-p)
             (lambda (_pid) nil)))
    (should-not (emacs-operator--pid-alive-p 4242))))

(ert-deftest emacs-operator-stale-record-keeps-live-process-when-proc-is-hidden ()
  (cl-letf (((symbol-function 'emacs-operator--pid-visible-via-process-attributes-p)
             (lambda (_pid) nil))
            ((symbol-function 'emacs-operator--pid-visible-via-signal-zero-p)
             (lambda (_pid) t)))
    (should-not
     (emacs-operator--stale-record-p
      `(("pid" . 4242)
        ("heartbeat_at" . ,(format-time-string "%FT%TZ" nil t)))))))

(provide 'emacs-operator-test)
;;; emacs-operator-test.el ends here
