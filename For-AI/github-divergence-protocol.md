# GitHub divergence preservation protocol

UnderTree treats the configured local folder as the editable source of truth while GitHub is a synchronized commit history. Synchronization must never erase a commit or silently choose one side of a divergence.

## Invariants

- Never force-push, delete a branch, reset a branch, discard a working tree, or automatically resolve a content conflict.
- Refuse synchronization while the editor has an unsaved snapshot, the Git working tree is dirty, or Git reports an unfinished merge/rebase operation.
- Fetch the configured GitHub branch before deciding whether a push is safe. A stale remote-tracking ref is not push authority.
- Fast-forward only when the replaced tip is an ancestor of the destination tip.
- When local and GitHub each contain unique commits, create a local branch named `undertree-safety/<unix-time>-<local-tip>` at the exact pre-merge local commit.
- If the connected account can push, publish that safety branch to GitHub before attempting reconciliation. If publication fails, stop before changing the configured branch.
- Reconcile non-conflicting divergence with a two-parent merge commit. If merge analysis finds conflicts, leave the configured branch and working tree unchanged and report the safety branch name.
- A push that discovers a newer GitHub tip stops. If histories diverged, it first publishes the local safety branch and instructs the caller to use Sync.
- Successful sync output must name any safety branch it created so recovery is discoverable from both UI and CLI.

## State table

| Local vs GitHub | UnderTree action |
| --- | --- |
| Equal | Report up to date. |
| Local strictly behind | Safe fast-forward after clean-editor and clean-worktree checks. |
| Local strictly ahead | Non-force push after a live fetch confirms GitHub did not advance. |
| Both ahead and behind | Preserve local tip on a safety branch, publish it when writable, then attempt a two-parent merge. |
| Content conflict | Keep configured branch unchanged; retain the safety branch; require explicit human reconciliation. |
| Dirty files or unsaved editor | Stop without changing refs, index, or working tree. |
| Network interruption | Keep all local refs; GitHub's configured branch remains unchanged unless the server confirmed a non-force update. |

## Validation

At minimum, changes to this protocol must run:

```powershell
cargo test --locked git::tests::safety_branch_preserves_the_local_tip_without_switching_branches
cargo test --locked git::tests::merges_non_conflicting_local_and_remote_commits_without_switching_branches
cargo test --locked github::tests::ordinary_sync_refuses_to_misreport_uncommitted_files_as_synchronized
cargo clippy --locked --all-targets -- -D warnings
```

Live validation must use UnderTree's CLI and credentials, never raw tokens or a generic shell bridge. Run `github doctor` first. Mutating divergence tests belong in a disposable repository; never manufacture divergence in a user's active writing repository merely to test this protocol.
