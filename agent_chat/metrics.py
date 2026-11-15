"""Bounded, dependency-free Prometheus metrics for Agent Chat."""

from __future__ import annotations

from collections.abc import Mapping
from threading import Lock


def _escape(value: object) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _labels(labels: Mapping[str, str] | None) -> str:
    if not labels:
        return ""
    return "{" + ",".join(f'{key}="{_escape(value)}"' for key, value in sorted(labels.items())) + "}"


class Metrics:
    """Counters and gauges with bounded label cardinality."""

    def __init__(self) -> None:
        self._counters: dict[tuple[str, tuple[tuple[str, str], ...]], float] = {}
        self._gauges: dict[tuple[str, tuple[tuple[str, str], ...]], float] = {}
        self._lock = Lock()

    @staticmethod
    def _key(name: str, labels: Mapping[str, str] | None) -> tuple[str, tuple[tuple[str, str], ...]]:
        return name, tuple(sorted((labels or {}).items()))

    def inc(self, name: str, labels: Mapping[str, str] | None = None, value: float = 1) -> None:
        key = self._key(name, labels)
        with self._lock:
            self._counters[key] = self._counters.get(key, 0) + value

    def gauge(self, name: str, value: float, labels: Mapping[str, str] | None = None) -> None:
        with self._lock:
            self._gauges[self._key(name, labels)] = value

    def adjust(self, name: str, delta: float, labels: Mapping[str, str] | None = None) -> None:
        key = self._key(name, labels)
        with self._lock:
            self._gauges[key] = self._gauges.get(key, 0) + delta

    def render(self) -> str:
        with self._lock:
            counters = dict(self._counters)
            gauges = dict(self._gauges)
        lines: list[str] = []
        for name in sorted({key[0] for key in counters}):
            lines.append(f"# TYPE {name} counter")
            for (metric, labels), value in sorted(counters.items()):
                if metric == name:
                    lines.append(f"{metric}{_labels(dict(labels))} {value:g}")
        for name in sorted({key[0] for key in gauges}):
            lines.append(f"# TYPE {name} gauge")
            for (metric, labels), value in sorted(gauges.items()):
                if metric == name:
                    lines.append(f"{metric}{_labels(dict(labels))} {value:g}")
        return "\n".join(lines) + "\n"
