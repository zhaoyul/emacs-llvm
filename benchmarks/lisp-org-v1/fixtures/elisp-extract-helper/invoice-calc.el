;;; invoice-calc.el --- Extract-function benchmark -*- lexical-binding: t; -*-

(defun invoice-grand-total (items tax-rate)
  "Return the total of ITEMS after applying TAX-RATE."
  (let* ((subtotal (apply #'+ (mapcar (lambda (item) (plist-get item :price)) items)))
         (tax (* subtotal tax-rate)))
    (+ subtotal tax)))

(provide 'invoice-calc)
;;; invoice-calc.el ends here
