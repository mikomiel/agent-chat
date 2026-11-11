"""Disposable HTTP child. Configuration arrives on stdin, never in process arguments."""

import json
import socket
import sys

import uvicorn

from agent_chat import api, storage
from agent_chat.api import create_app


def connect_with_budget(seconds):
    """`storage.connect` with its lock and statement limits replaced by one budget."""

    def connect(dsn):
        db = storage.connect(dsn)
        db.execute(
            "SELECT set_config('lock_timeout', %(limit)s, false), set_config('statement_timeout', %(limit)s, false)",
            {"limit": f"{seconds}s"},
        )
        return db

    return connect


if __name__ == "__main__":
    config = json.loads(sys.stdin.readline())
    if config["lock_budget"] is not None:
        # `api` binds `connect` at import and looks it up per request, so the replacement reaches every connection.
        api.connect = connect_with_budget(config["lock_budget"])
    listener = socket.socket(fileno=config["fd"])
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(
                config["database"],
                enabled=True,
                public_origin=config["origin"],
                delivery_enabled=config["delivery_enabled"],
                stream_poll=config["stream_poll"],
            ),
            access_log=False,
            log_level="critical",
            lifespan="off",
            ws="none",
            proxy_headers=False,
            timeout_graceful_shutdown=3,
        )
    )
    server.run(sockets=[listener])
