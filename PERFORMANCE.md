# Performance and footprint audit

## Current desktop architecture

The desktop uses Rust authority and Tauri v2 with a bundled HTML/CSS frontend
and the operating system's web view. The obsolete Electron Windows shell,
preload, installer hook and utility-process entry were removed on 2026-10-16.
The architecture check rejects their return as well as Electron dependencies
and packaging. Node/GTK and TeX paths below describe the earlier compatibility
implementation; their measurements do not qualify the current Rust/Tauri build.

## Historical realtime modularization phase (2026-08-22)

Frontend live compilation now uses a tested latest-state scheduler. It debounces
edit bursts for 450 ms, keeps typing enabled throughout ordinary compilation,
and retains one newest follow-up request when edits land during a slow build.
This changes perceived responsiveness without weakening the exact-snapshot save
barrier or pretending that the TeX engine itself has become instantaneous.

Runtime packaging excludes frontend packages already compiled into `dist`, the
optional native PDF.js canvas dependency, unused Tiptap packages, and the Codex
runtime from the recovery-disabled Windows distribution. Codex SDK loading is
deferred to the disabled recovery path. `modules/maintenance/` contains the
machine-checkable package policy and architecture validator.

Measured on 2026-08-05 on the Linux workstation used for development. These
numbers separate the downloadable application from the development toolchain
and from the system TeX distribution.

## Baseline

| Item | Measured size or use | Interpretation |
| --- | ---: | --- |
| Tracked application source | 616 KB | The original code and assets are already small. |
| Development checkout | 149 MB | Almost all of this is `node_modules`, not runtime code. |
| Development `node_modules` | 144 MB | Includes Vite, Playwright, PDF.js Node canvas binaries, and build tools. |
| PDF.js package and optional canvas binaries | about 102 MB | Required while building, but not by the installed service. |
| Local Node service at idle | 29 MB cgroup / 42 MB process RSS | Small enough to remain available in the background. |
| Original blocking interface JavaScript | 839 KB | CodeMirror and PDF.js were parsed before the editor appeared. |
| PDF worker | 1.24 MB | Loaded locally and only used for document decoding/rendering. |
| Lean 0.2.0 release archive | 1.2 MB compressed / 4.1 MB unpacked | Ready-to-run application files and runtime dependency only. |

The earlier 359 MB service memory peak included child TeX compilations in the
same systemd cgroup. It is not the editor's idle footprint. TeX engines and
complex projects can independently use substantial memory.

## Improvements implemented for 0.2.0

1. The release builder ships only the compiled interface, native shell,
   standard-library Node service, layout compiler, and `fast-xml-parser`. Vite,
   Playwright, CodeMirror packages, PDF.js Node canvas binaries, and all other
   development dependencies are excluded.
2. PDF.js is dynamically imported. The blocking interface chunk fell from
   839 KB to about 437 KB; its 411 KB viewer chunk warms during browser idle or
   while TeX compiles, instead of adding cold-start time after a build.
3. PDF backing canvases have a 10-megapixel budget. Normal zoom remains sharp,
   while 400% zoom no longer creates two extremely large high-DPI canvases
   during an atomic preview replacement.
4. The service uses `latexmk` incrementally, rejects overlapping build jobs,
   and keeps automatic recompilation off by default. An edit-aware mode
   rebuilds once after one second without changes, while explicit 5–120 second
   intervals remain available.
5. PDF refresh fetches the document directly without a preliminary metadata
   round trip. The current preview stays visible until its replacement page is
   ready; nearby pages render first and the rest render lazily while scrolling.
6. The backend remains a dependency-light Node HTTP service rather than an
   application framework. The desktop shell reuses the operating system's
   WebKitGTK instead of embedding Chromium or Electron.
7. Personal absolute paths were removed. Project storage defaults to
   `~/Documents/Overleaf-projects`, can be overridden, and is created lazily.

## Critical design choices

The lightest credible design is the current split process: a small local
service plus the system web view. Replacing it with Electron would make
distribution easier but would normally add a complete Chromium runtime and a
large idle-memory cost. AppImage or Flatpak packaging that bundles WebKitGTK
would similarly trade portability for a much larger download. Native `.deb`
and `.rpm` wrappers that declare system dependencies are better future package
formats for this project.

