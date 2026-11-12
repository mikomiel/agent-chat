"""Behavioural contracts for the trusted merge policy; no network."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import pr_policy as policy

HEAD = "b" * 40
OTHER = "c" * 40


def run(name, conclusion="success", head=HEAD, app_id=None):
    return {
        "id": 1,
        "name": name,
        "head_sha": head,
        "status": "completed" if conclusion is not None else "in_progress",
        "conclusion": conclusion,
        "app": {"id": app_id or policy.ACTIONS_APP_ID},
    }


def checks():
    return [dict(run(name), id=index) for index, name in enumerate(policy.REQUIRED_CHECKS, 1)]


def statuses():
    return [{"id": 1, "context": policy.GATE_CONTEXT, "state": "success",
             "creator": {"login": "github-actions[bot]", "type": "Bot"}}]


def refused(runs):
    return policy.checks_green(runs, statuses(), HEAD)[0] is False


def test_all_required_checks_green_passes():
    assert policy.checks_green(checks(), statuses(), HEAD)[0] is True


def test_missing_dependency_review_refuses():
    assert refused([r for r in checks() if r["name"] != "dependency-review"])


def test_skipped_dependency_review_refuses():
    runs = checks()
    for item in runs:
        if item["name"] == "dependency-review":
            item["conclusion"] = "skipped"
    assert refused(runs)


def test_pending_dependency_review_refuses():
    runs = checks()
    for item in runs:
        if item["name"] == "dependency-review":
            item.update(status="in_progress", conclusion=None)
    assert refused(runs)


def test_failed_dependency_review_refuses():
    runs = checks()
    for item in runs:
        if item["name"] == "dependency-review":
            item["conclusion"] = "failure"
    assert refused(runs)


def test_dependency_review_from_another_app_refuses():
    runs = checks()
    for item in runs:
        if item["name"] == "dependency-review":
            item["app"] = {"id": 7}
    assert refused(runs)


def test_dependency_review_from_another_head_refuses():
    runs = checks()
    for item in runs:
        if item["name"] == "dependency-review":
            item["head_sha"] = OTHER
    assert refused(runs)
