"""Every harness package is released at the product version, with the same rule.

``integrations/<harness>/`` is a self-contained package directory with
``package.json`` at its root, and every such directory ships at the version in
``pyproject.toml``. These tests enumerate the directories, so a package that
someone adds later is held to the rule without an edit here. They use no
network, no real ``npm`` and no build. Most read files or archives that the
tests write themselves, and the packing tests run ``pack`` against a stand-in
``npm`` that records what it was asked to pack. One group runs the install
block of ``integrations/README.md`` with ``bash``, ``curl`` (over ``file://``),
``tar`` and ``sha256sum``, and is skipped when one of them is missing.
``scripts/check_release_artifacts.py`` proves the built artifacts, and the
release workflow runs it.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import textwrap
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
def test_a_package_directory_holds_no_license_of_its_own(package: Path) -> None:
    """The pack step puts the one repository LICENSE into every tarball; a second copy would be shadowed."""
    own = [path.name for path in package.iterdir() if re.match(r"licen[cs]e", path.name, re.IGNORECASE)]
    assert own == []


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
    # The guide checks one named line and extracts only after that passes.
    assert "--ignore-missing" not in overview
    assert "sha256sum --check --strict asset.sha256" in overview
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
LICENSE_TEXT = "the repository licence\n"


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
        "package/LICENSE": LICENSE_TEXT,
    }


def write_sums(dist: Path) -> None:
    lines = [f"{script.sha256(path)}  {path.name}\n" for path in sorted(dist.glob("*.tgz"))]
    (dist / script.SUMS).write_text("".join(lines), encoding="utf-8")


@pytest.fixture
def release(tmp_path: Path) -> tuple[Path, Path, list[str]]:
    root, dist = tmp_path / "root", tmp_path / "dist"
    dist.mkdir()
    root.mkdir()
    (root / "LICENSE").write_text(LICENSE_TEXT, encoding="utf-8")
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


Entry = tuple[tarfile.TarInfo, bytes]


def regular(name: str, text: str) -> Entry:
    return tarfile.TarInfo(name), text.encode("utf-8")


def special(name: str, kind: bytes, linkname: str = "") -> Entry:
    info = tarfile.TarInfo(name)
    info.type = kind
    info.linkname = linkname
    return info, b""


def write_alpha(release: tuple[Path, Path, list[str]], entries: list[Entry], fmt: int = tarfile.PAX_FORMAT) -> None:
    """Replace the alpha tarball with exactly these members; the tarfile module builds the bad ones."""
    _, dist, _ = release
    with tarfile.open(dist / script.tarball_name("alpha", VERSION), "w:gz", format=fmt) as archive:
        for info, data in entries:
            info.size = len(data) if info.isreg() else 0
            archive.addfile(info, io.BytesIO(data) if info.isreg() else None)
    write_sums(dist)


def alpha_entries() -> list[Entry]:
    return [regular(name, text) for name, text in tarball_members("alpha").items()]


@pytest.mark.parametrize(
    ("kind", "linkname"),
    [
        pytest.param(tarfile.SYMTYPE, "/etc/passwd", id="symlink"),
        pytest.param(tarfile.LNKTYPE, "package/package.json", id="hardlink"),
        pytest.param(tarfile.CHRTYPE, "", id="character-device"),
        pytest.param(tarfile.BLKTYPE, "", id="block-device"),
        pytest.param(tarfile.FIFOTYPE, "", id="fifo"),
    ],
)
def test_a_tarball_member_that_is_not_a_file_or_a_directory_fails(
    release: tuple[Path, Path, list[str]], kind: bytes, linkname: str
) -> None:
    write_alpha(release, [*alpha_entries(), special("package/lib/extra.js", kind, linkname)])
    assert any(
        "member package/lib/extra.js is not a regular file or directory" in error for error in problems(release)
    )


def test_a_link_cannot_stand_in_for_a_tracked_file(release: tuple[Path, Path, list[str]]) -> None:
    entries = [entry for entry in alpha_entries() if entry[0].name != "package/lib/config.js"]
    write_alpha(release, [*entries, special("package/lib/config.js", tarfile.SYMTYPE, "/etc/passwd")])
    errors = problems(release)
    assert any("member package/lib/config.js is not a regular file or directory" in error for error in errors)
    assert any("missing lib/config.js" in error for error in errors)


def test_a_tarball_with_a_duplicate_member_fails(release: tuple[Path, Path, list[str]]) -> None:
    write_alpha(release, [*alpha_entries(), regular("package/lib/config.js", "export const changed = 1")])
    assert any("duplicate member package/lib/config.js" in error for error in problems(release))


def test_a_directory_member_is_allowed(release: tuple[Path, Path, list[str]]) -> None:
    directory = tarfile.TarInfo("package/lib")
    directory.type = tarfile.DIRTYPE
    write_alpha(release, [(directory, b""), *alpha_entries()])
    assert problems(release) == []


def test_the_package_root_directory_member_is_allowed(release: tuple[Path, Path, list[str]]) -> None:
    root_directory = tarfile.TarInfo("package")
    root_directory.type = tarfile.DIRTYPE
    write_alpha(release, [(root_directory, b""), *alpha_entries()])
    assert problems(release) == []


@pytest.mark.parametrize(
    "name",
    [
        pytest.param("package/lib/./extra.js", id="dot-segment"),
        pytest.param("package/lib/../extra.js", id="dot-dot-segment"),
        pytest.param("package//lib/extra.js", id="empty-segment"),
        pytest.param("./package/lib/extra.js", id="leading-dot"),
        pytest.param("/package/lib/extra.js", id="leading-slash"),
        pytest.param("package\\lib\\extra.js", id="backslash"),
        pytest.param("package/lib/extra.js/", id="trailing-slash-on-a-file"),
    ],
)
def test_a_tarball_member_with_a_non_canonical_path_fails(release: tuple[Path, Path, list[str]], name: str) -> None:
    write_alpha(release, [*alpha_entries(), regular(name, "x")])
    assert any(f"member {name!r} has a non-canonical path" in error for error in problems(release))


def test_a_non_canonical_spelling_cannot_stand_in_for_a_tracked_file(release: tuple[Path, Path, list[str]]) -> None:
    entries = [entry for entry in alpha_entries() if entry[0].name != "package/lib/config.js"]
    write_alpha(release, [*entries, regular("package/lib/./config.js", "export {}")])
    errors = problems(release)
    assert any("has a non-canonical path" in error for error in errors)
    assert any("missing lib/config.js" in error for error in errors)


def directory(name: str) -> Entry:
    info = tarfile.TarInfo(name)
    info.type = tarfile.DIRTYPE
    return info, b""


@pytest.mark.parametrize(
    ("first", "second"),
    [
        pytest.param(regular("package/lib/config.js", "a"), regular("package/lib/./config.js", "b"), id="files"),
        pytest.param(directory("package/lib"), directory("package/./lib"), id="directories"),
        pytest.param(directory("package/lib"), regular("package/lib/../lib", "b"), id="directory-and-file"),
    ],
)
def test_duplicates_are_compared_on_the_normalized_path(
    release: tuple[Path, Path, list[str]], first: Entry, second: Entry
) -> None:
    entries = [entry for entry in alpha_entries() if entry[0].name != first[0].name]
    write_alpha(release, [first, *entries, second])
    assert any(f"duplicate member {second[0].name} (path package/" in error for error in problems(release))


# tarfile strips the trailing slashes of a directory name, so these need the raw header names.
LONG_DIRECTORY = "package/lib/" + "d" * 110 + "//"


@pytest.mark.parametrize(
    ("fmt", "name"),
    [
        pytest.param(tarfile.USTAR_FORMAT, "package/lib//", id="ustar"),
        pytest.param(tarfile.PAX_FORMAT, "package/lib//", id="pax-header-only"),
        pytest.param(tarfile.PAX_FORMAT, LONG_DIRECTORY, id="pax-path-record"),
        pytest.param(tarfile.GNU_FORMAT, LONG_DIRECTORY, id="gnu-long-name"),
        pytest.param(tarfile.USTAR_FORMAT, "package/lib///", id="three-slashes"),
    ],
)
def test_a_directory_header_that_ends_in_more_than_one_slash_fails(
    release: tuple[Path, Path, list[str]], fmt: int, name: str
) -> None:
    write_alpha(release, [*alpha_entries(), directory(name)], fmt)
    # What tarfile hands over for these headers differs by format and by Python version.
    with tarfile.open(release[1] / script.tarball_name("alpha", VERSION)) as archive:
        assert not any(member.name.endswith("//") for member in archive.getmembers())
    assert any(f"member {name!r} has a non-canonical path" in error for error in problems(release))


@pytest.mark.parametrize("fmt", [tarfile.USTAR_FORMAT, tarfile.PAX_FORMAT, tarfile.GNU_FORMAT])
def test_a_directory_header_with_one_trailing_slash_is_allowed(
    release: tuple[Path, Path, list[str]], fmt: int
) -> None:
    write_alpha(release, [directory("package/lib"), *alpha_entries()], fmt)
    assert problems(release) == []


@pytest.mark.parametrize("fmt", [tarfile.USTAR_FORMAT, tarfile.PAX_FORMAT, tarfile.GNU_FORMAT])
def test_long_names_read_the_same_from_the_header_as_from_tarfile(
    release: tuple[Path, Path, list[str]], fmt: int
) -> None:
    """A ustar prefix, a pax path record and a GNU long name all reach the check unchanged."""
    _, _, tracked = release
    long_name = f"lib/{'d' * 90}/{'e' * 90}.js"
    tracked.append(f"integrations/alpha/{long_name}")
    write_alpha(release, [*alpha_entries(), regular(f"package/{long_name}", "export {}")], fmt)
    assert problems(release) == []


def test_a_tarball_whose_package_json_is_not_an_object_fails_cleanly(release: tuple[Path, Path, list[str]]) -> None:
    entries = [entry for entry in alpha_entries() if entry[0].name != "package/package.json"]
    write_alpha(release, [*entries, regular("package/package.json", "[]")])
    assert any("package.json is not a JSON object" in error for error in problems(release))


def test_an_odd_pi_field_in_package_json_does_not_crash_the_entry_point_check(
    release: tuple[Path, Path, list[str]],
) -> None:
    package = {"name": "agent-chat-alpha", "version": VERSION, "main": "./lib/config.js", "pi": "not an object"}
    entries = [entry for entry in alpha_entries() if entry[0].name != "package/package.json"]
    write_alpha(release, [*entries, regular("package/package.json", json.dumps(package))])
    assert problems(release) == []


def test_a_directory_named_like_a_tracked_file_fails(release: tuple[Path, Path, list[str]]) -> None:
    entries = [entry for entry in alpha_entries() if entry[0].name != "package/README.md"]
    write_alpha(release, [*entries, directory("package/README.md"), regular("package/README.md/extra", "x")])
    errors = problems(release)
    assert any("unexpected directory README.md" in error for error in errors)
    assert any("unexpected README.md/extra" in error for error in errors)
    assert any("missing README.md" in error for error in errors)


@pytest.mark.parametrize("name", ["package/lib/empty", "package/test", "package/elsewhere"])
def test_a_directory_member_must_be_an_ancestor_of_an_expected_file(
    release: tuple[Path, Path, list[str]], name: str
) -> None:
    write_alpha(release, [*alpha_entries(), directory(name)])
    assert any(f"unexpected directory {name.removeprefix('package/')}" in error for error in problems(release))


def test_every_tarball_ships_the_repository_license(release: tuple[Path, Path, list[str]]) -> None:
    entries = [entry for entry in alpha_entries() if entry[0].name != "package/LICENSE"]
    write_alpha(release, entries)
    assert any("missing LICENSE" in error for error in problems(release))
    write_alpha(release, [*entries, regular("package/LICENSE", "another licence\n")])
    assert any("LICENSE differs from the repository LICENSE" in error for error in problems(release))
    root, _, _ = release
    (root / "LICENSE").unlink()
    assert any("LICENSE is missing, so the tarball LICENSE check would prove nothing" in e for e in problems(release))


def test_the_sums_must_match_the_tarballs(release: tuple[Path, Path, list[str]]) -> None:
    _, dist, _ = release
    (dist / script.tarball_name("alpha", VERSION)).write_bytes(b"changed")
    assert any("wrong digest for agent-chat-alpha-1.2.3.tgz" in error for error in problems(release))
    (dist / script.SUMS).unlink()
    assert any(f"no {script.SUMS}" in error for error in problems(release))


ALPHA = script.tarball_name("alpha", VERSION)


def alpha_digest(release: tuple[Path, Path, list[str]]) -> str:
    return script.sha256(release[1] / ALPHA)


@pytest.mark.parametrize(
    "bad_line",
    [
        pytest.param("{digest_upper}  {name}", id="uppercase-digest"),
        pytest.param("{digest_short}  {name}", id="short-digest"),
        pytest.param("{digest} {name}", id="one-space"),
        pytest.param("{digest}   {name}", id="three-spaces"),
        pytest.param("{digest} *{name}", id="binary-mode"),
        pytest.param("{digest}  *{name}", id="star-in-the-name"),
        pytest.param("{digest}  ./{name}", id="path-in-the-name"),
        pytest.param("{digest}  {name} ", id="trailing-space"),
        pytest.param("{digest}  {name}\r", id="carriage-return"),
        pytest.param("{digest}  {name}\0", id="nul-byte"),
        pytest.param("{digest}  na me.tgz", id="space-in-the-name"),
        pytest.param("{digest}  na\\me.tgz", id="backslash-in-the-name"),
        pytest.param("", id="blank-line"),
        pytest.param("not a checksum line", id="free-text"),
    ],
)
def test_a_malformed_sums_line_fails(release: tuple[Path, Path, list[str]], bad_line: str) -> None:
    _, dist, _ = release
    digest = alpha_digest(release)
    line = bad_line.format(digest=digest, digest_upper=digest.upper(), digest_short=digest[:-1], name=ALPHA)
    sums = dist / script.SUMS
    sums.write_text(sums.read_text(encoding="utf-8") + line + "\n", encoding="utf-8")
    assert any(
        f"{script.SUMS}: line 3 is not '<64 lowercase hex digits>  <file name>'" in e for e in problems(release)
    )


def test_a_sums_file_with_windows_line_endings_fails(release: tuple[Path, Path, list[str]]) -> None:
    _, dist, _ = release
    sums = dist / script.SUMS
    sums.write_bytes(sums.read_bytes().replace(b"\n", b"\r\n"))
    assert sum("is not '<64 lowercase hex digits>" in error for error in problems(release)) == 2


@pytest.mark.parametrize("wrong_digest", [False, True])
def test_a_repeated_sums_line_fails_and_never_overwrites_the_first(
    release: tuple[Path, Path, list[str]], wrong_digest: bool
) -> None:
    _, dist, _ = release
    digest = "0" * 64 if wrong_digest else alpha_digest(release)
    sums = dist / script.SUMS
    sums.write_text(sums.read_text(encoding="utf-8") + f"{digest}  {ALPHA}\n", encoding="utf-8")
    assert any(f"{script.SUMS}: line 3 repeats {ALPHA}" in error for error in problems(release))


def test_an_empty_or_unreadable_sums_file_fails(release: tuple[Path, Path, list[str]]) -> None:
    _, dist, _ = release
    (dist / script.SUMS).write_text("", encoding="utf-8")
    errors = problems(release)
    assert any("line 1 is not" in error for error in errors)
    assert any(f"{script.SUMS}: no line for {ALPHA}" in error for error in errors)
    (dist / script.SUMS).write_bytes(b"\xff\xfe")
    assert any(f"{script.SUMS}: cannot read the file" in error for error in problems(release))


@pytest.mark.parametrize("damage", ["crc", "length", "truncated"])
def test_a_damaged_gzip_stream_fails_even_when_the_sums_match_the_damaged_bytes(
    release: tuple[Path, Path, list[str]], damage: str
) -> None:
    write_alpha(release, alpha_entries())
    _, dist, _ = release
    tarball = dist / ALPHA
    data = bytearray(tarball.read_bytes())
    if damage == "crc":
        data[-8] ^= 0xFF  # the CRC32 field of the gzip trailer
    elif damage == "length":
        data[-1] ^= 0xFF  # the ISIZE field of the gzip trailer
    else:
        del data[-20:]
    tarball.write_bytes(data)
    write_sums(dist)
    errors = problems(release)
    assert any(f"{ALPHA}: cannot read the archive" in error for error in errors)
    assert not any("wrong digest" in error for error in errors), "the sums were rewritten over the damaged bytes"


@pytest.mark.parametrize(
    ("lie", "message"),
    [
        pytest.param(lambda names: names[:-1], "the headers hold", id="one-member-fewer"),
        pytest.param(lambda names: [*names[:-1], "package/other.js"], "has the header name", id="another-name"),
    ],
)
def test_a_header_walk_that_disagrees_with_tarfile_fails_closed(
    release: tuple[Path, Path, list[str]], monkeypatch: pytest.MonkeyPatch, lie, message: str
) -> None:
    real = script.header_names
    monkeypatch.setattr(script, "header_names", lambda path: lie(real(path)))
    errors = problems(release)
    assert any(f"{ALPHA}: cannot read the archive" in error and message in error for error in errors)


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


@pytest.mark.parametrize("kind", [tarfile.DIRTYPE, tarfile.SYMTYPE])
def test_the_sdist_needs_a_regular_file_not_a_directory_or_a_link_named_like_one(tmp_path: Path, kind: bytes) -> None:
    tracked = tracked_files("alpha")
    with tarfile.open(tmp_path / "sessionyard-1.2.3.tar.gz", "w:gz") as archive:
        for name in tracked[1:]:
            info = tarfile.TarInfo(f"sessionyard-1.2.3/{name}")
            archive.addfile(info, io.BytesIO(b""))
        info = tarfile.TarInfo(f"sessionyard-1.2.3/{tracked[0]}")
        info.type = kind
        info.linkname = "/etc/passwd" if kind == tarfile.SYMTYPE else ""
        archive.addfile(info)
    assert script.check_sdist(tmp_path, tracked) == [f"sessionyard-1.2.3.tar.gz: missing tracked file {tracked[0]}"]


def test_the_wheel_must_hold_no_integration_path(tmp_path: Path) -> None:
    write_wheel(tmp_path, ["agent_chat/__init__.py", "sessionyard-1.2.3.dist-info/METADATA"])
    assert script.check_wheel(tmp_path) == []
    write_wheel(tmp_path, ["agent_chat/__init__.py", "integrations/alpha/package.json"])
    assert script.check_wheel(tmp_path) == [
        "sessionyard-1.2.3-py3-none-any.whl: holds integrations/alpha/package.json"
    ]
    write_wheel(tmp_path, ["sessionyard-1.2.3.dist-info/METADATA"])
    assert script.check_wheel(tmp_path)


@pytest.mark.parametrize(
    "name",
    [
        "agent_chat/integrations/pi/package.json",
        "agent_chat/mcp/integrations/pi/package.json",
        "sessionyard/integrations",
        "agent_chat\\integrations\\pi\\package.json",
    ],
)
def test_the_wheel_holds_no_integrations_segment_anywhere(tmp_path: Path, name: str) -> None:
    write_wheel(tmp_path, ["agent_chat/__init__.py", name])
    assert script.check_wheel(tmp_path) == [f"sessionyard-1.2.3-py3-none-any.whl: holds {name}"]


def test_a_path_that_only_contains_the_word_integrations_is_not_an_integrations_segment(tmp_path: Path) -> None:
    write_wheel(
        tmp_path, ["agent_chat/__init__.py", "agent_chat/integrations_notes.py", "agent_chat/myintegrations/x"]
    )
    assert script.check_wheel(tmp_path) == []


def test_an_artifact_that_is_a_link_fails(release: tuple[Path, Path, list[str]], tmp_path: Path) -> None:
    _, dist, _ = release
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    tarball = dist / script.tarball_name("alpha", VERSION)
    tarball.rename(elsewhere / tarball.name)
    tarball.symlink_to(elsewhere / tarball.name)
    write_sums(dist)
    assert any(f"{tarball.name} is not a regular file" in error for error in problems(release))
    tarball.unlink()
    (elsewhere / tarball.name).rename(tarball)
    write_sums(dist)
    sums = dist / script.SUMS
    sums.rename(elsewhere / script.SUMS)
    sums.symlink_to(elsewhere / script.SUMS)
    assert any(f"{script.SUMS} is a link" in error for error in problems(release))
    write_wheel(dist, ["agent_chat/__init__.py"])
    wheel = next(dist.glob("*.whl"))
    wheel.rename(elsewhere / wheel.name)
    wheel.symlink_to(elsewhere / wheel.name)
    assert any(f"{wheel.name} is not a regular file" in error for error in script.check_wheel(dist) if error)


def test_a_missing_or_doubled_distribution_fails(tmp_path: Path) -> None:
    assert script.check_wheel(tmp_path)
    assert script.check_sdist(tmp_path, tracked_files("alpha"))
    write_sdist(tmp_path, tracked_files("alpha"))
    write_tarball(tmp_path / "other-1.tar.gz", {})
    assert script.check_sdist(tmp_path, tracked_files("alpha"))


# Packing, against a stand-in for npm that records what it was asked to pack.

FAKE_NPM = """#!{python}
import os, pathlib, sys
staged, dist = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[4])
seen = sorted(path.relative_to(staged).as_posix() for path in staged.rglob("*"))
log = pathlib.Path(os.environ["FAKE_NPM_LOG"]) / (staged.name + ".log")
log.write_text("\\n".join(seen) + "\\n=== LICENSE\\n" + (staged / "LICENSE").read_text())
(dist / f"agent-chat-{{staged.name}}-1.2.3.tgz").write_bytes(b"tarball of " + staged.name.encode())
"""


@pytest.fixture
def fake_npm(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    bin_dir, log = tmp_path / "bin", tmp_path / "npm-log"
    bin_dir.mkdir()
    log.mkdir()
    npm = bin_dir / "npm"
    npm.write_text(FAKE_NPM.format(python=sys.executable), encoding="utf-8")
    npm.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_NPM_LOG", str(log))
    return log


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "LICENSE").parent.mkdir()
    (root / "LICENSE").write_text(LICENSE_TEXT, encoding="utf-8")
    for harness in HARNESSES:
        (root / "integrations" / harness / "lib").mkdir(parents=True)
        (root / "integrations" / harness / "package.json").write_text("{}", encoding="utf-8")
        (root / "integrations" / harness / "lib" / "config.js").write_text("export {}", encoding="utf-8")
    return root


def test_pack_stages_each_directory_with_the_license_and_leaves_the_source_alone(
    repository: Path, fake_npm: Path, tmp_path: Path
) -> None:
    # npm install leaves links under node_modules; the copy never takes that directory.
    (repository / "integrations" / "alpha" / "node_modules" / ".bin").mkdir(parents=True)
    (repository / "integrations" / "alpha" / "node_modules" / ".bin" / "tool").symlink_to("../tool.js")
    dist = tmp_path / "dist"
    script.pack(repository, dist)
    for harness in HARNESSES:
        listing, _, license_text = (fake_npm / f"{harness}.log").read_text(encoding="utf-8").partition("=== LICENSE\n")
        assert listing.split() == ["LICENSE", "lib", "lib/config.js", "package.json"]
        assert license_text == LICENSE_TEXT
        assert not (repository / "integrations" / harness / "LICENSE").exists(), "the source tree is never written"
    sums = (dist / script.SUMS).read_text(encoding="utf-8").splitlines()
    assert [line.split("  ")[1] for line in sums] == ["agent-chat-alpha-1.2.3.tgz", "agent-chat-beta-1.2.3.tgz"]
    assert script.check_sums(dist, {path.name: path for path in dist.glob("*.tgz")}) == []


def make_fifo(path: Path) -> None:
    os.mkfifo(path)


def link_license(package: Path, outside: Path) -> None:
    (package / "LICENSE").symlink_to(outside)


def link_other_file(package: Path, outside: Path) -> None:
    (package / "lib" / "link.js").symlink_to(outside)


def link_directory(package: Path, outside: Path) -> None:
    (package / "vendored").symlink_to(outside.parent, target_is_directory=True)


def link_dangling(package: Path, outside: Path) -> None:
    (package / "LICENSE").symlink_to(outside.parent / "does-not-exist")


@pytest.mark.parametrize(
    "plant",
    [
        pytest.param(link_license, id="license-link"),
        pytest.param(link_other_file, id="file-link"),
        pytest.param(link_directory, id="directory-link"),
        pytest.param(link_dangling, id="dangling-license-link"),
        pytest.param(lambda package, outside: make_fifo(package / "lib" / "pipe"), id="fifo"),
    ],
)
def test_pack_refuses_a_link_or_special_file_and_never_writes_through_it(
    repository: Path, fake_npm: Path, tmp_path: Path, plant
) -> None:
    outside = tmp_path / "outside" / "target.txt"
    outside.parent.mkdir()
    outside.write_text("keep", encoding="utf-8")
    plant(repository / "integrations" / "alpha", outside)
    with pytest.raises(SystemExit, match="not a regular file or a directory"):
        script.pack(repository, tmp_path / "dist")
    assert outside.read_text(encoding="utf-8") == "keep"
    assert sorted(path.name for path in outside.parent.iterdir()) == ["target.txt"]
    assert list(fake_npm.iterdir()) == [], "npm never ran"


def test_the_staged_license_is_created_exclusively(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A link that appears in the copy after the walk and the copy is still not written through."""
    package, scratch = tmp_path / "alpha", tmp_path / "scratch"
    (package / "lib").mkdir(parents=True)
    scratch.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("keep", encoding="utf-8")
    license_file = tmp_path / "LICENSE"
    license_file.write_text(LICENSE_TEXT, encoding="utf-8")
    staged = script.stage_package(package, scratch, license_file)
    assert (staged / "LICENSE").read_text(encoding="utf-8") == LICENSE_TEXT
    assert outside.read_text(encoding="utf-8") == "keep"

    copytree, second = shutil.copytree, tmp_path / "second-scratch"

    def copy_then_plant_a_link(source: Path, destination: Path, *args, **options) -> Path:
        # copytree calls itself for each subdirectory; plant the link in the top of the copy only.
        result = copytree(source, destination, *args, **options)
        if Path(destination) == second / "alpha":
            (Path(destination) / "LICENSE").symlink_to(outside)
        return result

    second.mkdir()
    monkeypatch.setattr(script.shutil, "copytree", copy_then_plant_a_link)
    with pytest.raises(SystemExit, match="holds no LICENSE of its own"):
        script.stage_package(package, second, license_file)
    assert outside.read_text(encoding="utf-8") == "keep"


