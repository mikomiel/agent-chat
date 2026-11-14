# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0](https://github.com/mikomiel/agent-chat/compare/v0.2.0...v0.3.0) (2026-11-14)


### Features

* **mcp:** add opt-in coordination write tools ([#48](https://github.com/mikomiel/agent-chat/issues/48)) ([8b19cb2](https://github.com/mikomiel/agent-chat/commit/8b19cb233c4fbda63203ec40ec67bb6d933fd847))
* **web:** add persisted Polish and English UI ([#52](https://github.com/mikomiel/agent-chat/issues/52)) ([c9362b2](https://github.com/mikomiel/agent-chat/commit/c9362b2465d821e9c57e03a53ca38f5abbd14fcb))


### Bug Fixes

* satisfy the adapter operations protocol ([#51](https://github.com/mikomiel/agent-chat/issues/51)) ([8ce2f69](https://github.com/mikomiel/agent-chat/commit/8ce2f6968d9a24f336527cedd138b8671c5a790c))

## [0.2.0](https://github.com/mikomiel/agent-chat/compare/v0.1.3...v0.2.0) (2026-11-13)


### Features

* **mcp:** add read-only Streamable HTTP surface ([#45](https://github.com/mikomiel/agent-chat/issues/45)) ([a37ca31](https://github.com/mikomiel/agent-chat/commit/a37ca31f364128bc869a04e9890b640d209346cb))
* publish the adapter core and classify missing bindings ([#39](https://github.com/mikomiel/agent-chat/issues/39)) ([15b5ea4](https://github.com/mikomiel/agent-chat/commit/15b5ea4eea08ec757926f3f27d045683240da66e))
* **web:** page through Sessions beyond the first hundred ([#34](https://github.com/mikomiel/agent-chat/issues/34)) ([85d03da](https://github.com/mikomiel/agent-chat/commit/85d03da7dd7a6ed9e0a1169208c7dd22898573d5))
* **web:** show safe server refusal codes ([#40](https://github.com/mikomiel/agent-chat/issues/40)) ([49dbbec](https://github.com/mikomiel/agent-chat/commit/49dbbec842406727575fb3d0cdf3f393ce1dc08c))


### Bug Fixes

* **retention:** count every maintenance category as progress ([#38](https://github.com/mikomiel/agent-chat/issues/38)) ([cb0f910](https://github.com/mikomiel/agent-chat/commit/cb0f91075e8d61e6958ca71f4a83c372e10edcf0))
* **web:** keep unknown native state unknown in Sessions ([#33](https://github.com/mikomiel/agent-chat/issues/33)) ([e55d22c](https://github.com/mikomiel/agent-chat/commit/e55d22c4ec726e2b4f7a60f461bd9be63dd5ba34))


### Performance

* **ci:** run the full suite with four workers ([#43](https://github.com/mikomiel/agent-chat/issues/43)) ([58b2ade](https://github.com/mikomiel/agent-chat/commit/58b2ade442d8873d2a070ad81d6722637df3ca2f))

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
