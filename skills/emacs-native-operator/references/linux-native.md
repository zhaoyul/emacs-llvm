# Linux native execution

- Alpha.13 supports native desktop operations only through the `x11_xtest` backend.
- Require `native_keyboard`, `window_focus`, `frontmost_query`, or `window_capture` individually before using each operation.
- A Wayland-only session deliberately returns `backend=unavailable`; continue with semantic or internal-key operations.
- XWayland support applies only when the target Emacs frame is an X11/XWayland window.
- uinput is detected but not implemented as a backend.
- X11 user-interference detection is unavailable. Keep native sequences short and use a controlled desktop session.
- Cursor capture is unsupported. Do not request `include_cursor=true`.
- Always verify the resulting Emacs state through the Bridge and restore the prior foreground window when requested.
