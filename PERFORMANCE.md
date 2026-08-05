# Performance and footprint audit

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
   839 KB to 430 KB; its 411 KB viewer chunk loads when a PDF is requested.
3. PDF backing canvases have a 10-megapixel budget. Normal zoom remains sharp,
   while 400% zoom no longer creates two extremely large high-DPI canvases
   during an atomic preview replacement.
4. The service uses `latexmk` incrementally, rejects overlapping build jobs,
   and keeps automatic recompilation off by default. This avoids redundant TeX
   processes while retaining explicit 5–120 second intervals.
5. The backend remains a dependency-light Node HTTP service rather than an
   application framework. The desktop shell reuses the operating system's
   WebKitGTK instead of embedding Chromium or Electron.
6. Personal absolute paths were removed. Project storage defaults to
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

## Next optimizations, in priority order

1. Add file-system watching and invalidate only the affected project tree.
   The current five-second project-inventory cache is cheap for dozens of
   projects, but a very large library still causes periodic directory scans.
2. Cache project trees by directory modification time. This improves switching
   among large repositories without keeping a permanent in-memory index.
3. Add an optional on-disk text-search index only after profiling libraries
   with tens of thousands of files. Always-on indexing would consume more CPU,
   memory, and disk than direct search for ordinary writing libraries.
4. Move compile-history accounting outside the service cgroup if users need
   clearer memory telemetry; it does not improve real resource use.
5. Offer native Debian/RPM packages that depend on Node, WebKitGTK, Git,
   `latexmk`, and TeXstudio. Avoid bundling those components unless a separate
   portability-first edition is explicitly desired.

The governing rule is to optimize measured editing latency and resource use,
not merely repository size. The editor, PDF controls, bridge safety, and exact
local compilation behavior should not be sacrificed for marginal byte savings.
