# Tasks

## 1. Author the change

- [x] 1.1 Write `specs/chat-service/spec.md`, `specs/coordination/spec.md`, `specs/chat-clients/spec.md` and `specs/web-ui/spec.md` from the code at source ref `ba8ca34` and, for roster navigation, history paging and the history arguments, at `ce19844`; verify that `openspec validate port-service-specs --strict`, run from the repository root, reports the change valid.
- [x] 1.2 Write `proposal.md`, `design.md` and this file; verify with the same command.
- [x] 1.3 Scan for private identifiers; verify that `uv run python scripts/check_estate_identifiers.py` exits 0 with `no estate identifiers found`. That script reads tracked files only, so also verify that each change file passes `uv run python scripts/check_estate_identifiers.py --stdin` when piped in.

## 2. Review against the source

- [x] 2.1 A reviewer other than the author compares each requirement and scenario with the code at the head under review (`agent_chat/` and `agent_chat/web/`) and lists each disagreement; verify that the review names the head and leaves no disagreement unresolved.
- [x] 2.2 The reviewer confirms that no file under the change names a deployment, host, address, internal DNS name, credential or private runbook, and that every example is synthetic; verify that the review records this and that `public-content`, which scans the tracked files and the commit range, is green on the same head.
- [x] 2.3 The maintainer decides each open question in `design.md` or records the issue that tracks it; verify that the archive disposition names the decision or the issue for each.

## 3. Land the product source change

- [x] 3.1 Open one pull request against `main` that contains only files under `openspec/changes/port-service-specs/` and that references issue #6; verify with the pull request's file list.
- [x] 3.2 Obtain an independent review of the exact head commit; verify that the `review` status names that head. A new commit needs a fresh review.
- [x] 3.3 Confirm that the required checks `checks`, `public-content`, `review` and `dependency-review` are green on the exact head; verify with the check results for that head. A new commit needs fresh results.
- [x] 3.4 Merge through the repository's merge policy (`scripts/pr_policy.py`) or by a maintainer. The authoring agent does not merge its own pull request. Verify that the pull request state is merged and that the merge commit is on `main`.

## Closure evidence

- PR #100 covered all four delta specs. The independent approval was on
  `75a1bd439861f9e4389605d11db8904306f12c7a`. Its required checks passed
  and it merged as `fe043eff8f6af4cc29b14d010ec1e3bbb9e8006c`.
- PR #110 clarified retention expiry. The independent approval was on
  `3f3afcfc182ccb9dcac4eb57a7ddce6d8ef8f500`. It merged as
  `d7b9ec86fdb69db0aa4e69ce539695bf2e6da80d`.
- The design records the scope decisions that carry forward. Archiving
  applies the four reviewed deltas to the main specifications. This
  evidence describes the product source.
