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

## Required checks

`main` requires these contexts on the pull request's exact head, all strict:

| Context | What it proves |
| --- | --- |
| `checks` | Lint and the test suite passed on the primary Python version. |
| `public-content` | The pinned secret scan and the estate-identifier guard passed. |
| `review` | An independent approval exists at this exact commit. |
| `dependency-review` | The change does not add a dependency with a known vulnerability. |

`build` and `checks-python-3.11` also run on pull requests. They are not
required contexts, but they are additional checks: a missing, skipped or neutral
result is tolerated, while a reported failure, cancellation or timeout refuses
the merge (`additional_check_not_green`). `build` builds and verifies the Python
distribution, not a container image; `checks` already runs the suite on the
primary interpreter, and the second-version job is an extra compatibility
signal. Making either a required context is a maintainer decision.

## Pull requests

1. Branch from the current `main`.
2. Add or update the focused tests. The suite fails, never skips, without its
   PostgreSQL binaries and Playwright Chromium.
3. Run the local checks:

   ```sh
   uv sync --frozen
   uv lock --check
   uv run ruff check .
   uv run python -m pytest -q
   ```

4. Push the branch and open one pull request against `main`. Expect the required
   checks (`checks`, `public-content`, `review`, `dependency-review`) and an
   independent review on the exact head.
5. Correct review findings on the same branch. A new commit needs fresh CI and
   fresh review.

Workflows may use GitHub-owned or verified Marketplace actions, always pinned
to a full commit SHA; any other action needs a maintainer decision.

An authoring agent does not merge its own pull request, does not use
`gh pr merge`, does not enable a standing auto-merge order and does not change
branch protection to unblock a change.

## Review and merge

`main` is protected. It requires the exact-head checks `checks`,
`public-content` and `dependency-review`, the trusted `review` status published
from the default branch, and a complete policy evaluation.

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

## Response expectations

This is a spare-time project with one maintainer. Expect an acknowledgement
within a few days, not an immediate review. A new commit restarts CI and the
review cycle; an approval from before the latest commit does not count.

## Releases

Releases use [release-please](https://github.com/googleapis/release-please) so
the version, the changelog and the tag cannot disagree. A merged
release-relevant conventional commit (`feat`, `fix` or `perf`) on `main` makes
release-please open or update one release pull request: it bumps
`pyproject.toml`, writes `CHANGELOG.md`, records the version in
`.release-please-manifest.json` and updates the project's own version in
`uv.lock`. `checks` runs `uv lock --check`, so a release pull request whose
lock disagrees with `pyproject.toml` fails before it can reach `main`. That
update is observed after both a
maintainer merge and a merge by the repository's own automation. Merging the
release pull request is the release decision; release-please then creates the
tag and the GitHub Release. release-please creates a lightweight tag. Never tag
by hand and never move a published tag. A `docs`, `chore` or
`test` commit does not by itself open a release pull request.

The workflow authenticates with a fine-grained personal access token stored as
`RELEASE_PLEASE_TOKEN`, with Contents and pull-request write on this repository.
The default `GITHUB_TOKEN` cannot be used: a pull request it creates does not
trigger the pull-request workflows, so the required checks never run, and a
merge it makes suppresses the `push`-triggered run, which is why the workflow
also observes the completed `automerge` run. Renew the token before it expires:
a missing or empty secret fails the run with `Input required and not supplied:
token`, and an expired one fails authentication.

The release pull request always changes a sensitive path, so the merge policy
never auto-merges it: a maintainer merges it. A tag or a release is not a
deployment; package, image and deployment decisions remain separate operator
decisions recorded outside this repository.

## Database migrations

`agent_chat/*.sql` is an append-only sequence. Once a migration is part of a
release, its bytes are fixed: never edit it, not even a comment. Consumers of
this repository record a SHA-256 of each applied migration, so migration checks
and upgrades against a database that applied the original bytes fail with
`SCHEMA_MISMATCH`, even for a comment-only edit. A correction or a new
behaviour is a new migration appended after the last one.

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licence

Contributions are accepted under the GNU Affero General Public License v3.0
(see [LICENSE](LICENSE)). By contributing you confirm you have the right to
submit the change under that licence.
