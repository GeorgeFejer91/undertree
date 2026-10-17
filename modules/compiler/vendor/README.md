# Tectonic library adaptation

`tectonic/` contains the Rust library source, generated Cargo manifest, build script, README and MIT license from the published Tectonic 0.17.0 crate. Its recorded source commit is `8c0126a9653239a2e6e0a5274af9b8510f643030`; the downloaded crate SHA-256 is `6d323fa8790f75cd903c1f4501b0eac6d8165b4ba4a32113fedd0ea9db88fcb2`.

UnderTree changes are deliberately limited:

- `driver.rs` can receive an `IoProvider` for project input, replacing ambient filesystem reads while retaining the standard engine/pass driver.
- `external_tool_pass` refuses external tools, including Biber. In-process BibTeX remains available.
- The Cargo manifest excludes upstream CLI/test targets that this embedded worker does not build. Its dependencies remain resolved by the product's single root lockfile. No vendor lockfile is maintained.

Native engine and bridge crates remain pinned by the workspace lockfile. They retain their respective upstream licenses and notices. The worker builds without network-backend features, serves immutable approved project bytes, and uses an explicitly prepared offline resource cache. This is conventional converging TeX compilation, not an incremental TeXpresso engine.
