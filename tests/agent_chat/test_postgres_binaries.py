"""The Debian fallback `postgres_cluster` applies after PG_TEST_BIN_DIR and PATH.

The suite's pre-run probe applies the same rule. No cluster is started here:
the tests build synthetic `<root>/<N>/bin` trees.
"""

import importlib.util
from pathlib import Path

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "agent_chat_postgres_binaries", Path(__file__).with_name("postgres_binaries.py")
)
assert _SPEC is not None and _SPEC.loader is not None
postgres_binaries = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(postgres_binaries)


def _install(root: Path, major: str, *names: str, mode: int = 0o755) -> Path:
    bin_dir = root / major / "bin"
    bin_dir.mkdir(parents=True)
    for name in names:
        binary = bin_dir / name
        binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        binary.chmod(mode)
    return bin_dir


def test_picks_the_highest_numeric_major_not_the_last_lexically(tmp_path):
    for major in ("9", "17", "100"):
        _install(tmp_path, major, "initdb", "postgres")
    assert postgres_binaries.distro_bin_dir(tmp_path) == tmp_path / "100" / "bin"


def test_skips_a_higher_major_that_lacks_either_executable(tmp_path):
    _install(tmp_path, "18", "initdb")
    _install(tmp_path, "17", "postgres")
    expected = _install(tmp_path, "16", "initdb", "postgres")
    assert postgres_binaries.distro_bin_dir(tmp_path) == expected


def test_a_non_executable_binary_does_not_count(tmp_path):
    _install(tmp_path, "17", "initdb", "postgres", mode=0o644)
    assert postgres_binaries.distro_bin_dir(tmp_path) is None


def test_a_directory_that_is_not_a_bare_integer_is_not_a_major(tmp_path):
    _install(tmp_path, "latest", "initdb", "postgres")
    _install(tmp_path, "9.6", "initdb", "postgres")
    assert postgres_binaries.distro_bin_dir(tmp_path) is None


def test_an_absent_root_finds_nothing(tmp_path):
    assert postgres_binaries.distro_bin_dir(tmp_path / "absent") is None


def test_the_root_comes_from_the_environment_and_defaults_to_the_distro_path(tmp_path, monkeypatch):
    expected = _install(tmp_path, "17", "initdb", "postgres")
    monkeypatch.setenv(postgres_binaries.DISTRO_ROOT_ENV, str(tmp_path))
    assert postgres_binaries.distro_bin_dir() == expected
    assert postgres_binaries.DEFAULT_DISTRO_ROOT == "/usr/lib/postgresql"
    monkeypatch.delenv(postgres_binaries.DISTRO_ROOT_ENV)
    assert postgres_binaries.distro_bin_dir(tmp_path) == expected


@pytest.mark.parametrize("names", [("initdb",), ("postgres",), ()])
def test_a_major_with_fewer_than_both_executables_is_unavailable(tmp_path, names):
    _install(tmp_path, "17", *names)
    assert postgres_binaries.distro_bin_dir(tmp_path) is None
