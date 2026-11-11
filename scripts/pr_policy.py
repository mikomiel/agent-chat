"""One owner for agent-chat's review and merge decisions.

The trusted status publisher and merger use these same rules. The pattern is
adapted from mikomiel/ci-burst (MIT, same copyright holder), which adapted it
from advisory-radar's review/status and sensitive-path controls; there is
deliberately no dependency-update review exemption.
"""

import re
from pathlib import PurePosixPath

REPOSITORY = "mikomiel/agent-chat"
BASE_BRANCH = "main"
REVIEWER = (351676210, "ecomwizards-gandalf[bot]", "Bot")
ACTIONS_APP_ID = 15368
REQUIRED_CHECKS = ("checks", "public-content")
GATE_CONTEXT = "review"
DECISIVE = {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}
REVIEW_STATES = DECISIVE | {"COMMENTED", "PENDING"}
ORDINARY_ROOT_DOCS = {"README.md", "CHANGELOG.md"}
ORDINARY_CHANGE_DOCS = {"proposal.md", "design.md", "tasks.md", ".openspec.yaml"}


class Unusable(ValueError):
    """A complete policy decision cannot be established from these inputs."""


def valid_sha(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) is not None


def review_verdict(reviews, head, author, maintainers=()):
    """Latest decisive state per verified identity; any change request blocks.

    ``maintainers`` contains numeric user IDs verified by the API consumer to
    have write, maintain or admin permission. Association labels alone do not
    grant that authority. Neither route accepts a review by the PR author.
    """
    if not valid_sha(head) or not isinstance(reviews, list) or not author:
        raise Unusable("invalid_review_snapshot")
    latest = {}
    for item in reviews:
        if not isinstance(item, dict):
            raise Unusable("invalid_review")
        user = item.get("user")
        if not isinstance(user, dict) or type(user.get("id")) is not int:
            raise Unusable("invalid_review_identity")
        if type(item.get("id")) is not int or item["id"] < 1:
            raise Unusable("invalid_review_id")
        state = item.get("state")
        if not isinstance(state, str) or state not in REVIEW_STATES:
            raise Unusable("unknown_review_state")
        identity = (user["id"], user.get("login"), user.get("type"))
        trusted = identity == REVIEWER or (user.get("type") == "User" and user["id"] in maintainers)
        if not trusted or user.get("login") == author or state not in DECISIVE:
            continue
        if not valid_sha(item.get("commit_id")):
            raise Unusable("invalid_review_commit")
        previous = latest.get(user["id"])
        if previous is None or item["id"] > previous["id"]:
            latest[user["id"]] = item
    if any(x["state"] == "CHANGES_REQUESTED" for x in latest.values()):
        return "failure", "changes_requested"
    if any(x["state"] == "APPROVED" and x["commit_id"] == head for x in latest.values()):
        return "success", "approved_at_head"
    return "pending", "current_head_approval_required"


def pull_scope(pr):
    if not isinstance(pr, dict):
        return False
    base, head, user = pr.get("base"), pr.get("head"), pr.get("user")
    if not all(isinstance(value, dict) for value in (base, head, user)):
        return False
    if not isinstance(base.get("repo"), dict):
        return False
    return (
        pr.get("state") == "open"
        and type(pr.get("number")) is int
        and type(pr.get("draft")) is bool
        and base.get("ref") == BASE_BRANCH
        and (base.get("repo") or {}).get("full_name") == REPOSITORY
        and valid_sha(base.get("sha"))
        and valid_sha(head.get("sha"))
        and isinstance(user.get("login"), str) and bool(user["login"])
    )


def review_plan(prs):
    """One verdict per SHA, worst open-PR verdict winning for a shared head."""
    if not isinstance(prs, list):
        raise Unusable("invalid_pull_snapshot")
    result = {}
    severity = {"success": 0, "pending": 1, "failure": 2}
    for pr in prs:
        if not pull_scope(pr):
            raise Unusable("invalid_pull_scope")
        head = pr["head"]["sha"]
        state, reason = review_verdict(
            pr.get("reviews"), head, pr["user"]["login"], pr.get("maintainers", ())
        )
        if pr["draft"]:
            state, reason = "pending", "pull_request_is_draft"
        if head not in result or severity[state] > severity[result[head][0]]:
            result[head] = (state, reason)
    return result