def test_pack_refuses_a_license_that_the_package_already_holds(
    repository: Path, fake_npm: Path, tmp_path: Path
) -> None:
    own = repository / "integrations" / "alpha" / "LICENSE"
    own.write_text("a second licence", encoding="utf-8")
    with pytest.raises(SystemExit, match="holds no LICENSE of its own"):
        script.pack(repository, tmp_path / "dist")
    assert own.read_text(encoding="utf-8") == "a second licence"


def test_pack_refuses_a_link_in_the_output_directory(repository: Path, fake_npm: Path, tmp_path: Path) -> None:
    outside = tmp_path / "outside.txt"
    outside.write_text("keep", encoding="utf-8")
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / script.SUMS).symlink_to(outside)
    with pytest.raises(SystemExit, match="is a link"):
        script.pack(repository, dist)
    assert outside.read_text(encoding="utf-8") == "keep"


@pytest.mark.parametrize("dangling", [False, True], ids=["link-to-a-directory", "dangling-link"])
def test_pack_refuses_an_output_directory_that_is_a_link(
    repository: Path, fake_npm: Path, tmp_path: Path, dangling: bool
) -> None:
    real = tmp_path / "real"
    if not dangling:
        real.mkdir()
    dist = tmp_path / "dist"
    dist.symlink_to(real, target_is_directory=not dangling)
    with pytest.raises(SystemExit, match="is a link"):
        script.pack(repository, dist)
    assert not real.exists() or list(real.iterdir()) == [], "nothing is written through the link"
    assert list(fake_npm.iterdir()) == [], "npm never ran"


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="needs fifos")
@pytest.mark.parametrize("name", ["agent-chat-x-0.8.0.tgz", script.SUMS])
def test_pack_refuses_a_fifo_named_like_an_artifact_without_opening_it(
    fake_npm: Path, tmp_path: Path, name: str
) -> None:
    """A regression would block on open(); a child process with a timeout turns that into a failure."""
    dist = tmp_path / "dist"
    dist.mkdir()
    os.mkfifo(dist / name)
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "check_release_artifacts.py"), "--pack", str(dist)],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        cwd=tmp_path,
    )
    assert result.returncode != 0
    assert f"{dist / name} is not a regular file" in result.stderr
    assert list(fake_npm.iterdir()) == [], "refused before npm ran or anything was staged"


