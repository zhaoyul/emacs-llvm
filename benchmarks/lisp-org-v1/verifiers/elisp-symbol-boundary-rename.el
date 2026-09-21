;;; elisp-symbol-boundary-rename.el --- Benchmark verifier -*- lexical-binding: t; -*-
(require 'invoice)
(unless (fboundp 'invoice-subtotal) (error "invoice-subtotal is not defined"))
(when (fboundp 'invoice-total) (error "the old function invoice-total is still defined"))
(let ((model (render-invoice '(10 20 12))))
  (unless (equal (plist-get model :subtotal) 42) (error "render-invoice behavior changed"))
  (unless (eq (plist-get model :calculator) #'invoice-subtotal) (error "function reference was not renamed"))
  (unless (eq (plist-get model :qualified) 'billing/invoice-total) (error "qualified symbol was incorrectly changed"))
  (unless (equal (plist-get model :documentation) "invoice-total") (error "string content was incorrectly changed")))
(with-temp-buffer
  (insert-file-contents "invoice.el")
  (goto-char (point-min))
  (unless (search-forward ";; The documentation name invoice-total" nil t) (error "comment content was incorrectly changed")))
(princ "BENCHMARK_PASS elisp-symbol-boundary-rename\n")