PDF.js remains justified despite being the largest front-end component. A
browser PDF plug-in would be smaller in this repository but has inconsistent
controls, theming, and WebKitGTK support—the exact problems this application is
designed to avoid. CodeMirror is also worth retaining: a textarea would save
some bytes but lose robust editing, search, undo, syntax parsing, and keyboard
behavior.

The TeX distribution must remain an external system dependency. Bundling full
TeX Live would dwarf the application, while a tiny TeX subset would fail on
real projects with specialized packages. Users who need the smallest complete
environment can install a minimal TeX distribution and add packages as their
projects require them.

## Real-time compiler audit (2026-08-11)

The primary performance target is the interval from an editor change to a
correct replacement PDF. The audit used primary project documentation and
local measurements rather than language-level assumptions. Representative
measurements on this workstation were:

| Path | Before | Optimized or experimental | Result |
| --- | ---: | ---: | --- |
| 300 large-document editor updates | 1,237 ms | 9.76 ms | CodeMirror's persistent document stays lazy until a save/build boundary. |
| 5,000-heading outline calculation | 9,930 ms | 12.72 ms | One linear newline scan replaces a prefix split for every heading. |
| Production client build | 10.5+ s with Vite 7/Rollup | 0.8–1.3 s with Vite 8/Rolldown | Rust-based Rolldown is now the production bundler. |
| 5,000-file tree, first scan | 1,529 ms | 362–586 ms | File metadata requests run concurrently. |
| 5,000-file tree, warm response | 1,002 ms | 25.8 ms | A bounded native file watcher invalidates a five-second fallback cache. |
| 5,000-file no-match search | 5,053 ms | 83.0 ms | Rust ripgrep accelerates ASCII queries; ordered JavaScript remains the exact fallback. |
| 5,000-file last-file match | 1,045 ms | 62.5 ms | Results are reconstructed in the original deterministic file/line order. |
| Incremental one-shot `latexmk` | 427 ms | 211 ms experimental persistent mode | Continuous mode is faster, but cannot replace project bridge behavior silently. |

Compile now sends the exact active editor snapshot in the build request. The
server atomically reconciles that snapshot and then starts TeX, eliminating a
redundant save request and source reread. A revision guard prevents the build
response from marking a newer editor change clean. Project configuration is
loaded with one cached `git config --list` process instead of up to three Git
processes per build.

## Module-by-module strategy

