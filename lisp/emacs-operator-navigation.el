;;; emacs-operator-navigation.el --- Semantic point navigation -*- lexical-binding: t; -*-

(require 'cl-lib)
(require 'subr-x)
(require 'emacs-operator-observe)
(require 'emacs-operator-policy)

(defconst emacs-operator-navigation--operations
  '("goto_position" "goto_line" "buffer_start" "buffer_end"
    "line_start" "line_end" "search_forward" "search_backward"
    "forward_sexp" "backward_sexp" "beginning_of_defun" "end_of_defun"
    "up_list" "down_list")
  "Semantic navigation operations exposed to agents.")

(defun emacs-operator-navigation--positive-count (params)
  (let ((count (or (emacs-operator--get params "count") 1)))
    (unless (and (integerp count) (> count 0) (<= count 10000))
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Navigation count must be an integer from 1 to 10000."))
    count))

(defun emacs-operator-navigation--goto-line (line)
  (unless (and (integerp line) (> line 0))
    (emacs-operator-signal "E_INVALID_ARGUMENT" "goto_line requires a positive 1-based line number."))
  (goto-char (point-min))
  (forward-line (1- line))
  (when (< (line-number-at-pos (point) t) line)
    (emacs-operator-signal "E_TARGET_NOT_FOUND" "Requested line is beyond the accessible buffer."
                           `(("line" . ,line))))
  (point))

(defun emacs-operator-navigation--search (params backward)
  (let* ((query (emacs-operator--get params "query"))
         (regexp (emacs-operator--truthy-json-p (emacs-operator--get params "regex")))
         (case-sensitive (emacs-operator--truthy-json-p (emacs-operator--get params "case_sensitive")))
         (count (emacs-operator-navigation--positive-count params))
         (bound (emacs-operator--get params "bound"))
         (noerror t)
         (case-fold-search (not case-sensitive))
         found)
    (unless (and (stringp query) (> (length query) 0) (<= (length query) 8192))
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Search query must be a non-empty string up to 8192 characters."))
    (when bound
      (unless (and (integerp bound) (<= (point-min) bound) (<= bound (point-max)))
        (emacs-operator-signal "E_INVALID_ARGUMENT" "Search bound is outside the accessible buffer.")))
    (dotimes (_ count)
      (setq found
            (cond
             ((and backward regexp) (re-search-backward query bound noerror 1))
             (backward (search-backward query bound noerror 1))
             (regexp (re-search-forward query bound noerror 1))
             (t (search-forward query bound noerror 1))))
      (unless found
        (emacs-operator-signal "E_TARGET_NOT_FOUND" "Search did not find the requested occurrence."
                               `(("query" . ,query)
                                 ("direction" . ,(if backward "backward" "forward"))
                                 ("count" . ,count)))))
    found))

(defun emacs-operator-navigation-execute (params)
  "Move point in TARGET without mutating buffer contents.

The operation is deterministic and does not use the minibuffer or OS input."
  (let* ((target (emacs-operator--get params "target"))
         (operation (emacs-operator--get params "operation"))
         (precondition (emacs-operator--get params "precondition")))
    (unless (member operation emacs-operator-navigation--operations)
      (emacs-operator-signal "E_INVALID_ARGUMENT" "Unsupported navigation operation."
                             `(("operation" . ,operation))))
    (emacs-operator-check-precondition target precondition)
    (emacs-operator-call-in-target
     target nil t
     (lambda (buffer _window _frame)
       (with-current-buffer buffer
         (let ((before (point))
               (tick (buffer-chars-modified-tick)))
           (condition-case err
               (pcase operation
                 ("goto_position"
                  (let ((position (emacs-operator--get params "position")))
                    (unless (and (integerp position) (<= (point-min) position) (<= position (point-max)))
                      (emacs-operator-signal "E_INVALID_ARGUMENT" "goto_position is outside the accessible buffer."))
                    (goto-char position)))
                 ("goto_line" (emacs-operator-navigation--goto-line (emacs-operator--get params "line")))
                 ("buffer_start" (goto-char (point-min)))
                 ("buffer_end" (goto-char (point-max)))
                 ("line_start" (beginning-of-line (emacs-operator-navigation--positive-count params)))
                 ("line_end" (end-of-line (emacs-operator-navigation--positive-count params)))
                 ("search_forward" (emacs-operator-navigation--search params nil))
                 ("search_backward" (emacs-operator-navigation--search params t))
                 ("forward_sexp" (forward-sexp (emacs-operator-navigation--positive-count params)))
                 ("backward_sexp" (backward-sexp (emacs-operator-navigation--positive-count params)))
                 ("beginning_of_defun" (beginning-of-defun (emacs-operator-navigation--positive-count params)))
                 ("end_of_defun" (end-of-defun (emacs-operator-navigation--positive-count params)))
                 ("up_list" (up-list (emacs-operator-navigation--positive-count params)))
                 ("down_list" (down-list (emacs-operator-navigation--positive-count params))))
             (scan-error
              (emacs-operator-signal "E_TARGET_NOT_FOUND" "Structural navigation could not reach the requested location."
                                     `(("operation" . ,operation)
                                       ("condition" . ,(error-message-string err)))))
             (error
              (if (eq (car err) 'emacs-operator-error)
                  (signal (car err) (cdr err))
                (emacs-operator-signal "E_COMMAND_FAILED" "Navigation operation failed."
                                       `(("operation" . ,operation)
                                         ("condition" . ,(error-message-string err)))))))
           (unless (= tick (buffer-chars-modified-tick))
             (emacs-operator-signal "E_COMMAND_FAILED" "A navigation operation unexpectedly mutated the target buffer."
                                    `(("operation" . ,operation))))
           `(("operation" . ,operation)
             ("buffer_id" . ,(emacs-operator-buffer-id buffer))
             ("buffer_tick" . ,tick)
             ("point_before" . ,before)
             ("point_after" . ,(point))
             ("line" . ,(line-number-at-pos (point) t))
             ("column" . ,(current-column)))))))))

(provide 'emacs-operator-navigation)
;;; emacs-operator-navigation.el ends here
