# Performance contract

UnderTree's first performance requirement is that typing remains independent from compilation.

- Input is debounced for 280 milliseconds.
- Only one compile is in flight. Changes during that compile replace a single pending snapshot.
- Typst work runs on Tauri's blocking pool, never the WebView event path.
- Embedded fonts and shared compiler assets are initialized once.
- Imported files are cached within each compile world.
- Source, imported resource, page-count, and SVG-output limits bound memory growth.
- Obsolete compile results are discarded by revision before preview rendering.

The first Rust build is large because it compiles Tauri and Typst. Development and test profiles disable debug symbols and incremental artifacts to reduce the Windows build footprint.

Formal cold-start, keystroke-to-preview, large-project inventory, and peak-memory benchmarks are not yet claimed. Add measured baselines before treating any of those as release regressions.
