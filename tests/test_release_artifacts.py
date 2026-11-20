"""Every harness package is released at the product version, with the same rule.

``integrations/<harness>/`` is a self-contained package directory with
``package.json`` at its root, and every such directory ships at the version in
``pyproject.toml``. These tests enumerate the directories, so a package that
someone adds later is held to the rule without an edit here. They read files
only: no network, no ``npm`` and no build. ``scripts/check_release_artifacts.py``
proves the built artifacts, and the release workflow runs it.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tomllib
import zipfile
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
INTEGRATIONS = ROOT / "integrations"
WORKFLOWS = ROOT / ".github" / "workflows"
PACKAGES = sorted(path for path in INTEGRATIONS.iterdir() if path.is_dir())
PROJECT_VERSION = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
DEFAULT_RUNNER = "ubuntu-24.04"
TAG_CHECK_STEP = "Release tag matches the project version"
INSTALL_SECTION = "## Install a pinned release"


def load_script():
    path = ROOT / "scripts" / "check_release_artifacts.py"
    spec = importlib.util.spec_from_file_location("agent_chat_check_release_artifacts", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


script = load_script()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def release_please_entries() -> list[dict]:
    config = read_json(ROOT / "release-please-config.json")
    return config["packages"]["."]["extra-files"]


def glob_pattern(glob: str) -> re.Pattern[str]:
    """The release-please glob dialect used here: ``*`` stays inside one path segment.

    release-please matches with minimatch, where a leading ``*`` does not match
    a name that starts with a dot. Any other glob character is refused rather
    than guessed, so this test cannot report coverage that release-please would
    not give.
    """
    assert not re.search(r"[\[\]{}?!]|\*\*", glob), f"a glob form this test does not model: {glob}"
    segments = []
    for segment in glob.split("/"):
        parts = [re.escape(part) for part in segment.split("*")]
        segments.append(("(?!\\.)" if segment.startswith("*") else "") + "[^/]*".join(parts))
    return re.compile("/".join(segments))


def bumps_version(entry: dict, relative: str) -> bool:
    if entry.get("type") != "json" or entry.get("jsonpath") != "$.version":
        return False
    if entry["path"] == relative:
        return True
    return bool(entry.get("glob")) and glob_pattern(entry["path"]).fullmatch(relative) is not None


def covered(relative: str) -> bool:
    return any(bumps_version(entry, relative) for entry in release_please_entries())


def package_readme(package: Path) -> str:
    return (package / "README.md").read_text(encoding="utf-8")


def test_the_integrations_directory_holds_packages() -> None:
    """A parametrized test over no directory would be skipped, which proves nothing."""
    assert {path.name for path in PACKAGES} >= {"pi", "deepseek", "claude-code"}


def test_release_please_bumps_the_uv_lock_and_the_integration_manifests() -> None:
    """The whole list is pinned: the uv.lock entry unchanged, then the two directory globs.

    A glob names every package directory, so a new harness needs no edit here or
    in the config. ``path`` is matched against the target branch's tree by
    release-please itself, and ``test_every_package_version_is_bumped_by_release_please``
    proves each directory is matched.
    """
    assert release_please_entries() == [
        {
            "type": "toml",
            "path": "uv.lock",
            "jsonpath": "$.package[?(@.name.value=='sessionyard')].version",
        },
        {"type": "json", "path": "integrations/*/package.json", "glob": True, "jsonpath": "$.version"},
        {"type": "json", "path": "integrations/*/.claude-plugin/plugin.json", "glob": True, "jsonpath": "$.version"},
    ]


@pytest.mark.parametrize("package", PACKAGES, ids=lambda path: path.name)
def test_every_directory_is_a_package_at_the_product_version(package: Path) -> None:
    manifest = read_json(package / "package.json")
    assert manifest["name"] == f"agent-chat-{package.name}", "npm pack names the release asset after the package name"
    assert manifest["version"] == PROJECT_VERSION
    assert manifest["private"] is True, "publishing to npm is a separate decision"
    assert manifest["engines"]["node"].startswith(">=")


def test_the_release_please_coverage_check_can_fail() -> None:
    """The glob model must refuse what release-please would not bump, or coverage proves nothing."""
    entry = {"type": "json", "path": "integrations/*/package.json", "glob": True, "jsonpath": "$.version"}
    assert bumps_version(entry, "integrations/codex/package.json")
    assert not bumps_version(entry, "integrations/codex/nested/package.json")
    assert not bumps_version(entry, "integrations/.hidden/package.json")
    assert not bumps_version(entry, "integrations/codex/package-lock.json")
    assert not bumps_version({**entry, "glob": False}, "integrations/codex/package.json")
    assert not bumps_version({**entry, "jsonpath": "$.name"}, "integrations/codex/package.json")
    assert not bumps_version({**entry, "type": "toml"}, "integrations/codex/package.json")
    assert bumps_version(
        {**entry, "path": "integrations/codex/package.json", "glob": False}, "integrations/codex/package.json"
    )


@pytest.mark.parametrize("package", PACKAGES, ids=lambda path: path.name)
def test_every_package_version_is_bumped_by_release_please(package: Path) -> None:
    assert covered(f"integrations/{package.name}/package.json")


@pytest.mark.parametrize("package", PACKAGES, ids=lambda path: path.name)
def test_files_allowlist_ships_everything_but_the_tests(package: Path) -> None:
    """Without ``files`` npm packs the tests; with a stale one it drops a new directory."""
    files = read_json(package / "package.json")["files"]
    assert files and all(isinstance(entry, str) for entry in files)
    names = {entry.rstrip("/") for entry in files}
    assert "README.md" in names
    for name in names:
        assert (package / name).exists(), f"files lists {name}, which is not in the package"
        assert name.split("/")[0] not in {"test", "tests", "node_modules"}
    top_level = {path.name for path in package.iterdir()} - {"package.json", "test", "node_modules"}
    assert top_level <= names, f"top-level paths missing from files: {sorted(top_level - names)}"


@pytest.mark.parametrize("package", PACKAGES, ids=lambda path: path.name)
def test_each_package_reads_the_shared_opt_out_and_one_documented_config_variable(package: Path) -> None:
    config = (package / "lib" / "config.js").read_text(encoding="utf-8")
    assert "AGENT_CHAT_DELEGATED_CHILD" in config
    (variable,) = set(re.findall(r"AGENT_CHAT_[A-Z0-9]+_CONFIG", config))
    assert variable in package_readme(package)
    overview = (INTEGRATIONS / "README.md").read_text(encoding="utf-8")
    assert variable in overview, "the per-harness variable table in integrations/README.md lists it"
    assert "AGENT_CHAT_DELEGATED_CHILD" in overview


@pytest.mark.parametrize("package", PACKAGES, ids=lambda path: path.name)
def test_each_package_readme_names_its_release_asset_and_points_at_the_install_steps(package: Path) -> None:
    readme = package_readme(package)
    assert f"agent-chat-{package.name}-<version>.tgz" in readme
    # An absolute link: the tarball ships only the package README.
    assert "https://github.com/mikomiel/agent-chat/blob/main/integrations/README.md#install-a-pinned-release" in readme


def test_the_overview_documents_the_install_by_version_steps_and_the_compatibility_rule() -> None:
    overview = (INTEGRATIONS / "README.md").read_text(encoding="utf-8")
    assert INSTALL_SECTION in overview
    assert "SHA256SUMS" in overview
    assert "tested only with the core of the same version" in overview


@pytest.mark.parametrize(
    "package",
    [path for path in PACKAGES if (path / ".claude-plugin" / "plugin.json").is_file()],
    ids=lambda path: path.name,
)
def test_a_claude_plugin_is_at_the_package_version_and_listed_in_the_marketplace(package: Path) -> None:
    plugin = read_json(package / ".claude-plugin" / "plugin.json")
    assert plugin["version"] == read_json(package / "package.json")["version"]
    assert covered(f"integrations/{package.name}/.claude-plugin/plugin.json")
    marketplace = read_json(ROOT / ".claude-plugin" / "marketplace.json")
    (entry,) = [item for item in marketplace["plugins"] if item["name"] == plugin["name"]]
    assert (ROOT / entry["source"]).resolve() == package.resolve()
    # plugin.json wins when both set a version, and `claude plugin validate` warns.
    assert "version" not in entry


def test_the_marketplace_is_a_valid_catalog_of_relative_plugin_sources() -> None:
    marketplace = read_json(ROOT / ".claude-plugin" / "marketplace.json")
    assert marketplace["name"] == "agent-chat"
    assert marketplace["owner"]["name"]
    names = [entry["name"] for entry in marketplace["plugins"]]
    assert names and len(names) == len(set(names))
    for entry in marketplace["plugins"]:
        assert entry["source"].startswith("./") and ".." not in entry["source"].split("/")
        manifest = ROOT / entry["source"] / ".claude-plugin" / "plugin.json"
        assert read_json(manifest)["name"] == entry["name"]


def workflow() -> dict:
    return yaml.safe_load((WORKFLOWS / "release-integrations.yml").read_text(encoding="utf-8"))


def test_integration_assets_are_attached_only_when_a_release_is_published() -> None:
    document = workflow()
    assert document.get("on", document.get(True)) == {"release": {"types": ["published"]}}
    assert document["permissions"] == {}
    assert document.get("env") is None
    assert document.get("defaults") is None
    jobs = document["jobs"]
    assert set(jobs) == {"pack", "upload"}
    for job in jobs.values():
        assert job["runs-on"] == DEFAULT_RUNNER
        assert job["timeout-minutes"] <= 10
        assert job.get("env") is None
        assert job.get("container") is None
        assert job.get("services") is None
        assert job.get("environment") is None
    assert jobs["pack"]["permissions"] == {"contents": "read"}
    assert jobs["upload"]["permissions"] == {"contents": "write"}
    assert jobs["upload"]["needs"] == "pack"


def test_the_job_that_may_write_runs_no_repository_code() -> None:
    """``pack`` runs npm and the check script with a read-only token; ``upload`` only downloads and uploads."""
    jobs = workflow()["jobs"]
    pack, upload = jobs["pack"]["steps"], jobs["upload"]["steps"]
    checkout = pack[0]
    assert checkout["uses"].startswith("actions/checkout@")
    assert checkout["with"] == {"persist-credentials": False, "ref": "${{ github.sha }}"}
    download, release = upload
    assert download["uses"].startswith("actions/download-artifact@")
    assert download["with"] == {"name": "integration-assets", "path": "assets/"}
    assert not any(step.get("uses", "").startswith("actions/checkout@") for step in upload)
    assert release["env"] == {
        "GH_TOKEN": "${{ github.token }}",
        "RELEASE_TAG": "${{ github.event.release.tag_name }}",
    }
    assert "${{" not in release["run"]
    # Only the checked set is uploaded: the tarballs and SHA256SUMS, never assets/*.
    assert release["run"] == (
        'gh release upload "$RELEASE_TAG" assets/*.tgz assets/SHA256SUMS --repo "$GITHUB_REPOSITORY" --clobber'
    )
    assert "if" not in release and "continue-on-error" not in release


def test_the_release_packs_every_directory_through_the_checked_command() -> None:
    steps = workflow()["jobs"]["pack"]["steps"]
    (tag,) = [step for step in steps if step.get("name") == TAG_CHECK_STEP]
    (pack,) = [step for step in steps if step.get("name") == "Pack and check the integrations"]
    (upload,) = [step for step in steps if step.get("uses", "").startswith("actions/upload-artifact@")]
    # One command packs and verifies: no harness is named, and the directories come from a listing.
    assert pack["run"] == "python scripts/check_release_artifacts.py --pack --integrations-only assets"
    assert upload["with"] == {"name": "integration-assets", "path": "assets/", "if-no-files-found": "error"}
    assert steps.index(tag) < steps.index(pack) < steps.index(upload)
    for step in (tag, pack):
        assert "if" not in step and "continue-on-error" not in step
    assert tag["env"] == {"RELEASE_TAG": "${{ github.event.release.tag_name }}"}
    assert "${{" not in tag["run"]
    assert "set -euo pipefail" in tag["run"]


def test_the_release_tag_check_passes_only_the_exact_project_version(tmp_path: Path) -> None:
    """Run the committed script: the text assertions cannot catch an inverted comparison."""
    steps = workflow()["jobs"]["pack"]["steps"]
    (step,) = [item for item in steps if item.get("name") == TAG_CHECK_STEP]
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "python").symlink_to(sys.executable)
    marker = tmp_path / "injected"

    def check(tag: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step["run"]],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
            cwd=ROOT,
            env={**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "RELEASE_TAG": tag},
        )

    assert check(f"v{PROJECT_VERSION}").returncode == 0
    for tag in (
        PROJECT_VERSION,
        f"v{PROJECT_VERSION}.1",
        f"v{PROJECT_VERSION}-rc1",
        "",
        f"v{PROJECT_VERSION}$(touch {marker})",
    ):
        result = check(tag)
        assert result.returncode == 1, tag
        assert f"v{PROJECT_VERSION}" in result.stderr
    assert not marker.exists()


# The artifact checker, against archives built here. A check that cannot fail proves nothing.

VERSION = "1.2.3"
HARNESSES = ("alpha", "beta")


def write_tarball(path: Path, members: dict[str, str]) -> None:
    with tarfile.open(path, "w:gz") as archive:
        for name, text in members.items():
            data = text.encode("utf-8")
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))


def tracked_files(harness: str) -> list[str]:
    return [
        f"integrations/{harness}/{name}" for name in ("package.json", "README.md", "lib/config.js", "test/a.test.js")
    ]


def tarball_members(harness: str, version: str = VERSION) -> dict[str, str]:
    package = {"name": f"agent-chat-{harness}", "version": version, "main": "./lib/config.js"}
    return {
        "package/package.json": json.dumps(package),
        "package/README.md": "readme",
        "package/lib/config.js": "export {}",
    }


def write_sums(dist: Path) -> None:
    lines = [f"{script.sha256(path)}  {path.name}\n" for path in sorted(dist.glob("*.tgz"))]
    (dist / script.SUMS).write_text("".join(lines), encoding="utf-8")


@pytest.fixture
def release(tmp_path: Path) -> tuple[Path, Path, list[str]]:
    root, dist = tmp_path / "root", tmp_path / "dist"
    dist.mkdir()
    tracked: list[str] = []
    for harness in HARNESSES:
        (root / "integrations" / harness).mkdir(parents=True)
        (root / "integrations" / harness / "package.json").write_text("{}", encoding="utf-8")
        write_tarball(dist / script.tarball_name(harness, VERSION), tarball_members(harness))
        tracked.extend(tracked_files(harness))
    write_sums(dist)
    return root, dist, tracked


def problems(release: tuple[Path, Path, list[str]]) -> list[str]:
    root, dist, tracked = release
    return script.check_tarballs(root, dist, VERSION, tracked)


def test_a_complete_set_of_tarballs_passes(release: tuple[Path, Path, list[str]]) -> None:
    assert problems(release) == []


def test_a_directory_without_a_tarball_fails(release: tuple[Path, Path, list[str]]) -> None:
    _, dist, _ = release
    (dist / script.tarball_name("beta", VERSION)).unlink()
    assert any("no tarball agent-chat-beta-1.2.3.tgz" in error for error in problems(release))


def test_a_new_package_directory_must_be_packed(release: tuple[Path, Path, list[str]]) -> None:
    root, _, _ = release
    (root / "integrations" / "gamma").mkdir()
    (root / "integrations" / "gamma" / "package.json").write_text("{}", encoding="utf-8")
    assert any("no tarball agent-chat-gamma-1.2.3.tgz" in error for error in problems(release))


def test_a_directory_without_package_json_fails(release: tuple[Path, Path, list[str]]) -> None:
    root, _, _ = release
    (root / "integrations" / "gamma").mkdir()
    assert any("integrations/gamma: no package.json" in error for error in problems(release))


def test_a_tarball_of_a_removed_package_fails(release: tuple[Path, Path, list[str]]) -> None:
    _, dist, _ = release
    write_tarball(dist / script.tarball_name("gone", VERSION), tarball_members("gone"))
    write_sums(dist)
    assert any("unexpected tarball agent-chat-gone-1.2.3.tgz" in error for error in problems(release))


def test_a_tarball_at_another_version_fails(release: tuple[Path, Path, list[str]]) -> None:
    _, dist, _ = release
    write_tarball(dist / script.tarball_name("alpha", VERSION), tarball_members("alpha", "0.1.0"))
    write_sums(dist)
    assert any("package version is '0.1.0'" in error for error in problems(release))


def test_a_tarball_with_a_test_path_fails(release: tuple[Path, Path, list[str]]) -> None:
    _, dist, _ = release
    members = {**tarball_members("alpha"), "package/test/a.test.js": "test"}
    write_tarball(dist / script.tarball_name("alpha", VERSION), members)
    write_sums(dist)
    assert any("unexpected test/a.test.js" in error for error in problems(release))


def test_a_tarball_that_drops_a_tracked_file_fails(release: tuple[Path, Path, list[str]]) -> None:
    _, dist, _ = release
    members = tarball_members("alpha")
    del members["package/lib/config.js"]
    write_tarball(dist / script.tarball_name("alpha", VERSION), members)
    write_sums(dist)
    errors = problems(release)
    assert any("missing lib/config.js" in error for error in errors)
    assert any("declared entry point lib/config.js is not in the tarball" in error for error in errors)


def test_the_sums_must_match_the_tarballs(release: tuple[Path, Path, list[str]]) -> None:
    _, dist, _ = release
    (dist / script.tarball_name("alpha", VERSION)).write_bytes(b"changed")
    assert any("wrong digest for agent-chat-alpha-1.2.3.tgz" in error for error in problems(release))
    (dist / script.SUMS).unlink()
    assert any(f"no {script.SUMS}" in error for error in problems(release))


def write_sdist(dist: Path, names: list[str]) -> None:
    write_tarball(dist / "sessionyard-1.2.3.tar.gz", {f"sessionyard-1.2.3/{name}": "x" for name in names})


def write_wheel(dist: Path, names: list[str]) -> None:
    with zipfile.ZipFile(dist / "sessionyard-1.2.3-py3-none-any.whl", "w") as archive:
        for name in names:
            archive.writestr(name, "x")


def test_the_sdist_must_hold_every_tracked_integration_file(tmp_path: Path) -> None:
    tracked = [*tracked_files("alpha"), *tracked_files("beta")]
    write_sdist(tmp_path, ["pyproject.toml", *tracked])
    assert script.check_sdist(tmp_path, tracked) == []
    write_sdist(tmp_path, ["pyproject.toml", *tracked[1:]])
    assert script.check_sdist(tmp_path, tracked) == [f"sessionyard-1.2.3.tar.gz: missing tracked file {tracked[0]}"]
    assert script.check_sdist(tmp_path, [])


def test_the_wheel_must_hold_no_integration_path(tmp_path: Path) -> None:
    write_wheel(tmp_path, ["agent_chat/__init__.py", "sessionyard-1.2.3.dist-info/METADATA"])
    assert script.check_wheel(tmp_path) == []
    write_wheel(tmp_path, ["agent_chat/__init__.py", "integrations/alpha/package.json"])
    assert script.check_wheel(tmp_path) == [
        "sessionyard-1.2.3-py3-none-any.whl: holds integrations/alpha/package.json"
    ]
    write_wheel(tmp_path, ["sessionyard-1.2.3.dist-info/METADATA"])
    assert script.check_wheel(tmp_path)


def test_a_missing_or_doubled_distribution_fails(tmp_path: Path) -> None:
    assert script.check_wheel(tmp_path)
    assert script.check_sdist(tmp_path, tracked_files("alpha"))
    write_sdist(tmp_path, tracked_files("alpha"))
    write_tarball(tmp_path / "other-1.tar.gz", {})
    assert script.check_sdist(tmp_path, tracked_files("alpha"))
