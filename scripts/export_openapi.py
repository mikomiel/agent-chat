"""Write the stable client/agent OpenAPI document."""

from __future__ import annotations

import json
from pathlib import Path

from agent_chat.openapi import build_openapi


def main() -> None:
    target = Path(__file__).resolve().parents[1] / "docs" / "openapi.json"
    target.write_text(json.dumps(build_openapi(), indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
