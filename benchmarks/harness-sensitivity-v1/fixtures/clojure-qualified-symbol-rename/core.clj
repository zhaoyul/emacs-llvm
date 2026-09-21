(ns demo.core
  (:require [app.calc :as calc]))

(defn invoice-total [xs]
  (app.calc/sum xs))

(def alias-example calc/sum)
(def documentation "app.calc/sum")
;; Keep app.calc/sum in this comment.
