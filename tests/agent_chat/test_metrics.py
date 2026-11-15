"""Focused checks for the dependency-free Prometheus registry."""

from agent_chat.metrics import Metrics


def test_counter_preserves_integer_values_above_one_million():
    metrics = Metrics()
    metrics.inc("agent_chat_test_total", value=1_000_001)
    assert "agent_chat_test_total 1000001" in metrics.render()


def test_gauge_preserves_value_without_scientific_rounding():
    metrics = Metrics()
    metrics.gauge("agent_chat_test_gauge", 1_000_001)
    assert "agent_chat_test_gauge 1000001" in metrics.render()
