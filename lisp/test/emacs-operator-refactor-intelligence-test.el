;;; emacs-operator-refactor-intelligence-test.el --- alpha.9 tests -*- lexical-binding: t; -*-
(require 'ert)
(require 'emacs-operator-refactor-intelligence)

(ert-deftest emacs-operator-alpha9-infers-defun-parameters ()
  (with-temp-buffer
    (emacs-lisp-mode)
    (insert "(defun sample (x y)\n  (+ x (* y 2)))")
    (goto-char (point-min))
    (search-forward "(+")
    (backward-char 2)
    (let* ((start (point))
           (end (progn (forward-sexp) (point)))
           (result (emacs-operator-lisp-infer-extract-parameters start end)))
      (should (equal (alist-get 'parameters result) '("x" "y")))
      (should (equal (alist-get 'unresolved result) nil)))))

(ert-deftest emacs-operator-alpha9-reports-unknown-symbol ()
  (with-temp-buffer
    (emacs-lisp-mode)
    (insert "(defun sample (x)\n  (+ x mystery))")
    (goto-char (point-min))
    (search-forward "(+")
    (backward-char 2)
    (let* ((start (point))
           (end (progn (forward-sexp) (point)))
           (result (emacs-operator-lisp-infer-extract-parameters start end)))
      (should (member "x" (alist-get 'parameters result)))
      (should (member "mystery" (alist-get 'unresolved result))))))

(ert-deftest emacs-operator-alpha9-symbol-validation-rejects-reader-input ()
  (should-error
   (emacs-operator--alpha9-assert-symbol-name "(delete-file x)" "name")))


(ert-deftest emacs-operator-alpha10-infers-enclosing-let-binding ()
  (with-temp-buffer
    (emacs-lisp-mode)
    (insert "(defun sample (x)\n  (let ((y 2))\n    (+ x y mystery)))")
    (goto-char (point-min))
    (search-forward "(+")
    (backward-char 2)
    (let* ((start (point))
           (end (progn (forward-sexp) (point)))
           (result (emacs-operator-lisp-infer-extract-parameters start end)))
      (should (equal (alist-get 'parameters result) '("x" "y")))
      (should (member "mystery" (alist-get 'unresolved result))))))


(ert-deftest emacs-operator-alpha10-adapter-analysis-registry-is-read-only ()
  (require 'emacs-operator-adapter-lisp)
  (with-temp-buffer
    (emacs-lisp-mode)
    (insert "(defun sample (x) (+ x 1))")
    (goto-char (point-min))
    (search-forward "(+")
    (backward-char 2)
    (let* ((start (point))
           (end (progn (forward-sexp) (point)))
           (tick (buffer-chars-modified-tick))
           (result (emacs-operator-adapters-analyze
                    "infer_extract_parameters"
                    `(("bounds" . [,start ,end]))
                    (emacs-operator-adapter-context)
                    "lisp")))
      (should (equal (alist-get "adapter" result nil nil #'equal) "lisp"))
      (should (= tick (buffer-chars-modified-tick))))))

(ert-deftest emacs-operator-alpha10-project-rename-preview-apply-rollback ()
  (let* ((directory (make-temp-file "eo-alpha10-" t))
         (file (expand-file-name "sample.el" directory))
         (plan-id "alpha10-test-plan")
         buffer
         journal-id)
    (unwind-protect
        (progn
          (with-temp-file file
            (insert "(foo)\n"))
          (setq buffer (find-file-noselect file))
          (with-current-buffer buffer
            (emacs-lisp-mode)
            (let* ((sha (emacs-operator--alpha9-buffer-sha256 buffer))
                   (now (float-time))
                   (file-entry
                    `((path . "sample.el")
                      (absolute_path . ,file)
                      (sha256 . ,sha)
                      (buffer_tick . ,(buffer-chars-modified-tick))
                      (bytes . ,(buffer-size))
                      (edits . (((start . 2)
                                 (end . 5)
                                 (line . 1)
                                 (column . 1)
                                 (old_text . "foo")
                                 (new_text . "bar"))))))
                   (plan
                    `((version . 2)
                      (kind . "lisp_project_rename")
                      (root . ,(file-name-as-directory directory))
                      (old_symbol . "foo")
                      (new_symbol . "bar")
                      (files . (,file-entry))
                      (total_edits . 1)
                      (plan_id . ,plan-id)
                      (created_at . ,now)
                      (expires_at . ,(+ now 300)))))
              (puthash plan-id plan emacs-operator--project-rename-plans)
              (let ((preview (emacs-operator-project-rename-preview plan-id 10)))
                (should (= (alist-get 'total_edits preview) 1))
                (should (string-match-p "bar" (prin1-to-string preview))))
              (let ((applied (emacs-operator-project-rename-apply plan-id)))
                (setq journal-id (alist-get 'journal_id applied))
                (should (equal (buffer-string) "(bar)\n")))
              (let ((status (emacs-operator-project-rename-journal-status journal-id)))
                (should (equal (alist-get 'journal_id status) journal-id))
                (should (= (length (alist-get 'entries status)) 1))
                (should-not (string-match-p "original_text" (prin1-to-string status))))
              (emacs-operator-project-rename-rollback journal-id)
              (should (equal (buffer-string) "(foo)\n")))))
      (when (buffer-live-p buffer)
        (kill-buffer buffer))
      (ignore-errors (delete-directory directory t)))))


(ert-deftest emacs-operator-alpha11-normalizes-project-rename-language-metadata ()
  (let ((metadata
         (emacs-operator--alpha11-normalize-project-rename-metadata
          "app.calc/sum" "app.calc/add" "clojure" nil "add"
          '(("effective_new_symbol" . "app.calc/add")))))
    (should (equal (nth 0 metadata) "clojure"))
    (should (equal (nth 1 metadata) "preserve_qualification"))
    (should (equal (nth 2 metadata) "add"))
    (should (equal (alist-get "effective_new_symbol" (nth 3 metadata) nil nil #'equal)
                   "app.calc/add")))
  (should-error
   (emacs-operator--alpha11-normalize-project-rename-metadata
    "foo" "bar" "unknown" "exact" "bar" nil)
   :type 'user-error)
  (should-error
   (emacs-operator--alpha11-normalize-project-rename-metadata
    "foo" "bar" "elisp" "unsafe" "bar" nil)
   :type 'user-error))

(ert-deftest emacs-operator-alpha11-project-rename-plan-hash-binds-symbol-semantics ()
  (let* ((base '((version . 2)
                 (kind . "lisp_project_rename")
                 (root . "/tmp/project/")
                 (language . "clojure")
                 (qualification_policy . "leaf_only")
                 (old_symbol . "app.calc/sum")
                 (requested_new_symbol . "add")
                 (new_symbol . "app.calc/add")
                 (symbol_semantics . (("effective_new_symbol" . "app.calc/add")))
                 (files . nil)
                 (total_edits . 0)))
         (changed (copy-tree base)))
    (setf (alist-get 'qualification_policy changed) "exact")
    (should-not
     (equal (secure-hash 'sha256
                         (prin1-to-string
                          (emacs-operator--alpha9-plan-canonical-data base)))
            (secure-hash 'sha256
                         (prin1-to-string
                          (emacs-operator--alpha9-plan-canonical-data changed)))))))

(provide 'emacs-operator-refactor-intelligence-test)
;;; emacs-operator-refactor-intelligence-test.el ends here
