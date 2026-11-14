"""Workflow and merge-policy invariants.

A SHA-pinned action or a required check is only useful if a later edit cannot
silently unpin it. These tests read the committed workflow files and the policy
module, so a change to either fails here before it reaches the default branch.
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
DEFAULT_BRANCH = "${{ github.event.repository.default_branch }}"
DEFAULT_RUNNER = "ubuntu-24.04"
PINNED_ACTION = re.compile(r"^[^@]+@[0-9a-f]{40}$")


def workflow(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def triggers(document: dict) -> dict:
    # PyYAML resolves the YAML 1.1 boolean spelling of ``on`` to True.
    value = document.get("on", document.get(True))
    assert isinstance(value, dict), "a workflow must declare a mapping of triggers"
    return value


def policy_module():
    path = ROOT / "scripts" / "pr_policy.py"
    spec = importlib.util.spec_from_file_location("agent_chat_pr_policy", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("name", "mode", "permission"),
    [
        ("review-gate.yml", "review", {"contents": "read", "pull-requests": "read", "statuses": "write"}),
        (
            "automerge.yml",
            "merge",
            {"contents": "write", "pull-requests": "write", "checks": "read", "statuses": "read"},
        ),
    ],
)
def test_write_token_workflows_run_only_trusted_default_branch_code(
    name: str, mode: str, permission: dict
) -> None:
    document = workflow(name)
    assert document["permissions"] == permission
    assert document.get("env") is None
    assert document.get("defaults") is None
    assert document["concurrency"]["cancel-in-progress"] is False
    for job in document["jobs"].values():
        assert job.get("permissions") is None
        assert job.get("env") is None
        assert job.get("defaults") is None
        assert job.get("container") is None
        assert job.get("services") is None
        assert job.get("environment") is None
        assert job["runs-on"] == DEFAULT_RUNNER
        assert job["timeout-minutes"] <= 10
        checkout, execute = job["steps"]
        assert len(job["steps"]) == 2, "a write-token job has an explicit two-step allowlist"
        assert PINNED_ACTION.match(checkout["uses"])
        assert checkout["with"] == {"ref": DEFAULT_BRANCH, "persist-credentials": False}
        assert execute["run"] == f"python3 scripts/github_pr_automation.py {mode} --apply"
        assert execute["env"]["GH_TOKEN"] == "${{ github.token }}"


@pytest.mark.parametrize("name", ["review-gate.yml", "automerge.yml"])
def test_write_token_workflows_have_no_pr_head_trigger(name: str) -> None:
    declared = triggers(workflow(name))
    for forbidden in ("pull_request", "pull_request_review", "workflow_dispatch", "repository_dispatch"):
        assert declared.get(forbidden) is None
    assert declared["workflow_run"]["types"] == ["completed"]
    assert "CI" in declared["workflow_run"]["workflows"]
    assert declared["schedule"]


def test_review_gate_observes_lifecycle_without_executing_the_head() -> None:
    document = workflow("review-gate.yml")
    declared = triggers(document)
    assert set(declared["pull_request_target"]["types"]) == {
        "opened",
        "reopened",
        "synchronize",
        "ready_for_review",
        "converted_to_draft",
        "closed",
    }
    steps = document["jobs"]["publish-review"]["steps"]
    assert steps[1]["env"]["EVENT_HEAD"] == "${{ github.event.pull_request.head.sha }}"
    assert declared["schedule"][0]["cron"] == "*/5 * * * *"


def test_automerge_wakes_only_from_trusted_completion_or_its_sweep() -> None:
    declared = triggers(workflow("automerge.yml"))
    assert sorted(declared) == ["schedule", "workflow_run"]
    assert "review-gate" in declared["workflow_run"]["workflows"]


def test_validation_ci_is_read_only_and_runs_the_declared_checks() -> None:
    document = workflow("ci.yml")
    assert document["permissions"] == {"contents": "read"}
    jobs = document["jobs"]
    assert jobs["checks"]["name"] == "checks"
    assert jobs["public-content"]["name"] == "public-content"
    for job in jobs.values():
        assert job.get("permissions") is None
    commands = [step["run"] for step in jobs["checks"]["steps"] if "run" in step]
    assert "uv run ruff check ." in commands
    assert "uv run python -m pytest -q -n 4 --durations=15" in commands
    assert "uv sync --frozen" in commands
    checkout = next(step for step in jobs["checks"]["steps"] if step.get("uses", "").startswith("actions/checkout@"))
    assert checkout["with"]["persist-credentials"] is False
    scan = [step["run"] for step in jobs["public-content"]["steps"] if "run" in step]
    assert any("gitleaks" in command for command in scan)
    assert "python3 scripts/check_estate_identifiers.py" in scan
    assert any("git log --all --format= --patch" in command and "--stdin" in command for command in scan)
    history = next(
        step
        for step in jobs["public-content"]["steps"]
        if step.get("name") == "Scan the commit range for private estate identifiers"
    )
    assert history["shell"] == "bash"
    assert "set -euo pipefail" in history["run"]


def test_every_action_reference_is_sha_pinned() -> None:
    for path in sorted(WORKFLOWS.glob("*.yml")):
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
        for job in document["jobs"].values():
            for step in job["steps"]:
                if "uses" in step:
                    assert PINNED_ACTION.match(step["uses"]), f"{path.name}: unpinned {step['uses']}"


JOB_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")


def test_every_workflow_job_identifier_is_valid_for_actions() -> None:
    """A job key is an Actions identifier: letters, digits, ``_`` and ``-``.

    A period is not allowed. GitHub rejects the whole workflow file, so the
    required jobs in the same file stop reporting; a version such as ``3.11``
    in a job key is exactly the shape this catches.
    """

    for path in sorted(WORKFLOWS.glob("*.yml")):
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
        for job_id in document["jobs"]:
            assert JOB_ID.fullmatch(job_id), f"{path.name}: invalid job identifier {job_id!r}"


def test_merge_policy_admits_only_the_intended_ordinary_areas() -> None:
    policy = policy_module()
    assert policy.REPOSITORY == "mikomiel/agent-chat"
    assert policy.BASE_BRANCH == "main"
    assert policy.REQUIRED_CHECKS == ("checks", "public-content", "dependency-review")
    assert policy.GATE_CONTEXT == "review"
    assert policy.sensitive("README.md") is False
    assert policy.sensitive("CHANGELOG.md") is False
    assert policy.sensitive("agent_chat/api.py") is False
    assert policy.sensitive("agent_chat/web/chat.js") is False
    assert policy.sensitive("tests/test_api.py") is True
    assert policy.sensitive("scripts/pr_policy.py") is True
    assert policy.sensitive(".github/workflows/ci.yml") is True
    assert policy.sensitive("pyproject.toml") is True
    assert policy.sensitive("LICENSE") is True
    assert policy.sensitive("AGENTS.md") is True
    assert policy.sensitive("docs/architecture.md") is True


def test_release_please_observes_automated_merges_and_requires_its_token() -> None:
    """The push trigger alone never fires for an automerge GITHUB_TOKEN merge."""
    document = workflow("release-please.yml")
    declared = triggers(document)
    assert declared["push"]["branches"] == ["main"]
    assert declared["workflow_run"]["workflows"] == ["automerge"]
    assert declared["workflow_run"]["types"] == ["completed"]
    assert document["permissions"] == {"contents": "write", "pull-requests": "write"}
    job = document["jobs"]["release-please"]
    assert job["runs-on"] == DEFAULT_RUNNER
    assert job["timeout-minutes"] <= 10
    assert " ".join(job["if"].split()) == (
        "github.event_name != 'workflow_run' "
        "|| github.event.workflow_run.head_branch == 'main'"
    )
    (step,) = job["steps"]
    assert PINNED_ACTION.match(step["uses"])
    assert step["uses"].startswith("googleapis/release-please-action@")
    assert step["with"] == {
        "token": "${{ secrets.RELEASE_PLEASE_TOKEN }}",
        "config-file": "release-please-config.json",
        "manifest-file": ".release-please-manifest.json",
    }


def test_release_metadata_is_never_auto_merged() -> None:
    policy = policy_module()
    assert policy.sensitive("release-please-config.json") is True
    assert policy.sensitive(".release-please-manifest.json") is True


def test_release_please_updates_the_lockfile_project_version() -> None:
    """release-please bumps pyproject.toml; the lock's root version needs the same bump.

    A release pull request that skipped ``uv.lock`` would leave ``main`` stale
    while ``uv sync --frozen`` kept CI green. This pins the extra-files entry
    that prevents it; if release-please stops matching the jsonpath, the lock
    check in ``checks`` fails the release pull request instead of merging it.
    """
    config = json.loads((ROOT / "release-please-config.json").read_text(encoding="utf-8"))
    (entry,) = config["packages"]["."]["extra-files"]
    assert entry == {
        "type": "toml",
        "path": "uv.lock",
        "jsonpath": "$.package[?(@.name.value=='agent-chat')].version",
    }


def test_checks_asserts_the_lockfile_is_current() -> None:
    """The check is the backstop for the extra-files entry, so it must stay in ``checks``.

    Removing the step breaks the singleton unpacking. These assertions also
    keep it fail-closed: a later ``if``, ``continue-on-error`` or an
    intervening ``uv run`` (which can relock an environment) would turn the
    guard into a no-op or repair the lock before it is checked.
    """
    steps = workflow("ci.yml")["jobs"]["checks"]["steps"]
    (step,) = [item for item in steps if item.get("run") == "uv lock --check"]
    assert step["name"] == "Lockfile is current"
    assert "if" not in step
    assert "continue-on-error" not in step
    runs = [item.get("run") for item in steps]
    sync = runs.index("uv sync --frozen")
    assert runs.index("uv lock --check") == sync + 1
