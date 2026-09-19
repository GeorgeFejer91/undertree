# Change and verification workflow

## Approval and scope

This first pass is documentation only. Never interpret a design example as a request to edit a manuscript, run a migration, expose an endpoint, or publish anything. After George reviews the roadmap and authorizes implementation, work in small branch/commit slices from the then-current `typst-main`; inspect dirty state before touching a local checkout. Do not reset, switch, or overwrite the user's active work. Preserve a known checkpoint before runtime retirement.

Read `README.md`, the relevant constraints, and the owning module; consult audit/research only for the affected question. Use current code as evidence for existing behavior and these reviewed documents for intended changes. Do not import the old LaTeX `main` architecture into the Typst branch.

For each implementation slice: establish a baseline, define the smallest acceptance test, reuse the existing owner, update native and frontend contracts together, run focused tests, and report exact outcomes. Refactor only touched seams needed for that slice. No generic policy engine, schema-registry project, service bus, or automatic provider selection.

## Minimum acceptance matrix

| Area | Required evidence |
| --- | --- |
| Authority | Reviewer cannot change source, bibliography, policies, credentials, or acceptance by any exposed route |
| Proposal | Human and AI proposals share validation; submission leaves manuscript bytes unchanged; idempotent retry |
| Decision | Exact-version acceptance; typing/policy/disk races fail safely; recovery and undo remain consistent |
| PDF | Actual PDF display; zoom/resize/page moves; current build identity; repeated text, columns, Unicode, ligatures, math, generated output; ambiguity never targets a guess |
| Performance | Cold/warm timings separated by stage; responsive typing; latest-state wins; bounded native/viewer memory; failed compile retains last good PDF |
| Portability | Three canonical files restore the project on a clean supported installation; required assets/profile mismatch reported; no hidden state dependency |
| Sync | Torn tuples, stale parent, divergent JSON/source, missing baseline and provider limitations tested; both versions retained |
| Privacy | No credentials/local paths in shared JSON; no project-triggered network or auto-accept; generated content never becomes policy |
| Packaging | Offline installed Windows app loads viewer worker/resources, compiler/fonts, and tested command catalogue; source tests alone are insufficient |

Use disposable projects for mutation and sync tests. Do not use real manuscripts, publishing repositories, or connected accounts as implicit destructive test fixtures. A native CLI can test service behavior, but it cannot prove PDF highlight placement or human approval UX; those require UI tests and rendered inspection.

## Existing verification commands to retain

Confirm the current repository/CI commands before executing; these are examples from the baseline, not results of this planning pass:

```text
cd src-tauri
cargo fmt --check
cargo check --locked
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
node --check ../web/app.js
node --test ../web/*.test.cjs
git diff --check
```

Runtime changes also need an installed/release build smoke test. Keep dependency lockfiles, byte/resource limits, origin/path checks, Unicode tests, atomic saves, unknown-outcome handling, and safe secret storage. “YAGNI” does not permit deleting these merely to reduce line counts.

## Documentation and handoff

`For-AI/` contains only Markdown; runtime policy lives in validated project JSON/native code. Keep one definition per rule and cross-link it. Historical conversion/GitHub validation is consulted only when changing those modules; it is not a backlog to extend. Remove obsolete evidence files only after finding all references and confirming their useful provenance remains recoverable.

Handoff states branch, commit, files changed, commands actually run, pass/fail/not-run outcomes, and unverified platforms. For a docs-only change verify path scope and links; do not claim app tests or performance measurements. Never mark a blocked phase complete because its roadmap was written. Plans await approval; approved implementation ends at the agreed acceptance criteria.
