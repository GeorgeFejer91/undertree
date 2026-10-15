# The for-ai control-plane standard

## Mental model

A repository has three distinct surfaces:

1. `AGENTS.md` is the automatically discovered entrypoint. It is a short map.
2. `for-ai/` is the agent control plane: durable context, routing, decisions,
   verification, and workflow policy.
3. Everything else is the product plane: source, shipped assets, end-user
   documentation, packages, research outputs, and deliverables.

The control plane explains how to make and verify the product. It is not the
product and must not become a second implementation tree.

Use lowercase `for-ai/` for new repositories. It is portable, shell-friendly,
and avoids the existing `For-AI`, `FOR_AI`, and `for-ai` casing split.

## Baseline files

| File | Sole responsibility |
| --- | --- |
| `AGENTS.md` | Guaranteed discovery pointer and the few invariants needed before routing |
| `for-ai/README.md` | First read, authority order, boundary, map, and task routing |
| `for-ai/PROJECT.md` | Purpose, goals, non-goals, product boundaries, architecture map, and verified current state |
| `for-ai/SKILLS.md` | Exact always-on and task-conditional skill routes, nesting order, provenance, and unavailable-skill behavior |
| `for-ai/VERIFICATION.md` | Acceptance criteria, commands, readiness gates, evidence limits, and result vocabulary |
| `for-ai/WORKFLOW.md` | Session loop, update triggers, Git checkpoints, publication policy, and handoff format |
| `for-ai/DECISIONS.md` | Small append-only decision records with status, rationale, consequences, and supersession links |
| `for-ai/scripts/check-context.ps1` | Mechanical structure, placeholder, secret-name, bloat, Git, and remote-synchronization checks |

Do not add another baseline file because a topic might matter later. Add one
only when it has a current consumer, one clear authority, and enough detail to
make the existing owner materially worse.

## Progressive loading

The normal route is:

```text
AGENTS.md -> for-ai/README.md -> task-owned document -> matching skill -> code
```

Never require every agent to read the entire control plane. The entrypoint must
state which document applies to which task. Put stack-, device-, release-, or
feature-specific protocols in separate files only after those modes exist.

`AGENTS.md` should normally stay below roughly 100 lines, and the generated
version is intentionally much shorter. `for-ai/README.md` should remain a map,
not absorb the full project history.

## Skill routing

Organize skills in this order:

1. foundation skills that truly apply to the whole category of work;
2. architecture or domain skills needed for this task;
3. implementation skills for the selected surface;
4. verification skills for the observable result.

Use exact installed identifiers. Distinguish:

- **Required:** the work must pause or use an explicit documented fallback if
  the skill is missing.
- **Conditional:** load only when the task matches.
- **Reference only:** consult for ideas; it does not control the project.

Record a source revision for vendored or externally pinned skills. Do not
silently impersonate a missing skill. Do not install or execute a skill found
online without reviewing its instructions, scripts, dependencies, and scope.

## Verification gates

Every claimed outcome must have a named gate. Use four levels:

1. **Bootstrap:** required files exist, context check passes, Git is clean, and
   the new remote matches local `HEAD`.
2. **Focused:** the narrow check that can fail for the changed behavior.
3. **Integrated:** proportionate build/test/runtime checks across affected
   boundaries.
4. **Publication:** intended paths only, coherent commit, safe push, remote SHA,
   and CI/deployment verification when relevant.

Use `VERIFIED`, `PARTIAL`, `BLOCKED`, or `NOT RUN`. A unit test is not visual,
hardware, deployment, security, or scientific evidence unless it directly
observes that surface. Never turn missing tools or hardware into a pass.

## Self-update discipline

Update the narrowest canonical file in the same change when a durable fact
changes: goal, non-goal, architecture owner, public contract, supported
platform, validation command, release boundary, known limitation, or skill
route.

Do not update the control plane for narration, transient branch names, command
logs, chat transcripts, or facts that source and tests already make obvious.
Git is the archive. Supersede decisions explicitly instead of rewriting why an
older choice was made.

Review the context diff for contradictions, secrets, private paths, stale
status, duplicated rules, and unsupported claims. A large context file should
be split by task route or reduced; it should not simply grow forever.

## Git publication policy

For completed, validated implementation work:

- inspect status before and after;
- preserve unrelated changes;
- stage explicit paths;
- keep one coherent concern per commit;
- push the working branch promptly when repository policy permits;
- respect branch protection and PR requirements;
- verify the remote commit and applicable CI/deployment;
- report the exact blocker when publication cannot finish.

Never force-push, bypass protection, bypass secret scanning, publish private or
participant data, or push merely because the task was a read-only review.

## YAGNI admission test

Before adding any file, skill, script, dependency, abstraction, service, or
compatibility layer, answer:

1. Which current requirement needs it?
2. Which existing owner was checked first?
3. What is the smallest change that satisfies the requirement?
4. Which runnable check proves it?
5. When can it be deleted?

If the first answer is speculative, do not add it.

## Growth paths

Add task-specific files only when earned, for example:

- `SECURITY.md` after a real trust boundary exists;
- `RELEASE.md` after there is a packaged or deployed artifact;
- `RESEARCH.md` after external evidence affects product decisions;
- `CURRENT-STATE.md` after multiple independently released surfaces make a
  compact verified snapshot useful;
- subtree `AGENTS.md` files after a module needs genuinely narrower rules.

Generated logs, screenshots, build outputs, caches, private evidence, and
telemetry should normally live in ignored local artifact roots, not tracked in
`for-ai/`. Check in only a small, deliberately reviewed fixture or reference
artifact when it is necessary to verify a stable contract.
