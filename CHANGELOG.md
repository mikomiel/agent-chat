# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3](https://github.com/mikomiel/agent-chat/compare/v0.1.2...v0.1.3) (2026-11-11)


### Bug Fixes

* set the connection socket seam without a version-specific type ignore ([#18](https://github.com/mikomiel/agent-chat/issues/18)) ([f80c1fa](https://github.com/mikomiel/agent-chat/commit/f80c1fa3e5dca865916e68f4a55180ef111eef5b))

## [0.1.2](https://github.com/mikomiel/agent-chat/compare/v0.1.1...v0.1.2) (2026-11-11)


### Bug Fixes

* annotate the expected migration rows for type checkers ([#15](https://github.com/mikomiel/agent-chat/issues/15)) ([4242950](https://github.com/mikomiel/agent-chat/commit/424295016be7c672ad583814e711d4ec8ab2eae4))

## [0.1.1](https://github.com/mikomiel/agent-chat/compare/v0.1.0...v0.1.1) (2026-11-11)


### Bug Fixes

* accept the reviewed pre-release migration digests ([#12](https://github.com/mikomiel/agent-chat/issues/12)) ([b11ebe3](https://github.com/mikomiel/agent-chat/commit/b11ebe3a89dbee0e6e568edc6114b9d151f428c1))

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

[Unreleased]: https://github.com/mikomiel/agent-chat/compare/v0.1.3...HEAD
[0.1.0]: https://github.com/mikomiel/agent-chat/releases/tag/v0.1.0
