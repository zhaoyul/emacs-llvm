(ns bench.app
  (:require [bench.math :as math]))

(defn invoice-total [xs]
  (math/sum xs))

(def documentation "math/sum")
;; The example math/sum must remain in this comment.
