;;; emacs-operator-cider-test.el --- CIDER adapter ERT tests -*- lexical-binding: t; -*-

(require 'ert)
(require 'cl-lib)
(require 'emacs-operator)
(require 'emacs-operator-adapter-cider)

(ert-deftest emacs-operator-cider-sync-eval-passes-connection-before-namespace ()
  "Keep the CIDER 2.x sync-eval positional contract locked down."
  (let (captured)
    (cl-letf (((symbol-function 'emacs-operator-cider--ready-state)
               (lambda () '(t . nil)))
              ((symbol-function 'emacs-operator-cider--namespace)
               (lambda () "demo.ns"))
              ((symbol-function 'emacs-operator-cider--connection)
               (lambda () 'fake-connection))
              ((symbol-function 'emacs-operator-repl-source-metadata)
               (lambda (&rest _args) '(("operation" . "eval_defun"))))
              ((symbol-function 'cider-nrepl-sync-request:eval)
               (lambda (input &optional connection namespace)
                 (setq captured (list input connection namespace))
                 '(dict "value" "42" "status" ("done")))))
      (let ((result
             (emacs-operator-cider--eval-source
              "(defn demo [x] (+ x 1))"
              '(("operation" . "eval_defun") ("timeout_ms" . 1000)))))
        (should (equal captured
                       '("(defn demo [x] (+ x 1))" fake-connection "demo.ns")))
        (should (eq (emacs-operator--get result "completed") t))
        (should (equal (emacs-operator--get result "value") "42"))))))

(ert-deftest emacs-operator-cider-dict-get-supports-nrepl-dict-shape ()
  "Read the flat plist-like nREPL dict returned by CIDER 2.x."
  (let ((response '(dict "value" "42" "out" "hello" "status" ("done"))))
    (should (equal (emacs-operator-cider--dict-get response "value") "42"))
    (should (equal (emacs-operator-cider--dict-get response "out") "hello"))
    (should (equal (emacs-operator-cider--dict-get response "status") '("done")))
    (should-not (emacs-operator-cider--dict-get response "missing"))))

(provide 'emacs-operator-cider-test)
;;; emacs-operator-cider-test.el ends here