def test_write_sums_refuses_a_tarball_that_is_not_a_regular_file(tmp_path: Path) -> None:
    dist = tmp_path / "dist"
    (dist / "agent-chat-x-0.8.0.tgz").mkdir(parents=True)
    with pytest.raises(SystemExit, match="is not a regular file"):
        script.write_sums(dist)
    assert not (dist / script.SUMS).exists()


def test_the_sums_file_is_replaced_and_never_written_through(tmp_path: Path) -> None:
    dist, outside = tmp_path / "dist", tmp_path / "outside.txt"
    dist.mkdir()
    write_tarball(dist / "agent-chat-alpha-1.2.3.tgz", {"package/package.json": "{}"})
    outside.write_text("keep", encoding="utf-8")
    (dist / script.SUMS).symlink_to(outside)
    script.write_sums(dist)
    assert outside.read_text(encoding="utf-8") == "keep"
    assert not (dist / script.SUMS).is_symlink()
    assert (dist / script.SUMS).read_text(encoding="utf-8").endswith("  agent-chat-alpha-1.2.3.tgz\n")
    assert [path.name for path in dist.iterdir() if path.name.startswith("SHA256SUMS.")] == []


# The install guide, executed. A block that nobody runs drifts from the checker that guards the same file.

INSTALL_TOOLS = ("bash", "curl", "tar", "sha256sum")
MISSING_TOOLS = [tool for tool in INSTALL_TOOLS if shutil.which(tool) is None]
GUIDE_BASE_URL = "https://github.com/mikomiel/agent-chat/releases/download/v${version}"
PI_ASSET = f"agent-chat-pi-{VERSION}.tgz"
needs_install_tools = pytest.mark.skipif(bool(MISSING_TOOLS), reason=f"the install block needs {MISSING_TOOLS}")


