"""Configuration for the optional Agent Chat MCP service."""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..models import ChatError
from ..protocol import validate_origin

MAX_CONFIG_BYTES = 65536


class Config(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    bind_host: str = Field(default="127.0.0.1", min_length=1, max_length=255)
    port: int = Field(default=8951, ge=1024, le=65535)
    # Internal origin of the Agent Chat service. Loopback HTTP is allowed.
    agent_chat_origin: str
    # Browser-origin allowlist. When unset, no browser origin is accepted.
    public_origin: str | None = None
    # Write tools are not registered unless this is explicitly enabled.
    enable_writes: bool = False

    @field_validator("agent_chat_origin")
    @classmethod
    def valid_service_origin(cls, value: str) -> str:
        try:
            validate_origin(value)
        except ChatError:
            raise ValueError("agent_chat_origin must be a canonical origin") from None
        return value

    @field_validator("public_origin")
    @classmethod
    def valid_public_origin(cls, value: str | None) -> str | None:
        if value is not None:
            try:
                validate_origin(value, https_only=True)
            except ChatError:
                raise ValueError("public_origin must be a canonical HTTPS origin") from None
        return value


def load_config(path: str) -> Config:
    raw = Path(path).read_bytes()
    if len(raw) > MAX_CONFIG_BYTES:
        raise ValueError("CONFIG_INVALID")
    try:
        return Config.model_validate(json.loads(raw.decode("utf-8")))
    except (ValueError, UnicodeError, ValidationError):
        raise ValueError("CONFIG_INVALID") from None
