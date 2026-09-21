;;; emacs-operator-secure-token.el --- Private bridge token acquisition -*- lexical-binding: t; -*-

;; This file is part of Emacs Operator.

;;; Commentary:
;; Prefer a launcher-generated, owner-only token file.  Autonomous Emacs
;; startup falls back to an operating-system CSPRNG without seeking within
;; /dev/urandom, which is not portable across all Emacs 30 runtimes.

;;; Code:

(require 'cl-lib)
(require 'subr-x)

(defgroup emacs-operator-secure-token nil
  "Secure token acquisition for Emacs Operator."
  :group 'applications)

(defcustom emacs-operator-token-file-environment-variable
  "EMACS_OPERATOR_TOKEN_FILE"
  "Environment variable containing the launcher-generated token path."
  :type 'string)

(defun emacs-operator-secure-token--hexify (bytes)
  "Return lowercase hexadecimal representation of byte string BYTES.
Each character must represent exactly one octet in the range 0..255.  Do not
pass BYTES through `string-as-unibyte', because converting a multibyte test
fixture such as character 255 would UTF-8 encode it as two octets."
  (unless (stringp bytes)
    (error "E_TOKEN_BYTES_TYPE: CSPRNG output must be a string"))
  (apply #'concat
         (mapcar (lambda (byte)
                   (unless (and (integerp byte) (<= 0 byte) (<= byte #xff))
                     (error "E_TOKEN_BYTE_RANGE: CSPRNG output contains a non-octet"))
                   (format "%02x" byte))
                 (string-to-list bytes))))

(defun emacs-operator-secure-token--private-mode-p (modes)
  "Return non-nil when MODES grants no group or other access."
  (and (integerp modes) (zerop (logand modes #o077))))

(defun emacs-operator-secure-token-read-file (path)
  "Read and validate a 256-bit lowercase hexadecimal token from PATH.
PATH and every resolved component must be local and non-symlinked.  The file
must be regular, owned by the current user, and grant no group/other access."
  (unless (and (stringp path) (file-name-absolute-p path) (not (file-remote-p path)))
    (error "E_TOKEN_FILE_PATH: token path must be an absolute local path"))
  (let* ((expanded (expand-file-name path))
         (attributes (file-attributes expanded 'integer))
         (modes (and attributes (file-modes expanded)))
         (owner (and attributes (file-attribute-user-id attributes)))
         (size (and attributes (file-attribute-size attributes))))
    (unless attributes
      (error "E_TOKEN_FILE_MISSING: %s" expanded))
    (when (file-symlink-p expanded)
      (error "E_TOKEN_FILE_SYMLINK: %s" expanded))
    (unless (string= expanded (file-truename expanded))
      (error "E_TOKEN_FILE_SYMLINK_COMPONENT: %s" expanded))
    (unless (null (file-attribute-type attributes))
      (error "E_TOKEN_FILE_TYPE: %s" expanded))
    (unless (or (not (fboundp 'user-uid))
                (not (integerp owner))
                (= owner (user-uid)))
      (error "E_TOKEN_FILE_OWNER: %s" expanded))
    (unless (emacs-operator-secure-token--private-mode-p modes)
      (error "E_TOKEN_FILE_MODE: %s" expanded))
    (unless (and (integerp size) (<= 64 size) (<= size 66))
      (error "E_TOKEN_FILE_SIZE: %s" expanded))
    (with-temp-buffer
      (set-buffer-multibyte nil)
      (insert-file-contents-literally expanded)
      (let ((value (string-trim (buffer-string))))
        (unless (string-match-p "\\`[0-9a-f]\\{64\\}\\'" value)
          (error "E_TOKEN_FILE_FORMAT: %s" expanded))
        value))))

(defun emacs-operator-secure-token--gnutls-bytes ()
  "Return 32 bytes from Emacs' GnuTLS CSPRNG, or nil when unavailable."
  (when (fboundp 'gnutls-random)
    (condition-case nil
        (let ((bytes (gnutls-random 32)))
          (and (stringp bytes) (= (length bytes) 32) bytes))
      (error nil))))

(defun emacs-operator-secure-token--process-bytes ()
  "Return 32 bytes from /dev/urandom via a no-shell process, or nil.
This avoids passing a seek offset to `insert-file-contents-literally'."
  (let ((head (executable-find "head")))
    (when (and head (file-readable-p "/dev/urandom"))
      (with-temp-buffer
        (set-buffer-multibyte nil)
        (when (and (zerop (call-process head nil t nil "-c" "32" "/dev/urandom"))
                   (= (buffer-size) 32))
          (buffer-string))))))

(defun emacs-operator-secure-token-generate-fallback ()
  "Generate a 256-bit token using an operating-system CSPRNG.
No weak PRNG fallback is provided."
  (let ((bytes (or (emacs-operator-secure-token--gnutls-bytes)
                   (emacs-operator-secure-token--process-bytes))))
    (unless bytes
      (error "E_CSPRNG_UNAVAILABLE: launcher token file is required"))
    (emacs-operator-secure-token--hexify bytes)))

(defun emacs-operator-secure-token-acquire (&rest _ignored)
  "Acquire a token from a private launcher file or secure fallback.
Arguments are ignored so this function can safely advise legacy zero-argument
token generators."
  (let ((path (getenv emacs-operator-token-file-environment-variable)))
    (if (and path (not (string-empty-p path)))
        (emacs-operator-secure-token-read-file path)
      (emacs-operator-secure-token-generate-fallback))))

(provide 'emacs-operator-secure-token)
;;; emacs-operator-secure-token.el ends here
