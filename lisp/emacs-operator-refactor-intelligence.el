;;; emacs-operator-refactor-intelligence.el --- Conservative refactoring analysis -*- lexical-binding: t; -*-

;; Alpha.9 adds analysis-first refactoring. Every project-wide mutation is
;; planned and preflighted before any buffer is changed. Applying a plan only
;; changes live buffers; saving remains a separate, explicit operation.

(require 'cl-lib)
(require 'seq)
(require 'subr-x)
(require 'xref)
(require 'project)
(require 'emacs-operator-adapter-repl)

(defgroup emacs-operator-refactor-intelligence nil
  "Conservative analysis and refactoring support for Emacs Operator."
  :group 'tools)

(defcustom emacs-operator-project-rename-plan-ttl 300
  "Seconds for which an unapplied project rename plan remains valid."
  :type 'integer)

(defcustom emacs-operator-project-rename-max-files 500
  "Maximum number of files in a project rename plan."
  :type 'integer)

(defcustom emacs-operator-project-rename-max-edits 10000
  "Maximum number of edits in a project rename plan."
  :type 'integer)

(defcustom emacs-operator-project-rename-max-bytes (* 16 1024 1024)
  "Maximum aggregate source bytes represented by one rename plan."
  :type 'integer)

(defvar emacs-operator--project-rename-plans (make-hash-table :test #'equal))

(defcustom emacs-operator-project-rename-journal-ttl 900
  "Seconds for which an applied project rename can be rolled back."
  :type 'integer)

(defcustom emacs-operator-project-rename-max-preview-edits 200
  "Maximum rename edits returned by one preview request."
  :type 'integer)

(defvar emacs-operator--project-rename-journals (make-hash-table :test #'equal))

(defconst emacs-operator--lisp-analysis-special-symbols
  '(nil t quote function lambda defun defmacro let let* if when unless cond
    progn prog1 prog2 and or while catch throw unwind-protect condition-case
    save-excursion save-restriction setq setf fn defn defn- loop recur doseq
    dotimes for binding with-open letfn do case try finally &optional &rest
    &key &aux &body &environment _)
  "Symbols that are never inferred as extract-function parameters.")

(defun emacs-operator--alpha9-valid-symbol-name-p (value)
  "Return non-nil when VALUE is a bounded Lisp symbol token."
  (and (stringp value)
       (> (length value) 0)
       (<= (length value) 256)
       (not (string-match-p "[][(){}\"'`,;[:space:]]" value))
       (not (string-match-p "\\`[+-]?[0-9]+\\(?:\\.[0-9]*\\)?\\'" value))))

(defun emacs-operator--alpha9-assert-symbol-name (value label)
  "Validate VALUE as a Lisp symbol, identifying it as LABEL."
  (unless (emacs-operator--alpha9-valid-symbol-name-p value)
    (user-error "%s must be a bounded Lisp symbol token" label))
  value)

(defun emacs-operator--alpha9-current-defun-bounds ()
  "Return bounds of the current top-level definition, or signal an error."
  (save-excursion
    (end-of-defun)
    (let ((end (point)))
      (beginning-of-defun)
      (when (= (point) end)
        (user-error "Point is not inside a definition"))
      (cons (point) end))))

(defun emacs-operator--alpha9-flatten-binding-pattern (value)
  "Return simple symbols in binding pattern VALUE.
Complex map-like destructuring is intentionally not guessed."
  (cond
   ((symbolp value)
    (unless (or (keywordp value)
                (memq value emacs-operator--lisp-analysis-special-symbols))
      (list value)))
   ((vectorp value)
    (cl-mapcan #'emacs-operator--alpha9-flatten-binding-pattern (append value nil)))
   ((listp value)
    (cl-mapcan #'emacs-operator--alpha9-flatten-binding-pattern value))
   (t nil)))

(defun emacs-operator--alpha9-form-binding-symbols (form)
  "Collect symbols bound by FORM without attempting macro expansion."
  (let ((head (car-safe form)))
    (cond
     ((memq head '(defun defmacro defn defn-))
      (emacs-operator--alpha9-flatten-binding-pattern (nth 2 form)))
     ((memq head '(lambda fn))
      (emacs-operator--alpha9-flatten-binding-pattern (nth 1 form)))
     ((memq head '(let let*))
      (cl-mapcan
       (lambda (binding)
         (emacs-operator--alpha9-flatten-binding-pattern
          (if (consp binding) (car binding) binding)))
       (nth 1 form)))
     ((memq head '(loop binding with-open doseq for))
      (let ((bindings (nth 1 form)) result)
        (when (vectorp bindings)
          (let ((values (append bindings nil)))
            (while values
              (setq result
                    (nconc result
                           (emacs-operator--alpha9-flatten-binding-pattern
                            (pop values))))
              (pop values))))
        result))
     (t nil))))

(defun emacs-operator--alpha9-read-region-forms (start end)
  "Read complete Lisp forms between START and END.
Return a plist with :forms and :diagnostics."
  ;; Capture the source before entering `with-temp-buffer'.  Calling
  ;; `buffer-substring-no-properties' from inside the temporary buffer reads
  ;; the wrong buffer and turns every non-trivial selection into an
  ;; out-of-range reader diagnostic.
  (let ((source (buffer-substring-no-properties start end))
        forms diagnostics)
    (condition-case err
        (with-temp-buffer
          (insert source)
          (goto-char (point-min))
          (while (progn (skip-chars-forward " \t\r\n") (< (point) (point-max)))
            (push (read (current-buffer)) forms)))
      (error
       (push (list :code "reader_error"
                   :message (error-message-string err))
             diagnostics)))
    (list :forms (nreverse forms) :diagnostics (nreverse diagnostics))))

(defun emacs-operator--alpha9-collect-local-bindings (form)
  "Collect simple binding names introduced anywhere inside FORM."
  (let ((result (emacs-operator--alpha9-form-binding-symbols form)))
    (when (consp form)
      (dolist (child form)
        (when (consp child)
          (setq result
                (nconc result
                       (emacs-operator--alpha9-collect-local-bindings child))))))
    (delete-dups result)))

(defun emacs-operator--alpha9-defun-bindings (bounds)
  "Return parameters of the definition at BOUNDS."
  (save-excursion
    (goto-char (car bounds))
    (condition-case nil
        (emacs-operator--alpha9-form-binding-symbols (read (current-buffer)))
      (error nil))))

(defun emacs-operator--alpha9-function-position-p (position)
  "Return non-nil when symbol at POSITION is the head of a list."
  (save-excursion
    (goto-char position)
    (skip-chars-backward " \t\r\n")
    (eq (char-before) ?\()))

(defun emacs-operator--alpha9-quoted-position-p (position)
  "Return non-nil when token at POSITION is immediately quoted."
  (save-excursion
    (goto-char position)
    (skip-chars-backward " \t\r\n")
    (memq (char-before) '(?' ?`))))


(defun emacs-operator--alpha10-binding-names-from-spec (bindings)
  "Return conservative simple binding names from BINDINGS."
  (cond
   ((vectorp bindings)
    (let ((items (append bindings nil)) result)
      (while items
        (setq result
              (nconc result
                     (emacs-operator--alpha9-flatten-binding-pattern (pop items))))
        (when items (pop items)))
      result))
   ((listp bindings)
    (cl-mapcan
     (lambda (binding)
       (emacs-operator--alpha9-flatten-binding-pattern
        (if (consp binding) (car binding) binding)))
     bindings))
   (t nil)))

(defun emacs-operator--alpha10-enclosing-lexical-bindings (position)
  "Return names lexically visible at POSITION from enclosing forms.
This intentionally handles a conservative set of Lisp/Clojure binding forms."
  (save-excursion
    (goto-char position)
    (let ((continue t)
          result)
      (while continue
        (setq continue
              (condition-case nil
                  (progn
                    (backward-up-list 1)
                    t)
                (error nil)))
        (when continue
          (let* ((list-start (point))
                 (bindings
                  (condition-case nil
                      (save-excursion
                        (goto-char list-start)
                        (forward-char 1)
                        (let ((head (read (current-buffer))))
                          (cond
                           ((memq head '(lambda fn))
                            (let ((params (read (current-buffer))))
                              (when (>= position (point))
                                (emacs-operator--alpha9-flatten-binding-pattern params))))
                           ((memq head '(defun defmacro defn defn-))
                            (read (current-buffer))
                            (let ((params (read (current-buffer))))
                              (when (>= position (point))
                                (emacs-operator--alpha9-flatten-binding-pattern params))))
                           ((memq head '(let let* loop binding with-open doseq for))
                            (let ((spec (read (current-buffer))))
                              (when (>= position (point))
                                (emacs-operator--alpha10-binding-names-from-spec spec)))))))
                    (error nil))))
            (when bindings
              (setq result (nconc result bindings))))))
      (delete-dups result))))

(defun emacs-operator-lisp-infer-extract-parameters (start end &optional known-bindings)
  "Conservatively infer parameters needed to extract START..END.
Only lexical names proven to be visible are returned as parameters. Unknown
value-position symbols are returned in `unresolved`; callers must not silently
turn those into parameters."
  (unless (and (integer-or-marker-p start)
               (integer-or-marker-p end)
               (<= (point-min) start end (point-max)))
    (user-error "Invalid analysis bounds"))
  (let* ((defun-bounds (save-excursion
                         (goto-char start)
                         (emacs-operator--alpha9-current-defun-bounds)))
         (read-result (emacs-operator--alpha9-read-region-forms start end))
         (forms (plist-get read-result :forms))
         (diagnostics (plist-get read-result :diagnostics))
         (visible (delete-dups
                   (append (emacs-operator--alpha9-defun-bindings defun-bounds)
                           (emacs-operator--alpha10-enclosing-lexical-bindings start)
                           (mapcar (lambda (value)
                                     (if (symbolp value) value (intern value)))
                                   known-bindings))))
         (local (delete-dups
                 (cl-mapcan #'emacs-operator--alpha9-collect-local-bindings forms)))
         parameters unresolved)
    (save-excursion
      (goto-char start)
      (while (re-search-forward "\\_<\\(?:\\sw\\|\\s_\\)+\\_>" end t)
        (let* ((position (match-beginning 0))
               (name (match-string-no-properties 0))
               (state (save-match-data
                        (save-excursion (syntax-ppss position))))
               (symbol (intern-soft name)))
          (unless (or (nth 3 state)
                      (nth 4 state)
                      (null symbol)
                      (keywordp symbol)
                      (memq symbol emacs-operator--lisp-analysis-special-symbols)
                      (memq symbol local)
                      (emacs-operator--alpha9-function-position-p position)
                      (emacs-operator--alpha9-quoted-position-p position)
                      (string-match-p "/" name))
            (cond
             ((memq symbol visible)
              (unless (memq symbol parameters)
                (setq parameters (append parameters (list symbol)))))
             ((or (boundp symbol) (fboundp symbol)) nil)
             ((not (memq symbol unresolved))
              (setq unresolved (append unresolved (list symbol)))))))))
    `((parameters . ,(mapcar #'symbol-name parameters))
      (unresolved . ,(mapcar #'symbol-name unresolved))
      (confidence . ,(cond
                      ((and (null unresolved) (null diagnostics)) "high")
                      (parameters "medium")
                      (t "low")))
      (bounds . [,start ,end])
      (defun_bounds . [,(car defun-bounds) ,(cdr defun-bounds)])
      (source_sha256 . ,(secure-hash 'sha256
                                     (buffer-substring-no-properties start end)))
      (diagnostics . ,diagnostics))))

(defun emacs-operator-lisp-analyze (operation &optional params _context)
  "Dispatch Lisp analysis OPERATION with PARAMS.
This stable entry point is suitable for adapter registries."
  (pcase operation
    ((or 'infer_extract_parameters "infer_extract_parameters")
     (let ((bounds (or (alist-get 'bounds params)
                       (alist-get "bounds" params nil nil #'equal))))
       (unless (and (sequencep bounds) (= (length bounds) 2))
         (user-error "infer_extract_parameters requires [start,end] bounds"))
       (emacs-operator-lisp-infer-extract-parameters
        (elt bounds 0) (elt bounds 1)
        (or (alist-get 'known_bindings params)
            (alist-get "known_bindings" params nil nil #'equal)))))
    ((or 'evaluation_source_fingerprint "evaluation_source_fingerprint")
     (let* ((eval-operation (or (alist-get 'evaluation_operation params)
                                (alist-get "evaluation_operation" params nil nil #'equal)))
            (bounds (emacs-operator-repl-source-bounds eval-operation))
            (source (emacs-operator-repl-source-from-bounds bounds eval-operation)))
       `((operation . ,eval-operation)
         (source_bounds . ,bounds)
         (source_start . ,(aref bounds 0))
         (source_sha256 . ,(secure-hash 'sha256 source))
         (source_bytes . ,(string-bytes source)))))
    (_ (user-error "Unsupported Lisp analysis operation: %S" operation))))

(defun emacs-operator--alpha9-project-root ()
  "Return the local project root or signal a user error."
  (let ((project (project-current nil)))
    (unless project (user-error "No project is active"))
    (let ((root (file-truename (project-root project))))
      (when (file-remote-p root)
        (user-error "Remote project rename is not supported"))
      root)))

(defun emacs-operator--alpha9-path-inside-root-p (file root)
  "Return non-nil when FILE resolves below ROOT."
  (file-in-directory-p (file-truename file) (file-name-as-directory root)))

(defun emacs-operator--alpha9-buffer-sha256 (buffer)
  "Return SHA-256 for BUFFER text without properties."
  (with-current-buffer buffer
    (secure-hash 'sha256 (current-buffer) (point-min) (point-max))))

(defun emacs-operator--alpha9-find-symbol-on-line (name marker)
  "Find exact Lisp symbol NAME on MARKER's line, nearest MARKER."
  (with-current-buffer (marker-buffer marker)
    (save-excursion
      (goto-char marker)
      (let ((origin (point))
            (line-start (line-beginning-position))
            (line-end (line-end-position))
            matches)
        (goto-char line-start)
        (while (search-forward name line-end t)
          (let* ((start (- (point) (length name)))
                 (end (point))
                 (state (save-match-data
                          (save-excursion (syntax-ppss start)))))
            (when (and (not (nth 3 state))
                       (not (nth 4 state))
                       (or (= start (point-min))
                           (not (memq (char-syntax (char-before start)) '(?w ?_))))
                       (or (= end (point-max))
                           (not (memq (char-syntax (char-after end)) '(?w ?_)))))
              (push (cons start end) matches))))
        (car
         (sort matches
               (lambda (a b)
                 (< (abs (- (car a) origin))
                    (abs (- (car b) origin))))))))))

(defun emacs-operator--alpha9-xref-items (backend name include-definitions)
  "Return xref items for NAME from BACKEND."
  (let ((items (condition-case err
                   (xref-backend-references backend name)
                 (error
                  (user-error "xref references failed: %s"
                              (error-message-string err))))))
    (when include-definitions
      (setq items
            (append items
                    (condition-case nil
                        (xref-backend-definitions backend name)
                      (error nil)))))
    items))

(defconst emacs-operator--alpha11-project-rename-languages
  '("generic" "elisp" "clojure" "common_lisp")
  "Language identifiers accepted by project rename plans.")

(defconst emacs-operator--alpha11-project-rename-qualification-policies
  '("exact" "preserve_qualification" "leaf_only")
  "Qualification policies accepted by project rename plans.")

(defun emacs-operator--alpha11-normalize-project-rename-metadata
    (old-symbol new-symbol language qualification-policy requested-new-symbol symbol-semantics)
  "Validate and normalize language metadata for a project rename plan."
  (let* ((normalized-language (or language "generic"))
         (normalized-policy
          (or qualification-policy
              (if (member normalized-language '("clojure" "common_lisp"))
                  "preserve_qualification"
                "exact")))
         (requested (or requested-new-symbol new-symbol))
         (semantics
          (or symbol-semantics
              `(("language" . ,normalized-language)
                ("qualification_policy" . ,normalized-policy)
                ("old" . (("raw" . ,old-symbol)))
                ("requested_new" . (("raw" . ,requested)))
                ("new" . (("raw" . ,new-symbol)))
                ("effective_new_symbol" . ,new-symbol)))))
    (unless (member normalized-language emacs-operator--alpha11-project-rename-languages)
      (user-error "Unsupported project rename language: %s" normalized-language))
    (unless (member normalized-policy emacs-operator--alpha11-project-rename-qualification-policies)
      (user-error "Unsupported project rename qualification policy: %s" normalized-policy))
    (emacs-operator--alpha9-assert-symbol-name requested "requested new symbol")
    (list normalized-language normalized-policy requested semantics)))

(defun emacs-operator--alpha9-plan-canonical-data (plan)
  "Return PLAN fields that participate in its integrity hash."
  (list (alist-get 'version plan)
        (alist-get 'kind plan)
        (alist-get 'root plan)
        (alist-get 'language plan)
        (alist-get 'qualification_policy plan)
        (alist-get 'old_symbol plan)
        (alist-get 'requested_new_symbol plan)
        (alist-get 'new_symbol plan)
        (alist-get 'symbol_semantics plan)
        (alist-get 'files plan)
        (alist-get 'total_edits plan)))

(defun emacs-operator-project-rename-plan
    (old-symbol new-symbol &optional include-definitions language qualification-policy requested-new-symbol symbol-semantics)
  "Build and cache an immutable xref-backed rename plan.
No buffers are modified. The returned plan expires and must be passed to
`emacs-operator-project-rename-apply` by its plan id."
  (interactive
   (list (or (thing-at-point 'symbol t) (read-string "Old symbol: "))
         (read-string "New symbol: ")
         t))
  (emacs-operator--alpha9-assert-symbol-name old-symbol "old symbol")
  (emacs-operator--alpha9-assert-symbol-name new-symbol "new symbol")
  (when (equal old-symbol new-symbol)
    (user-error "Symbols must differ"))
  (pcase-let* ((`(,normalized-language ,normalized-policy ,requested ,semantics)
                 (emacs-operator--alpha11-normalize-project-rename-metadata
                  old-symbol new-symbol language qualification-policy
                  requested-new-symbol symbol-semantics))
               (root (emacs-operator--alpha9-project-root))
               (backend (xref-find-backend))
         (_ (unless backend (user-error "No xref backend is available")))
         (items (emacs-operator--alpha9-xref-items
                 backend old-symbol include-definitions))
         (groups (make-hash-table :test #'equal))
         (total-bytes 0)
         (total-edits 0))
    (dolist (item items)
      (let* ((location (xref-item-location item))
             (marker (xref-location-marker location))
             (buffer (marker-buffer marker)))
        (when (buffer-live-p buffer)
          (with-current-buffer buffer
            (let ((file buffer-file-name))
              (when (and file
                         (not (file-remote-p file))
                         (emacs-operator--alpha9-path-inside-root-p file root))
                (let ((bounds (emacs-operator--alpha9-find-symbol-on-line
                               old-symbol marker)))
                  (when bounds
                    (let* ((true-file (file-truename file))
                           (existing (gethash true-file groups))
                           (edit `((start . ,(car bounds))
                                   (end . ,(cdr bounds))
                                   (line . ,(line-number-at-pos (car bounds)))
                                   (column . ,(save-excursion
                                                (goto-char (car bounds))
                                                (current-column)))
                                   (old_text . ,old-symbol)
                                   (new_text . ,new-symbol))))
                      (unless (seq-find
                               (lambda (candidate)
                                 (= (alist-get 'start candidate) (car bounds)))
                               (alist-get 'edits existing))
                        (if existing
                            (setf (alist-get 'edits existing)
                                  (cons edit (alist-get 'edits existing)))
                          (setq existing
                                `((path . ,(file-relative-name true-file root))
                                  (absolute_path . ,true-file)
                                  (sha256 . ,(emacs-operator--alpha9-buffer-sha256 buffer))
                                  (buffer_tick . ,(buffer-chars-modified-tick))
                                  (bytes . ,(buffer-size))
                                  (edits . (,edit))))
                          (puthash true-file existing groups))
                        (cl-incf total-edits)))))))))))
    (let (files)
      (maphash
       (lambda (_file entry)
         (setf (alist-get 'edits entry)
               (sort (alist-get 'edits entry)
                     (lambda (a b)
                       (< (alist-get 'start a) (alist-get 'start b)))))
         (cl-incf total-bytes (alist-get 'bytes entry))
         (push entry files))
       groups)
      (setq files
            (sort files
                  (lambda (a b)
                    (string< (alist-get 'path a) (alist-get 'path b)))))
      (when (> (length files) emacs-operator-project-rename-max-files)
        (user-error "Rename plan exceeds file limit"))
      (when (> total-edits emacs-operator-project-rename-max-edits)
        (user-error "Rename plan exceeds edit limit"))
      (when (> total-bytes emacs-operator-project-rename-max-bytes)
        (user-error "Rename plan exceeds source byte limit"))
      (let* ((created (float-time))
             (base `((version . 2)
                     (kind . "lisp_project_rename")
                     (root . ,root)
                     (language . ,normalized-language)
                     (qualification_policy . ,normalized-policy)
                     (old_symbol . ,old-symbol)
                     (requested_new_symbol . ,requested)
                     (new_symbol . ,new-symbol)
                     (symbol_semantics . ,semantics)
                     (files . ,files)
                     (total_edits . ,total-edits)))
             (plan-id
              (secure-hash
               'sha256
               (prin1-to-string
                (emacs-operator--alpha9-plan-canonical-data base))))
             (stored
              (append base
                      `((plan_id . ,plan-id)
                        (created_at . ,created)
                        (expires_at . ,(+ created
                                          emacs-operator-project-rename-plan-ttl))))))
        (puthash plan-id stored emacs-operator--project-rename-plans)
        stored))))


(defun emacs-operator--alpha10-line-preview (buffer edit)
  "Return a bounded before/after line preview for EDIT in BUFFER."
  (with-current-buffer buffer
    (save-excursion
      (goto-char (alist-get 'start edit))
      (let* ((line-start (line-beginning-position))
             (line-end (line-end-position))
             (before (buffer-substring-no-properties line-start line-end))
             (local-start (- (alist-get 'start edit) line-start))
             (local-end (- (alist-get 'end edit) line-start))
             (after (concat (substring before 0 local-start)
                            (alist-get 'new_text edit)
                            (substring before local-end))))
        `((line . ,(line-number-at-pos (alist-get 'start edit)))
          (column . ,(alist-get 'column edit))
          (before . ,before)
          (after . ,after)
          (old_text . ,(alist-get 'old_text edit))
          (new_text . ,(alist-get 'new_text edit)))))))

(defun emacs-operator-project-rename-preview (plan-id &optional max-edits)
  "Return bounded, read-only preview information for cached PLAN-ID."
  (let ((plan (gethash plan-id emacs-operator--project-rename-plans)))
    (unless plan (user-error "Unknown or expired rename plan"))
    (when (> (float-time) (alist-get 'expires_at plan))
      (remhash plan-id emacs-operator--project-rename-plans)
      (user-error "Rename plan has expired"))
    (let* ((limit (min emacs-operator-project-rename-max-preview-edits
                       (max 1 (or max-edits emacs-operator-project-rename-max-preview-edits))))
           (remaining limit)
           previews)
      (dolist (file-entry (alist-get 'files plan))
        (when (> remaining 0)
          (let* ((file (alist-get 'absolute_path file-entry))
                 (buffer (find-file-noselect file))
                 edits)
            (with-current-buffer buffer
              (unless (equal (emacs-operator--alpha9-buffer-sha256 buffer)
                             (alist-get 'sha256 file-entry))
                (user-error "Stale rename plan for %s" file))
              (dolist (edit (alist-get 'edits file-entry))
                (when (> remaining 0)
                  (push (emacs-operator--alpha10-line-preview buffer edit) edits)
                  (setq remaining (1- remaining)))))
            (when edits
              (push `((path . ,(alist-get 'path file-entry))
                      (edits . ,(nreverse edits)))
                    previews)))))
      `((plan_id . ,plan-id)
        (language . ,(alist-get 'language plan))
        (qualification_policy . ,(alist-get 'qualification_policy plan))
        (old_symbol . ,(alist-get 'old_symbol plan))
        (requested_new_symbol . ,(alist-get 'requested_new_symbol plan))
        (new_symbol . ,(alist-get 'new_symbol plan))
        (symbol_semantics . ,(alist-get 'symbol_semantics plan))
        (total_edits . ,(alist-get 'total_edits plan))
        (returned_edits . ,(- limit remaining))
        (truncated . ,(if (> (alist-get 'total_edits plan) (- limit remaining)) t :json-false))
        (files . ,(nreverse previews))))))

(defun emacs-operator--alpha10-new-journal-id (plan-id)
  "Return an opaque rollback journal id derived from PLAN-ID and fresh entropy."
  (concat "rj_"
          (substring
           (secure-hash 'sha256
                        (format "%s:%s:%s:%s" plan-id (float-time) (random) (emacs-pid)))
           0 32)))

(defun emacs-operator--alpha10-prune-rename-journals ()
  "Remove expired project rename rollback journals."
  (let ((now (float-time)) expired)
    (maphash (lambda (id journal)
               (when (> now (alist-get 'expires_at journal))
                 (push id expired)))
             emacs-operator--project-rename-journals)
    (dolist (id expired) (remhash id emacs-operator--project-rename-journals))))

(defun emacs-operator--alpha9-plan-preflight (plan)
  "Validate PLAN against every current buffer before editing."
  (when (> (float-time) (alist-get 'expires_at plan))
    (remhash (alist-get 'plan_id plan) emacs-operator--project-rename-plans)
    (user-error "Rename plan has expired"))
  (let ((root (alist-get 'root plan)) buffers)
    (dolist (file-entry (alist-get 'files plan))
      (let* ((file (alist-get 'absolute_path file-entry))
             (_ (unless (emacs-operator--alpha9-path-inside-root-p file root)
                  (user-error "Planned file escaped project root")))
             (buffer (find-file-noselect file)))
        (with-current-buffer buffer
          (unless (equal (emacs-operator--alpha9-buffer-sha256 buffer)
                         (alist-get 'sha256 file-entry))
            (user-error "Stale rename plan for %s" file))
          (dolist (edit (alist-get 'edits file-entry))
            (unless (equal
                     (buffer-substring-no-properties
                      (alist-get 'start edit) (alist-get 'end edit))
                     (alist-get 'old_text edit))
              (user-error "Stale rename edit in %s at %s"
                          file (alist-get 'start edit)))))
        (push (cons buffer file-entry) buffers)))
    (nreverse buffers)))

(defun emacs-operator-project-rename-apply (plan-id &optional policy)
  "Apply cached project rename PLAN-ID to live buffers atomically.
The operation does not save files. All buffers are preflighted before the
first edit. A bounded rollback journal is retained after success."
  (interactive (list (read-string "Rename plan id: ")))
  (emacs-operator--alpha10-prune-rename-journals)
  (let ((plan (gethash plan-id emacs-operator--project-rename-plans)))
    (unless plan
      (user-error "Unknown or expired rename plan"))
    (let ((buffers (emacs-operator--alpha9-plan-preflight plan))
          groups snapshots changed)
      ;; Policy-check every buffer before the first mutation.
      (dolist (pair buffers)
        (when (and policy (fboundp 'emacs-operator-policy-check-buffer-mutation))
          (emacs-operator-policy-check-buffer-mutation policy (car pair))))
      ;; Capture bounded pre-apply text so rollback remains possible after the
      ;; change groups are accepted. The plan's aggregate byte limit bounds this.
      (dolist (pair buffers)
        (with-current-buffer (car pair)
          (push `((file . ,buffer-file-name)
                  (buffer_name . ,(buffer-name))
                  (original_text . ,(buffer-substring-no-properties (point-min) (point-max)))
                  (original_sha256 . ,(emacs-operator--alpha9-buffer-sha256 (current-buffer)))
                  (original_modified . ,(if (buffer-modified-p) t :json-false))
                  (original_point . ,(point)))
                snapshots)))
      (condition-case err
          (progn
            (dolist (pair buffers)
              (with-current-buffer (car pair)
                (let ((group (prepare-change-group)))
                  (activate-change-group group)
                  (push (cons (current-buffer) group) groups))))
            (dolist (pair buffers)
              (with-current-buffer (car pair)
                (dolist
                    (edit
                     (sort (copy-sequence (alist-get 'edits (cdr pair)))
                           (lambda (a b)
                             (> (alist-get 'start a)
                                (alist-get 'start b)))))
                  (goto-char (alist-get 'start edit))
                  (delete-region (alist-get 'start edit)
                                 (alist-get 'end edit))
                  (insert (alist-get 'new_text edit)))
                (push (buffer-name) changed)))
            ;; Build the rollback journal while every change group is still
            ;; active. If hashing/snapshot construction fails, the error path can
            ;; cancel all groups before any of them has been accepted.
            (let* ((journal-id (emacs-operator--alpha10-new-journal-id plan-id))
                   (created (float-time))
                   (journal-entries
                    (mapcar
                     (lambda (snapshot)
                       (let* ((file (alist-get 'file snapshot))
                              (buffer (find-file-noselect file)))
                         (append snapshot
                                 `((applied_sha256 . ,(emacs-operator--alpha9-buffer-sha256 buffer))))))
                     (nreverse snapshots)))
                   (journal `((journal_id . ,journal-id)
                              (plan_id . ,plan-id)
                              (root . ,(alist-get 'root plan))
                              (language . ,(alist-get 'language plan))
                              (qualification_policy . ,(alist-get 'qualification_policy plan))
                              (old_symbol . ,(alist-get 'old_symbol plan))
                              (requested_new_symbol . ,(alist-get 'requested_new_symbol plan))
                              (new_symbol . ,(alist-get 'new_symbol plan))
                              (symbol_semantics . ,(alist-get 'symbol_semantics plan))
                              (created_at . ,created)
                              (expires_at . ,(+ created emacs-operator-project-rename-journal-ttl))
                              (entries . ,journal-entries))))
              (dolist (entry groups)
                (with-current-buffer (car entry)
                  (accept-change-group (cdr entry))))
              (puthash journal-id journal emacs-operator--project-rename-journals)
              (remhash plan-id emacs-operator--project-rename-plans)
              `((status . "applied_to_buffers")
                (plan_id . ,plan-id)
                (journal_id . ,journal-id)
                (language . ,(alist-get 'language plan))
                (qualification_policy . ,(alist-get 'qualification_policy plan))
                (old_symbol . ,(alist-get 'old_symbol plan))
                (requested_new_symbol . ,(alist-get 'requested_new_symbol plan))
                (new_symbol . ,(alist-get 'new_symbol plan))
                (symbol_semantics . ,(alist-get 'symbol_semantics plan))
                (journal_expires_at . ,(alist-get 'expires_at journal))
                (saved . :json-false)
                (changed_buffers . ,(nreverse changed))
                (total_edits . ,(alist-get 'total_edits plan))
                (warning . "Saving files and runtime side effects are outside this buffer transaction."))))
        (error
         (dolist (entry groups)
           (when (buffer-live-p (car entry))
             (with-current-buffer (car entry)
               (ignore-errors (cancel-change-group (cdr entry))))))
         (signal (car err) (cdr err)))))))

(defun emacs-operator-project-rename-rollback (journal-id &optional policy)
  "Rollback applied project rename JOURNAL-ID when no later edits conflict."
  (interactive (list (read-string "Rename journal id: ")))
  (emacs-operator--alpha10-prune-rename-journals)
  (let ((journal (gethash journal-id emacs-operator--project-rename-journals)))
    (unless journal (user-error "Unknown or expired rename rollback journal"))
    (let (buffers groups changed)
      ;; Preflight every target before touching any buffer.
      (dolist (entry (alist-get 'entries journal))
        (let* ((file (alist-get 'file entry))
               (buffer (find-file-noselect file)))
          (when (and policy (fboundp 'emacs-operator-policy-check-buffer-mutation))
            (emacs-operator-policy-check-buffer-mutation policy buffer))
          (with-current-buffer buffer
            (unless (equal (emacs-operator--alpha9-buffer-sha256 buffer)
                           (alist-get 'applied_sha256 entry))
              (user-error "Rename rollback conflict: buffer changed after apply: %s" file))
            (when (and buffer-file-name (not (verify-visited-file-modtime buffer)))
              (user-error "Rename rollback conflict: file changed on disk: %s" file)))
          (push (cons buffer entry) buffers)))
      (setq buffers (nreverse buffers))
      (condition-case err
          (progn
            (dolist (pair buffers)
              (with-current-buffer (car pair)
                (let ((group (prepare-change-group)))
                  (activate-change-group group)
                  (push (cons (current-buffer) group) groups))))
            (dolist (pair buffers)
              (with-current-buffer (car pair)
                (let ((inhibit-read-only nil)
                      (entry (cdr pair)))
                  (erase-buffer)
                  (insert (alist-get 'original_text entry))
                  (goto-char (min (point-max)
                                  (max (point-min) (alist-get 'original_point entry))))
                  (push (buffer-name) changed))))
            (dolist (entry groups)
              (with-current-buffer (car entry)
                (accept-change-group (cdr entry))))
            ;; Restore the pre-apply modified flags after accepting changes.
            (dolist (pair buffers)
              (with-current-buffer (car pair)
                (set-buffer-modified-p
                 (not (eq (alist-get 'original_modified (cdr pair)) :json-false)))))
            (remhash journal-id emacs-operator--project-rename-journals)
            `((status . "rolled_back")
              (journal_id . ,journal-id)
              (saved . :json-false)
              (changed_buffers . ,(nreverse changed))))
        (error
         (dolist (entry groups)
           (when (buffer-live-p (car entry))
             (with-current-buffer (car entry)
               (ignore-errors (cancel-change-group (cdr entry))))))
         (signal (car err) (cdr err)))))))

(defun emacs-operator-project-rename-journal-status (journal-id)
  "Return bounded metadata for rollback JOURNAL-ID without source snapshots."
  (emacs-operator--alpha10-prune-rename-journals)
  (let ((journal (gethash journal-id emacs-operator--project-rename-journals)))
    (unless journal (user-error "Unknown or expired rename rollback journal"))
    `((journal_id . ,journal-id)
      (plan_id . ,(alist-get 'plan_id journal))
      (root . ,(alist-get 'root journal))
      (language . ,(alist-get 'language journal))
      (qualification_policy . ,(alist-get 'qualification_policy journal))
      (old_symbol . ,(alist-get 'old_symbol journal))
      (requested_new_symbol . ,(alist-get 'requested_new_symbol journal))
      (new_symbol . ,(alist-get 'new_symbol journal))
      (symbol_semantics . ,(alist-get 'symbol_semantics journal))
      (created_at . ,(alist-get 'created_at journal))
      (expires_at . ,(alist-get 'expires_at journal))
      (entries . ,(mapcar
                   (lambda (entry)
                     `((file . ,(alist-get 'file entry))
                       (buffer_name . ,(alist-get 'buffer_name entry))
                       (original_sha256 . ,(alist-get 'original_sha256 entry))
                       (applied_sha256 . ,(alist-get 'applied_sha256 entry))
                       (original_modified . ,(alist-get 'original_modified entry))))
                   (alist-get 'entries journal))))))

(defun emacs-operator-project-rename-commit (journal-id)
  "Forget rollback JOURNAL-ID, explicitly accepting the applied buffer state."
  (interactive (list (read-string "Rename journal id: ")))
  (emacs-operator--alpha10-prune-rename-journals)
  (unless (gethash journal-id emacs-operator--project-rename-journals)
    (user-error "Unknown or expired rename rollback journal"))
  (remhash journal-id emacs-operator--project-rename-journals)
  `((status . "committed") (journal_id . ,journal-id)))

(provide 'emacs-operator-refactor-intelligence)
;;; emacs-operator-refactor-intelligence.el ends here
