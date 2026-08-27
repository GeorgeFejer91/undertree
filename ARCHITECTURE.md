# UnderTree architecture

UnderTree is a local Tauri application with an embedded Typst compiler. The WebView is presentation-only; the Rust process owns compilation, filesystem policy, and persistence.

~~~text
web/ HTML, CSS, JavaScript
          |
          | typed, capability-scoped Tauri commands
          v
src-tauri/src/commands.rs
          |
          +--> project.rs: approved root, inventory, reads, atomic saves
          |
          +--> compiler.rs: Typst world, validation, layout, SVG pages
~~~

## Compiler boundary

The compiler loads Typst and its embedded default fonts once. Each compile receives the exact editor snapshot and creates a short-lived world with its own file cache. The editor snapshot is authoritative for the active document; imported source and assets are read from the approved project root.

Project-relative imports are canonicalized and rejected if they escape that root. Package imports and additional roots are not supported. Source size, resource size, page count, and total SVG output have explicit upper bounds. Compilation runs on Tauri's blocking pool so editing and window events remain responsive.

## Project and save boundary

A project root enters application state only through the native folder picker. Inventory traversal is depth- and count-bounded, skips symlinks and common generated directories, and exposes only UTF-8 Typst files.

Every opened document carries a SHA-256 digest. A save compares that digest with the current disk content. If another process changed the file, UnderTree first atomically preserves the displaced bytes in `.undertree/conflicts/`, then atomically commits the editor snapshot. The UI accepts a save result only when its revision still matches the editor revision.

## IPC and frontend

Commands are thin adapters over the compiler and project services. Boundary errors are deliberately stable and sanitized. The frontend centralizes command invocation and uses latest-state-wins scheduling: at most one compile runs, with one newest follow-up snapshot retained.

The frontend reuses the checkpoint application's stylesheet and layout vocabulary. Its top bar, activity rail, split file/diagnostic sidebar, editor and preview panes, toolbars, resizers, and status bar are a compatibility contract. Capability labels may change from TeX to Typst, but layout changes require an explicit product decision and a rendered comparison against the checkpoint screenshot.

Compiled pages are returned as SVG strings, converted to Blob URLs, and displayed through image elements. Generated SVG is never inserted into the document as markup.

## Security model

The main WebView receives only the five application commands listed in `src-tauri/capabilities/main.json`. The content security policy denies remote content, objects, frames, forms, and arbitrary connections. The application exposes no shell, network, or generic filesystem command.

The principal remaining risks are resource-heavy legal Typst programs and platform WebView behavior. Compile limits, the blocking pool, a restrictive CSP, release builds, and manual platform smoke tests are the current controls.
