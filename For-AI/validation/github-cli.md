# Native GitHub CLI validation

This is an orchestration and result ledger only. Keep temporary repositories, logs, screenshots, credentials, and generated command output outside `For-AI/`, under an ignored `tmp/` location when a disposable artifact is necessary. Never record tokens or credential-store contents.

## Contract

- No arguments starts the Tauri editor; command arguments select the console path before Tauri startup.
- Commands call UnderTree's Rust services directly and never invoke Git, GitHub CLI, GitHub Desktop, a shell, or a generic HTTP/filesystem bridge.
- `--json` returns existing sanitized DTOs and stable errors without tokens or document contents.
- `status` and `doctor` are read-only. Mutating project commands hold `.undertree/project.lock` for their lifetime.
- The desktop and CLI use the same compiled OAuth identity, OS credential-store session, project approval, remote/branch checks, libgit2 authentication, TLS verification, transfer limits, and non-force synchronization policy.
- `sync` moves committed history only and rejects a dirty working tree. `commit-and-sync` requires an explicit message and is the only manual CLI command that stages local changes before synchronization.

## Required checks

1. Run `undertree-typst help` and `version`; confirm neither opens a Tauri window.
2. Run parser unit tests for Unicode paths, unknown options, duplicates, invalid intervals, and unrecognized token options.
3. Run `github status --json` without a project and confirm no credential value is serialized.
4. Run `github doctor --project PATH --json` against an approved disposable project and confirm repository, branch, write capability, divergence, and bounded changes.
5. Hold a project with one owner and verify a second desktop/CLI `ProjectState` receives `project_in_use`; release the first and retry successfully.
6. On a dirty disposable project, verify `sync` returns `uncommitted_changes` before network mutation.
7. Run `commit-and-sync` with a deliberate test commit; verify fetch, normal merge/fast-forward policy, push, clean status, and matching remote commit.
8. Re-run full Rust formatting, checking, strict Clippy, tests, frontend syntax, diff checks, and the optimized Windows build.

## Grant-project diagnosis — 2026-08-28

`github doctor` used UnderTree's compiled client and stored OS credential session against the local `GeorgeFejer91/grants` checkout. It confirmed:

- authenticated account `GeorgeFejer91`;
- approved repository `GeorgeFejer91/grants` on `main` with write access;
- zero known ahead/behind divergence;
- 127 visible untracked `.typ` files produced by the preservation-first conversion pass;
- automatic synchronization disabled and automatic commits disabled.

Therefore authorization, repository selection, origin matching, and the embedded HTTPS transport were not the blocker. The files were not in Git history, so ordinary Sync had nothing new to push. The safe resolution is an explicit reviewed `commit-and-sync` operation, or opt-in automatic commits for later scheduled synchronization.
