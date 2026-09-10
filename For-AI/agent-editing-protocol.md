# AI editing protocol

UnderTree exposes a narrow editing contract for coding agents. It does not expose a shell, generic filesystem access, or an untyped editor command. The running-editor commands use the existing authenticated user-local broker and preserve the editor revision guard.

## User marks

- `keep`: the selected source text must remain byte-for-byte present in every agent replacement. It is durable until the user removes or changes the mark.
- `revise`: the selected source text is an explicit rewrite target. If at least one revise mark exists, every byte outside the revise ranges is immutable for that agent replacement.
- Marks may not overlap. Positions are UTF-8 byte offsets and include the exact selected text and one-based source lines.
- A collapsed editor selection expands to the surrounding paragraph. Marks live in `.undertree/agent-editing.json`; they never add control syntax to the `.typ` document.

Manual user edits are allowed. The frontend rebases marks over the edited source and persists the resulting anchors. Ambiguous, overlapping, or externally displaced anchors become stale and block agent replacement until the user reviews them.

## Agent handshake

Read a single coherent editor and policy snapshot:

```text
undertree-typst cli app agent context --json
```

The result includes:

- `state.revision`: exact live editor revision;
- `source`: the unsaved editor overlay, not merely the on-disk file;
- `policy.policyVersion`: exact durable policy generation;
- `policy.scope`: `revise-only` when revise targets exist, otherwise `unprotected-text`;
- `policy.annotations`: typed Keep/Revise ranges, selected text, line positions, and stale state.

Submit a full candidate source against both guards:

```text
undertree-typst cli app agent replace \
  --expected-revision EDITOR_REVISION \
  --expected-policy-version POLICY_VERSION \
  --stdin --json
```

Native Rust code loads the claimed authenticated request, validates the current source against the durable policy, rejects changes outside the allowed scope, atomically advances the policy, and only then permits the WebView to install the candidate source. A successful edit consumes all revise marks and preserves/re-anchors keep marks.

## Stable refusal codes

- `stale_editor_revision`: source changed after the agent read context.
- `stale_agent_policy`: marks changed after the agent read context.
- `agent_annotations_stale`: durable marks do not match the current source snapshot.
- `agent_annotation_anchor_stale`: an individual mark cannot be anchored safely.
- `outside_revise_scope`: a candidate changed text outside active revise ranges.
- `protected_text_changed`: a candidate changed or removed a keep range.

Agents must not retry a mutating request blindly after an unknown transport outcome. Read `app agent context --json` again and decide from the returned source, revision, and policy version.

## Verification

The policy implementation has pure Rust tests for persistence, Unicode byte anchors, stale policy versions, overlaps, keep enforcement, revise-only scope, and revise consumption. The frontend helper has Node tests for UTF-16/UTF-8 conversion, paragraph selection, and mark rebasing. The end-to-end smoke path is context read, one expected refusal, one permitted replacement, and a second expected keep refusal through the built CLI and running Tauri editor.