def install_block() -> str:
    """The one fenced bash block of the install section, as the guide prints it."""
    section = (INTEGRATIONS / "README.md").read_text(encoding="utf-8").split(INSTALL_SECTION, 1)[1]
    (block,) = re.findall(r"^   ```bash\n(.*?)^   ```$", section, flags=re.DOTALL | re.MULTILINE)
    return textwrap.dedent(block)


def make_release(directory: Path) -> Path:
    """A local stand-in for the release download directory: two tarballs and their SHA256SUMS."""
    directory.mkdir()
    write_tarball(directory / PI_ASSET, {"package/package.json": "{}", "package/lib/config.js": "export {}"})
    write_tarball(directory / f"agent-chat-deepseek-{VERSION}.tgz", {"package/package.json": "{}"})
    write_sums(directory)
    return directory


def run_install(tmp_path: Path, release_dir: Path) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    """Run the guide's block over ``file://`` and return the result, the target and the scratch directory."""
    block = install_block()
    assert GUIDE_BASE_URL in block, "the block no longer downloads from the release URL that this test replaces"
    parent, scratch = tmp_path / "install", tmp_path / "scratch"
    parent.mkdir(exist_ok=True)
    scratch.mkdir()
    block = (
        block.replace(GUIDE_BASE_URL, f"file://{release_dir}")
        .replace("<version>", VERSION)
        .replace("<absolute-directory>", str(parent))
    )
    result = subprocess.run(
        ["bash", "--noprofile", "--norc", "-c", block],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
        cwd=tmp_path,
        env={**os.environ, "TMPDIR": str(scratch), "LC_ALL": "C"},
    )
    return result, parent / f"agent-chat-pi-{VERSION}", scratch


