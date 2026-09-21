;;; emacs-operator-adapter-lisp.el --- Lisp structural adapter -*- lexical-binding: t; -*-

(require 'cl-lib)
(require 'subr-x)
(require 'thingatpt)
(require 'emacs-operator-adapter-generic)
(require 'emacs-operator-keys)
(require 'emacs-operator-adapter-repl)

(require 'emacs-operator-refactor-intelligence)

(defconst emacs-operator-lisp--structural-commands
  '(paredit-forward-slurp-sexp paredit-forward-barf-sexp paredit-splice-sexp
    paredit-wrap-round paredit-raise-sexp paredit-split-sexp paredit-join-sexps
    sp-forward-slurp-sexp sp-forward-barf-sexp sp-splice-sexp sp-wrap-round
    sp-raise-sexp sp-split-sexp sp-join-sexp)
  "Commands whose postcondition must preserve balanced Lisp structure.")

(defconst emacs-operator-lisp--operation-specs
  '(("forward_sexp" nil nil forward-sexp)
    ("backward_sexp" nil nil backward-sexp)
    ("slurp_forward" paredit-forward-slurp-sexp sp-forward-slurp-sexp nil)
    ("barf_forward" paredit-forward-barf-sexp sp-forward-barf-sexp nil)
    ("splice" paredit-splice-sexp sp-splice-sexp nil)
    ("wrap_round" paredit-wrap-round sp-wrap-round nil)
    ("raise" paredit-raise-sexp sp-raise-sexp nil)
    ("split" paredit-split-sexp sp-split-sexp nil)
    ("join" paredit-join-sexps sp-join-sexp nil)
    ("indent_defun" nil nil indent-sexp))
  "Semantic structural operations and their preferred implementations.")

(defconst emacs-operator-lisp--mutating-operations
  '("slurp_forward" "barf_forward" "splice" "wrap_round" "raise" "split" "join" "indent_defun"))

(defconst emacs-operator-lisp--max-eval-bytes 262144
  "Maximum buffer-derived source size allowed for one structured evaluation.")

(defun emacs-operator-lisp-mode-p ()
  (or (derived-mode-p 'emacs-lisp-mode 'lisp-mode 'lisp-interaction-mode 'scheme-mode)
      (derived-mode-p 'clojure-mode 'clojurescript-mode 'clojurec-mode)))

(defun emacs-operator-lisp--bounds-vector (bounds)
  (and bounds (vector (car bounds) (cdr bounds))))

(defun emacs-operator-lisp--defun-bounds ()
  (save-excursion
    (condition-case nil
        (let (start end)
          (beginning-of-defun)
          (setq start (point))
          (end-of-defun)
          (setq end (point))
          (and (< start end) (vector start end)))
      (error nil))))

(defun emacs-operator-lisp--defun-name ()
  (save-excursion
    (condition-case nil
        (progn
          (beginning-of-defun)
          (when (looking-at "[[:space:]\n]*(\\(?:cl-\\)?def\\(?:un\\|macro\\|subst\\|generic\\|method\\|var\\|parameter\\|constant\\|class\\|struct\\)[[:space:]\n]+\\([^[:space:]()]+\\)")
            (match-string-no-properties 1)))
      (error nil))))

(defun emacs-operator-lisp--namespace-or-package ()
  (cond
   ((and (derived-mode-p 'clojure-mode 'clojurescript-mode 'clojurec-mode)
         (fboundp 'cider-current-ns))
    (condition-case nil (cider-current-ns) (error nil)))
   ((derived-mode-p 'clojure-mode 'clojurescript-mode 'clojurec-mode)
    (save-excursion
      (goto-char (point-min))
      (when (re-search-forward "^[[:space:]]*(ns[[:space:]\n]+\\([^[:space:]()]+\\)" nil t)
        (match-string-no-properties 1))))
   ((derived-mode-p 'lisp-mode)
    (save-excursion
      (goto-char (point-min))
      (when (re-search-forward "^[[:space:]]*(in-package[[:space:]\n]+[':]?\\([^[:space:]()]+\\)" nil t)
        (match-string-no-properties 1))))))

(defun emacs-operator-lisp--balanced-p ()
  (condition-case nil
      (save-restriction
        (widen)
        (save-excursion
          (goto-char (point-min))
          (check-parens)
          t))
    (error nil)))

(defun emacs-operator-lisp-structural-snapshot ()
  (let* ((ppss (syntax-ppss))
         (sexp (bounds-of-thing-at-point 'sexp)))
    `(("point" . ,(point))
      ("parse_depth" . ,(car ppss))
      ("in_string" . ,(if (nth 3 ppss) t :json-false))
      ("in_comment" . ,(if (nth 4 ppss) t :json-false))
      ("sexp_bounds" . ,(emacs-operator-lisp--bounds-vector sexp))
      ("defun_bounds" . ,(emacs-operator-lisp--defun-bounds))
      ("balanced" . ,(if (emacs-operator-lisp--balanced-p) t :json-false)))))

(defun emacs-operator-lisp-observe (_context)
  (let ((snapshot (emacs-operator-lisp-structural-snapshot)))
    (append snapshot
            `(("defun_name" . ,(emacs-operator-lisp--defun-name))
              ("namespace_or_package" . ,(emacs-operator-lisp--namespace-or-package))
              ("region" . ,(when (use-region-p)
                              (vector (region-beginning) (region-end))))
              ("paredit" .
               (("loaded" . ,(if (featurep 'paredit) t :json-false))
                ("enabled" . ,(if (and (boundp 'paredit-mode) paredit-mode) t :json-false))))
              ("smartparens" .
               (("loaded" . ,(if (featurep 'smartparens) t :json-false))
                ("enabled" . ,(if (and (boundp 'smartparens-mode) smartparens-mode) t :json-false))))))))

(defun emacs-operator-lisp--resolve-operation-command (operation)
  "Resolve OPERATION to (:command SYMBOL :provider STRING), or nil."
  (let* ((spec (assoc operation emacs-operator-lisp--operation-specs))
         (paredit (nth 1 spec))
         (smartparens (nth 2 spec))
         (fallback (nth 3 spec))
         (paredit-enabled (and (boundp 'paredit-mode) paredit-mode))
         (smartparens-enabled (and (boundp 'smartparens-mode) smartparens-mode)))
    (when spec
      (cond
       ((and paredit paredit-enabled (fboundp paredit))
        (list :command paredit :provider "paredit"))
       ((and smartparens smartparens-enabled (fboundp smartparens))
        (list :command smartparens :provider "smartparens"))
       ((and paredit (fboundp paredit))
        (list :command paredit :provider "paredit"))
       ((and smartparens (fboundp smartparens))
        (list :command smartparens :provider "smartparens"))
       ((and fallback (fboundp fallback))
        (list :command fallback :provider "builtin"))))))

(defun emacs-operator-lisp--command-capability (operation)
  (let* ((resolved (emacs-operator-lisp--resolve-operation-command operation))
         (command (plist-get resolved :command)))
    `(("name" . ,operation)
      ("available" . ,(if command t :json-false))
      ("command" . "emacs-operator-lisp-structural-edit")
      ("arguments" . (,operation))
      ("resolved_command" . ,(and command (symbol-name command)))
      ("provider" . ,(plist-get resolved :provider))
      ("channel" . "semantic")
      ("mutation" . ,(if (member operation emacs-operator-lisp--mutating-operations) t :json-false)))))

(defun emacs-operator-lisp-capabilities (_context)
  `(("operations" .
     ,(mapcar #'emacs-operator-lisp--command-capability
              (mapcar #'car emacs-operator-lisp--operation-specs)))
    ("evaluation" .
     (("eval_last_sexp" . ,(if (or (derived-mode-p 'emacs-lisp-mode 'lisp-interaction-mode)
                                    (fboundp 'cider-nrepl-sync-request:eval)
                                    (fboundp 'sly-eval)) t :json-false))
      ("eval_defun" . ,(if (or (derived-mode-p 'emacs-lisp-mode 'lisp-interaction-mode)
                                (fboundp 'cider-nrepl-sync-request:eval)
                                (fboundp 'sly-eval)) t :json-false))
      ("eval_region" . ,(if (and (use-region-p)
                                  (or (derived-mode-p 'emacs-lisp-mode 'lisp-interaction-mode)
                                      (fboundp 'cider-nrepl-sync-request:eval)
                                      (fboundp 'sly-eval))) t :json-false))))
    ("semantic_structural_command" . "emacs-operator-lisp-structural-edit")
    ("refactoring" .
     (("rename_symbol" . "emacs-operator-lisp-rename-symbol")
      ("extract_function" . "emacs-operator-lisp-extract-function")
      ("move_top_level_form" . "emacs-operator-lisp-move-top-level-form")))
    ("warnings" .
     ,(delq nil
            (list (and (not (featurep 'paredit))
                       (not (featurep 'smartparens))
                       "No structural editing package is loaded; navigation/indent remain available, but slurp/barf/splice/wrap may be unavailable."))))))

(defun emacs-operator-lisp-verify (action before after _context)
  (let* ((command-name (or (emacs-operator--get action "command")
                           (emacs-operator--get action "last_command")))
         (command (and command-name (intern-soft command-name)))
         (balanced (emacs-operator-lisp--balanced-p)))
    (when (and command
               (or (memq command emacs-operator-lisp--structural-commands)
                   (eq command 'emacs-operator-lisp-structural-edit))
               (not balanced))
      (emacs-operator-signal "E_COMMAND_FAILED"
                             "Structural Lisp command left the buffer with unbalanced delimiters."
                             `(("command" . ,command-name))))
    `(("balanced" . ,(if balanced t :json-false))
      ("parse_depth_before" . ,(emacs-operator--get before "parse_depth"))
      ("parse_depth_after" . ,(or (emacs-operator--get after "parse_depth")
                                  (car (syntax-ppss)))))))

(defun emacs-operator-lisp--diagnostic-context (position)
  (let* ((radius 120)
         (start (max (point-min) (- position radius)))
         (end (min (point-max) (+ position radius))))
    `(("start" . ,start)
      ("end" . ,end)
      ("text" . ,(buffer-substring-no-properties start end)))))

(defun emacs-operator-lisp-validate (_options _context)
  "Return non-throwing structural and reader diagnostics for the current Lisp buffer."
  (save-restriction
    (widen)
    (save-excursion
      (goto-char (point-min))
      (let ((diagnostics nil)
            (balanced t)
            (reader-checked (derived-mode-p 'emacs-lisp-mode 'lisp-interaction-mode))
            (forms-read 0))
        (condition-case err
            (check-parens)
          (error
           (setq balanced nil)
           (let* ((position (point))
                  (line (line-number-at-pos position t))
                  (column (save-excursion (goto-char position) (current-column))))
             (push `(("severity" . "error")
                     ("kind" . "delimiter")
                     ("condition" . ,(symbol-name (car err)))
                     ("message" . ,(error-message-string err))
                     ("position" . ,position)
                     ("line" . ,line)
                     ("column" . ,column)
                     ("context" . ,(emacs-operator-lisp--diagnostic-context position)))
                   diagnostics))))
        (when (and balanced reader-checked)
          (goto-char (point-min))
          (condition-case err
              (while (< (point) (point-max))
                (skip-chars-forward " \t\r\n")
                (when (< (point) (point-max))
                  (read (current-buffer))
                  (setq forms-read (1+ forms-read))))
            ;; A trailing comment can make the reader reach EOF while skipping
            ;; input, which is not a structural error. Delimiter errors have
            ;; already been caught by check-parens above.
            (end-of-file nil)
            (error
             (let* ((position (point))
                    (line (line-number-at-pos position t))
                    (column (save-excursion (goto-char position) (current-column))))
               (push `(("severity" . "error")
                       ("kind" . "reader")
                       ("condition" . ,(symbol-name (car err)))
                       ("message" . ,(error-message-string err))
                       ("position" . ,position)
                       ("line" . ,line)
                       ("column" . ,column)
                       ("context" . ,(emacs-operator-lisp--diagnostic-context position)))
                     diagnostics)))))
        `(("valid" . ,(if (null diagnostics) t :json-false))
          ("balanced" . ,(if balanced t :json-false))
          ("reader_checked" . ,(if reader-checked t :json-false))
          ("forms_read" . ,forms-read)
          ("condition" . ,(and diagnostics (emacs-operator--get (car diagnostics) "condition")))
          ("diagnostics" . ,(vconcat (nreverse diagnostics)))
          ("buffer_tick" . ,(buffer-chars-modified-tick)))))))

(defun emacs-operator-lisp-check-structure ()
  "Return a structured validation result for the current Lisp buffer.
Signal when invalid for compatibility with existing command workflows."
  (let ((validation (emacs-operator-lisp-validate nil nil)))
    (unless (emacs-operator--truthy-json-p (emacs-operator--get validation "valid"))
      (emacs-operator-signal "E_COMMAND_FAILED" "Lisp delimiters are not balanced."
                             `(("validation" . ,validation))))
    validation))

(defun emacs-operator-lisp--run-resolved-operation (operation command count)
  (cond
   ((equal operation "forward_sexp") (funcall command count))
   ((equal operation "backward_sexp") (funcall command count))
   ((equal operation "indent_defun") (funcall command))
   (t
    (dotimes (_ count)
      (let ((this-command command)
            (real-this-command command))
        (call-interactively command))))))

(defun emacs-operator-lisp-structural-edit (operation &optional count)
  "Execute semantic Lisp structural OPERATION using the best active provider.
COUNT defaults to 1 and is bounded. Mutating operations are atomic and must
preserve balanced delimiters. The return value describes the actual provider."
  (unless (emacs-operator-lisp-mode-p)
    (emacs-operator-signal "E_COMMAND_FAILED" "Target buffer is not a supported Lisp mode."))
  (unless (stringp operation)
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Lisp structural operation must be a string."))
  (let* ((count (or count 1))
         (resolved (emacs-operator-lisp--resolve-operation-command operation))
         (command (plist-get resolved :command))
         (provider (plist-get resolved :provider))
         (mutating (member operation emacs-operator-lisp--mutating-operations)))
    (unless (and (integerp count) (> count 0) (<= count 100))
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Structural operation count must be an integer from 1 to 100."))
    (unless command
      (emacs-operator-signal "E_COMMAND_NOT_FOUND"
                             "No active structural editor or built-in command can implement this operation."
                             `(("operation" . ,operation))))
    (let ((before (emacs-operator-lisp-structural-snapshot))
          (emacs-operator--command-source 'rpc))
      (when (and mutating (not (emacs-operator-lisp--balanced-p)))
        (emacs-operator-signal "E_COMMAND_FAILED"
                               "Refusing structural mutation because the Lisp buffer is already unbalanced."
                               `(("operation" . ,operation))))
      (if mutating
          (atomic-change-group
            (emacs-operator-lisp--run-resolved-operation operation command count)
            (unless (emacs-operator-lisp--balanced-p)
              (emacs-operator-signal "E_COMMAND_FAILED"
                                     "Structural edit broke Lisp delimiter balance; the atomic edit was rolled back."
                                     `(("operation" . ,operation)
                                       ("provider" . ,provider))))
            `(("operation" . ,operation)
              ("provider" . ,provider)
              ("resolved_command" . ,(symbol-name command))
              ("count" . ,count)
              ("before" . ,before)
              ("after" . ,(emacs-operator-lisp-structural-snapshot))))
        (progn
          (emacs-operator-lisp--run-resolved-operation operation command count)
          `(("operation" . ,operation)
            ("provider" . ,provider)
            ("resolved_command" . ,(symbol-name command))
            ("count" . ,count)
            ("before" . ,before)
            ("after" . ,(emacs-operator-lisp-structural-snapshot))))))))

(defun emacs-operator-lisp--safe-symbol-token (value label)
  "Validate VALUE as a bounded Lisp symbol token and return it."
  (unless (and (stringp value)
               (> (length value) 0)
               (<= (string-bytes value) 512)
               (not (string-match-p "[[:space:]()\\[\\]{}\\\";'`,]" value)))
    (emacs-operator-signal
     "E_INVALID_ARGUMENT"
     (format "%s must be a non-empty Lisp symbol token without whitespace or reader delimiters." label)))
  value)

(defun emacs-operator-lisp--safe-generated-symbol-token (value label)
  "Validate VALUE for insertion as a generated definition/local-binding symbol.
This is intentionally stricter than rename_symbol because generated parameters
must not be able to introduce reader macros, package markers, lambda-list markers,
or Clojure namespace qualification."
  (setq value (emacs-operator-lisp--safe-symbol-token value label))
  (when (or (string-match-p "\\`[#@:&]" value)
            (member value '("." "&")))
    (emacs-operator-signal
     "E_INVALID_ARGUMENT"
     (format "%s contains syntax reserved for reader/package/binding semantics." label)))
  (when (and (derived-mode-p 'clojure-mode 'clojurescript-mode 'clojurec-mode)
             (string-match-p "/" value))
    (emacs-operator-signal
     "E_INVALID_ARGUMENT"
     (format "%s must be an unqualified Clojure symbol." label)))
  value)

(defun emacs-operator-lisp--symbol-boundary-char-p (char)
  "Return non-nil when CHAR can participate in a supported Lisp symbol token."
  (and char
       (or (memq (char-syntax char) '(?w ?_))
           (memq char '(?+ ?- ?* ?/ ?< ?> ?= ?! ?? ?$ ?% ?& ?~ ?^ ?. ?: ?@ ?#)))))

(defun emacs-operator-lisp--scope-bounds (scope)
  "Resolve refactoring SCOPE to a vector [START END]."
  (cond
   ((or (null scope) (equal scope "current_defun"))
    (or (emacs-operator-lisp--defun-bounds)
        (emacs-operator-signal "E_COMMAND_FAILED" "No enclosing defun could be resolved for the requested refactoring scope.")))
   ((equal scope "buffer") (vector (point-min) (point-max)))
   (t (emacs-operator-signal "E_INVALID_ARGUMENT" "Lisp refactoring scope must be current_defun or buffer."))))

(defun emacs-operator-lisp-rename-symbol (old-symbol new-symbol &optional scope max-replacements)
  "Rename OLD-SYMBOL to NEW-SYMBOL in SCOPE, skipping comments and strings.
SCOPE is `current_defun' by default or `buffer'. The operation is lexical-textual,
not project-wide: only exact syntax-table symbol occurrences are replaced."
  (unless (emacs-operator-lisp-mode-p)
    (emacs-operator-signal "E_COMMAND_FAILED" "Target buffer is not a supported Lisp mode."))
  (setq old-symbol (emacs-operator-lisp--safe-symbol-token old-symbol "Old symbol")
        new-symbol (emacs-operator-lisp--safe-symbol-token new-symbol "New symbol"))
  (when (equal old-symbol new-symbol)
    (emacs-operator-signal "E_INVALID_ARGUMENT" "Old and new Lisp symbols are identical."))
  (let* ((scope (or scope "current_defun"))
         (bounds (emacs-operator-lisp--scope-bounds scope))
         (start (aref bounds 0))
         (end-marker (copy-marker (aref bounds 1) t))
         (limit (or max-replacements 10000))
         (case-fold-search nil)
         (count 0))
    (unless (and (integerp limit) (> limit 0) (<= limit 10000))
      (emacs-operator-signal "E_INVALID_ARGUMENT" "max_replacements must be an integer from 1 to 10000."))
    (unless (emacs-operator-lisp--balanced-p)
      (emacs-operator-signal "E_COMMAND_FAILED" "Refusing Lisp rename because the buffer is already unbalanced."))
    (unwind-protect
        (atomic-change-group
          (save-excursion
            (goto-char start)
            (while (search-forward old-symbol end-marker t)
              (let* ((match-start (match-beginning 0))
                     (match-end (match-end 0))
                     (ppss (save-match-data
                             (save-excursion (syntax-ppss match-start))))
                     (left (char-before match-start))
                     (right (char-after match-end)))
                (when (and (not (nth 3 ppss))
                           (not (nth 4 ppss))
                           (not (emacs-operator-lisp--symbol-boundary-char-p left))
                           (not (emacs-operator-lisp--symbol-boundary-char-p right)))
                  (setq count (1+ count))
                  (when (> count limit)
                    (emacs-operator-signal "E_INVALID_ARGUMENT" "Lisp rename exceeded max_replacements; the atomic change was rolled back."
                                           `(("max_replacements" . ,limit))))
                  (replace-match new-symbol t t)))))
          (unless (emacs-operator-lisp--balanced-p)
            (emacs-operator-signal "E_COMMAND_FAILED" "Lisp rename broke delimiter balance; the atomic change was rolled back."))
          `(("old_symbol" . ,old-symbol)
            ("new_symbol" . ,new-symbol)
            ("scope" . ,scope)
            ("replacements" . ,count)
            ("scope_bounds" . ,(vector start (marker-position end-marker)))
            ("balanced" . t)))
      (set-marker end-marker nil))))

(defun emacs-operator-lisp--complete-form-range-p (start end)
  "Return non-nil when START..END contains only complete Lisp sexps/comments/space."
  (save-restriction
    (narrow-to-region start end)
    (save-excursion
      (goto-char (point-min))
      (condition-case nil
          (progn
            (while (< (point) (point-max))
              (forward-comment (max 1 (buffer-size)))
              (skip-chars-forward " \t\r\n")
              (when (< (point) (point-max))
                (let ((next (scan-sexps (point) 1)))
                  (unless (and next (<= next (point-max))) (signal 'scan-error nil))
                  (goto-char next))))
            (= (point) (point-max)))
        (error nil)))))

(defun emacs-operator-lisp--function-definition-regexp (name)
  "Return a conservative source regexp for a function definition named NAME."
  (let ((quoted (regexp-quote name)))
    (cond
     ((derived-mode-p 'clojure-mode 'clojurescript-mode 'clojurec-mode)
      (concat "(\\s-*defn-?\\s-+" quoted "\\(?:\\s-\\|[\\[({]\\)"))
     ((derived-mode-p 'emacs-lisp-mode 'lisp-interaction-mode)
      (concat "(\\s-*\\(?:defun\\|cl-defun\\)\\s-+" quoted "\\(?:\\s-\\|[({]\\)"))
     ((derived-mode-p 'lisp-mode)
      (concat "(\\s-*defun\\s-+" quoted "\\(?:\\s-\\|[({]\\)"))
     (t nil))))

(defun emacs-operator-lisp--function-name-collision-p (name)
  "Return non-nil when NAME is already defined in source or the local Elisp runtime.
This is deliberately conservative: extract_function creates a new definition, so
reusing a visible function name is treated as a state conflict rather than silently
overwriting it."
  (or
   (and (derived-mode-p 'emacs-lisp-mode 'lisp-interaction-mode)
        (let ((symbol (intern-soft name)))
          (and symbol (fboundp symbol))))
   (let ((regexp (emacs-operator-lisp--function-definition-regexp name)))
     (and regexp
          (save-restriction
            (widen)
            (save-excursion
              (goto-char (point-min))
              (catch 'found
                (while (re-search-forward regexp nil t)
                  (let ((ppss (save-match-data
                                (save-excursion (syntax-ppss (match-beginning 0))))))
                    (unless (or (nth 3 ppss) (nth 4 ppss))
                      (throw 'found t))))
                nil)))))))

(defun emacs-operator-lisp--definition-and-call (name parameters body)
  "Return (DEFINITION CALL) for current Lisp dialect using buffer-derived BODY."
  (let ((params (mapcar (lambda (item) (emacs-operator-lisp--safe-generated-symbol-token item "Function parameter")) parameters)))
    (cond
     ((derived-mode-p 'clojure-mode 'clojurescript-mode 'clojurec-mode)
      (list (format "(defn %s [%s]\n%s)\n\n" name (mapconcat #'identity params " ") body)
            (format "(%s%s)" name (if params (concat " " (mapconcat #'identity params " ")) ""))))
     ((derived-mode-p 'emacs-lisp-mode 'lisp-interaction-mode 'lisp-mode)
      (list (format "(defun %s (%s)\n%s)\n\n" name (mapconcat #'identity params " ") body)
            (format "(%s%s)" name (if params (concat " " (mapconcat #'identity params " ")) ""))))
     (t
      (emacs-operator-signal "E_COMMAND_FAILED" "extract_function currently supports Emacs Lisp, Common Lisp, and Clojure buffers.")))))

(defun emacs-operator-lisp-extract-function (start end name parameters)
  "Extract complete forms in START..END into a new function before the current defun.
The extracted BODY comes only from the target buffer. PARAMETERS must be an
array/list of simple symbol tokens and are also used as the generated call arguments."
  (unless (emacs-operator-lisp-mode-p)
    (emacs-operator-signal "E_COMMAND_FAILED" "Target buffer is not a supported Lisp mode."))
  (unless (and (integerp start) (integerp end) (<= (point-min) start) (< start end) (<= end (point-max)))
    (emacs-operator-signal "E_INVALID_ARGUMENT" "extract_function requires valid start/end buffer positions."))
  (setq name (emacs-operator-lisp--safe-generated-symbol-token name "New function name"))
  (when (emacs-operator-lisp--function-name-collision-p name)
    (emacs-operator-signal
     "E_STATE_CONFLICT"
     "extract_function refuses to overwrite an existing function definition."
     `(("name" . ,name))))
  (unless (or (vectorp parameters) (listp parameters))
    (emacs-operator-signal "E_INVALID_ARGUMENT" "extract_function parameters must be an array/list of symbol names."))
  (let* ((params (append parameters nil))
         (_ (when (/= (length params) (length (delete-dups (copy-sequence params))))
              (emacs-operator-signal "E_INVALID_ARGUMENT" "extract_function parameters must be unique symbol names.")))
         (defun-bounds (or (emacs-operator-lisp--defun-bounds)
                           (emacs-operator-signal "E_COMMAND_FAILED" "No enclosing defun could be resolved for extraction.")))
         (defun-start (aref defun-bounds 0))
         (defun-end (aref defun-bounds 1)))
    (unless (and (<= defun-start start) (<= end defun-end))
      (emacs-operator-signal "E_INVALID_ARGUMENT" "The extraction range must be entirely inside the current defun."))
    (unless (emacs-operator-lisp--complete-form-range-p start end)
      (emacs-operator-signal "E_INVALID_ARGUMENT" "The extraction range must contain only complete Lisp forms."))
    (let* ((body (buffer-substring-no-properties start end))
           (_ (when (> (string-bytes body) emacs-operator-lisp--max-eval-bytes)
                (emacs-operator-signal "E_INVALID_ARGUMENT" "Extracted function body exceeds the 256 KiB safety bound.")))
           (parts (emacs-operator-lisp--definition-and-call name params body))
           (definition (car parts))
           (call (cadr parts))
           (defun-marker (copy-marker defun-start nil))
           (range-start (copy-marker start nil))
           (range-end (copy-marker end t))
           definition-start
           definition-end-marker
           original-definition-bounds)
      (unless (emacs-operator-lisp--balanced-p)
        (emacs-operator-signal "E_COMMAND_FAILED" "Refusing extraction because the Lisp buffer is already unbalanced."))
      (unwind-protect
          (atomic-change-group
            (save-excursion
              (goto-char range-start)
              (delete-region range-start range-end)
              (insert call)
              (goto-char defun-marker)
              (setq definition-start (point))
              (insert definition)
              (setq definition-end-marker (copy-marker (point) t))
              (indent-region definition-start (marker-position definition-end-marker))
              (indent-region (marker-position range-start) (marker-position range-end))
              ;; RANGE-START now points at the generated call inside the original
              ;; definition. Re-resolve that enclosing definition after both the
              ;; insertion before it and the replacement within it have shifted
              ;; buffer positions.
              (goto-char range-start)
              (setq original-definition-bounds (emacs-operator-lisp--defun-bounds)))
            (unless (emacs-operator-lisp--balanced-p)
              (emacs-operator-signal "E_COMMAND_FAILED" "Function extraction produced invalid Lisp structure; the atomic change was rolled back."))
            `(("name" . ,name)
              ("parameters" . ,(vconcat params))
              ("source_bounds_before" . ,(vector start end))
              ("new_definition_bounds" . ,(vector definition-start (marker-position definition-end-marker)))
              ("enclosing_definition_bounds" . ,original-definition-bounds)
              ("call_bounds" . ,(vector (marker-position range-start) (marker-position range-end)))
              ("call" . ,call)
              ("balanced" . t)))
        (set-marker defun-marker nil)
        (set-marker range-start nil)
        (set-marker range-end nil)
        (when definition-end-marker (set-marker definition-end-marker nil))))))

(defun emacs-operator-lisp--top-level-form-bounds ()
  "Return vectors for top-level Lisp forms in the accessible buffer."
  (save-excursion
    (goto-char (point-min))
    (let (forms)
      (condition-case err
          (progn
            (while (< (point) (point-max))
              (forward-comment (max 1 (buffer-size)))
              (skip-chars-forward " \t\r\n")
              (when (< (point) (point-max))
                (let* ((start (point))
                       (end (scan-sexps start 1)))
                  (unless end (signal 'scan-error nil))
                  (push (vector start end) forms)
                  (goto-char end))))
            (vconcat (nreverse forms)))
        (error
         (emacs-operator-signal "E_COMMAND_FAILED" "Unable to resolve top-level Lisp forms."
                                `(("condition" . ,(error-message-string err)))))))))

(defun emacs-operator-lisp-move-top-level-form (direction &optional count)
  "Move the current top-level Lisp form up/backward or down/forward COUNT times."
  (unless (member direction '("up" "down" "backward" "forward"))
    (emacs-operator-signal "E_INVALID_ARGUMENT" "direction must be up, down, backward, or forward."))
  (let ((count (or count 1)))
    (unless (and (integerp count) (> count 0) (<= count 100))
      (emacs-operator-signal "E_INVALID_ARGUMENT" "move form count must be an integer from 1 to 100."))
    (unless (emacs-operator-lisp--balanced-p)
      (emacs-operator-signal "E_COMMAND_FAILED" "Refusing to move Lisp forms because the buffer is already unbalanced."))
    (let ((forward (member direction '("down" "forward")))
          result)
      (dotimes (_ count)
        (let* ((forms (append (emacs-operator-lisp--top-level-form-bounds) nil))
               (anchor (or (and (emacs-operator-lisp--defun-bounds)
                                (aref (emacs-operator-lisp--defun-bounds) 0))
                           (point)))
               (index (cl-position-if (lambda (bounds)
                                        (and (<= (aref bounds 0) anchor) (< anchor (aref bounds 1))))
                                      forms)))
          (unless index
            (emacs-operator-signal "E_COMMAND_FAILED" "Point is not inside a movable top-level Lisp form."))
          (let ((neighbor-index (if forward (1+ index) (1- index))))
            (unless (and (>= neighbor-index 0) (< neighbor-index (length forms)))
              (emacs-operator-signal "E_TARGET_NOT_FOUND" "There is no adjacent top-level form in the requested direction."))
            (let* ((first-index (min index neighbor-index))
                   (second-index (max index neighbor-index))
                   (first (nth first-index forms))
                   (second (nth second-index forms))
                   (a (aref first 0)) (b (aref first 1))
                   (c (aref second 0)) (d (aref second 1))
                   (first-text (buffer-substring-no-properties a b))
                   (separator (buffer-substring-no-properties b c))
                   (second-text (buffer-substring-no-properties c d))
                   (current-text (if (= index first-index) first-text second-text))
                   (new-start (if forward
                                  (+ a (length second-text) (length separator))
                                a)))
              (atomic-change-group
                (delete-region a d)
                (goto-char a)
                (insert second-text separator first-text)
                (goto-char new-start)
                (unless (emacs-operator-lisp--balanced-p)
                  (emacs-operator-signal "E_COMMAND_FAILED" "Moving the Lisp form broke delimiter balance; the atomic change was rolled back.")))
              (setq result `(("direction" . ,direction)
                             ("from_index" . ,index)
                             ("to_index" . ,neighbor-index)
                             ("moved_bytes" . ,(string-bytes current-text))
                             ("point" . ,(point))
                             ("balanced" . t)))))))
      result)))

(defun emacs-operator-lisp--bounded-backtrace ()
  "Return a bounded diagnostic backtrace for the current error context."
  (let ((trace (condition-case nil
                   (if (fboundp 'backtrace-to-string)
                       (backtrace-to-string)
                     "")
                 (error ""))))
    (if (> (length trace) 12000) (substring trace 0 12000) trace)))

(defun emacs-operator-lisp--source-metadata (operation bounds)
  "Return bounded metadata for buffer-derived source BOUNDS."
  (let* ((start (and bounds (aref bounds 0)))
         (end (and bounds (aref bounds 1)))
         (source (and start end (buffer-substring-no-properties start end))))
    `(("operation" . ,operation)
      ("source_bounds" . ,bounds)
      ("source_start" . ,start)
      ("source_bytes" . ,(and source (string-bytes source)))
      ("source_sha256" . ,(and source (secure-hash 'sha256 source)))
      ("point" . ,(point))
      ("line" . ,(line-number-at-pos (point) t))
      ("column" . ,(current-column)))))

(defun emacs-operator-lisp--capture-message-result (operation bounds thunk)
  "Run THUNK and return the normalized REPL result contract.
Errors are data, not transport failures, so an agent can inspect CONDITION,
repair the target buffer, and retry inside the same session/checkpoint."
  (let ((messages-before (with-current-buffer (get-buffer-create "*Messages*") (point-max)))
        (metadata (emacs-operator-lisp--source-metadata operation bounds)))
    (condition-case err
        (let ((value (funcall thunk)))
          (emacs-operator-repl-result
           :stdout ""
           :stderr ""
           :value (cond ((stringp value) value)
                        ((null value) nil)
                        (t (prin1-to-string value)))
           :condition nil
           :backtrace-handle nil
           :namespace-or-package (emacs-operator-lisp--namespace-or-package)
           :completed t
           :metadata (append metadata
                             `(("messages" . ,(with-current-buffer (get-buffer-create "*Messages*")
                                                (buffer-substring-no-properties messages-before (point-max))))))))
      (error
       (let* ((condition-name (symbol-name (car err)))
              (message (error-message-string err))
              (trace (emacs-operator-lisp--bounded-backtrace))
              (handle (format "elisp:%s" (substring (secure-hash 'sha256
                                                                  (format "%s:%s:%s" condition-name message trace))
                                                     0 16))))
         (emacs-operator-repl-result
          :stdout ""
          :stderr message
          :value nil
          :condition condition-name
          :backtrace-handle handle
          :namespace-or-package (emacs-operator-lisp--namespace-or-package)
          :completed nil
          :metadata (append metadata
                            `(("error_data" . ,(prin1-to-string (cdr err)))
                              ("backtrace" . ,trace)
                              ("messages" . ,(with-current-buffer (get-buffer-create "*Messages*")
                                                 (buffer-substring-no-properties messages-before (point-max))))))))))))

(defun emacs-operator-lisp--ensure-eval-bounds (bounds)
  "Validate BOUNDS and enforce the structured evaluation byte limit."
  (unless (and (vectorp bounds) (= (length bounds) 2)
               (integerp (aref bounds 0)) (integerp (aref bounds 1))
               (<= (point-min) (aref bounds 0)) (< (aref bounds 0) (aref bounds 1))
               (<= (aref bounds 1) (point-max)))
    (emacs-operator-signal "E_COMMAND_FAILED" "Evaluation source bounds are invalid."))
  (let* ((source (buffer-substring-no-properties (aref bounds 0) (aref bounds 1)))
         (bytes (string-bytes source)))
    (when (> bytes emacs-operator-lisp--max-eval-bytes)
      (emacs-operator-signal
       "E_INVALID_ARGUMENT"
       "Buffer-derived evaluation source exceeds the 256 KiB safety bound."
       `(("source_bytes" . ,bytes)
         ("max_source_bytes" . ,emacs-operator-lisp--max-eval-bytes))))
    bounds))

(defun emacs-operator-lisp--active-region-bounds ()
  (unless (use-region-p)
    (emacs-operator-signal "E_COMMAND_FAILED" "eval_region requires an active region in the target buffer."))
  (let ((start (region-beginning))
        (end (region-end)))
    (emacs-operator-lisp--ensure-eval-bounds (vector start end))))

(defun emacs-operator-lisp--preceding-sexp-bounds ()
  (let ((end (point)))
    (save-excursion
      (condition-case err
          (progn
            (backward-sexp)
            (vector (point) end))
        (error
         (emacs-operator-signal "E_COMMAND_FAILED"
                                "No complete expression exists immediately before point."
                                `(("condition" . ,(error-message-string err)))))))))

(defun emacs-operator-lisp-reader-validation ()
  "Validate the current Lisp buffer without evaluating it.
For Emacs Lisp this also asks the Emacs reader to consume every top-level form.
Other Lisp dialects receive delimiter/syntax state only because their reader
syntax belongs to their own runtime."
  (let ((snapshot (emacs-operator-lisp-structural-snapshot)))
    (if (not (derived-mode-p 'emacs-lisp-mode 'lisp-interaction-mode))
        `(("ok" . ,(if (emacs-operator--truthy-json-p (emacs-operator--get snapshot "balanced")) t :json-false))
          ("dialect_reader_checked" . :json-false)
          ("snapshot" . ,snapshot))
      (save-excursion
        (save-restriction
          (widen)
          (goto-char (point-min))
          (let ((forms 0) failure)
            (condition-case err
                (while (< (point) (point-max))
                  (skip-chars-forward " \t\r\n")
                  (when (< (point) (point-max))
                    (read (current-buffer))
                    (setq forms (1+ forms))))
              (end-of-file nil)
              (error
               (setq failure
                     `(("condition" . ,(symbol-name (car err)))
                       ("message" . ,(error-message-string err))
                       ("point" . ,(point))
                       ("line" . ,(line-number-at-pos (point) t))
                       ("column" . ,(current-column))))))
            `(("ok" . ,(if (and (not failure)
                                  (emacs-operator--truthy-json-p (emacs-operator--get snapshot "balanced")))
                             t :json-false))
              ("dialect_reader_checked" . t)
              ("forms_read" . ,forms)
              ("failure" . ,failure)
              ("snapshot" . ,snapshot))))))))

(defun emacs-operator-lisp-eval (params _context)
  "Handle structured local-buffer Lisp evaluation operations.
This does not accept arbitrary source strings. Evaluation failures are returned
through the normalized result contract with completed=false."
  (let ((operation (emacs-operator--get params "operation")))
    (pcase operation
      ("eval_last_sexp"
       (when (derived-mode-p 'emacs-lisp-mode 'lisp-interaction-mode)
         (let ((bounds (emacs-operator-lisp--ensure-eval-bounds
                        (emacs-operator-lisp--preceding-sexp-bounds))))
           (emacs-operator-lisp--capture-message-result
            operation bounds
            (lambda ()
              (eval (read (buffer-substring-no-properties (aref bounds 0) (aref bounds 1)))
                    lexical-binding))))))
      ("eval_defun"
       (when (derived-mode-p 'emacs-lisp-mode 'lisp-interaction-mode)
         (save-excursion
           (let* ((bounds (emacs-operator-lisp--defun-bounds))
                  (start (and bounds (aref bounds 0)))
                  (end (and bounds (aref bounds 1))))
             (unless (and start end)
               (emacs-operator-signal "E_COMMAND_FAILED" "No enclosing defun could be resolved."))
             (setq bounds (emacs-operator-lisp--ensure-eval-bounds bounds)
                   start (aref bounds 0)
                   end (aref bounds 1))
             (emacs-operator-lisp--capture-message-result
              operation bounds
              (lambda ()
                (eval-region start end)
                "evaluated"))))))
      ("eval_region"
       (when (derived-mode-p 'emacs-lisp-mode 'lisp-interaction-mode)
         (let* ((bounds (emacs-operator-lisp--active-region-bounds))
                (start (aref bounds 0))
                (end (aref bounds 1)))
           (emacs-operator-lisp--capture-message-result
            operation bounds
            (lambda ()
              (eval-region start end)
              "evaluated")))))
      (_ nil))))

(dolist (function '(emacs-operator-lisp-check-structure
                    emacs-operator-lisp-reader-validation
                    emacs-operator-lisp-structural-edit
                    emacs-operator-lisp-rename-symbol
                    emacs-operator-lisp-extract-function
                    emacs-operator-lisp-move-top-level-form))
  (when (fboundp 'emacs-operator-register-safe-noninteractive-function)
    (emacs-operator-register-safe-noninteractive-function function)))

(emacs-operator-register-adapter
 "lisp"
 (lambda (_context) (emacs-operator-lisp-mode-p))
 #'emacs-operator-lisp-capabilities
 :priority 50
 :observe #'emacs-operator-lisp-observe
 :analyze #'emacs-operator-lisp-analyze
 :verify #'emacs-operator-lisp-verify
 :eval #'emacs-operator-lisp-eval
 :validate #'emacs-operator-lisp-validate
 :metadata '(("kind" . "mode") ("structural" . t)))

(provide 'emacs-operator-adapter-lisp)
;;; emacs-operator-adapter-lisp.el ends here
