# Smart file viewer validation protocol

This protocol is orchestration-only. Keep commands, expected behavior, test notes, and durable results here. Any generated projects, screenshots, logs, or binaries belong under ignored `tmp/` paths and must be deleted after results are recorded.

## Policy matrix

| Category | Examples | Default visible | Editable |
| --- | --- | --- | --- |
| Typst | `.typ` | Yes | Yes |
| Generated LaTeX | `*.undertree-export*.tex` | Yes | Yes |
| Original LaTeX | `.tex` | No | No |
| Bibliography | `.bib` | Yes | Yes |
| PDF | `.pdf` | No | No |
| Image | `.png`, `.jpg`, `.svg`, `.webp` | No | No |
| Other | `.cls`, `.sty`, `.txt`, data and support files | No | No |

`Show all files` overrides category visibility but never overrides native editability or inventory exclusions. `.git`, `.undertree`, `node_modules`, `target`, symlinks, non-Unicode non-editable paths, excessive depth, and projects over the entry budget remain outside the WebView inventory.

## Required checks

1. Create a disposable project containing one example from every category.
2. Open it and confirm the focused view shows only Typst, generated LaTeX, and BibTeX.
3. Toggle each category independently and confirm the shown/hidden count updates.
4. Enable `Show all files`; confirm every bounded user-project file appears and category controls are temporarily disabled.
5. Disable `Show all files`; confirm the previous category choices resume.
6. Open each editable category and verify save confinement and conflict preservation.
7. Select each read-only category and verify no `open_document` invocation occurs and no content reaches the WebView.
8. Refresh after adding and removing files externally and confirm the inventory updates without changing the filter choices.
9. Run `cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings`, `node --check web/app.js`, and `git diff --check`.

## Current result

On 2026-08-28 the Rust inventory regression fixture passed for all seven categories, default visibility, editability, original-LaTeX preservation, and complete metadata refresh as part of the 62-test active suite. Strict Clippy, Rust formatting, frontend syntax, and diff checks passed. A rendered local-browser check confirmed the compact two-column filter layout at the application viewport, focused defaults, retained scratch `main.typ`, the Show all count, and disabled category controls while the override is active. Read-only asset selection remains a frontend status-only action and never invokes `open_document`.