def checks_green(runs, statuses, head):
    """Require positive exact-head CI and the trusted status; never absence."""
    if not isinstance(runs, list) or not isinstance(statuses, list) or not valid_sha(head):
        raise Unusable("invalid_check_snapshot")
    latest_runs = {}
    for run in runs:
        if (not isinstance(run, dict) or type(run.get("id")) is not int
                or not isinstance(run.get("name"), str) or not run["name"]
                or not isinstance(run.get("app"), dict) or type(run["app"].get("id")) is not int):
            raise Unusable("invalid_check_run")
        if run.get("head_sha") != head:
            return False, "check_head_mismatch"
        key = (run["name"], run["app"]["id"])
        if key not in latest_runs or run["id"] > latest_runs[key]["id"]:
            latest_runs[key] = run
    for name in REQUIRED_CHECKS:
        run = latest_runs.get((name, ACTIONS_APP_ID))
        if not run or run.get("status") != "completed" or run.get("conclusion") != "success":
            return False, "required_check_not_success"
    if any(r.get("status") != "completed" or r.get("conclusion") not in {"success", "neutral", "skipped"}
           for r in latest_runs.values()):
        return False, "additional_check_not_green"
    latest_statuses = {}
    for status in statuses:
        if (not isinstance(status, dict) or type(status.get("id")) is not int
                or not isinstance(status.get("context"), str) or not status["context"]):
            raise Unusable("invalid_commit_status")
        key = status["context"]
        if key not in latest_statuses or status["id"] > latest_statuses[key]["id"]:
            latest_statuses[key] = status
    gate = latest_statuses.get(GATE_CONTEXT)
    if not gate or gate.get("state") != "success":
        return False, "review_status_not_success"
    creator = gate.get("creator")
    if (not isinstance(creator, dict)
            or (creator.get("login"), creator.get("type")) != ("github-actions[bot]", "Bot")):
        return False, "untrusted_review_status"
    if any(s.get("state") != "success" for s in latest_statuses.values()):
        return False, "additional_status_not_green"
    return True, "checks_green"


def changed_paths(comparison, declared, base):
    """Only the immutable comparison of this complete, current-base diff."""
    if type(declared) is not int or declared < 1 or not isinstance(comparison, dict):
        raise Unusable("invalid_changed_file_count")
    origin, ancestor = comparison.get("base_commit"), comparison.get("merge_base_commit")
    if not isinstance(origin, dict) or origin.get("sha") != base:
        raise Unusable("comparison_base_mismatch")
    if not isinstance(ancestor, dict) or ancestor.get("sha") != base:
        raise Unusable("head_is_behind_base")
    if comparison.get("status") != "ahead":
        raise Unusable("comparison_not_ahead")
    files = comparison.get("files")
    if not isinstance(files, list) or len(files) != declared:
        raise Unusable("incomplete_changed_files")
    paths = []
    for item in files:
        if not isinstance(item, dict) or not item.get("filename"):
            raise Unusable("invalid_changed_path")
        for key in ("filename", "previous_filename"):
            path = item.get(key)
            if path is None:
                continue
            if (not isinstance(path, str) or not path or path.startswith("/")
                    or "\\" in path or "\0" in path or any(x in {".", "..", ""} for x in path.split("/"))):
                raise Unusable("invalid_changed_path")
            paths.append(path)
    return paths


def sensitive(path):
    """Unknown areas are human-only, not implicitly safe for automation.

    Ordinary: the product package and documentation. Everything else,
    including workflows, scripts, tests, dependency manifests, the licence and
    agent instructions, needs a human merge; a new ordinary area requires a
    reviewed policy change and tests.
    """
    if path in ORDINARY_ROOT_DOCS:
        return False
    parts = PurePosixPath(path).parts
    if parts[:1] == ("agent_chat",):
        return False
    if parts[:2] == ("openspec", "changes"):
        if len(parts) == 4 and parts[3] in ORDINARY_CHANGE_DOCS:
            return False
        if len(parts) == 6 and parts[3] == "specs" and parts[5] == "spec.md":
            return False
    return True


def merge_decision(pr, reviews, runs, statuses, comparison, maintainers=()):
    """Native GraphQL reviewDecision is intentionally not an input gate."""
    try:
        if not pull_scope(pr) or pr["draft"]:
            return False, "pull_not_ready"
        if pr.get("mergeable") is not True or pr.get("mergeable_state") != "clean":
            return False, "mergeability_not_clean"
        state, reason = review_verdict(reviews, pr["head"]["sha"], pr["user"]["login"], maintainers)
        if state != "success":
            return False, reason
        # A verified maintainer can serve the manual-review fallback, but the
        # operator requires Gandalf itself for unattended ordinary-area merges.
        if review_verdict(reviews, pr["head"]["sha"], pr["user"]["login"])[0] != "success":
            return False, "gandalf_required_for_automerge"
        green, reason = checks_green(runs, statuses, pr["head"]["sha"])
        if not green:
            return False, reason
        paths = changed_paths(comparison, pr.get("changed_files"), pr["base"]["sha"])
        if any(sensitive(path) for path in paths):
            return False, "sensitive_paths"
    except Unusable as exc:
        return False, str(exc)
    return True, "eligible"


def same_refs(before, after):
    """Snapshot equality, not merge readiness: an unchanged draft is valid."""
    return (pull_scope(before) and pull_scope(after) and before["draft"] == after["draft"]
            and before["number"] == after["number"]
            and before["head"]["sha"] == after["head"]["sha"]
            and before["base"]["sha"] == after["base"]["sha"])
