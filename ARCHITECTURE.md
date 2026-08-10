# LocalTeX Studio architecture

LocalTeX Studio is an original offline workspace inspired by the visible
left-editor-preview interaction model of online LaTeX editors. It does not
contain Overleaf HTML, JavaScript, images, branding, cookies, or private API
code.

## Process model

```text
Native LocalTeX Studio GTK/WebKit window
        (bundled HTML/CSS/CodeMirror/PDF.js)
                    │ localhost HTTP + authenticated JSON
                    ▼
Node standard-library service on 127.0.0.1:37371
        ├── canonical project inventory and icons
        ├── atomic, project-root-confined text saves
        ├── tex-sync / latexmk builds
        ├── generated PDF streaming
        ├── local full-project text search
        ├── read-only Git status
        ├── explicit safe pull/push bridge actions
        └── project-aware desktop file opening
```

The systemd user service keeps the local API available without internet. The
desktop launcher starts an independent GTK application backed by the operating
system's WebKitGTK runtime. Brave and the user's ordinary browser session are
not involved. A single-instance application identity raises the existing
LocalTeX Studio window when it is launched again.

## Security boundary

- The service binds only to `127.0.0.1`.
- The native shell permits in-app navigation only to the localhost origin and
  delegates external links to the operating system.
- The WebKit context is ephemeral, so the bootstrap cookie is not kept in a
  general-purpose browser profile.
- A random user-only token bootstraps an `HttpOnly`, `SameSite=Strict` cookie.
- Mutating APIs require same-origin JSON requests.
- Every path is resolved below an inventory-approved project root.
- Traversal, absolute paths, outside-project symlinks, oversized text, and
  unsupported binary editing are rejected.
- Saves use a same-directory temporary file and atomic rename, with modification
  time conflict detection.
- Sync uses existing repository protocols and never force-pushes.

## Clean-room UI mapping

The live reference was used only to measure observable behavior: a 40 px dark
top bar, icon rail and file tree on the left, syntax editor in the middle,
Recompile/PDF/log tools on the right, draggable dividers, compact 4 px controls,
pill-shaped primary actions, and a dark green/charcoal palette. All source in
this package was independently written for the local workflow.
