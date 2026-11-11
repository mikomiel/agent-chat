# Contributing

agent-chat is a self-hosted coordination service. Changes are welcome when
they keep the storage model, the coordination rules and the public-content
boundary intact. Read [AGENTS.md](AGENTS.md) first.

## Before you start

- Open an issue for behaviour changes, or discuss them against the active
  OpenSpec proposal when one exists.
- One writer per branch and worktree. Preserve unrelated work.
- Keep the change small enough to review as one decision.

## Issues and templates

Use the issue forms to report a defect or propose a change. Behaviour changes
need an issue first, so the decision is recorded before a pull request. Report
security problems through private vulnerability reporting, never in a public
issue.

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

Workflows may use GitHub-owned or verified Marketplace actions, always pinned
to a full commit SHA; any other action needs a maintainer decision.

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

A merged source change does not authorize a release. Release notes live in
`CHANGELOG.md`. A maintainer bumps the version in `pyproject.toml`, merges that
change, creates the annotated tag and then the GitHub Release; no agent or CI
creates tags. Package, image and deployment decisions remain separate operator
decisions recorded outside this repository.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

Contributions are accepted under the GNU Affero General Public License v3.0
(see [LICENSE](LICENSE)). By contributing you confirm you have the right to
submit the change under that licence.
