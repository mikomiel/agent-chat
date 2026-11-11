import errno
import json
import os
import stat
import time
from uuid import uuid4

import pytest

from agent_chat import instance_file
from agent_chat.instance_file import prepare_instance
from agent_chat.models import ChatError


def test_instance_secret_is_private_persistent_and_hidden_in_repr(tmp_path):
    boot = uuid4()
    first = prepare_instance(tmp_path, "native", boot, server_origin="https://chat.test")
    path = tmp_path / f"{boot}.json"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert len(first.token) == 64
    assert first.token not in repr(first)
    assert json.loads(path.read_text())["token"] == first.token
    assert prepare_instance(tmp_path, "native", boot, server_origin="https://chat.test") == first
    resumed = prepare_instance(tmp_path, "native", uuid4(), server_origin="https://chat.test")
    assert resumed.token != first.token
    assert resumed.boot_id != first.boot_id


def test_mismatched_or_partial_file_is_not_overwritten(tmp_path):
    boot = uuid4()
    prepare_instance(tmp_path, "native", boot, server_origin="https://chat.test")
    path = tmp_path / f"{boot}.json"
    original = path.read_bytes()
    with pytest.raises(ChatError, match="^BINDING_FILE_CONFLICT$"):
        prepare_instance(tmp_path, "another-native", boot, server_origin="https://chat.test")
    assert path.read_bytes() == original
    path.write_bytes(b'{"partial":')
    with pytest.raises(ChatError, match="^BINDING_FILE_INVALID$"):
        prepare_instance(tmp_path, "native", boot, server_origin="https://chat.test")
    assert path.read_bytes() == b'{"partial":'


@pytest.mark.parametrize("target", ["parent", "file"])
def test_unsafe_permissions_are_refused(tmp_path, target):
    boot = uuid4()
    prepare_instance(tmp_path, "native", boot, server_origin="https://chat.test")
    path = tmp_path if target == "parent" else tmp_path / f"{boot}.json"
    path.chmod(0o755 if target == "parent" else 0o644)
    with pytest.raises(ChatError, match="^BINDING_FILE_UNSAFE$"):
        prepare_instance(tmp_path, "native", boot, server_origin="https://chat.test")


def test_symlink_file_is_never_followed(tmp_path):
    boot = uuid4()
    target = tmp_path / "other"
    target.write_text("unrelated")
    (tmp_path / f"{boot}.json").symlink_to(target)
    with pytest.raises(OSError) as refused:
        prepare_instance(tmp_path, "native", boot, server_origin="https://chat.test")
    assert refused.value.errno == errno.ELOOP
    assert target.read_text() == "unrelated"


def test_write_failure_is_not_returned_as_persisted(monkeypatch, tmp_path):
    import agent_chat.instance_file as instance_file

    def fail_sync(_fd):
        raise OSError("synthetic persistence failure")

    boot = uuid4()
    with monkeypatch.context() as patch:
        patch.setattr(instance_file.os, "fsync", fail_sync)
        with pytest.raises(OSError, match="synthetic persistence failure"):
            prepare_instance(tmp_path, "native", boot, server_origin="https://chat.test")
    # A retry must reuse the bytes, and must complete fsync before returning.
    written = json.loads((tmp_path / f"{boot}.json").read_text())
    assert prepare_instance(tmp_path, "native", boot, server_origin="https://chat.test").token == written["token"]


def _age(path, seconds):
    then = time.time() - seconds
    os.utime(path, (then, then), follow_symlinks=False)


