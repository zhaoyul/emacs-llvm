Refactor `invoice-calc.el` by extracting the subtotal calculation into a new function named `invoice-subtotal`.

`invoice-grand-total` must call the new helper and retain its behavior. Choose a clear, minimal parameter list derived from the selected calculation. Keep both functions structurally valid and do not modify `DO_NOT_TOUCH.txt`.