def pi_line(release_dir: Path) -> str:
    return f"{script.sha256(release_dir / PI_ASSET)}  {PI_ASSET}\n"


def other_lines(release_dir: Path) -> str:
    return "".join(
        line
        for line in (release_dir / script.SUMS).read_text(encoding="utf-8").splitlines(True)
        if PI_ASSET not in line
    )


def tamper(release_dir: Path) -> None:
    (release_dir / PI_ASSET).write_bytes(b"tampered after the sums were written")


def repeat_line(release_dir: Path) -> None:
    sums = release_dir / script.SUMS
    sums.write_text(sums.read_text(encoding="utf-8") + pi_line(release_dir), encoding="utf-8")


def drop_line(release_dir: Path) -> None:
    (release_dir / script.SUMS).write_text(other_lines(release_dir), encoding="utf-8")


def repeat_in_binary_mode(release_dir: Path) -> None:
    sums = release_dir / script.SUMS
    digest = pi_line(release_dir).split()[0]
    sums.write_text(sums.read_text(encoding="utf-8") + f"{digest} *{PI_ASSET}\n", encoding="utf-8")


def only_binary_mode(release_dir: Path) -> None:
    digest = pi_line(release_dir).split()[0]
    (release_dir / script.SUMS).write_text(other_lines(release_dir) + f"{digest} *{PI_ASSET}\n", encoding="utf-8")


