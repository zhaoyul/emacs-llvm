;;; invoice.el --- Rename benchmark fixture -*- lexical-binding: t; -*-

(defun invoice-total (items)
  "Return the subtotal for ITEMS."
  (apply #'+ items))

(defun render-invoice (items)
  "Return a small invoice model."
  (list :subtotal (invoice-total items)
        :calculator #'invoice-total
        :qualified 'billing/invoice-total
        :documentation "invoice-total"))

;; The documentation name invoice-total must remain readable in this comment.

(provide 'invoice)
;;; invoice.el ends here
