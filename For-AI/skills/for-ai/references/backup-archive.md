# For-AI backup archive protocol

Use this mode for a local folder that stages computer files for a later external-drive copy. It is separate from the GitHub project bootstrap. The user chooses the library root and which source folders belong in it. Existing personal data, ignored Git files, and credentials are never inferred to be safe for GitHub.

## Discovery and package shape

The small root `AGENTS.md` routes to `for-ai/README.md`. That map points to the root `BACKUP_CATALOG.md` for human/LLM retrieval and `BACKUP_CATALOG.jsonl` for machine filtering. Open only the relevant item after selecting it. Each item is `category/item/` with:

```text
FOR_AI.md                 concise meaning, source, first-read pointers, restore route, limits
backup_catalog.json       structured item facts and observed state
EVENTS.jsonl              append-only, one record per lifecycle step
data/                     the payload; empty while PLANNED
MANIFEST.sha256.jsonl     one SHA-256 record per payload file after sealing
VERIFY_REPORT.json        external-copy comparison result, if run
```

Categories are `code-projects`, `research-data`, `personal-records`, `media-exports`, `software-system`, and `needs-review`. Prefer one package per coherent restore unit rather than one giant mixed folder or one package per trivial file. Keep product data outside `for-ai/`.

## Context that helps a future model

Write a brief orientation in `FOR_AI.md` that answers: what this package is; why it was retained; its original location and owner; its likely contents and first useful entrypoint; how to restore or re-use it; and what remains uncertain or nonportable. Use observed folder structure and existing documentation rather than guessing from a name. Distinguish originals, derived outputs, caches, Git history, Git LFS, untracked files, and ignored files. Do not reproduce private correspondence, participant records, passwords, tokens, or a detailed sensitive filename index in the summary.

`backup_catalog.json` is the canonical structured item record. The root JSONL index is generated from it. `EVENTS.jsonl` uses UTF-8 and one JSON object per line with time, action, observed state, and concise evidence; it is an operation log, not a chat diary. The manifest is the per-file log. Keep status terms precise: `PLANNED`, `STAGED`, `SEALED`, `COPIED`, `VERIFIED`, and `BLOCKED`.

## Saving and verification routine

1. **Plan:** inspect the source and storage capacity. Create a `PLANNED` item with source, purpose, sensitivity, restore notes, and summary. A planned item is not a backup.
2. **Stage:** place the retained payload under `data/`; record an exact source-to-destination mapping before moving active files. Same-volume moves reorganize data but free no space. Avoid double-copying large folders when the local drive is near full. Run `refresh` to count files and bytes; investigate access errors and links.
3. **Seal:** run `seal` after the payload is stable. It hashes every readable file into `MANIFEST.sha256.jsonl` and detects changes during hashing. Do not silently skip a link, unreadable file, or special entry. Any payload change requires re-sealing.
4. **Copy:** copy the whole item folder to an external drive, including context, metadata, event log, payload, and manifest. Record the drive label plus serial or a stable inventory ID, exact destination, and copy method with `record-copy`. Completion of a copy command is `COPIED`, not `VERIFIED`.
5. **Verify:** run `verify` against the recorded copy. It compares both the source and external payloads to the sealed manifest, including exact relative paths, sizes, SHA-256 hashes, missing files, and extra files. Use `--sync-context` after success so the external copy receives the updated context and report. For software-bound archives, separately test a representative restore route.
6. **Remove local source:** only after verification and review of active path dependencies. Record what was removed and where the surviving copy lives. For important material, keep another independent copy when practical; a single external drive can fail.

Example commands, from the installed skill directory:

```powershell
python scripts/backup_catalog.py init --root 'C:\path\to\Backups'
python scripts/backup_catalog.py create --root 'C:\path\to\Backups' --category research-data --name study-export --title 'Study export' --what '...' --purpose '...' --summary '...' --contents '...' --source 'C:\path\to\source' --restore '...' --sensitivity 'Restricted'
python scripts/backup_catalog.py refresh --root 'C:\path\to\Backups' --category research-data --name study-export
python scripts/backup_catalog.py seal --root 'C:\path\to\Backups' --category research-data --name study-export
python scripts/backup_catalog.py record-copy --root 'C:\path\to\Backups' --category research-data --name study-export --copy 'E:\Backups\research-data\study-export' --external-id 'Drive label and serial' --method 'robocopy command and exit status'
python scripts/backup_catalog.py verify --root 'C:\path\to\Backups' --category research-data --name study-export --copy 'E:\Backups\research-data\study-export' --sync-context
```

The item creation example uses placeholders; inspect the actual source before supplying context. The script creates no remote repository and never copies or deletes payload data.

## Design basis

- [Agent Skills specification](https://agentskills.io/specification): a short `SKILL.md` and task-specific resources support progressive loading. This library applies the same idea with a root route, index, and per-item detail.
- [BagIt RFC 8493](https://datatracker.ietf.org/doc/html/rfc8493): descriptive tags and per-file checksum manifests separate package meaning from payload fixity. This protocol borrows that principle; its JSONL manifest is **not** a BagIt claim.
- [RO-Crate 1.3 metadata](https://www.researchobject.org/ro-crate/specification/1.3/metadata): dataset and contextual entities make provenance and relationships explicit. Use full RO-Crate only when another tool needs that interchange format.
- [JSON Lines format](https://jsonlines.org/): UTF-8, one valid JSON value per line, supports streaming and simple machine filtering of events and item indexes.
- [Library of Congress personal preservation guidance](https://www.loc.gov/preservation/about/faqs/reformatting.html): organize selected files and keep copies on separate media and in separate locations.

Published skills informed the scope: [digital-preservation-skill](https://github.com/matthewbrutonall/digital-preservation-skill) covers archival concepts and fixity; [smart-file-organizer](https://github.com/jagas32/smart-file-organizer) demonstrates staged classification, JSON contracts, and hash-checked copies; [file-organizer](https://github.com/AlienHub/file-organizer/blob/main/SKILL.md) shows rule-based sorting. They are reference designs, not dependencies. This protocol focuses specifically on an external-copy gate and compact, truthful retrieval context.