def uppercase_digest(release_dir: Path) -> None:
    digest = pi_line(release_dir).split()[0].upper()
    (release_dir / script.SUMS).write_text(other_lines(release_dir) + f"{digest}  {PI_ASSET}\n", encoding="utf-8")


def windows_line_endings(release_dir: Path) -> None:
    sums = release_dir / script.SUMS
    sums.write_bytes(sums.read_bytes().replace(b"\n", b"\r\n"))


def append_to_sums(release_dir: Path, tail: bytes) -> None:
    sums = release_dir / script.SUMS
    sums.write_bytes(sums.read_bytes() + tail)


def mixed_line_endings(release_dir: Path) -> None:
    """One clean record for the tarball, and a second one for it that ends in CRLF."""
    append_to_sums(release_dir, pi_line(release_dir).rstrip("\n").encode() + b"\r\n")


def crlf_on_another_line(release_dir: Path) -> None:
    """The record for the chosen tarball is clean; only a record for another file ends in CRLF."""
    append_to_sums(release_dir, f"{'0' * 64}  agent-chat-other-{VERSION}.tgz\r\n".encode())


def carriage_return_inside_a_line(release_dir: Path) -> None:
    append_to_sums(release_dir, f"{'0' * 64}  agent-chat-ot\rher-{VERSION}.tgz\n".encode())


