# Electron removal scope

Requested: remove obsolete Electron assets while retaining Rust/Tauri/HTML and
the existing TeX compatibility modules.

Allowed changes: `native/windows/`, its sole compiler utility-process entry,
the obsolete CLI environment workaround, architecture validation and its focused
test, the performance document's current architecture statement, and narrow
canonical For-AI references to retained Electron sources. Other agents own
Windows packaging and Rust filesystem portability; their changes are excluded
from this scope.

Preserved contracts: Rust review authority, the Tauri shell, browser frontend,
local CLI behavior, ordinary TeX compilation and historical verification evidence.
Do not change manifests, notices, unrelated modules or historical source links.

Initial Git status was clean. The existing architecture-stack test passed on
2026-10-16. This scoped note supplements the main session's shared scope record.
