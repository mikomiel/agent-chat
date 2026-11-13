from pathlib import Path
from uuid import UUID, uuid4

import pytest

from agent_chat.adapter import Adapter, AdapterConfig
from agent_chat.instance_client import JoinedInstance
from agent_chat.instance_file import prepare_instance
from agent_chat.models import ChatError, DeliveryClaim, DeliveryResult, Heartbeat


class FixedRandom:
    def uniform(self, low: float, _high: float) -> float:
        return low


class FakeOperations:
    def __init__(self, directory: Path):
        self.directory = directory
        self.joins = 0
        self.heartbeats: list[Heartbeat] = []
        self.pending_calls = 0
        self.claims: list[tuple[DeliveryClaim, bool]] = []
        self.settles: list[DeliveryResult] = []
        self.ends = 0
        self.join_errors: list[str] = []
        self.heartbeat_errors: list[str] = []
        self.pending_errors: list[str] = []
        self.settle_errors: list[str] = []
        self.pending_result: dict[str, object] = {"messages": []}
        self.grant: dict[str, object] | None = None
        self.last_joined: JoinedInstance | None = None

    def join_instance(self, directory: Path, native_session_id: str, boot_id: UUID, *,
                      server_origin: str, host_token: str, harness: str, enabled: bool) -> JoinedInstance:
        assert directory == self.directory
        assert server_origin == "https://chat.test"
        assert host_token == "host-token"
        assert enabled is True
        self.joins += 1
        if self.join_errors:
            raise ChatError(self.join_errors.pop(0))
        secret = prepare_instance(directory, native_session_id, boot_id, server_origin=server_origin)
        joined = JoinedInstance(secret, uuid4(), uuid4(), uuid4(), "host", harness)
        self.last_joined = joined
        return joined

    def heartbeat(self, instance: JoinedInstance, state: Heartbeat) -> dict[str, object]:
        assert instance is self.last_joined
        if self.heartbeat_errors:
            raise ChatError(self.heartbeat_errors.pop(0))
        self.heartbeats.append(state)
        return {"session_id": str(instance.session_id), "instance_id": str(instance.instance_id)}

    def pending(self, instance: JoinedInstance, sizing: bool = False) -> dict[str, object]:
        assert instance is self.last_joined
        assert sizing is True
        self.pending_calls += 1
        if self.pending_errors:
            raise ChatError(self.pending_errors.pop(0))
        return self.pending_result

    def claim(self, instance: JoinedInstance, key: UUID, request: DeliveryClaim,
              bodies: bool = False) -> dict[str, object]:
        assert instance is self.last_joined
        self.claims.append((request, bodies))
        assert self.grant is not None
        return self.grant

    def settle(self, instance: JoinedInstance, attempt: UUID, request: DeliveryResult) -> dict[str, object]:
        assert instance is self.last_joined
        if self.settle_errors:
            raise ChatError(self.settle_errors.pop(0))
        self.settles.append(request)
        return {"id": str(attempt), "instance_id": str(instance.instance_id),
                "outcome": request.outcome, "reason": request.reason}

    def end(self, instance: JoinedInstance) -> dict[str, object]:
        self.ends += 1
        return {"instance_id": str(instance.instance_id)}


class FakeDelivery:
    def __init__(self) -> None:
        self.contexts: list[str | None] = []
        self.delivered: list[tuple[tuple[dict[str, object], ...], float]] = []
        self.native_state = "idle"
        self.reason: str | None = None
        self.outcome = "handed"

    def heartbeat_state(self) -> Heartbeat:
        return Heartbeat(native_state="idle", stopped=False, plan_mode=False)

    def state(self) -> str | None:
        return self.reason

    def deliver(self, messages, deadline: float) -> tuple[str, str | None]:
        self.delivered.append((tuple(messages), deadline))
        return self.outcome, None

    def context(self, text: str | None) -> None:
        self.contexts.append(text)


def make_adapter(tmp_path: Path, *, enabled: bool = True):
    operations = FakeOperations(tmp_path)
    delivery = FakeDelivery()
    config = AdapterConfig(
        directory=tmp_path,
        server_origin="https://chat.test",
        host_token="host-token",
        python="/usr/bin/python3",
        harness="pi",
        enabled=enabled,
    )
    adapter = Adapter(config, delivery, operations=operations, clock=lambda: 0.0, rng=FixedRandom())
    return adapter, operations, delivery


