;;; emacs-operator-adapter-org.el --- Org semantic adapter -*- lexical-binding: t; -*-

(require 'cl-lib)
(require 'subr-x)
(require 'org)
(require 'org-element)
(require 'ob-core)
(require 'org-table)
(require 'emacs-operator-adapter-generic)
(require 'emacs-operator-keys)
(require 'emacs-operator-adapter-repl)

(defun emacs-operator-org-mode-p () (derived-mode-p 'org-mode))

(defun emacs-operator-org--heading-info ()
  (save-excursion
    (when (ignore-errors (org-back-to-heading t) t)
      (let ((start (point))
            (level (org-outline-level))
            (title (org-get-heading t t t t))
            (todo (org-get-todo-state))
            (tags (org-get-tags nil t))
            (outline-path (org-get-outline-path t t))
            (properties (org-entry-properties nil 'standard)))
        (org-end-of-subtree t t)
        `(("title" . ,title)
          ("level" . ,level)
          ("todo" . ,todo)
          ("tags" . ,tags)
          ("outline_path" . ,outline-path)
          ("subtree_bounds" . ,(vector start (point)))
          ("properties" . ,properties))))))

(defun emacs-operator-org--element-info ()
  (let* ((element (org-element-context))
         (type (org-element-type element)))
    `(("type" . ,(and type (symbol-name type)))
      ("begin" . ,(org-element-property :begin element))
      ("end" . ,(org-element-property :end element))
      ("language" . ,(and (eq type 'src-block) (org-element-property :language element)))
      ("name" . ,(org-element-property :name element)))))

(defun emacs-operator-org--babel-language-enabled-p (language)
  "Return non-nil only when LANGUAGE is explicitly enabled for Babel.
Emacs Lisp is built in. Other languages must be enabled in
`org-babel-load-languages`; merely loading an ob-LANG feature is not enough."
  (and (stringp language)
       (let ((symbol (intern language)))
         (or (eq symbol 'emacs-lisp)
             (cdr (assq symbol org-babel-load-languages))))))

(defun emacs-operator-org--babel-info ()
  (when (org-in-src-block-p t)
    (condition-case nil
        (let* ((info (org-babel-get-src-block-info 'light))
               (language (nth 0 info))
               (result-pos (org-babel-where-is-src-block-result)))
          `(("language" . ,language)
            ("language_enabled" . ,(if (emacs-operator-org--babel-language-enabled-p language) t :json-false))
            ("body_length" . ,(length (or (nth 1 info) "")))
            ("parameters" . ,(nth 2 info))
            ("result_position" . ,result-pos)))
      (error nil))))

(defun emacs-operator-org--table-matrix ()
  (when (org-at-table-p)
    (condition-case nil
        (org-table-to-lisp)
      (error nil))))

(defun emacs-operator-org--table-dimensions (matrix)
  (let ((rows 0) (columns 0))
    (dolist (row matrix)
      (unless (eq row 'hline)
        (setq rows (1+ rows))
        (when (listp row)
          (setq columns (max columns (length row))))))
    (vector rows columns)))

(defun emacs-operator-org--table-info ()
  (when (org-at-table-p)
    (condition-case nil
        (let* ((matrix (emacs-operator-org--table-matrix))
               (begin (save-excursion (org-table-begin) (point)))
               (end (save-excursion (org-table-end) (point)))
               (row (ignore-errors (org-table-current-dline)))
               (column (ignore-errors (org-table-current-column)))
               (field (ignore-errors (org-table-get-field))))
          `(("bounds" . ,(vector begin end))
            ("dimensions" . ,(emacs-operator-org--table-dimensions matrix))
            ("row" . ,row)
            ("column" . ,column)
            ("cell" . ,field)
            ("has_formula" . ,(if (save-excursion
                                     (goto-char end)
                                     (re-search-backward "^[ \t]*#\\+TBLFM:" begin t))
                                   t :json-false))))
      (error nil))))

(defun emacs-operator-org--parse-valid-p ()
  (condition-case nil
      (progn
        (org-element-parse-buffer 'greater-element)
        t)
    (error nil)))

(defun emacs-operator-org-observe (_context)
  `(("heading" . ,(emacs-operator-org--heading-info))
    ("element" . ,(emacs-operator-org--element-info))
    ("table" . ,(emacs-operator-org--table-info))
    ("babel" . ,(emacs-operator-org--babel-info))
    ("parse_valid" . ,(if (emacs-operator-org--parse-valid-p) t :json-false))))

(defun emacs-operator-org-capabilities (_context)
  (let* ((babel (emacs-operator-org--babel-info))
         (language-enabled (and babel (emacs-operator--truthy-json-p
                                      (emacs-operator--get babel "language_enabled")))))
    `(("operations" .
       ((("name" . "insert_heading") ("command" . "emacs-operator-org-insert-heading") ("channel" . "semantic"))
       (("name" . "create_heading") ("command" . "emacs-operator-org-create-heading") ("channel" . "semantic"))
       (("name" . "insert_table") ("command" . "emacs-operator-org-insert-table") ("channel" . "semantic"))
       (("name" . "insert_src_block") ("command" . "emacs-operator-org-insert-src-block") ("channel" . "semantic"))
       (("name" . "promote") ("command" . "emacs-operator-org-promote") ("channel" . "semantic"))
       (("name" . "demote") ("command" . "emacs-operator-org-demote") ("channel" . "semantic"))
       (("name" . "move_subtree_up") ("command" . "emacs-operator-org-move-subtree-up") ("channel" . "semantic"))
       (("name" . "move_subtree_down") ("command" . "emacs-operator-org-move-subtree-down") ("channel" . "semantic"))
       (("name" . "set_todo") ("command" . "emacs-operator-org-set-todo") ("channel" . "semantic"))
       (("name" . "set_title") ("command" . "emacs-operator-org-set-title") ("channel" . "semantic"))
       (("name" . "set_tags") ("command" . "emacs-operator-org-set-tags") ("channel" . "semantic"))
       (("name" . "rewrite_section_body") ("command" . "emacs-operator-org-rewrite-section-body") ("channel" . "semantic"))
       (("name" . "set_property") ("command" . "emacs-operator-org-set-property") ("channel" . "semantic"))
       (("name" . "create_id") ("command" . "emacs-operator-org-create-id") ("channel" . "semantic"))
       (("name" . "table_set_cell") ("command" . "emacs-operator-org-table-set-cell") ("channel" . "semantic"))
       (("name" . "table_align") ("command" . "emacs-operator-org-table-align") ("channel" . "semantic"))
       (("name" . "table_recalculate") ("command" . "emacs-operator-org-table-recalculate") ("channel" . "semantic"))
       (("name" . "archive_subtree") ("command" . "org-archive-subtree") ("channel" . "semantic") ("external_side_effect" . t))
       (("name" . "execute_babel") ("tool" . "emacs_eval") ("operation" . "execute_babel")
        ("available" . ,(if language-enabled t :json-false)) ("channel" . "repl") ("policy_gated" . t))
       (("name" . "export") ("command" . "org-export-dispatch") ("channel" . "internal_keys") ("policy_gated" . t))))
      ("babel_requires_profile" . "trusted_local"))))

(defun emacs-operator-org--require-heading ()
  (unless (ignore-errors (org-back-to-heading t) t)
    (emacs-operator-signal "E_COMMAND_FAILED" "Org operation requires point inside a heading/subtree.")))

(defun emacs-operator-org--require-table ()
  (unless (org-at-table-p)
    (emacs-operator-signal "E_COMMAND_FAILED" "Org table operation requires point inside a table.")))

(defun emacs-operator-org--sequence-list (value label)
  (cond
   ((vectorp value) (append value nil))
   ((listp value) value)
   (t (emacs-operator-signal "E_INVALID_ARGUMENT" (format "%s must be an array/list." label)))))

(defun emacs-operator-org--safe-inline-text (value label &optional allow-empty)
  (unless (and (stringp value)
               (or allow-empty (> (length value) 0))
               (not (string-match-p "[\n\r]" value)))
    (emacs-operator-signal "E_INVALID_ARGUMENT" (format "%s must be a single-line string." label)))
  value)

(defun emacs-operator-org--safe-tag (value)
  "Validate and return one Org tag token."
  (emacs-operator-org--safe-inline-text value "Org tag")
  (unless (and (<= (string-bytes value) 256)
               (string-match-p "\\`[[:alnum:]_@#%+.-]+\\'" value))
    (emacs-operator-signal
     "E_INVALID_ARGUMENT"
     "Org tags must be 1-256 byte tokens containing only letters, numbers, _, @, #, %, +, ., or -."))
  value)

(defun emacs-operator-org-create-heading (title &optional level todo tags)
  "Create a heading with TITLE at point using deterministic Org syntax.
LEVEL defaults to 1. TODO and TAGS are optional and are applied through Org APIs."
  (unless (derived-mode-p 'org-mode)
    (emacs-operator-signal "E_COMMAND_FAILED" "Target buffer is not in org-mode."))
  (emacs-operator-org--safe-inline-text title "Org heading title")
  (let ((level (or level 1)))
    (unless (and (integerp level) (> level 0) (<= level 50))
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Org heading level must be an integer from 1 to 50."))
    (atomic-change-group
      (unless (bolp) (insert "\n"))
      (let ((start (point)))
        (insert (make-string level ?*) " " title "\n")
        (goto-char start)
        (when todo
          (unless (stringp todo)
            (emacs-operator-signal "E_INVALID_ARGUMENT" "Org TODO state must be a string or null."))
          (org-todo todo))
        (when tags
          (let ((items (emacs-operator-org--sequence-list tags "Org tags")))
            (dolist (tag items) (emacs-operator-org--safe-tag tag))
            (org-set-tags (if items (concat ":" (mapconcat #'identity items ":") ":") ""))))
        `(("heading" . ,(emacs-operator-org--heading-info))
          ("start" . ,start))))))

(defun emacs-operator-org--table-cell-text (value)
  (unless (stringp value)
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Org table cells must be strings."))
  (when (string-match-p "[\n\r|]" value)
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Org table cells must be single-line and may not contain an unescaped pipe."))
  value)

(defun emacs-operator-org--table-line (cells columns)
  (let ((items (emacs-operator-org--sequence-list cells "Org table row")))
    (unless (= (length items) columns)
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Every Org table row must match the header column count."
                             `(("expected_columns" . ,columns) ("actual_columns" . ,(length items)))))
    (concat "| " (mapconcat #'emacs-operator-org--table-cell-text items " | ") " |\n")))

(defun emacs-operator-org-insert-table (headers rows)
  "Insert a deterministic Org table at point and leave point inside the table."
  (unless (derived-mode-p 'org-mode)
    (emacs-operator-signal "E_COMMAND_FAILED" "Target buffer is not in org-mode."))
  (let* ((headers (emacs-operator-org--sequence-list headers "Org table headers"))
         (rows (emacs-operator-org--sequence-list rows "Org table rows"))
         (columns (length headers)))
    (unless (and (> columns 0) (<= columns 100))
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Org tables require 1 to 100 columns."))
    (when (> (length rows) 1000)
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Org table insertion is limited to 1000 data rows."))
    (atomic-change-group
      (unless (bolp) (insert "\n"))
      (let ((start (point)))
        (insert (emacs-operator-org--table-line headers columns))
        (insert "|" (mapconcat (lambda (_cell) "---") headers "+") "|\n")
        (dolist (row rows) (insert (emacs-operator-org--table-line row columns)))
        (goto-char start)
        (org-table-align)
        `(("start" . ,start)
          ("table" . ,(emacs-operator-org--table-info)))))))

(defun emacs-operator-org-insert-src-block (language body &optional headers)
  "Insert a source block using LANGUAGE, BODY and optional header argument string.
This function only edits the Org document; execution remains gated by emacs_eval."
  (unless (derived-mode-p 'org-mode)
    (emacs-operator-signal "E_COMMAND_FAILED" "Target buffer is not in org-mode."))
  (unless (and (stringp language) (string-match-p "\\`[A-Za-z0-9_+.-]+\\'" language))
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Invalid Org Babel language name."))
  (unless (stringp body)
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Org source block body must be a string."))
  (when (> (string-bytes body) 262144)
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Org source block body exceeds the 256 KiB safety bound."))
  (let ((case-fold-search t))
    (when (string-match-p "^[ \t]*#\\+end_src\\b" body)
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Org source body may not contain a raw #+end_src delimiter line.")))
  (let ((headers (or headers "")))
    (emacs-operator-org--safe-inline-text headers "Org Babel headers" t)
    (atomic-change-group
      (unless (bolp) (insert "\n"))
      (let ((start (point)))
        (insert "#+begin_src " language)
        (unless (string-empty-p headers) (insert " " headers))
        (insert "\n")
        (let ((body-start (point)))
          (insert body)
          (unless (or (string-empty-p body) (string-suffix-p "\n" body)) (insert "\n"))
          (insert "#+end_src\n")
          (let ((end (point)))
            (goto-char body-start)
            `(("bounds" . ,(vector start end))
              ("babel" . ,(emacs-operator-org--babel-info)))))))))

(defun emacs-operator-org-insert-heading (&optional level)
  "Insert a deterministic Org heading. LEVEL nil preserves the current heading level."
  (unless (derived-mode-p 'org-mode)
    (emacs-operator-signal "E_COMMAND_FAILED" "Target buffer is not in org-mode."))
  (let ((target-level (or level (and (not (org-before-first-heading-p))
                                      (save-excursion (org-back-to-heading t) (org-outline-level))) 1)))
    (unless (and (integerp target-level) (> target-level 0) (<= target-level 50))
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Org heading level must be an integer from 1 to 50."))
    (org-insert-heading-respect-content)
    (while (< (org-outline-level) target-level) (org-demote))
    (while (> (org-outline-level) target-level) (org-promote))
    `(("heading" . ,(emacs-operator-org--heading-info)))))

(defun emacs-operator-org-promote (&optional subtree)
  (emacs-operator-org--require-heading)
  (if subtree (org-promote-subtree) (org-promote))
  `(("heading" . ,(emacs-operator-org--heading-info))))

(defun emacs-operator-org-demote (&optional subtree)
  (emacs-operator-org--require-heading)
  (if subtree (org-demote-subtree) (org-demote))
  `(("heading" . ,(emacs-operator-org--heading-info))))

(defun emacs-operator-org-move-subtree-up (&optional count)
  (emacs-operator-org--require-heading)
  (org-move-subtree-up (or count 1))
  `(("heading" . ,(emacs-operator-org--heading-info))))

(defun emacs-operator-org-move-subtree-down (&optional count)
  (emacs-operator-org--require-heading)
  (org-move-subtree-down (or count 1))
  `(("heading" . ,(emacs-operator-org--heading-info))))

(defun emacs-operator-org-set-title (title)
  "Set the current heading title without changing TODO state, priority, or tags."
  (emacs-operator-org--require-heading)
  (emacs-operator-org--safe-inline-text title "Org heading title")
  (org-edit-headline title)
  `(("heading" . ,(emacs-operator-org--heading-info))))

(defun emacs-operator-org-set-tags (tags)
  "Replace the current heading tag set with TAGS."
  (emacs-operator-org--require-heading)
  (let ((items (emacs-operator-org--sequence-list tags "Org tags")))
    (when (> (length items) 100)
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Org headings are limited to 100 tags through this API."))
    (dolist (tag items) (emacs-operator-org--safe-tag tag))
    (org-set-tags (if items (concat ":" (mapconcat #'identity items ":") ":") ""))
    `(("tags" . ,(org-get-tags nil t))
      ("heading" . ,(emacs-operator-org--heading-info)))))

(defun emacs-operator-org--section-content-bounds ()
  "Return body bounds for the current heading, excluding metadata and child subtrees."
  (save-excursion
    (emacs-operator-org--require-heading)
    (org-back-to-heading t)
    (let ((heading-start (point))
          subtree-end body-start body-end)
      (save-excursion
        (org-end-of-subtree t t)
        (setq subtree-end (point)))
      (org-end-of-meta-data t)
      (setq body-start (point)
            body-end subtree-end)
      (goto-char body-start)
      (when (re-search-forward org-heading-regexp subtree-end t)
        (setq body-end (match-beginning 0)))
      (vector body-start body-end heading-start subtree-end))))

(defun emacs-operator-org-rewrite-section-body (body)
  "Replace only the current heading's section BODY, preserving metadata and child subtrees.
Raw Org heading lines are rejected so the operation cannot silently create or
replace child hierarchy. Use structured heading operations for tree changes."
  (emacs-operator-org--require-heading)
  (unless (stringp body)
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Org section body must be a string."))
  (when (> (string-bytes body) 262144)
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Org section body exceeds the 256 KiB safety bound."))
  (let ((case-fold-search nil))
    (when (string-match-p "^\\*+[ \\t]+" body)
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Org section body may not contain raw heading lines; use structured subtree operations.")))
  (let* ((bounds (emacs-operator-org--section-content-bounds))
         (start (aref bounds 0))
         (end (aref bounds 1))
         (normalized (if (string-empty-p body) "" (concat (string-remove-suffix "\n" body) "\n"))))
    (atomic-change-group
      (delete-region start end)
      (goto-char start)
      (insert normalized)
      `(("content_bounds_before" . ,(vector start end))
        ("content_bounds_after" . ,(vector start (+ start (length normalized))))
        ("body_bytes" . ,(string-bytes body))
        ("heading" . ,(emacs-operator-org--heading-info))))))

(defun emacs-operator-org-set-todo (state)
  (emacs-operator-org--require-heading)
  (unless (or (null state) (stringp state))
    (emacs-operator-signal "E_INVALID_ARGUMENT" "TODO state must be a string or null."))
  (if (null state) (org-todo 'none) (org-todo state))
  `(("todo" . ,(org-get-todo-state))
    ("heading" . ,(emacs-operator-org--heading-info))))

(defun emacs-operator-org-set-property (property value)
  (emacs-operator-org--require-heading)
  (unless (and (stringp property) (string-match-p "\\`[A-Za-z0-9_@#%:.-]+\\'" property))
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Invalid Org property name."))
  (unless (and (stringp value)
               (<= (string-bytes value) 65536)
               (not (string-match-p "[\n\r]" value)))
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Org property value must be a single-line string up to 64 KiB."))
  (org-set-property property value)
  `(("property" . ,property) ("value" . ,(org-entry-get nil property))))

(defun emacs-operator-org-create-id ()
  (emacs-operator-org--require-heading)
  (require 'org-id)
  `(("id" . ,(org-id-get-create))))

(defun emacs-operator-org-table-set-cell (row column value)
  "Set Org table ROW/COLUMN to VALUE and realign the table."
  (emacs-operator-org--require-table)
  (unless (and (integerp row) (> row 0) (integerp column) (> column 0))
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Org table row and column must be positive integers."))
  (unless (and (stringp value) (not (string-match-p "[\n\r]" value)))
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Org table cell value must be a single-line string."))
  (atomic-change-group
    (condition-case err
        (progn
          (org-table-put row column value)
          (org-table-align)
          `(("row" . ,row)
            ("column" . ,column)
            ("value" . ,(org-table-get row column))
            ("table" . ,(emacs-operator-org--table-info))))
      (error
       (emacs-operator-signal "E_COMMAND_FAILED" "Unable to update the requested Org table cell."
                              `(("row" . ,row) ("column" . ,column)
                                ("condition" . ,(error-message-string err))))))))

(defun emacs-operator-org-table-align ()
  (emacs-operator-org--require-table)
  (org-table-align)
  `(("table" . ,(emacs-operator-org--table-info))))

(defun emacs-operator-org-table-recalculate (&optional all)
  "Recalculate the current Org table. ALL non-nil recalculates all lines."
  (emacs-operator-org--require-table)
  (condition-case err
      (progn
        (org-table-recalculate (if all t nil))
        `(("table" . ,(emacs-operator-org--table-info))))
    (error
     (emacs-operator-signal "E_COMMAND_FAILED" "Org table recalculation failed."
                            `(("condition" . ,(error-message-string err)))))))

(defun emacs-operator-org--trusted-babel-info (info evaluation-policy)
  "Return a one-shot INFO copy suitable after trusted_local authorization.
Explicit no/never policies are rejected before this helper. When Org reports
`query', remove only query-style :eval from the copied header arguments so
`org-babel-execute-src-block' cannot open a minibuffer confirmation during a
noninteractive RPC. No user/global Org configuration is modified."
  (let ((copy (copy-tree info)))
    (when (eq evaluation-policy 'query)
      (let* ((headers (nth 2 copy))
             (eval-cell (assq :eval headers)))
        (when (and eval-cell
                   (member (cdr eval-cell) '("query" "query-export")))
          (setf (nth 2 copy) (assq-delete-all :eval headers)))))
    copy))

(defun emacs-operator-org--babel-result-bounds (result-position)
  "Return exact bounds for the current Babel result including its keyword line."
  (when result-position
    (save-excursion
      (goto-char result-position)
      (let ((start (line-beginning-position)))
        (forward-line 1)
        (vector start (org-babel-result-end))))))

(defun emacs-operator-org-eval (params _context)
  "Execute policy-gated Org operations derived only from the current buffer."
  (when (equal (emacs-operator--get params "operation") "execute_babel")
    (unless (org-in-src-block-p t)
      (emacs-operator-signal
       "E_COMMAND_FAILED"
       "execute_babel requires point inside an Org source block."))
    (let* ((info (org-babel-get-src-block-info 'light))
           (language (nth 0 info))
           (timeout (emacs-operator-repl-timeout-seconds params))
           (evaluation-policy (org-babel-check-confirm-evaluate info)))
      (unless (emacs-operator-org--babel-language-enabled-p language)
        (emacs-operator-signal
         "E_POLICY_DENIED"
         "The current Org Babel language is not enabled in this Emacs configuration."
         `(("language" . ,language))))
      (unless evaluation-policy
        (emacs-operator-signal
         "E_POLICY_DENIED"
         "Org Babel evaluation is disabled by the source block or Org policy."
         `(("language" . ,language))))
      (condition-case err
          (with-timeout
              (timeout
               (emacs-operator-repl-timeout-result "Org Babel" language))
            ;; trusted_local is already enforced by adapter.eval. Suppress Org's
            ;; second interactive confirmation because this RPC is intentionally
            ;; noninteractive, but do not enable languages that the user disabled.
            (let* ((org-confirm-babel-evaluate nil)
                   (execution-info
                    (emacs-operator-org--trusted-babel-info
                     info evaluation-policy))
                   (before-tick (buffer-chars-modified-tick))
                   (value (org-babel-execute-src-block nil execution-info))
                   (result-position
                    (org-babel-where-is-src-block-result nil execution-info)))
              (emacs-operator-repl-result
               :stdout ""
               :stderr ""
               :value (cond
                       ((stringp value) value)
                       ((null value) nil)
                       (t (prin1-to-string value)))
               :condition nil
               :backtrace-handle nil
               :namespace-or-package language
               :completed t
               :metadata
               `(("language" . ,language)
                 ("buffer_tick_before" . ,before-tick)
                 ("buffer_tick_after" . ,(buffer-chars-modified-tick))
                 ("org_evaluation_policy" .
                  ,(if (eq evaluation-policy 'query)
                       "trusted_query"
                     "allowed"))
                 ("result_position" . ,result-position)
                 ("result_bounds" .
                  ,(emacs-operator-org--babel-result-bounds
                    result-position))))))
        (error
         (emacs-operator-repl-result
          :stdout ""
          :stderr (error-message-string err)
          :value nil
          :condition (symbol-name (car err))
          :backtrace-handle (format "org-babel:%s" (sxhash-equal err))
          :namespace-or-package language
          :completed nil))))))

(defun emacs-operator-org--block-delimiter-issues ()
  "Return diagnostics for mismatched #+begin_X / #+end_X block delimiters."
  (save-excursion
    (goto-char (point-min))
    (let ((case-fold-search t) stack issues)
      (while (re-search-forward "^[ \t]*#\\+\\(begin\\|end\\)_\\([[:alnum:]_+-]+\\)\\b" nil t)
        (let ((kind (downcase (match-string-no-properties 1)))
              (name (downcase (match-string-no-properties 2)))
              (position (line-beginning-position))
              (line (line-number-at-pos (line-beginning-position) t)))
          (if (equal kind "begin")
              (push (list name position line) stack)
            (if (and stack (equal name (caar stack)))
                (pop stack)
              (push `(("severity" . "error")
                      ("message" . ,(format "Unexpected or mismatched #+end_%s" name))
                      ("position" . ,position)
                      ("line" . ,line))
                    issues)))))
      (dolist (entry stack)
        (push `(("severity" . "error")
                ("message" . ,(format "Unclosed #+begin_%s" (nth 0 entry)))
                ("position" . ,(nth 1 entry))
                ("line" . ,(nth 2 entry)))
              issues))
      (vconcat (nreverse issues)))))

(defun emacs-operator-org-document-summary (&optional max-nodes)
  "Return a bounded whole-document Org AST summary without source bodies.
MAX-NODES bounds each returned node collection so large Org knowledge bases do
not explode the RPC response. Counts always describe the full parsed document."
  (let* ((limit (min 2000 (max 1 (or max-nodes 500))))
         (tree (org-element-parse-buffer))
         (heading-count 0) (table-count 0) (src-count 0)
         headings tables src-blocks)
    (org-element-map tree 'headline
      (lambda (element)
        (setq heading-count (1+ heading-count))
        (when (< (length headings) limit)
          (push `(("begin" . ,(org-element-property :begin element))
                  ("end" . ,(org-element-property :end element))
                  ("level" . ,(org-element-property :level element))
                  ("title" . ,(org-element-property :raw-value element))
                  ("todo" . ,(org-element-property :todo-keyword element))
                  ("tags" . ,(or (org-element-property :tags element) '())))
                headings))))
    (org-element-map tree 'table
      (lambda (element)
        (setq table-count (1+ table-count))
        (when (< (length tables) limit)
          (push `(("begin" . ,(org-element-property :begin element))
                  ("end" . ,(org-element-property :end element))
                  ("name" . ,(org-element-property :name element))
                  ("type" . ,(org-element-property :type element)))
                tables))))
    (org-element-map tree 'src-block
      (lambda (element)
        (setq src-count (1+ src-count))
        (when (< (length src-blocks) limit)
          (let ((body (or (org-element-property :value element) "")))
            (push `(("begin" . ,(org-element-property :begin element))
                    ("end" . ,(org-element-property :end element))
                    ("name" . ,(org-element-property :name element))
                    ("language" . ,(org-element-property :language element))
                    ("parameters" . ,(org-element-property :parameters element))
                    ("body_bytes" . ,(string-bytes body)))
                  src-blocks)))))
    `(("max_nodes_per_kind" . ,limit)
      ("counts" . (("headings" . ,heading-count)
                    ("tables" . ,table-count)
                    ("src_blocks" . ,src-count)))
      ("truncated" . ,(if (or (> heading-count limit) (> table-count limit) (> src-count limit)) t :json-false))
      ("headings" . ,(vconcat (nreverse headings)))
      ("tables" . ,(vconcat (nreverse tables)))
      ("src_blocks" . ,(vconcat (nreverse src-blocks))))))

(defun emacs-operator-org-validate (options _context)
  "Return non-throwing structural diagnostics for the current Org buffer."
  (let ((parse-error nil)
        (issues (emacs-operator-org--block-delimiter-issues)))
    (condition-case err
        (org-element-parse-buffer 'greater-element)
      (error
       (setq parse-error
             `(("severity" . "error")
               ("message" . ,(error-message-string err))
               ("position" . ,(point))
               ("line" . ,(line-number-at-pos (point) t))))))
    (when parse-error
      (setq issues (vconcat issues (vector parse-error))))
    `(("valid" . ,(if (= (length issues) 0) t :json-false))
      ("parse_valid" . ,(if parse-error :json-false t))
      ("diagnostics" . ,issues)
      ("heading" . ,(emacs-operator-org--heading-info))
      ("table" . ,(emacs-operator-org--table-info))
      ("babel" . ,(emacs-operator-org--babel-info))
      ("document_summary" . ,(emacs-operator-org-document-summary
                                (let ((value (emacs-operator--get options "max_nodes")))
                                  (and (integerp value) value))))
      ("buffer_tick" . ,(buffer-chars-modified-tick)))))

(defun emacs-operator-org-verify (action _before _after _context)
  (let ((valid (emacs-operator-org--parse-valid-p))
        (command (or (emacs-operator--get action "command")
                     (emacs-operator--get action "last_command"))))
    (unless valid
      (emacs-operator-signal "E_COMMAND_FAILED" "Org operation left the buffer in an unparsable state."
                             `(("command" . ,command))))
    `(("parse_valid" . t)
      ("heading" . ,(emacs-operator-org--heading-info))
      ("table" . ,(emacs-operator-org--table-info))
      ("babel" . ,(emacs-operator-org--babel-info)))))

(dolist (function '(emacs-operator-org-insert-heading
                    emacs-operator-org-create-heading
                    emacs-operator-org-insert-table emacs-operator-org-insert-src-block
                    emacs-operator-org-promote emacs-operator-org-demote
                    emacs-operator-org-move-subtree-up emacs-operator-org-move-subtree-down
                    emacs-operator-org-set-todo emacs-operator-org-set-title
                    emacs-operator-org-set-tags emacs-operator-org-rewrite-section-body
                    emacs-operator-org-set-property
                    emacs-operator-org-create-id
                    emacs-operator-org-table-set-cell emacs-operator-org-table-align
                    emacs-operator-org-table-recalculate))
  (when (fboundp 'emacs-operator-register-safe-noninteractive-function)
    (emacs-operator-register-safe-noninteractive-function function)))

(emacs-operator-register-adapter
 "org"
 (lambda (_context) (emacs-operator-org-mode-p))
 #'emacs-operator-org-capabilities
 :priority 50
 :observe #'emacs-operator-org-observe
 :verify #'emacs-operator-org-verify
 :eval #'emacs-operator-org-eval
 :validate #'emacs-operator-org-validate
 :metadata '(("kind" . "mode") ("tree_structured" . t) ("table_structured" . t) ("babel_structured" . t)))

(provide 'emacs-operator-adapter-org)
;;; emacs-operator-adapter-org.el ends here
