"""The optional `bodies` mode of pending and claim against the real API and PostgreSQL (delivery enabled)."""

from datetime import datetime
from uuid import uuid4

import pytest

from agent_chat import instance_client
from agent_chat.models import DeliveryClaim, Heartbeat


@pytest.fixture
def delivery_enabled():
    return True


@pytest.fixture
def joined(process_api, credentials, tmp_path):
    directory = tmp_path / "instance"
    directory.mkdir(mode=0o700)
    instance = instance_client.join_instance(
        directory,
        "pi-native",
        uuid4(),
        server_origin=process_api.origin,
        host_token=credentials.agent,
        harness="pi",
        enabled=True,
    )
    instance_client.heartbeat(instance, Heartbeat(native_state="idle", stopped=False, plan_mode=False))
    return instance


def test_bodies_mode_returns_sizes_the_named_body_fields_and_the_grant_clock(joined, process_api, credentials, send):
    sent = send(
        process_api, credentials, "é" * 3000, kind="question", recipients=[str(joined.session_id)]
    )  # 6000 bytes: over the notice bound
    assert instance_client.pending(joined) == {"messages": [sent["id"]]}
    sized = instance_client.pending(joined, True)
    assert sized == {"messages": [sent["id"]], "sizes": {sent["id"]: 6000}, "retry": False}
    grant = instance_client.claim(joined, uuid4(), DeliveryClaim(messages=[sent["id"]]), True)
    assert set(grant) == {"dispatch", "attempt_id", "reservation_ms", "messages", "admitted_at"}
    assert datetime.fromisoformat(grant["admitted_at"]).utcoffset() is not None
    (row,) = grant["messages"]
    assert set(row) == {
        "id",
        "room_id",
        "history_after",
        "kind",
        "body",
        "body_truncated",
        "sender_session_id",
        "sender_principal_id",
        "created_at",
        "thread_id",
    }
    assert row["body"] == "é" * 2048 and row["body_truncated"] is True  # cut at a code point inside 4096 bytes
    assert row["sender_session_id"] is None  # the operator has no sending session
    assert datetime.fromisoformat(row["created_at"]).utcoffset() is not None


def test_the_default_claim_whitelist_carries_no_body(joined, process_api, credentials, send):
    sent = send(process_api, credentials, "private body", kind="question", recipients=[str(joined.session_id)])
    grant = instance_client.claim(joined, uuid4(), DeliveryClaim(messages=[sent["id"]]))
    assert set(grant) == {"dispatch", "attempt_id", "reservation_ms", "messages"}
    assert set(grant["messages"][0]) == {"id", "room_id", "history_after", "kind"}
    assert "private body" not in str(grant)