def test_sweep_unlinks_only_stale_sibling_records(tmp_path):
    origin = "https://chat.test"
    own, stale, fresh = (prepare_instance(tmp_path, f"n{i}", uuid4(), server_origin=origin) for i in range(3))
    beyond = instance_file.SWEEP_STALE_SECONDS
    _age(tmp_path / f"{own.boot_id}.json", 10 * beyond)  # own file is never swept, however old
    _age(tmp_path / f"{stale.boot_id}.json", beyond + 60)
    _age(tmp_path / f"{fresh.boot_id}.json", beyond - 60)
    other = tmp_path / "notes.txt"
    other.write_text("keep")
    wrong_case = tmp_path / f"{uuid4()}.json".upper()
    wrong_case.write_text("{}")
    target = tmp_path / "target"
    target.write_text("unrelated")
    link = tmp_path / f"{uuid4()}.json"
    link.symlink_to(target)
    folder = tmp_path / f"{uuid4()}.json"
    folder.mkdir()
    for path in (other, wrong_case, target, link, folder):
        _age(path, 10 * beyond)
    assert instance_file.sweep_stale(tmp_path, own.boot_id) == 1
    assert not (tmp_path / f"{stale.boot_id}.json").exists()
    assert (tmp_path / f"{own.boot_id}.json").exists() and (tmp_path / f"{fresh.boot_id}.json").exists()
    assert other.exists() and wrong_case.exists() and link.is_symlink() and target.exists() and folder.is_dir()
    # Content is never read: a stale record that is not even JSON goes the same way.
    junk = tmp_path / f"{uuid4()}.json"
    junk.write_bytes(b"not json")
    _age(junk, beyond + 60)
    assert instance_file.sweep_stale(tmp_path, own.boot_id) == 1 and not junk.exists()


def test_sweep_examines_a_bounded_number_of_names(tmp_path):
    for _ in range(instance_file.SWEEP_NAMES + 20):
        path = tmp_path / f"{uuid4()}.json"
        path.write_text("{}")
        _age(path, 10 * instance_file.SWEEP_STALE_SECONDS)
    assert instance_file.sweep_stale(tmp_path, uuid4()) == instance_file.SWEEP_NAMES
    assert len(list(tmp_path.iterdir())) == 20


def test_sweep_and_touch_ignore_an_unusable_directory(tmp_path):
    boot = uuid4()
    assert instance_file.sweep_stale(tmp_path / "missing", boot) == 0
    instance_file.touch_instance(tmp_path / "missing", boot)
    stale = tmp_path / f"{uuid4()}.json"
    stale.write_text("{}")
    _age(stale, 10 * instance_file.SWEEP_STALE_SECONDS)
    tmp_path.chmod(0o755)  # not private: refused as every other directory use is
    assert instance_file.sweep_stale(tmp_path, boot) == 0 and stale.exists()


def test_sweep_survives_a_failing_directory_listing_or_close(tmp_path, monkeypatch):
    stale = tmp_path / f"{uuid4()}.json"
    stale.write_text("{}")
    _age(stale, 10 * instance_file.SWEEP_STALE_SECONDS)
    real_listdir, real_close = os.listdir, os.close

    def failing_listdir(target):
        if isinstance(target, int):
            raise OSError(errno.EIO, "listing failed")
        return real_listdir(target)

    monkeypatch.setattr(os, "listdir", failing_listdir)
    assert instance_file.sweep_stale(tmp_path, uuid4()) == 0 and stale.exists()
    monkeypatch.setattr(os, "listdir", real_listdir)

    def failing_close(descriptor):
        real_close(descriptor)
        raise OSError(errno.EIO, "close failed")

    monkeypatch.setattr(os, "close", failing_close)
    assert instance_file.sweep_stale(tmp_path, uuid4()) == 1 and not stale.exists()


def test_touch_advances_only_the_own_record_and_never_follows_a_link(tmp_path):
    first = prepare_instance(tmp_path, "a", uuid4(), server_origin="https://chat.test")
    second = prepare_instance(tmp_path, "b", uuid4(), server_origin="https://chat.test")
    for record in (first, second):
        _age(tmp_path / f"{record.boot_id}.json", 600)
    instance_file.touch_instance(tmp_path, first.boot_id)
    assert (tmp_path / f"{first.boot_id}.json").stat().st_mtime > time.time() - 60
    assert (tmp_path / f"{second.boot_id}.json").stat().st_mtime < time.time() - 500
    target = tmp_path / "target"
    target.write_text("x")
    _age(target, 600)
    link_boot = uuid4()
    (tmp_path / f"{link_boot}.json").symlink_to(target)
    instance_file.touch_instance(tmp_path, link_boot)
    assert target.stat().st_mtime < time.time() - 500
