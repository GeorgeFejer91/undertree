# Change workflows

## Compiler changes

1. Define the boundary and limits in `compiler.rs`.
2. Keep the active editor source as an in-memory overlay.
3. Preserve approved-root confinement for all imported bytes.
4. Add focused Rust tests for both accepted and rejected input.
5. Run formatting, checking, clippy, tests, and a release build.

## Project and persistence changes

1. Route user root approval through the native dialog.
2. Canonicalize inside Rust before changing managed state.
3. Keep traversal bounded and skip symlinks/generated directories.
4. Preserve expected-digest checks, conflict copies, and atomic replacement.
5. Add path-confinement and persistence tests.

## Frontend changes

1. Treat Tauri responses as asynchronous and possibly stale.
2. Preserve latest-state-wins compile scheduling and revision guards.
3. Revoke replaced Blob URLs.
4. Never add remote assets, inline generated markup, direct filesystem APIs, or shell/network bridges.
5. Render at the checkpoint viewport and compare pane geometry, toolbars, colors, and spacing with the checkpoint screenshot.
6. Run the JavaScript syntax check and the desktop smoke checklist.

## Capabilities or dependency changes

Explain why the new authority is necessary. Prefer an application-specific Rust command over broad plugin permissions. Update `ARCHITECTURE.md`, regenerate Tauri capability artifacts through the normal build, and inspect the generated ACL manifest before handoff.

## Required handoff

Report the branch and commit, commands run, test results, any unverified platform behavior, and any release operation deliberately left manual.
