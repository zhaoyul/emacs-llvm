;;; linux-package-acceptance.el --- CI-only package runtime setup -*- lexical-binding: t; -*-

;; Trusted acceptance configuration.  It loads the pinned packages, connects
;; this dedicated Emacs to the local nREPL/Slynk runtimes, and retries until
;; both are reachable (the runtimes may still be starting when Emacs boots).

(require 'paredit nil t)
(require 'clojure-mode nil t)
(require 'cider nil t)
(require 'sly nil t)

(defvar emacs-operator-ci-nrepl-port
  (string-to-number (or (getenv "EMACS_OPERATOR_CI_NREPL_PORT") "7888")))
(defvar emacs-operator-ci-slynk-port
  (string-to-number (or (getenv "EMACS_OPERATOR_CI_SLYNK_PORT") "4005")))
(defvar emacs-operator-ci-connect-attempts 60
  "Remaining connection attempts, one every two seconds.")

;; CIDER resolves the connection for a buffer through sesman links.  The
;; acceptance runner writes its fixtures to a fresh workspace under the system
;; temporary directory, which a real user would have linked as their project.
;; Link the acceptance session to that directory tree explicitly.
(defun emacs-operator-ci-link-cider-session ()
  (when (and (fboundp 'sesman-sessions) (fboundp 'sesman-link-session))
    (let ((session (car (sesman-sessions 'CIDER)))
          (dir (file-name-as-directory (file-truename temporary-file-directory))))
      (when session
        (sesman-link-session 'CIDER session 'directory dir)
        (message "CIDER CI session linked with %s" dir)))))

(defun emacs-operator-ci--cider-connected-p ()
  (and (fboundp 'sesman-sessions) (sesman-sessions 'CIDER)))

(defun emacs-operator-ci--sly-connected-p ()
  (and (fboundp 'sly-connected-p) (sly-connected-p)))

(defun emacs-operator-ci--port-open-p (port)
  (condition-case nil
      (let ((probe (make-network-process :name "emacs-operator-ci-probe"
                                         :host "127.0.0.1" :service port
                                         :noquery t)))
        (delete-process probe)
        t)
    (error nil)))

(defun emacs-operator-ci-connect-package-runtimes ()
  "Connect the isolated acceptance Emacs to local CI runtimes, retrying."
  (when (and (featurep 'cider) (> emacs-operator-ci-nrepl-port 0)
             (not (emacs-operator-ci--cider-connected-p))
             (emacs-operator-ci--port-open-p emacs-operator-ci-nrepl-port))
    (condition-case err
        (cider-connect-clj
         `(:host "127.0.0.1" :port ,emacs-operator-ci-nrepl-port
           :project-dir ,default-directory))
      (error (message "CIDER CI connection failed: %S" err))))
  (when (and (featurep 'sly) (> emacs-operator-ci-slynk-port 0)
             (not (emacs-operator-ci--sly-connected-p))
             (emacs-operator-ci--port-open-p emacs-operator-ci-slynk-port))
    (condition-case err
        (sly-connect "127.0.0.1" emacs-operator-ci-slynk-port)
      (error (message "SLY CI connection failed: %S" err))))
  (setq emacs-operator-ci-connect-attempts (1- emacs-operator-ci-connect-attempts))
  (if (and (or (not (featurep 'cider)) (emacs-operator-ci--cider-connected-p))
           (or (not (featurep 'sly)) (emacs-operator-ci--sly-connected-p)))
      (message "Emacs Operator CI package runtimes connected")
    (when (> emacs-operator-ci-connect-attempts 0)
      (run-at-time 2 nil #'emacs-operator-ci-connect-package-runtimes))))

;; The dedicated acceptance frame must keep its target buffer selected: the
;; later native X11 gate types into whatever window has focus.  CIDER can be
;; told not to pop its REPL; SLY pops its mREPL from `sly-connected-hook'
;; unconditionally, so restore the pre-connection buffer afterwards (without
;; touching that buffer's point).
(setq cider-repl-pop-to-buffer-on-connect nil)
(defvar emacs-operator-ci--selected-buffer nil)

(defun emacs-operator-ci-restore-selected-buffer ()
  (let ((buffer emacs-operator-ci--selected-buffer))
    (when (buffer-live-p buffer)
      (let ((frame (window-frame (get-buffer-window buffer t))))
        (with-selected-frame (or frame (selected-frame))
          (delete-other-windows)
          (switch-to-buffer buffer 'norecord 'force-same-window))))))

(defun emacs-operator-ci--remember-selected-buffer ()
  (unless emacs-operator-ci--selected-buffer
    (setq emacs-operator-ci--selected-buffer (window-buffer (selected-window)))))

(add-hook 'cider-connected-hook #'emacs-operator-ci-link-cider-session)
(add-hook 'cider-connected-hook #'emacs-operator-ci-restore-selected-buffer 90)
(add-hook 'sly-connected-hook #'emacs-operator-ci-restore-selected-buffer 90)
(run-at-time 1 nil (lambda ()
                     (emacs-operator-ci--remember-selected-buffer)
                     (emacs-operator-ci-connect-package-runtimes)))

(provide 'linux-package-acceptance)
;;; linux-package-acceptance.el ends here
