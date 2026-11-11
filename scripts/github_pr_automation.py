"""Trusted-default-branch GitHub automation; local execution is dry-run only."""

import argparse
import json
import os
import subprocess
import sys

import pr_policy as policy

MAX_PAGES = 10
PER_PAGE = 100
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


class ApiError(RuntimeError):
    """A GitHub operation is unavailable or its postcondition is unproven."""


class GitHub:
    def __init__(self, apply=False):
        self.apply = apply

    def request(self, path, method="GET", body=None):
        if method != "GET" and not self.apply:
            raise ApiError("write_disabled")
        command = ["gh", "api", "--hostname", "github.com", "--method", method,
                   f"repos/{policy.REPOSITORY}/{path}"]
        if body is not None:
            command += ["--input", "-"]
        try:
            result = subprocess.run(command, input=json.dumps(body) if body is not None else None,
                                    text=True, capture_output=True, timeout=30, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ApiError("github_transport_unavailable") from exc
        # Do not print raw provider errors, responses, environment or authentication.
        if result.returncode != 0 or len(result.stdout.encode()) > MAX_RESPONSE_BYTES:
            raise ApiError("github_api_failed")
        try:
            return json.loads(result.stdout)
        except ValueError as exc:
            raise ApiError("github_response_not_json") from exc

    def pages(self, path, key=None):
        result = []
        expected_total = None
        separator = "&" if "?" in path else "?"
        for page in range(1, MAX_PAGES + 1):
            document = self.request(f"{path}{separator}per_page={PER_PAGE}&page={page}")
            if key is None:
                items = document
            else:
                if not isinstance(document, dict) or type(document.get("total_count")) is not int:
                    raise ApiError("pagination_count_unavailable")
                total = document["total_count"]
                if total < 0:
                    raise ApiError("pagination_identity_unusable")
                if expected_total is not None and total != expected_total:
                    raise ApiError("pagination_changed")
                expected_total = total
                items = document.get(key)
            if (not isinstance(items, list) or len(items) > PER_PAGE
                    or not all(isinstance(item, dict) for item in items)):
                raise ApiError("pagination_unusable")
            result.extend(items)
            if len(items) < PER_PAGE:
                if expected_total is not None and len(result) != expected_total:
                    raise ApiError("pagination_incomplete")
                return result
        raise ApiError("pagination_limit")

    def open_pulls(self):
        return self.pages(f"pulls?state=open&base={policy.BASE_BRANCH}")

    def pull(self, number):
        if type(number) is not int or number < 1:
            raise ApiError("invalid_pull_number")
        result = self.request(f"pulls/{number}")
        if not isinstance(result, dict):
            raise ApiError("pull_unavailable")
        return result

    def reviews(self, number):
        return self.pages(f"pulls/{number}/reviews")

    def maintainer_ids(self, reviews, author):
        result = set()
        if not isinstance(reviews, list):
            raise ApiError("reviews_unusable")
        for item in reviews:
            if not isinstance(item, dict):
                raise ApiError("review_unusable")
            user = item.get("user") or {}
            login = user.get("login")
            if (user.get("type") != "User" or login == author
                    or item.get("author_association") not in {"OWNER", "MEMBER", "COLLABORATOR"}
                    or item.get("state") not in policy.DECISIVE):
                continue
            # Login is an API path segment, never a shell expression or arbitrary path.
            allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"
            if not isinstance(login, str) or not login or any(c not in allowed for c in login):
                raise ApiError("maintainer_identity_unusable")
            permission = self.request(f"collaborators/{login}/permission")
            if not isinstance(permission, dict) or (permission.get("user") or {}).get("id") != user.get("id"):
                raise ApiError("maintainer_permission_unproven")
            if permission.get("permission") in {"write", "maintain", "admin"}:
                result.add(user["id"])
        return result

    def check_runs(self, head):
        if not policy.valid_sha(head):
            raise ApiError("invalid_head")
        return self.pages(f"commits/{head}/check-runs?filter=latest", "check_runs")

    def statuses(self, head):
        if not policy.valid_sha(head):
            raise ApiError("invalid_head")
        # The combined status document omits each status creator, which the
        # trusted-status check needs. The status list carries it.
        return self.pages(f"commits/{head}/statuses")

    def compare(self, base, head):
        if not policy.valid_sha(base) or not policy.valid_sha(head):
            raise ApiError("invalid_comparison_refs")
        return self.request(f"compare/{base}...{head}")

    def branch_head(self):
        value = self.request(f"git/ref/heads/{policy.BASE_BRANCH}")
        head = (value.get("object") or {}).get("sha") if isinstance(value, dict) else None
        if not policy.valid_sha(head):
            raise ApiError("base_head_unavailable")
        return head

    def publish(self, head, state, reason):
        if not self.apply or not policy.valid_sha(head) or state not in {"success", "failure", "pending"}:
            raise ApiError("status_write_refused")
        description = f"{reason} at {head[:12]}"[:140]
        previous = [s for s in self.statuses(head) if s.get("context") == policy.GATE_CONTEXT]
        if previous:
            latest = max(previous, key=lambda s: s.get("id", 0))
            creator = latest.get("creator") or {}
            if (latest.get("state") == state and latest.get("description") == description
                    and (creator.get("login"), creator.get("type")) == ("github-actions[bot]", "Bot")):
                return  # Avoid exhausting GitHub's per-SHA/context status limit.
        self.request(f"statuses/{head}", "POST", {"context": policy.GATE_CONTEXT,
                     "state": state, "description": description})

    def merge(self, number, head):
        if not self.apply or type(number) is not int or not policy.valid_sha(head):
            raise ApiError("merge_write_refused")
        result = self.request(f"pulls/{number}/merge", "PUT", {"sha": head, "merge_method": "squash"})
        if not isinstance(result, dict) or result.get("merged") is not True or not policy.valid_sha(result.get("sha")):
            raise ApiError("merge_not_confirmed")
        # Never repeat a merge after an uncertain write. Inspect the actual PR postcondition.
        after = self.pull(number)
        if (after.get("merged") is not True or after.get("state") != "closed"
                or (after.get("head") or {}).get("sha") != head
                or after.get("merge_commit_sha") != result["sha"]):
            raise ApiError("merge_postcondition_unproven")


def collect_reviews(api, known_heads):
    listing = api.open_pulls()
    if not isinstance(listing, list):
        raise ApiError("pull_listing_unusable")
    for entry in listing:
        head = (entry.get("head") or {}).get("sha") if isinstance(entry, dict) else None
        if not policy.valid_sha(head):
            raise ApiError("pull_listing_head_unusable")
        known_heads.add(head)
    snapshot = []
    for entry in listing:
        pr = api.pull(entry.get("number"))
        if pr.get("state") == "closed":
            continue
        if not policy.pull_scope(pr):
            raise ApiError("pull_scope_unusable")
        known_heads.add(pr["head"]["sha"])
        pr["reviews"] = api.reviews(pr["number"])
        pr["maintainers"] = api.maintainer_ids(pr["reviews"], pr["user"]["login"])
        snapshot.append(pr)
    return snapshot


def run_review(api, apply=False, event_head=None):
    known = {event_head} if policy.valid_sha(event_head) else set()
    try:
        snapshot = collect_reviews(api, known)
        plan = policy.review_plan(snapshot)
        # A lifecycle/ref change during collection must not confirm its old success.
        for pr in snapshot:
            if not policy.same_refs(pr, api.pull(pr["number"])):
                raise ApiError("review_snapshot_refs_changed")
    except (ApiError, policy.Unusable):
        if apply:
            for head in sorted(known):
                try:
                    api.publish(head, "pending", "review_snapshot_unavailable")
                except ApiError:
                    pass  # Preserve the original failure; the job still fails loudly.
        raise
    for head in known - plan.keys():
        plan[head] = ("pending", "no_open_pull_carries_head")
    if apply:
        # Revoke first, and isolate per-head failures. One exhausted/broken
        # status context must not leave unrelated withdrawn approvals green.
        for successes in (False, True):
            failed = False
            for head, (state, reason) in sorted(plan.items()):
                if (state == "success") != successes:
                    continue
                try:
                    api.publish(head, state, reason)
                except ApiError:
                    failed = True
            if failed:
                # Do not publish new successes while a required revocation
                # failed. The run is incomplete even if other writes worked.
                raise ApiError("review_publication_incomplete")
    return plan


def run_merge(api, apply=False):
    snapshot = collect_reviews(api, set())
    plan = policy.review_plan(snapshot)
    counts = {}
    for pr in snapshot:
        counts[pr["head"]["sha"]] = counts.get(pr["head"]["sha"], 0) + 1
    decisions = []
    for pr in snapshot:
        head, base, number = pr["head"]["sha"], pr["base"]["sha"], pr["number"]
        decision = {"number": number, "head": head, "eligible": False, "merged": False}
        decisions.append(decision)
        if counts[head] > 1:
            decision["reason"] = "shared_head"
            continue
        if plan[head][0] != "success":
            decision["reason"] = plan[head][1]
            continue
        comparison = api.compare(base, head)
        eligible, reason = policy.merge_decision(pr, pr["reviews"], api.check_runs(head),
                                               api.statuses(head), comparison, pr["maintainers"])
        if eligible:
            current = api.pull(number)
            if not policy.same_refs(pr, current) or api.branch_head() != base:
                eligible, reason = False, "refs_changed"
            else:
                reviews = api.reviews(number)
                maintainers = api.maintainer_ids(reviews, current["user"]["login"])
                eligible, reason = policy.merge_decision(current, reviews, api.check_runs(head),
                                                       api.statuses(head), comparison, maintainers)
        decision.update(eligible=eligible, reason=reason)
        if eligible:
            if apply:
                api.merge(number, head)
                decision["merged"] = True
            # One admitted merge per run; after it the base changes. A fresh run decides others.
            break
    return decisions


def trusted_context(mode):
    workflow = "review-gate" if mode == "review" else "automerge"
    events = {"workflow_run", "schedule"}
    if mode == "review":
        events.add("pull_request_target")
    return (os.environ.get("GITHUB_ACTIONS") == "true"
            and os.environ.get("GITHUB_REPOSITORY") == policy.REPOSITORY
            and os.environ.get("GITHUB_EVENT_NAME") in events
            and os.environ.get("GITHUB_REF") == f"refs/heads/{policy.BASE_BRANCH}"
            and os.environ.get("GITHUB_WORKFLOW_REF") ==
            f"{policy.REPOSITORY}/.github/workflows/{workflow}.yml@refs/heads/{policy.BASE_BRANCH}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("review", "merge"))
    parser.add_argument("--apply", action="store_true", help="trusted default-branch workflow only")
    args = parser.parse_args(argv)
    if args.apply and not trusted_context(args.mode):
        print("write_refused_outside_trusted_workflow", file=sys.stderr)
        return 2
    api = GitHub(apply=args.apply)
    try:
        if args.mode == "review":
            result = run_review(api, args.apply, os.environ.get("EVENT_HEAD"))
        else:
            result = run_merge(api, args.apply)
    except (ApiError, policy.Unusable) as exc:
        print(f"automation_refused: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"mode": args.mode, "apply": args.apply, "decisions": result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