def stray_text_for_another_file(release_dir: Path) -> None:
    append_to_sums(release_dir, b"this is not a checksum line\n")


def binary_mode_for_another_file(release_dir: Path) -> None:
    append_to_sums(release_dir, f"{'0' * 64} *agent-chat-other-{VERSION}.tgz\n".encode())


def blank_line(release_dir: Path) -> None:
    append_to_sums(release_dir, b"\n")


def nul_byte_line(release_dir: Path) -> None:
    append_to_sums(release_dir, f"{'0' * 64}  agent-chat-other-{VERSION}.tgz\0\n".encode())


def drop_sums(release_dir: Path) -> None:
    (release_dir / script.SUMS).unlink()


def drop_tarball(release_dir: Path) -> None:
    (release_dir / PI_ASSET).unlink()


@needs_install_tools
def test_the_install_block_extracts_a_verified_tarball_and_cleans_up(tmp_path: Path) -> None:
    release_dir = make_release(tmp_path / "release")
    result, target, scratch = run_install(tmp_path, release_dir)
    assert result.returncode == 0, result.stderr
    assert (target / "package.json").is_file() and (target / "lib" / "config.js").is_file()
    assert not (target / "package").exists(), "--strip-components=1 removes the package/ directory"
    assert list(scratch.iterdir()) == [], "the temporary download directory is removed"