| Module | Fastest compatible implementation now | Rust decision |
| --- | --- | --- |
| Editor state and syntax | Keep CodeMirror 6 persistent documents and incremental Lezer parsing; debounce derived outline work. | Replacing the editor would lose mature editing behavior and would not remove DOM/WebKit costs. [CodeMirror state](https://codemirror.net/docs/ref/#state.EditorState) and [Lezer incremental parsing](https://lezer.codemirror.net/docs/guide/#incremental) directly support the chosen approach. |
| Save → compile transaction | One localhost build request carrying the exact snapshot, atomic rename, conflict backup, and revision acceptance guard. | A Rust HTTP handler would save microseconds around a TeX job measured in hundreds of milliseconds and adds migration risk now. |
| TeX orchestration | Keep incremental `latexmk` and every existing `scripts/tex-sync` bridge. Prototype continuous mode only through a future bridge protocol that can preserve clean builds, logs, engine selection, and on/off semantics. | Tectonic is not a transparent Rust replacement: it has a different engine/compatibility surface and needs `--only-cached` plus a complete local bundle for strict offline operation. See [latexmk continuous mode](https://ctan.org/pkg/latexmk), [Tectonic build behavior](https://tectonic-typesetting.github.io/book/latest/v2cli/build.html), and [Tectonic's implementation mix](https://github.com/tectonic-typesetting/tectonic). |
| File tree | Concurrent Node `stat` calls plus a 12-project LRU-style set of recursive native watchers and a five-second fallback TTL. | Node already maps `fs.watch` to Linux inotify and supports recursive Linux watching, so a Rust `notify` sidecar would duplicate the same kernel facility. [Node file watching](https://nodejs.org/api/fs.html#fswatchfilename-options-listener). |
| Project search | Use ripgrep JSON output for safe ASCII fixed-string searches, validate matches in JavaScript, reconstruct original order, and fall back for unavailable/truncated/non-ASCII cases. | This is the measured, targeted Rust win: ripgrep combines parallel traversal and optimized regex/literal search without making the whole service a Rust migration. [ripgrep design and benchmarks](https://github.com/BurntSushi/ripgrep). |
| PDF loading/rendering | Keep PDF.js worker loading, render the visible page first, observe nearby pages, cap backing pixels, and atomically swap previews. | Rendering remains in the web view. PDF.js 6.2.108 is current and patched; hardware acceleration remains off because the upstream default is false and this app has WebKitGTK correctness fallbacks. [PDF.js loading options](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html). |
| XML layout compiler | Keep current `fast-xml-parser`; LuaLaTeX dominates end-to-end layout latency. | `quick-xml` is a fast zero-copy Rust parser, but rewriting a tiny XML parse would not materially change a 9–14 second layout build. [quick-xml](https://docs.rs/quick-xml/latest/quick_xml/) and [fast-xml-parser](https://www.npmjs.com/package/fast-xml-parser). |
| Desktop shell/backend | Keep GTK/WebKitGTK + the small Node service for this release; retain direct process control over Git, bridge scripts, and TeX. | Tauri is the best long-term full-Rust candidate, but on Linux it still uses WebKitGTK, so it can remove Python/Node runtime overhead without removing the dominant web process or TeX engine. [Tauri architecture](https://v2.tauri.app/concept/architecture/) and [Linux prerequisites](https://v2.tauri.app/start/prerequisites/). |
| Front-end build | Vite 8/Rolldown. | Adopted: Vite documents Rolldown as its Rust bundler and reports major build-time gains. [Vite 8 announcement](https://vite.dev/blog/announcing-vite8). |
| Recovery and Git sync | Keep them off the successful compile hot path and preserve the external Codex/Git contracts. | Rewriting orchestration cannot make TeX itself faster and risks recovery/synchronization semantics. |

The ranked architecture choices are therefore:

1. **Implemented hybrid:** CodeMirror/PDF.js/WebKitGTK, Node orchestration,
   `latexmk`, native watcher caching, and ripgrep only for the measured search
   hot path. This has the best speed-to-compatibility ratio.
2. **Next real-time phase:** extend the project bridge contract with a managed
   continuous-compile command. The local prototype is about twice as fast, but
   deployment must preserve explicit auto-compile state, diagnostics, clean
   rebuilds, and project-specific commands.
3. **Long-term footprint phase:** port the shell and service to Tauri/Rust while
   retaining the current web frontend and `latexmk`. This can reduce startup,
   packaging, and backend RSS; it is not expected to halve edit-to-PDF time
   because WebKitGTK and TeX remain.

Electron, Monaco, Bun, a blanket Axum rewrite, and Tectonic-as-default were not
selected. Their strongest benchmark advantages target bundled-browser features,
HTTP throughput, or engine replacement rather than this application's measured
single-user compile path.

## Next optimizations, in priority order

1. Define and test a backward-compatible continuous-build command in
   `scripts/tex-sync`; only then use persistent `latexmk -pvc -view=none` for
   edit-aware auto-compile mode.
2. Add an optional on-disk text-search index only after profiling libraries
   with tens of thousands of files. Always-on indexing would consume more CPU,
   memory, and disk than direct search for ordinary writing libraries.
3. Move compile-history accounting outside the service cgroup if users need
   clearer memory telemetry; it does not improve real resource use.
4. Build a Tauri/Rust parity prototype only behind the full API, UI, bridge,
   offline, and release test suite; accept it only if startup/RSS gains justify
   the migration and edit-to-PDF latency does not regress.
5. Offer native Debian/RPM packages that depend on Node, WebKitGTK, Git,
   `latexmk`, and the system TeX distribution. Avoid bundling those components unless a separate
   portability-first edition is explicitly desired.

The governing rule is to optimize measured editing latency and resource use,
not merely repository size. The editor, PDF controls, bridge safety, and exact
local compilation behavior should not be sacrificed for marginal byte savings.
