# Codex workflows

## Changing frontend behavior

1. Put reusable scheduling/state logic in `modules/frontend/`.
2. Keep `src/main.js` as the DOM and API adapter.
3. Add deterministic unit tests for the reusable module before relying on UI smoke tests.
4. Verify that typing remains enabled during builds and that a newer edit cannot be marked clean by an older response.

## Changing compiler behavior

1. Put toolchain discovery and process lifecycle code in `modules/compiler/`.
2. Preserve the authenticated localhost API and project-root confinement.
3. Treat automatic compilation as coalescible and explicit compilation as non-coalescible.
4. Test missing-tool, failed-build, superseded-build, clean-build, and shutdown behavior.

## Changing packaging or maintenance

1. Put reusable validation/release policy in `modules/maintenance/`.
2. Keep platform command wrappers in `scripts/` or `native/`.
3. Run `npm run verify:architecture` before building a release.
4. Inspect the unpacked package and installer size; do not assume dependency declarations equal shipped contents.

## Required handoff

Report changed module boundaries, responsiveness behavior, tests run, environment-only failures, and any performance claim that still needs measurement on representative TeX projects.
