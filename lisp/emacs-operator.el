(require 'emacs-operator-secure-token)
;;; emacs-operator.el --- LLM-native Emacs operator runtime -*- lexical-binding: t; -*-

(defgroup emacs-operator nil
  "Expose Emacs state and native command semantics to local LLM agents."
  :group 'tools)

(require 'emacs-operator-observe)
(require 'emacs-operator-policy)
(require 'emacs-operator-transaction)
(require 'emacs-operator-keys)
(require 'emacs-operator-navigation)
(require 'emacs-operator-adapter-generic)
(require 'emacs-operator-adapter-lisp)
(require 'emacs-operator-adapter-org)
(require 'emacs-operator-adapter-sly)
(require 'emacs-operator-adapter-cider)
(require 'emacs-operator-bridge)

;;;###autoload
(define-minor-mode emacs-operator-mode
  "Global mode that starts the authenticated local Emacs Operator bridge."
  :global t
  :lighter " EOp"
  (if emacs-operator-mode
      (progn
        (emacs-operator-state-start)
        (emacs-operator-policy-start)
        (emacs-operator-bridge-start))
    (emacs-operator-bridge-stop)
    (emacs-operator-policy-stop)
    (emacs-operator-state-stop)
    (emacs-operator-transaction-clear)))


;; alpha.15 secure token override
(when (fboundp 'emacs-operator--secure-random-token)
  (unless (advice-member-p #'emacs-operator-secure-token-acquire 'emacs-operator--secure-random-token)
    (advice-add 'emacs-operator--secure-random-token :override #'emacs-operator-secure-token-acquire)))
(provide 'emacs-operator)
;;; emacs-operator.el ends here
