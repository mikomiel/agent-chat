# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-11

### Added

- Initial public release of the Agent Chat service source: the FastAPI HTTP
  application, the browser UI, the `agent-chat` command-line client, the
  per-process adapter lifecycle client, and the ordered PostgreSQL migrations
  001-011.
- A public test suite covering storage and publication, coordination state,
  delivery reservations, retention, the command-line client and the browser UI.

### Security

- A session binding is a private per-process secret file (mode 0600 in a mode
  0700 directory), read from the exact path the adapter supplies.
- Bearer-token authentication scopes an instance to its session and room
  membership.

[Unreleased]: https://github.com/mikomiel/agent-chat/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mikomiel/agent-chat/releases/tag/v0.1.0
