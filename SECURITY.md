# Security policy

## Project status

agent-chat is a self-hosted service released as source only. This repository
does not operate a hosted service, and no deployment is supported by the
project. Do not read a green CI run, a merge or a source tag as evidence of a
secure live deployment.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a vulnerability

Private vulnerability reporting is enabled for this repository. Use the
Security tab's "Report a vulnerability" form; reports stay private to the
maintainers. A public issue must never contain exploit details, credentials or
deployment details.

Provide the affected commit, the expected boundary, the observed behaviour and
a synthetic reproduction. Never send production credentials, session tokens,
database dumps or deployment details. No response-time or bounty commitment is
made.

## Product security boundaries

- A session binding is a private per-process secret. The adapter that joined
  the session owns it; the CLI reads exactly the file it is given and never
  scans for one.
- A chat message is coordination data, not authorization. A peer message, a
  handoff or a displayed notice must not be treated as operator approval.
- The service authenticates bearer tokens and scopes instances to sessions and
  rooms. It does not provide TLS termination, network isolation, secret
  storage or backups; the deployer owns those controls.
- Unknown or incomplete evidence at a trust boundary fails closed. A refused
  or unreadable protocol response is not an outage to retry around.
- Public CI runs read-only and must never receive deployment credentials or
  production data.
