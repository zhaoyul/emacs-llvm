(ns bench.math)

(defn sum
  "Return the sum of XS."
  [xs]
  (reduce + 0 xs))