def test_join_exposes_binding_and_poll_claims_and_settles(tmp_path):
    adapter, operations, delivery = make_adapter(tmp_path)
    message_id = uuid4()
    operations.pending_result = {"messages": [str(message_id)]}
    operations.grant = {
        "dispatch": True,
        "attempt_id": str(uuid4()),
        "reservation_ms": 5000,
        "messages": [{"id": str(message_id)}],
    }

    adapter.start("native-a")

    assert operations.joins == 1
    assert adapter.available
    binding = adapter.binding()
    assert binding is not None
    assert binding["native_session_id"] == "native-a"
    assert binding["harness"] == "pi"
    assert binding["instance_file"].endswith(f"{adapter.joined.binding.boot_id}.json")
    assert delivery.contexts[-1] is not None
    assert "supersedes every earlier Agent Chat binding" in delivery.contexts[-1]

    assert adapter.tick(0.0) == 2.0
    assert operations.claims[0][0].messages == (message_id,)
    assert operations.claims[0][1] is True
    assert operations.settles == [DeliveryResult(outcome="handed", reason=None)]
    assert delivery.delivered[0][1] == 5.0


def test_heartbeat_runs_on_its_own_interval(tmp_path):
    adapter, operations, _delivery = make_adapter(tmp_path)
    adapter.start("native-a")

    adapter.tick(30.0)
    assert len(operations.heartbeats) == 1
    assert adapter.available


def test_join_conflict_waits_for_the_lease_and_retries(tmp_path):
    adapter, operations, delivery = make_adapter(tmp_path)
    operations.join_errors = ["BINDING_CONFLICT"]

    adapter.start("native-a")
    assert operations.joins == 1
    assert not adapter.available
    assert adapter.joined is None
    assert delivery.contexts[-1] is None
    assert adapter.tick(2.4) == pytest.approx(2.5)

    assert adapter.tick(2.5) is not None
    assert operations.joins == 2
    assert adapter.available
    assert adapter.binding() is not None


def test_stale_instance_rejoins_with_a_new_boot_id(tmp_path):
    adapter, operations, delivery = make_adapter(tmp_path)
    adapter.start("native-a")
    first = adapter.joined.binding.boot_id
    operations.heartbeat_errors = ["STALE_INSTANCE"]

    adapter.tick(30.0)
    assert adapter.joined is None
    assert delivery.contexts[-1] is None
    assert adapter.tick(32.4) == pytest.approx(32.5)
    assert adapter.tick(32.5) is not None
    assert adapter.available
    assert operations.joins == 2
    assert adapter.joined.binding.boot_id != first
    assert "supersedes every earlier Agent Chat binding" in delivery.contexts[-1]


def test_an_authority_refusal_fails_closed_without_a_retry(tmp_path):
    adapter, operations, _delivery = make_adapter(tmp_path)
    operations.join_errors = ["UNAUTHENTICATED"]

    adapter.start("native-a")
    assert adapter.failed == "UNAUTHENTICATED"
    assert not adapter.available
    assert adapter.tick(10_000.0) is None
    assert operations.joins == 1


def test_a_busy_native_state_defers_without_claiming(tmp_path):
    adapter, operations, delivery = make_adapter(tmp_path)
    adapter.start("native-a")
    operations.pending_result = {"messages": [str(uuid4())]}
    delivery.reason = "busy"

    assert adapter.tick(0.0) == 2.0
    assert operations.claims == []
    assert adapter.available


def test_a_settlement_refusal_keeps_the_binding(tmp_path):
    adapter, operations, _delivery = make_adapter(tmp_path)
    adapter.start("native-a")
    operations.pending_result = {"messages": [str(uuid4())]}
    operations.grant = {"dispatch": True, "attempt_id": str(uuid4()), "reservation_ms": 1000,
                        "messages": []}
    operations.settle_errors = ["DELIVERY_CLOSED"]

    adapter.tick(0.0)
    assert adapter.available
    assert adapter.joined is not None


def test_stop_ends_the_binding_and_discards_its_record(tmp_path):
    adapter, operations, delivery = make_adapter(tmp_path)
    adapter.start("native-a")
    path = tmp_path / f"{adapter.joined.binding.boot_id}.json"
    assert path.exists()

    adapter.stop()

    assert operations.ends == 1
    assert not path.exists()
    assert delivery.contexts[-1] is None
    assert not adapter.available


def test_four_failures_in_one_hour_fail_the_rejoin_budget(tmp_path):
    adapter, operations, _delivery = make_adapter(tmp_path)
    adapter.start("native-a")
    now = adapter._next_heartbeat

    for _ in range(3):
        operations.heartbeat_errors = ["STALE_INSTANCE"]
        adapter.tick(now)
        assert adapter.available is False
        now = adapter._next_join
        adapter.tick(now)
        assert adapter.available is True
        now = adapter._next_heartbeat

    operations.heartbeat_errors = ["STALE_INSTANCE"]
    adapter.tick(now)
    assert adapter.failed == "REJOIN_BUDGET"
    assert adapter.tick(10_000.0) is None
