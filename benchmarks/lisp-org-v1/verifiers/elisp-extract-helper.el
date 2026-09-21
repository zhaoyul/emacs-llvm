;;; elisp-extract-helper.el --- Benchmark verifier -*- lexical-binding: t; -*-
(require 'invoice-calc)
(unless (fboundp 'invoice-subtotal) (error "invoice-subtotal was not extracted"))
(let ((items '((:price 10) (:price 20) (:price 10))))
  (unless (equal (invoice-subtotal items) 40) (error "invoice-subtotal returned the wrong value"))
  (unless (equal (invoice-grand-total items 0.05) 42.0) (error "invoice-grand-total behavior changed")))
(with-temp-buffer
  (insert-file-contents "invoice-calc.el")
  (goto-char (point-min))
  (unless (re-search-forward "(invoice-subtotal[[:space:]]+items)" nil t)
    (error "invoice-grand-total does not call invoice-subtotal with items")))
(princ "BENCHMARK_PASS elisp-extract-helper\n")
