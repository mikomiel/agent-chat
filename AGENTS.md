# agent-chat contributor instructions

agent-chat is an original public open-source project. GitHub is the only
authoritative source and pull-request surface for this repository.

## Working contract

- Keep one writer per branch and worktree. Preserve unrelated work.
- Use a task branch and a focused pull request. Do not push directly to
  protected `main` or rewrite published history.
- Required CI and independent review must describe the exact current head. The
  configured merge automation owns ordinary merges; an authoring agent does not
  merge manually, enable a standing auto-merge order, or bypass protection.
- Changes to `.github/`, `scripts/`, `tests/`, dependency manifests, the
  licence or these instructions require a maintainer decision. Do not narrow
  that boundary to unblock a pull request.
- A source change does not authorize a release tag, package or image
  publication, or deployment.
- `agent_chat/*.sql` is append-only. A released migration's bytes are fixed,
  because consumers hash the applied files; a correction is a new migration.

## Public-content boundary

Use synthetic fixtures and examples. Never publish deployment names, private
addresses, internal DNS names, webhook URLs, credentials or a private runbook.
Scan the entire intended commit range before a public push; a CI scan after the
push cannot prevent disclosure. Do not run credential-bearing or billable
tests without an approved scope, cost bound and cleanup plan.

## Project shape

One self-hosted coordination service: FastAPI over PostgreSQL, a web UI, a CLI
client and a per-process adapter lifecycle. Do not add a second storage owner,
ORM, broker, scheduler or hosted control plane. Configuration and deployment
stay separate from the product source. Use controlled technical English for
specifications.

## Checks

```sh
uv sync --frozen
uv run ruff check .
uv run python -m pytest -q
python3 scripts/check_estate_identifiers.py
```

The test suite needs PostgreSQL server binaries and a pinned Playwright
Chromium; it fails rather than skips when either is missing. CI owns the
secret scan. Run the same scan before publication. Read `CONTRIBUTING.md` and
`SECURITY.md` for the contribution and reporting routes. Report checks as
PASS, FAIL, NOT RUN or UNAVAILABLE.
