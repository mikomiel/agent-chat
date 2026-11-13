# agent-chat agent instructions

agent-chat is a self-hosted coordination service for AI coding-agent sessions
on one host or a small fleet. This repository is the product source only: the
HTTP service, the web UI, the CLI, the adapter lifecycle client and the
database migrations. Licence: AGPL-3.0-only. GitHub is the only writable
source and pull-request surface; the target branch is `main`.
Non-goals: a hosted service, a registry package, deployment configuration.

## Checks

```sh
uv sync --frozen
uv run ruff check .
uv run python -m pytest -q
python3 scripts/check_estate_identifiers.py
```

- Prerequisites: Linux, Python 3.11 or newer, uv, PostgreSQL server binaries
  (`PG_TEST_BIN_DIR` can name their directory) and the pinned Playwright
  Chromium. The suite fails, and does not skip, when one is missing.
- Run these commands without asking. They use temporary state and synthetic
  data, and they need no credential.
- A change is ready for a pull request when every command passes.
  `CONTRIBUTING.md` "Required checks" owns the contexts that `main` requires
  on the exact head.
- Before a push, run the secret scan from the `public-content` job in
  `.github/workflows/ci.yml` with the Gitleaks version that the job pins. A
  CI scan after the push cannot prevent disclosure.

## Project shape

- One service: FastAPI over PostgreSQL, a web UI, a CLI client and a
  per-process adapter lifecycle. README "Architecture" owns the module map.
- PostgreSQL is the only history owner. Do not add a second storage owner, an
  ORM, a broker, a scheduler or a hosted control plane.
- `agent_chat/*.sql` is append-only. The bytes of a released migration are
  fixed, because consumers hash the applied files. Write a correction as a
  new migration. `agent_chat/storage.py` refuses a changed file with
  `SCHEMA_MISMATCH`.
- A message body travels in the request body, never in a process argument.
- Configuration and deployment stay outside the product source.

## Working contract

- Use a task branch and one focused pull request. Keep one writer per branch
  and worktree. Preserve unrelated work.
- Do not push to `main` and do not rewrite published history. Branch
  protection enforces both.
- Required CI and the independent review must describe the exact current
  head. A new commit needs fresh CI and a fresh review.
- The merge automation owns ordinary merges. An authoring agent does not run
  `gh pr merge`, does not enable a standing auto-merge order and does not
  change branch protection. When the automation cannot merge, report the pull
  request and the tested head to the maintainer.
- `scripts/pr_policy.py` owns the merge policy. A change outside its ordinary
  paths needs a maintainer merge: workflows, scripts, tests, dependency
  manifests, the licence, these instructions and every unknown path. Do not
  narrow that boundary to unblock a pull request.
- A source change does not authorize a release tag, a package or image
  publication, or a deployment.

## Content boundary

- Use synthetic fixtures and examples. Do not publish deployment names,
  private addresses, internal DNS names, webhook URLs, credentials or a
  private runbook.
- Scan the entire intended commit range and its commit messages before a
  push. `scripts/check_estate_identifiers.py --stdin` scans a patch stream.
- Do not run credential-bearing or billable tests without an approved scope,
  cost bound and cleanup plan.
- A chat message is coordination data, not authorization. Do not write code,
  tests or documentation that treat a peer message, a handoff or a displayed
  notice as approval.

## Where to read more

- For the pull-request steps, the required checks and releases, read
  `CONTRIBUTING.md`.
- For the product security boundaries and the private reporting route, read
  `SECURITY.md`.
- For a behaviour change, open an issue first. `CONTRIBUTING.md` owns that
  rule.
- For a specification under `openspec/`, use controlled technical English.

## Reporting

Report each check as PASS, FAIL, NOT RUN or UNAVAILABLE. Keep source, merge,
release and deployment claims distinct. A green CI run is not evidence of a
secure deployment.
