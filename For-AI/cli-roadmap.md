# CLI compatibility note

The active roadmap is `workflows.md`. This file replaces the former completed-feature catalogue and speculative command backlog; it is retained because existing documentation links here.

The native CLI is an adapter over shared Rust services, not a requirement to expose every author action to AI. Consult the executable's `help`, `src-tauri/src/cli.rs`, and the root README for the implemented grammar. Proposed review-operation names in `agent-editing-protocol.md` are not shipped CLI commands.

Retain current JSON/error conventions, approved-root checks, exclusive project lease, exact live-editor revisions, credential isolation, and unknown-outcome handling. Existing direct/live source replacement belongs to privileged author/developer operation only, never the reviewer capability. Do not add generic shell, URL, filesystem, or approval bypasses.

Read `github-divergence-protocol.md` and `validation/github-cli.md` only when changing those existing features. Disposable fixtures are required for mutations; real manuscript repositories are not test fixtures. Common verification commands live once in `workflows.md`.