@needs_install_tools
@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        pytest.param(tamper, "FAILED", id="tampered-tarball"),
        pytest.param(repeat_line, "exactly one line", id="duplicate-line"),
        pytest.param(drop_line, "exactly one line", id="missing-line"),
        pytest.param(repeat_in_binary_mode, "outside the GNU text form", id="binary-mode-duplicate"),
        pytest.param(only_binary_mode, "outside the GNU text form", id="binary-mode-only"),
        pytest.param(uppercase_digest, "outside the GNU text form", id="uppercase-digest"),
        pytest.param(windows_line_endings, "outside the GNU text form", id="windows-line-endings"),
        pytest.param(mixed_line_endings, "outside the GNU text form", id="mixed-line-endings"),
        pytest.param(crlf_on_another_line, "outside the GNU text form", id="crlf-on-another-line"),
        pytest.param(carriage_return_inside_a_line, "outside the GNU text form", id="carriage-return-inside-a-line"),
        pytest.param(stray_text_for_another_file, "outside the GNU text form", id="stray-text-for-another-file"),
        pytest.param(binary_mode_for_another_file, "outside the GNU text form", id="binary-mode-for-another-file"),
        pytest.param(blank_line, "outside the GNU text form", id="blank-line"),
        pytest.param(nul_byte_line, "outside the GNU text form", id="nul-byte-line"),
        pytest.param(drop_sums, "curl", id="missing-sums-file"),
        pytest.param(drop_tarball, "curl", id="missing-tarball"),
    ],
)
def test_the_install_block_extracts_nothing_when_a_check_fails(tmp_path: Path, mutate, message: str) -> None:
    release_dir = make_release(tmp_path / "release")
    mutate(release_dir)
    result, target, scratch = run_install(tmp_path, release_dir)
    assert result.returncode != 0
    assert message in result.stdout + result.stderr
    assert not target.exists(), "nothing is extracted after a failed check"
    assert list(scratch.iterdir()) == [], "the temporary download directory is removed"


@needs_install_tools
def test_the_install_block_leaves_an_existing_target_alone(tmp_path: Path) -> None:
    release_dir = make_release(tmp_path / "release")
    target = tmp_path / "install" / f"agent-chat-pi-{VERSION}"
    target.mkdir(parents=True)
    (target / "keep.txt").write_text("mine", encoding="utf-8")
    result, _, _ = run_install(tmp_path, release_dir)
    assert result.returncode != 0 and "must not exist yet" in result.stderr
    assert [path.name for path in target.iterdir()] == ["keep.txt"]


@needs_install_tools
@pytest.mark.parametrize("dangling", [False, True], ids=["link-to-a-directory", "dangling-link"])
def test_the_install_block_will_not_extract_through_a_link(tmp_path: Path, dangling: bool) -> None:
    release_dir = make_release(tmp_path / "release")
    elsewhere = tmp_path / "elsewhere"
    if not dangling:
        elsewhere.mkdir()
    target = tmp_path / "install" / f"agent-chat-pi-{VERSION}"
    target.parent.mkdir()
    target.symlink_to(elsewhere, target_is_directory=not dangling)
    result, _, _ = run_install(tmp_path, release_dir)
    assert result.returncode != 0 and "must not exist yet" in result.stderr
    assert not elsewhere.exists() or list(elsewhere.iterdir()) == [], "nothing is extracted through the link"


def test_the_install_guide_names_its_requirements_and_the_macos_route() -> None:
    section = (INTEGRATIONS / "README.md").read_text(encoding="utf-8").split(INSTALL_SECTION, 1)[1]
    assert "bash" in section and "GNU coreutils" in section and "sha256sum" in section
    assert "libexec/gnubin" in section
