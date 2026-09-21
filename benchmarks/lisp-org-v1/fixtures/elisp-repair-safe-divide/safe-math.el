;;; safe-math.el --- Small benchmark fixture -*- lexical-binding: t; -*-

(defun safe-divide (numerator denominator)
  "Return NUMERATOR divided by DENOMINATOR, or nil when it is zero."
  (/ numerator denominator))

(defun safe-divide-demo ()
  "Return representative safe-divide results."
  (list (safe-divide 10 2)
        (safe-divide 10 0)))

(provide 'safe-math)
;;; safe-math.el ends here
