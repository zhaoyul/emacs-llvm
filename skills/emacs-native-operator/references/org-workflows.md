# Org workflows

Observe with adapter scope before structural Org changes. The Org adapter exposes heading title, level, outline path, TODO state, tags, subtree bounds, properties, element context, current table context, Babel block context, and parser validity.

Prefer deterministic Org wrappers or Org interactive commands over raw-text editing of stars, drawers, tables, and result blocks. Semantic wrappers include heading insertion, promote/demote, subtree movement, TODO changes, property changes, ID creation, table cell updates, table alignment, and table recalculation.

For a table update, keep point inside the table, inspect its `dimensions`, `row`, `column`, and `bounds`, then call `emacs-operator-org-table-set-cell` non-interactively through `emacs_command`. Row and column are positive logical table coordinates. Re-observe the table after mutation.

Babel execution is deliberately separate from document editing. Use `emacs_eval` with `operation="execute_babel"`, optionally `adapter="org"`, only under `trusted_local`. The adapter executes only the source block already present at point. It does not accept caller source code and it does not enable Babel languages disabled by the user's Emacs configuration. Inspect `completed`, `condition`, `value`, and Babel metadata before continuing.

After heading/subtree/property/table mutations, inspect `adapter_verification` and observe the Org tree again. A multi-step Org mutation should use one checkpoint. Export and archive remain external-side-effect decisions and must never be inferred merely from permission to edit Org text.
