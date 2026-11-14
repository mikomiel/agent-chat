# syntax=docker/dockerfile:1.7
ARG PYTHON_VERSION=3.12

FROM ghcr.io/astral-sh/uv:0.13.8 AS uv

FROM python:${PYTHON_VERSION}-slim-bookworm AS build-base
COPY --from=uv /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY pyproject.toml uv.lock README.md LICENSE ./
COPY agent_chat ./agent_chat

FROM build-base AS build-server
RUN uv sync --frozen --no-dev --no-editable --extra server

FROM build-base AS build-mcp
RUN uv sync --frozen --no-dev --no-editable --extra mcp

FROM python:${PYTHON_VERSION}-slim-bookworm AS runtime-base
ARG UID=10001
ARG GID=10001
RUN groupadd --gid "${GID}" agentchat \
    && useradd --uid "${UID}" --gid "${GID}" --system --no-create-home \
       --home-dir /tmp --shell /usr/sbin/nologin agentchat
ENV PATH=/app/.venv/bin:${PATH} \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp
WORKDIR /app
USER ${UID}:${GID}
STOPSIGNAL SIGTERM

FROM runtime-base AS server
COPY --from=build-server /app/.venv /app/.venv
EXPOSE 8443
ENTRYPOINT ["python", "-m", "agent_chat.admin"]
CMD ["serve", "--config", "/etc/agent-chat/config.json"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8443/healthz', timeout=2)"]

FROM runtime-base AS mcp
COPY --from=build-mcp /app/.venv /app/.venv
EXPOSE 8951
ENTRYPOINT ["agent-chat-mcp"]
CMD ["--config", "/etc/agent-chat/mcp.json"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
    CMD ["python", "-c", "import socket; s=socket.create_connection(('127.0.0.1',8951),2); s.close()"]
