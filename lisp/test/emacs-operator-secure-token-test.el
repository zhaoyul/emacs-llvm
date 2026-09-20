;;; emacs-operator-secure-token-test.el --- Tests -*- lexical-binding: t; -*-
(require 'ert)
(require 'cl-lib)
(require 'emacs-operator-secure-token)

(defmacro emacs-operator-secure-token-test--with-directory (&rest body)
  `(let ((directory (make-temp-file "emacs-operator-token-test-" t)))
     (unwind-protect
         (progn
           (set-file-modes directory #o700)
           ,@body)
       (ignore-errors (delete-directory directory t)))))

(ert-deftest emacs-operator-secure-token-reads-private-file ()
  (emacs-operator-secure-token-test--with-directory
   (let ((path (expand-file-name "token" directory))
         (value (make-string 64 ?a)))
     (with-temp-file path (insert value "\n"))
     (set-file-modes path #o600)
     (should (equal value (emacs-operator-secure-token-read-file path))))))

(ert-deftest emacs-operator-secure-token-rejects-permissive-mode ()
  (emacs-operator-secure-token-test--with-directory
   (let ((path (expand-file-name "token" directory)))
     (with-temp-file path (insert (make-string 64 ?b) "\n"))
     (set-file-modes path #o644)
     (should-error (emacs-operator-secure-token-read-file path)))))

(ert-deftest emacs-operator-secure-token-rejects-invalid-format ()
  (emacs-operator-secure-token-test--with-directory
   (let ((path (expand-file-name "token" directory)))
     (with-temp-file path (insert (make-string 64 ?Z) "\n"))
     (set-file-modes path #o600)
     (should-error (emacs-operator-secure-token-read-file path)))))

(ert-deftest emacs-operator-secure-token-rejects-symlink ()
  (emacs-operator-secure-token-test--with-directory
   (let ((real (expand-file-name "real" directory))
         (link (expand-file-name "token" directory)))
     (with-temp-file real (insert (make-string 64 ?c) "\n"))
     (set-file-modes real #o600)
     (condition-case _
         (progn
           (make-symbolic-link real link)
           (should-error (emacs-operator-secure-token-read-file link)))
       (file-error (ert-skip "Symbolic links unavailable"))))))

(ert-deftest emacs-operator-secure-token-env-file-wins ()
  (emacs-operator-secure-token-test--with-directory
   (let ((path (expand-file-name "token" directory))
         (process-environment (copy-sequence process-environment))
         (value (make-string 64 ?d)))
     (with-temp-file path (insert value "\n"))
     (set-file-modes path #o600)
     (setenv "EMACS_OPERATOR_TOKEN_FILE" path)
     (cl-letf (((symbol-function 'emacs-operator-secure-token-generate-fallback)
                (lambda () (ert-fail "fallback must not run"))))
       (should (equal value (emacs-operator-secure-token-acquire)))))))

(ert-deftest emacs-operator-secure-token-fallback-is-256-bit-hex ()
  (let ((process-environment (copy-sequence process-environment)))
    (setenv "EMACS_OPERATOR_TOKEN_FILE" nil)
    (cl-letf (((symbol-function 'emacs-operator-secure-token--gnutls-bytes)
               (lambda () (make-string 32 255)))
              ((symbol-function 'emacs-operator-secure-token--process-bytes)
               (lambda () (ert-fail "secondary fallback must not run"))))
      (should (equal (make-string 64 ?f)
                     (emacs-operator-secure-token-generate-fallback))))))

(ert-deftest emacs-operator-secure-token-hexify-rejects-non-octet-character ()
  (should-error
   (emacs-operator-secure-token--hexify (make-string 1 #x100))
   :type 'error))

(provide 'emacs-operator-secure-token-test)
;;; emacs-operator-secure-token-test.el ends here
