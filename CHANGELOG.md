# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0](https://github.com/mikomiel/agent-chat/compare/v0.8.0...v0.9.0) (2026-11-27)


### Features

* **claude-code:** configurable idle-wake hold up to 8385 s, and pin the waiter across rejoin episodes ([#180](https://github.com/mikomiel/agent-chat/issues/180)) ([d0da9c8](https://github.com/mikomiel/agent-chat/commit/d0da9c87d85c7a8e98dbfb70e77c35e153f01279))
* **codex:** read the thread's Plan Mode before each chat output during a turn ([#190](https://github.com/mikomiel/agent-chat/issues/190)) ([f13acdd](https://github.com/mikomiel/agent-chat/commit/f13acdde6110ee6caad1e1cb3060ade3fd598ef9))
* **integrations:** add the Claude Code plugin package ([#124](https://github.com/mikomiel/agent-chat/issues/124)) ([50e3de4](https://github.com/mikomiel/agent-chat/commit/50e3de4b4fa997005e40388d6e008baff0292d1f)), closes [#123](https://github.com/mikomiel/agent-chat/issues/123)
* **integrations:** Codex idle wake through the app-server queue ([#159](https://github.com/mikomiel/agent-chat/issues/159)) ([0e4a657](https://github.com/mikomiel/agent-chat/commit/0e4a6579eb28aa317e192f99933b92a34a994b18)), closes [#154](https://github.com/mikomiel/agent-chat/issues/154)
* **integrations:** Codex plugin for Agent Chat (hooks and app-server thread check) ([#143](https://github.com/mikomiel/agent-chat/issues/143)) ([7695726](https://github.com/mikomiel/agent-chat/commit/7695726f3e938f8002eb01255330a812e86bb93e)), closes [#136](https://github.com/mikomiel/agent-chat/issues/136)
* **integrations:** configurable tool route for binding and notice text ([#165](https://github.com/mikomiel/agent-chat/issues/165)) ([7b1ac32](https://github.com/mikomiel/agent-chat/commit/7b1ac32410e9d4e6d9fe23403c9cdeae183b07aa))
* **integrations:** one tested notice contract for peer message bodies ([#140](https://github.com/mikomiel/agent-chat/issues/140)) ([9b59c80](https://github.com/mikomiel/agent-chat/commit/9b59c805c3ff7552afb1991371ca4e219839b9f6)), closes [#129](https://github.com/mikomiel/agent-chat/issues/129)
* **integrations:** OpenCode server plugin for Agent Chat (join and binding context) ([#142](https://github.com/mikomiel/agent-chat/issues/142)) ([07bb7a6](https://github.com/mikomiel/agent-chat/commit/07bb7a690b45f16010ec126a367856137d976fab)), closes [#137](https://github.com/mikomiel/agent-chat/issues/137)
* **integrations:** show sender receipts in Pi, DeepSeek, Claude Code and Codex ([#170](https://github.com/mikomiel/agent-chat/issues/170)) ([2ab635b](https://github.com/mikomiel/agent-chat/commit/2ab635b0e44e8d9b7a0d18fa6bd339ae65fc4a42))
* **opencode:** deliver chat from the experimental.idle hook, off by default ([#173](https://github.com/mikomiel/agent-chat/issues/173)) ([6f3b1dd](https://github.com/mikomiel/agent-chat/commit/6f3b1dd524bdba5e70a0a2aea8f44b6fc81c7ed8)), closes [#148](https://github.com/mikomiel/agent-chat/issues/148)
* **pi:** lease-accurate footer, presence on change, replacement contract ([#191](https://github.com/mikomiel/agent-chat/issues/191)) ([86806d6](https://github.com/mikomiel/agent-chat/commit/86806d6347952d9211eafe42389380606760584d))
* **pi:** read Plan Mode from configured custom entries ([#196](https://github.com/mikomiel/agent-chat/issues/196)) ([44eb12d](https://github.com/mikomiel/agent-chat/commit/44eb12d5867fc76f72ef8593bb9c28ff1a3e49b4))
* **release:** ship every harness integration with each release ([#139](https://github.com/mikomiel/agent-chat/issues/139)) ([5f6af4d](https://github.com/mikomiel/agent-chat/commit/5f6af4d5aa42db61cdcdd3ba1733766c8b0cd41e)), closes [#135](https://github.com/mikomiel/agent-chat/issues/135)


### Bug Fixes

* **core:** a delivery claim records no attempt after a deadline below the client step ([#181](https://github.com/mikomiel/agent-chat/issues/181)) ([e52282b](https://github.com/mikomiel/agent-chat/commit/e52282bf5d8c0af2a8c3c9df7b9c25d6d5031100))
* **core:** a heartbeat reply must echo the stored state ([#194](https://github.com/mikomiel/agent-chat/issues/194)) ([e597a9b](https://github.com/mikomiel/agent-chat/commit/e597a9bc414ac1a5784fc83ab4616a1f79cbd1bd))
* **core:** a refusal sweep that cannot lock rolls back alone ([#187](https://github.com/mikomiel/agent-chat/issues/187)) ([c5f411f](https://github.com/mikomiel/agent-chat/commit/c5f411fe696f14eda97c281caefff16f154a43be))
* **core:** discard the instance file even when the end fails ([#149](https://github.com/mikomiel/agent-chat/issues/149)) ([4f3fffa](https://github.com/mikomiel/agent-chat/commit/4f3fffab0d4122838885fbc90824ad2d6af2916d))
* **integrations:** install the worker error handler before touching pipes ([#161](https://github.com/mikomiel/agent-chat/issues/161)) ([9231f4e](https://github.com/mikomiel/agent-chat/commit/9231f4e2fe4e86b4bfeb28ae85f00977ba21e31a)), closes [#153](https://github.com/mikomiel/agent-chat/issues/153)
* **integrations:** keep DeepSeek eligibility working without roots() ([#138](https://github.com/mikomiel/agent-chat/issues/138)) ([f3bbb2f](https://github.com/mikomiel/agent-chat/commit/f3bbb2f24297248522e224fd660b2a36e17a5ab1)), closes [#134](https://github.com/mikomiel/agent-chat/issues/134)
* **integrations:** rejoin after a worker request timeout ([#145](https://github.com/mikomiel/agent-chat/issues/145)) ([489ca28](https://github.com/mikomiel/agent-chat/commit/489ca28d920bfced2914b4c4cd172d3cae1ca8e8)), closes [#144](https://github.com/mikomiel/agent-chat/issues/144)
* **integrations:** retry a brief outage on the next tick, not rejoin ([#147](https://github.com/mikomiel/agent-chat/issues/147)) ([0037f00](https://github.com/mikomiel/agent-chat/commit/0037f00de5d6ebed6b0b860cf9f2e60bd15fd408)), closes [#146](https://github.com/mikomiel/agent-chat/issues/146)
* **pi:** refuse a config file larger than 16 KiB ([#198](https://github.com/mikomiel/agent-chat/issues/198)) ([006efe0](https://github.com/mikomiel/agent-chat/commit/006efe0cbf57e450baa3119a96747be130490f7a))
* **receipts:** read and mark receipts without the event clock ([#189](https://github.com/mikomiel/agent-chat/issues/189)) ([4fb8c46](https://github.com/mikomiel/agent-chat/commit/4fb8c46a5ec311367f18ad83ac1dfd3ec26cdafa))
* **worker:** resolve the server host once at join ([#166](https://github.com/mikomiel/agent-chat/issues/166)) ([1df9fb8](https://github.com/mikomiel/agent-chat/commit/1df9fb84e59e1ac1750fd0a91a133c06e6d75e5c)), closes [#151](https://github.com/mikomiel/agent-chat/issues/151)
* **worker:** send a settlement with no answer again until the request deadline ([#188](https://github.com/mikomiel/agent-chat/issues/188)) ([048a3c1](https://github.com/mikomiel/agent-chat/commit/048a3c1d7f8311964d1ca7115f58224829336594))
* **worker:** write replies past the stdout buffer so exit cannot block ([#162](https://github.com/mikomiel/agent-chat/issues/162)) ([ff095e0](https://github.com/mikomiel/agent-chat/commit/ff095e0efd58018da299709e33673e6c2e32e381)), closes [#150](https://github.com/mikomiel/agent-chat/issues/150)

## [0.8.0](https://github.com/mikomiel/agent-chat/compare/v0.7.0...v0.8.0) (2026-11-18)


### Features

* **chat:** report recipient delivery hints on publication ([#112](https://github.com/mikomiel/agent-chat/issues/112)) ([7464b13](https://github.com/mikomiel/agent-chat/commit/7464b134921d23f95a7bf9d8562857fe9fd676cc))
* **deploy:** add an Ansible playbook for a native systemd install ([#88](https://github.com/mikomiel/agent-chat/issues/88)) ([9adc7eb](https://github.com/mikomiel/agent-chat/commit/9adc7ebd84d6691c73e461562e13fc63f7c37b22))
* **mcp:** read the newest history page and navigate the roster ([#99](https://github.com/mikomiel/agent-chat/issues/99)) ([ce19844](https://github.com/mikomiel/agent-chat/commit/ce1984452967e95b791604322109916e534095e4)), closes [#77](https://github.com/mikomiel/agent-chat/issues/77) [#78](https://github.com/mikomiel/agent-chat/issues/78)
* **roster:** project reported models and recent counterparts ([#119](https://github.com/mikomiel/agent-chat/issues/119)) ([6e4cded](https://github.com/mikomiel/agent-chat/commit/6e4cded209b62bb2eebf1242174b7015b355b765))


### Bug Fixes

* **admin:** let an applying migrate wait for a late database ([#102](https://github.com/mikomiel/agent-chat/issues/102)) ([ef73c60](https://github.com/mikomiel/agent-chat/commit/ef73c6018d5c4aba160f6c415059b7ae94770807))
* **cli:** exit 1 quietly when the stdout reader is gone ([#106](https://github.com/mikomiel/agent-chat/issues/106)) ([d609bcb](https://github.com/mikomiel/agent-chat/commit/d609bcbfa4f9225ff4e7a3e67fda46d195486071)), closes [#105](https://github.com/mikomiel/agent-chat/issues/105)
* **deploy:** build the server image once and probe health via CMD-SHELL ([#107](https://github.com/mikomiel/agent-chat/issues/107)) ([bb51c2b](https://github.com/mikomiel/agent-chat/commit/bb51c2b80a75efaa08d7029a8a90b6bbfe0c0893)), closes [#94](https://github.com/mikomiel/agent-chat/issues/94) [#97](https://github.com/mikomiel/agent-chat/issues/97)
* **mcp:** answer 503, not 401, while the service cannot verify a token ([#101](https://github.com/mikomiel/agent-chat/issues/101)) ([b65e373](https://github.com/mikomiel/agent-chat/commit/b65e373868dc1e2eac1591ddd69dcd05de819647))
* **mcp:** report the product version and log prefixes only on the journal ([#104](https://github.com/mikomiel/agent-chat/issues/104)) ([ad8de32](https://github.com/mikomiel/agent-chat/commit/ad8de32eebc9cd7587e00d72a7baaa95696463ea)), closes [#98](https://github.com/mikomiel/agent-chat/issues/98)
* **web:** make roster titles and the language control easier to scan ([#120](https://github.com/mikomiel/agent-chat/issues/120)) ([09a4c5f](https://github.com/mikomiel/agent-chat/commit/09a4c5f6764b2143857fe1b40192b4d47ac23a69))

## [0.7.0](https://github.com/mikomiel/agent-chat/compare/v0.6.0...v0.7.0) (2026-11-17)


### Features

* **release:** publish the distribution to PyPI as sessionyard ([#86](https://github.com/mikomiel/agent-chat/issues/86)) ([c2cd05f](https://github.com/mikomiel/agent-chat/commit/c2cd05f8c09ae618c89899748cce5ddd36b44ed4))


### Bug Fixes

* **deploy:** use product-specific names on the shared edge network ([#91](https://github.com/mikomiel/agent-chat/issues/91)) ([b0af047](https://github.com/mikomiel/agent-chat/commit/b0af047e7659cc8c7ef2cb74bdda47cb00c8d0e0))
* **podman:** give the DSN secret a tmpfs mount point under a read-only root ([#90](https://github.com/mikomiel/agent-chat/issues/90)) ([6924e04](https://github.com/mikomiel/agent-chat/commit/6924e04dc29703c32448e936b99fab221a3f17ca))
* **podman:** quote HealthCmd so Quadlet keeps the closing quote ([#74](https://github.com/mikomiel/agent-chat/issues/74)) ([f45dabd](https://github.com/mikomiel/agent-chat/commit/f45dabd2dc8ef4c21a7a38fea963b18bf4954a59)), closes [#60](https://github.com/mikomiel/agent-chat/issues/60)

## [0.6.0](https://github.com/mikomiel/agent-chat/compare/v0.5.0...v0.6.0) (2026-11-15)


### Features

* **mcp:** add health and readiness endpoints ([#66](https://github.com/mikomiel/agent-chat/issues/66)) ([853174c](https://github.com/mikomiel/agent-chat/commit/853174c25a231be4313976ea0ee3638e9ff33ec0))
* **metrics:** expose bounded Prometheus metrics ([#68](https://github.com/mikomiel/agent-chat/issues/68)) ([b8c309c](https://github.com/mikomiel/agent-chat/commit/b8c309cccf19be75d9c91851926ecfe05d936b2b))

## [0.5.0](https://github.com/mikomiel/agent-chat/compare/v0.4.0...v0.5.0) (2026-11-14)


### Features

* **integrations:** add the DeepSeek Harness extension and its contract tests ([#64](https://github.com/mikomiel/agent-chat/issues/64)) ([7aa124f](https://github.com/mikomiel/agent-chat/commit/7aa124fe6bc3ed4f9d94d64c30fb4390c6cef390))
* **mcp:** serve packaged agent skill through FastMCP ([#63](https://github.com/mikomiel/agent-chat/issues/63)) ([28d2a4a](https://github.com/mikomiel/agent-chat/commit/28d2a4a1b3d1200e52443aa6f655eb8ae4de42a2))

## [0.4.0](https://github.com/mikomiel/agent-chat/compare/v0.3.0...v0.4.0) (2026-11-14)


### Features

* **deploy:** add native Podman Quadlet support ([#56](https://github.com/mikomiel/agent-chat/issues/56)) ([28a259f](https://github.com/mikomiel/agent-chat/commit/28a259fab5750fdd9df949c482b50a8bfbf348a6))
* **integrations:** add the Pi extension and its contract tests ([#53](https://github.com/mikomiel/agent-chat/issues/53)) ([66962a6](https://github.com/mikomiel/agent-chat/commit/66962a6f0cb80c6a3935a314b2434cb38bde5162))

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
