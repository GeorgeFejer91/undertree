# Secret Tunnel reference analysis — 14 October 2026

Inspected the user-owned local `SecretTunnel-v2` source alongside UnderTree. Despite its directory name, the current brief covers the v3 product, v4 Smart Folders and v5 layout. It is a source snapshot with no Git metadata; do not describe it as an immutable commit or a live integration test. No private configuration, credentials, assets or upstream executable code were copied.

## Sources and relevant structures

| Inspected source | Adopted structure or lesson |
| --- | --- |
| `AGENTS.md`, `For-AI/README.md` | Read canonical entry/constraints first; route to actual skills; preserve concurrent work; separate runtime from orchestration. UnderTree keeps its own existing entry and module map. |
| `For-AI/PROTOCOLS/v3-ui-modules.md` | Name a feature consistently across UI, native boundary and owning module. The connection popup uses ordinary tabs rather than a new plugin framework. |
| `For-AI/PROTOCOLS/v5-ui-layout.md` | Allocate boxes first, measure complete text with the existing Pretext runtime, reflow controls, retain full values and test rendered geometry. Policy remains in UnderTree's `ui-layout.md`. |
| `For-AI/PROTOCOLS/v3-e2e-product-acceptance.md` | Separate local checks, synthetic evidence and actual user outcomes. Adapt this into the connection protocol plus this evidence note. |
| `app/src-tauri/src/process.rs` | Native process ownership, fixed zrok2 argv, bounded startup survival, cleanup and honest readiness. UnderTree independently implements a single session and never cleans up other installations' shares. |
| `app/src-tauri/src/system_prompt.rs` and MCP initialize contract in the brief | Server instructions are machine-facing and delivered at initialization. Keep UnderTree's restrictive reviewer instructions in Rust rather than copying Secret Tunnel's broader coding/publishing prompt. |
| Installed Ponytail, Tauri Rust Developer, Uncodixfy/Pretext skills and measurement reference | Reuse existing service, IPC and dependency; keep secrets/policy in Rust; connect a small DOM adapter; verify failure and denial paths. Full skill bodies remain outside this repository. |

The layout source SHA-256 was `864fc4320fd0ad253839efde8d68f67b1951b88331d2a56943381b26b9ba0106`; the process source was `142c75ffc8b95b49917319b8f53ce6bd19bb6a69ed70ca976cb38b062cf137d8`. These identify files read, not installed app bytes.

## Deliberate scope decisions

Secret Tunnel's enabled For-AI skill also describes a minimal project control plane. Reuse the equivalent UnderTree documents rather than generating duplicate uppercase/lowercase trees:

| Reference responsibility | UnderTree owner |
| --- | --- |
| Entry and project brief | `AGENTS.md` → `For-AI/README.md`, `product-goal.md`, `constraints.md` |
| Skills and implementation workflow | `For-AI/skills.md`, `workflows.md`, `module-map.md` |
| Verification and decisions | `For-AI/reference-evidence.md`, this `BOARD/` note, `PROTOCOLS/connections.md` |
| Context validator | Existing `modules/maintenance/validate-architecture.mjs`; executable checks stay outside Markdown-only `For-AI/`. |

Keep UnderTree's manuscript consent and suggestion-only tools. Do not copy Secret Tunnel's generic folder writes, GitHub publication, Codex delegation, account sessions, voice, storage, device pairing or Security Center placeholders. Its v5 fixed utility window forbids all scrolling; UnderTree is a document editor with an existing accessible scrolling policy, so transfer the measurement/reflow discipline while preserving that policy. Do not copy Secret Tunnel's dimensions, fonts, full-tab scaling, private settings or runtime dependencies.

Runtime ownership and trust boundaries are recorded in [the connection protocol](../PROTOCOLS/connections.md). Official ChatGPT setup wording is sourced there. The legacy TeX frontends are outside this implementation; the button lives in the new Rust/Tauri manuscript workspace.

## Qualification evidence

- `cargo test -p undertree-review`: passed, 28 tests in the observed run, including bounded setup validation and persistence without restored grants. Other work in this checkout added further review/security cases concurrently; this is not a claim of authorship of every test.
- `cargo build -p undertree-review` and `cargo check -p undertree-desktop --features custom-protocol`: passed on Linux.
- `cargo clippy -p undertree-review --all-targets -- -D warnings`: passed.
- `npm run build` and `npm run verify:architecture`: passed. Existing large-chunk notices remain; no bundle-size or latency improvement is claimed.
- `npm run test:connections-ui`: passed against the real Rust service and synthetic owned zrok child, covering startup failure, exact argv, MCP initialization/catalogue/activity, duplicate and malformed setup without revocation, per-manuscript revoke, stop, capability rotation, child-death revocation, keyboard/focus, stable focus during polling, remembered setup, long German/Unicode paths, real Pretext and widths 320/760/1600 CSS px plus 200% text size. Screenshots under ignored `artifacts/connections-*.png` were reviewed; cramped zoomed tab labels were corrected to reflow.
- `npm run test:review-ui`: passed with a separately installed Typst CLI, including protected suggestions, local acceptance, real PDF compilation, import and last-good-preview retention. Its zrok child is also simulated.
- `npm test`: 57 passed, 3 failed because the environment lacks `latexmk` (two layout compilation cases and the legacy server PDF case). No TeX distribution was installed for this connection feature.
- `git diff --check`: passed. The workspace-wide `cargo fmt --all -- --check` reports existing/in-progress formatting in `modules/review/src/lib.rs` and `native/tauri/src/main.rs`; those unrelated adapters were not reformatted by this change.

Node was available in an existing temporary toolchain rather than the login PATH. Typst for the review UI gate was also available in that toolchain. Neither is a product runtime dependency on this machine's temporary directory.

Not qualified: real zrok account/reservation, public HTTPS route, live ChatGPT suggestion/revocation, native WebView rendering, installers, Windows/macOS, or full zoom/locale/font/accessibility matrices. The new connection gate deliberately uses no real account credentials or public service. Local success does not close those integration gaps.
