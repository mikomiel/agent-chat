# Contributing

agent-chat is a self-hosted coordination service. Changes are welcome when
they keep the storage model, the coordination rules and the public-content
boundary intact. Read [AGENTS.md](AGENTS.md) first.

## Before you start

- Open an issue for behaviour changes, or discuss them against the active
  OpenSpec proposal when one exists.
- One writer per branch and worktree. Preserve unrelated work.
- Keep the change small enough to review as one decision.

## Pull requests

1. Branch from the current `main`.
2. Add or update the focused tests. The suite fails, never skips, without its
   PostgreSQL binaries and Playwright Chromium.
3. Run the local checks:

   ```sh
   uv sync --frozen
   uv run ruff check .
   uv run python -m pytest -q
   ```

4. Push the branch and open one pull request against `main`. Expect required
   CI (`checks`, `public-content`) and an independent review on the exact head.
5. Correct review findings on the same branch. A new commit needs fresh CI and
   fresh review.

An authoring agent does not merge its own pull request, does not use
`gh pr merge`, does not enable a standing auto-merge order and does not change
branch protection to unblock a change.

## Review and merge

`main` is protected. It requires the exact-head checks `checks` and
`public-content`, the trusted `review` status published from the default
branch, and a complete policy evaluation.

- The reviewer is the configured GitHub App. A comment is not an approval; an
  approval is valid only for the head it names.
- `scripts/pr_policy.py` is the single owner of the merge policy. It admits
  ordinary changes under `agent_chat/**`, root `README.md`/`CHANGELOG.md` and
  the named OpenSpec documents. Everything else — workflows, scripts, tests,
  dependency manifests, the licence, agent instructions and every unknown path
  — needs a human merge.
- The merge automation re-reads the current base and head, required checks,
  the review decision and the immutable file comparison before a head-pinned
  squash merge. A timeout or unreadable result is not permission to repeat the
  merge blindly.

## Releases and deployment

A merged source change does not authorize a release. Tags, packages, images
and deployment are separate operator decisions recorded outside this
repository. Do not create a tag or publish an artefact from a pull request.

## Licence

Contributions are accepted under the GNU Affero General Public License v3.0
(see [LICENSE](LICENSE)). By contributing you confirm you have the right to
submit the change under that licence.
