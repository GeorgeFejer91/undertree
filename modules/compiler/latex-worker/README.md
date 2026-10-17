# Confined LaTeX worker

`undertree-latex` is a separate GPL-2.0-or-later process. The Rust/Tauri manuscript authority prepares a private saved project snapshot, supervises the worker, accepts the exact resulting PDF only for the current source identity, and retains the last good preview on errors. The worker never receives an editor mutation or remote authority.

```text
undertree-latex compile --root ABSOLUTE_PRIVATE_STAGE --input manuscript/main.tex --deps ABSOLUTE_PRIVATE_EXISTING_FILE
```

Success writes raw PDF bytes to stdout and `{ "inputs": [...] }` to the existing private dependency file. Human diagnostics use stderr. Failure exits nonzero without a PDF. The parent owns cancellation, timeouts, process teardown and output limits.

Project reads use capability handles with no-follow traversal and bounded immutable input copies. Relative paths resolve from the main document's folder, including `../shared.tex` when it remains inside the staged project. Absolute, drive, UNC and escaping parent paths are denied. TeX-generated files remain in memory; the worker does not write project sources or auxiliary files into the project. Limits are 16 MiB per project input, 128 MiB cumulative project input, 2048 opened project inputs, 16 MiB PDF and 48 KiB reported diagnostics. Engine working memory is separately subject to parent process supervision.

Tectonic's native engines perform conventional converging XeTeX and in-process BibTeX passes. External tools, including Biber and shell escape, are disabled. On Windows, system font-name discovery is disabled by installing an empty in-memory Fontconfig configuration before engine initialization; explicitly referenced project and cached bundle font files use the input provider. Native synthetic font-map cache keys are unavailable logical resources and never become filesystem/alternate-stream reads. The Linux Fontconfig route requires separate native qualification. macOS compilation fails before engine initialization until its different CoreText font access has a confined, qualified policy. This does not promise pdfLaTeX/LuaLaTeX equivalence or TeXpresso incremental compilation.

## Offline resources

The worker has no HTTP backend. It selects an already prepared Tectonic cache from `UNDERTREE_TECTONIC_CACHE`, then `TECTONIC_CACHE_DIR`, then `latex-resources` beside its executable. The cache uses the normal `bundles/` and `formats/` layout. Missing resources produce a build error; there is no runtime download fallback. Package provisioning belongs to explicit maintenance/setup, and package licenses must accompany any redistributed resource seed.

The dependency result includes every project input actually opened and the external cached bundle index once that bundle and its format cache are selected. The index is an external resource witness, not proof that every format/package/font byte remains unchanged; the native publication authority must retain its external-resource freshness qualification.

## Reproducible Windows build

Use the workspace Cargo.lock and an isolated vcpkg checkout at `a62ce77d56ee07513b4b67de1ec2daeaebfae51a`. The upstream triplet `x64-windows-static-release` sets x64, static libraries, static CRT and release-only builds. Install `fontconfig`, `freetype`, `harfbuzz[graphite2]`, and `icu` with that triplet, retaining their actual `installed/<triplet>/share/*/copyright` files and `installed/vcpkg/status` identities.

With an existing Visual Studio C++ build toolchain:

```powershell
$env:TECTONIC_DEP_BACKEND = 'vcpkg'
$env:VCPKG_ROOT = '<isolated-vcpkg-checkout>'
$env:VCPKGRS_TRIPLET = 'x64-windows-static-release'
$env:RUSTFLAGS = '-C target-feature=+crt-static'
cargo build --locked -p undertree-latex --release
```

The separate worker owns this native dependency chain. The desktop/review process does not link Tectonic. See `../vendor/README.md` for the exact upstream library adaptation; preserve that source, the lockfile, native source identities, build recipe, and all notices with any future distributable release. This goal does not itself authorize public distribution.
