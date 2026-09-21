# Emacs Operator MCPB alpha

This MCPB contains the zero-dependency Node.js MCP server plus companion copies of the Emacs Lisp Bridge and Agent Skill.

The package deliberately does not modify the user's Emacs configuration and does not install a native desktop Host. Benchmark, test-harness, acceptance, and external Agent experiment assets are excluded from the production bundle.

After installing the MCPB server:

1. Install `companion/lisp/` into an Emacs load path and enable `emacs-operator-mode`.
2. Install or copy `companion/skill/emacs-native-operator/` into the Agent Skills location used by the selected Agent host.
3. On macOS, install and launch `EmacsOperatorHost.app` when `native_keys` or `emacs_capture` is required.
4. On Linux/X11, install and launch the separate Linux Host when `native_keys` or `emacs_capture` is required. Wayland-native and uinput backends are not implemented in Alpha.13.
5. `semantic` and `internal_keys` require only the Emacs Bridge and do not require a native desktop Host.

The MCP server, Emacs Bridge, and native Host discover one another through private per-user runtime records and random local tokens.

High-level workflows are checkpoint-managed Buffer transactions. Already-produced REPL, Babel, process, filesystem, network, or database side effects are not generally reversible when a Buffer is rolled back.
