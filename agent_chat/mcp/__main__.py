"""Launch the optional Agent Chat MCP service over Streamable HTTP."""

from __future__ import annotations

import argparse
import sys

import uvicorn

from .app import create_app
from .config import load_config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="agent-chat-mcp",
        description="Agent Chat MCP service (Streamable HTTP, bearer instance tokens).",
    )
    parser.add_argument("--config", required=True, metavar="PATH", help="JSON configuration file")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
    except (OSError, ValueError):
        print("agent-chat-mcp: CONFIG_INVALID", file=sys.stderr)
        return 2
    uvicorn.run(
        create_app(config),
        host=config.bind_host,
        port=config.port,
        log_config=None,
        access_log=False,
        proxy_headers=False,
        server_header=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
