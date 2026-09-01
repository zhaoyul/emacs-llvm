;;; linux-package-acceptance.el --- CI-only package runtime setup -*- lexical-binding: t; -*-

(require 'paredit nil t)
(require 'clojure-mode nil t)
(require 'cider nil t)
(require 'sly nil t)

(defvar emacs-operator-ci-nrepl-port
  (string-to-number (or (getenv "EMACS_OPERATOR_CI_NREPL_PORT") "7888")))
(defvar emacs-operator-ci-slynk-port
  (string-to-number (or (getenv "EMACS_OPERATOR_CI_SLYNK_PORT") "4005")))

(defun emacs-operator-ci-connect-package-runtimes ()
  "Connect the isolated acceptance Emacs to local CI runtimes."
  (when (and (featurep 'cider)
             (fboundp 'cider-connect-clj)
             (> emacs-operator-ci-nrepl-port 0))
    (condition-case err
        (cider-connect-clj
         `(:host "127.0.0.1"
           :port ,emacs-operator-ci-nrepl-port
           :project-dir ,default-directory))
      (error (message "CIDER CI connection failed: %S" err))))
  (when (and (featurep 'sly)
             (fboundp 'sly-connect)
             (> emacs-operator-ci-slynk-port 0))
    (condition-case err
        (sly-connect "127.0.0.1" emacs-operator-ci-slynk-port)
      (error (message "SLY CI connection failed: %S" err)))))

(run-at-time 1 nil #'emacs-operator-ci-connect-package-runtimes)

(provide 'linux-package-acceptance)
;;; linux-package-acceptance.el ends here
