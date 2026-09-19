# Target invariants — pending approval

These describe the intended implementation, not capabilities already shipped. Baseline behavior and differences are in `yagni-audit.md`.

## Three-file data contract

The portable profile has one `main.typ`, one `references.bib` (possibly empty), and one `undertree.json`. No per-page annotation files, duplicate manuscript text file, shared SQLite database, or fourth manifest. A native JSON schema/validator belongs in runtime code, not `For-AI/`. Preserve ordinary Typst text and BibTeX syntax.

The JSON holds versioned project identity, the current checkpoint and parents, exact source/bibliography SHA-256 digests, render-profile identity, annotations, immutable proposal versions, comments, and human decision records. Use stable object IDs and stable serialization. Timestamps are descriptive, not ordering or conflict authority. A local editor revision is not a globally unique version; pair session identity with content digests and checkpoint IDs.

Illustrative shape only; phase 1 defines the complete validated schema:

```json
{
  "schemaVersion": 1,
  "projectId": "uuid",
  "checkpoint": {
    "id": "uuid",
    "parents": [],
    "sourceSha256": "64-hex-digits",
    "bibliographySha256": "64-hex-digits"
  },
  "renderProfile": {"id": "undertree-portable-v1"},
  "annotations": [],
  "proposals": [],
  "comments": [],
  "decisions": [],
  "resources": {}
}
```

The JSON does not store its own byte hash inside itself. A transfer may hash its bytes externally. Persist before/after text for individual proposals, not an extra canonical whole manuscript. Unknown schema versions open without automatic modification. Malformed or missing review metadata must never silently unlock an established project; offer explicit recovery. Creating metadata for a new ordinary `.typ` is a separate human action.

### Figures and reproducibility

The first portable fixtures use built-in layout/fonts, in-source drawings, and optionally bounded inline SVG resources in JSON. Typst supports image bytes; exact wiring must be tested. No external font, package, raster image, dataset, or template may be silently omitted. A later bounded embedded-resource design can represent raster bytes inside the same JSON, but requires explicit size, decoding, and portability tests before support is claimed. Do not base64-embed everything by default or hide required assets in a local cache. Imports of additional source files require a separate, non-destructive conversion into the portable profile or an explicit unsupported result.

Pin the supported compiler/font/render profile in the application; record its identity in JSON. Missing/incompatible profiles are reported, never silently replaced. Date/time and other environment-dependent inputs must be fixed by the profile or explicitly supplied. Three filenames alone do not guarantee identical layout on different installations. Comment-only changes must not trigger compilation; hash only actual rendering inputs for build reuse.

## Local saving and external synchronization

Preserve native canonical-path confinement, bounded inputs, SHA-256 guards, and atomic replacement. **Change the target conflict policy:** a changed external file is not overwritten automatically merely because a backup is created. Preserve both versions and require resolution.

There is no portable atomic rename of three independent files. Serialize saves through one owner, stage a coherent tuple with an application-local recovery journal, write changed `.typ`/`.bib`, and publish the matching JSON last. Reopen/recovery verifies hashes before using a tuple. A receiver waits for a complete matching tuple; on incomplete or mismatched delivery it retains the last coherent local state. Use bounded retries, not silent adoption or an endless poll loop.

Initial collaboration is asynchronous checkpoint exchange with conservative conflict handling, not Google-Docs-style concurrent typing. Keep the last synchronized baseline locally. Same-parent divergent edits, including JSON-only review edits, are conflicts. Preserve both; do not last-writer-wins or claim wall-clock/UUID sorting merges semantics. Without a common baseline, do not invent a merge. A local project lock is not a cross-device lock. A sync provider lacking version retention/conditional writes cannot promise lossless simultaneous offline writing; require turn-taking/manual reconciliation and report that limitation. Git transport can reuse its existing multi-file commits, but JSON semantic validation still follows a merge.

Never execute a synchronized `accepted` status as an instruction to patch source. Imported records describe a coherent checkpoint; they do not grant local authority. JSON author labels are attribution, not authenticated identities. Native credentials, role grants, tokens, endpoint records, absolute paths, device settings, PDF caches, and recovery copies remain application-local. An untrusted project cannot enable a tunnel, network request, executable, or new write permission.

## PDF and responsiveness

Review runs on an actual generated PDF rendered by a locally bundled viewer. SVG preview is existing behavior, not acceptance evidence for PDF review. PDF bytes, source map, input hashes, and render profile share one build identity. Reuse one compiled paged document for PDF output and mapping where the pinned Typst APIs permit it. Do not compile separately for every consumer or launch a compiler per keystroke.

Keep typing independent of compilation: debounce, at most one active build plus the newest pending request, stale-result rejection, last-good preview, and bounded caches. Move heavy compilation/render work off UI execution. Dropping a result does not cancel native CPU work; measure uninterruptible compilations and add stronger isolation only if required by evidence.

Map PDF selections to native-validated UTF-8 source spans. Browser UTF-16 positions, normalized PDF text, source bytes, and PDF coordinates are distinct. Never authorize by a rectangle or first matching quote alone. Generated content, repeated text, multi-column selection, ligatures, equations, and ambiguous spans require explicit resolution or comment-only behavior. Stale previews cannot silently target current source.

## Authority and UI

One Rust service owns rules, proposal persistence, decisions, and safe source transactions. Frontend and MCP validation is supplementary. AI never receives general source/JSON writes, policy mutation, acceptance, shell execution, or owner credentials. The guarantee covers restricted review sessions, not an independently authorized operating-system user, coding agent, or second write-capable connector.

Preserve unsaved typing, undo, explicit source/PDF status, and visible failures. Policy swatches need labels/icons, not color alone. Keep manuscript and diff text readable and fully inspectable; do not shrink or truncate it to fit utility buttons. Reuse shared measured fitting for variable control labels where needed, not as a manuscript layout engine. No generated SVG/HTML injection or remote viewer assets. Any narrow PDF delivery/CSP change requires explicit capability tests; no generic file serving.
