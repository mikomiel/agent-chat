# Native deployment with Ansible

This page installs Agent Chat as systemd services on one Linux host. It is the
supported native path. The example playbook in `deploy/ansible/` creates the
service users, installs a tagged release into a versioned virtual environment,
checks and applies reviewed migrations, writes the configuration and the units,
and waits for `/readyz`. PostgreSQL, TLS termination, secret storage, network
policy and backups stay with the deployer.

The container paths are [Compose](containers.md) and
[Podman Quadlet](podman.md). [self-hosting.md](self-hosting.md) is the manual
first run; it explains each step that this playbook automates.

## What the playbook installs

| Item | Where |
| --- | --- |
| Service user and group | `agent-chat`, no login shell; also `agent-chat-mcp` when MCP is enabled |
| Release | `/usr/local/lib/agent-chat/venvs/<tag>-<extras>`, selected by the `current` link in `/usr/local/lib/agent-chat`; `<extras>` is `server`, or `server-mcp` when MCP is enabled |
| Configuration | `/etc/agent-chat/server.json` (owner root, group `agent-chat`) and, when MCP is enabled, `/etc/agent-chat/mcp.json` (owner root, group `agent-chat-mcp`); both mode 0640 |
| Server | `agent-chat.service` |
| Retention | `agent-chat-prune.service`, started daily by `agent-chat-prune.timer` |
| MCP, optional | `agent-chat-mcp.service` |

The server and the prune unit run as `agent-chat`, and the MCP unit runs as
`agent-chat-mcp`. All units have an empty capability set, a read-only file
system, a private `/tmp` and `/dev`, and a system-call filter.
`systemd-analyze security agent-chat.service` reports the exposure. The server
and the prune unit receive the DSN through `LoadCredential=`. The MCP unit has
no credential and its own user, because a process that runs as the server's
user could read the DSN through `/proc/<server pid>/root`. The server's
processes are invisible to a different user. The unit also hides
`/run/credentials` as a second layer.

## Prerequisites

On the control host:

- ansible-core. The playbook uses only `ansible.builtin` modules and was run
  with 2.18.
- A checkout of this repository that contains `deploy/ansible/`. Use the tag of
  the release you install, so that the units and the product match. Releases
  that predate the playbook are not covered: an older MCP service, for example,
  has no `/readyz`, so the readiness check fails. Until a release ships the
  playbook, use the main branch with the newest release.

On the target host:

- Linux with systemd 247 or newer, which is the first release with
  `LoadCredential=`.
- `python3` 3.11 or newer with the `venv` module (Debian and Ubuntu:
  `python3-venv`) and `git`. The install uses a git URL that names the tag.
- Outbound HTTPS to GitHub and to the Python package index during the install.
- Root access through `become`.
- A PostgreSQL server that the host can reach, with an empty database and the
  role that owns it. The playbook creates neither; see section 1 of
  [self-hosting.md](self-hosting.md).

## Provide the DSN

The playbook never creates, reads or prints the DSN. Create the file before the
first run, with your secret manager or a private editor:

```sh
install -d -m 0700 /etc/agent-chat/credentials
install -m 0600 /dev/null /etc/agent-chat/credentials/agent-chat-dsn
${EDITOR:-vi} /etc/agent-chat/credentials/agent-chat-dsn
```

The file holds exactly one libpq DSN line, for example
`host=db.example.invalid dbname=agent_chat user=agent_chat sslmode=require`,
plus whatever authentication your server needs. A database on another host
needs TLS: libpq's default, `prefer`, falls back to plain text and never checks
the server. `require` encrypts but does not check the server. To check it, use
`sslmode=verify-full` and `sslrootcert=/etc/agent-chat/db-ca.crt` (owner root,
group `agent-chat`, mode 0640). Always name the CA file: the service user has
no home directory, so libpq finds no `~/.postgresql/root.crt`, and the 0700
credentials directory is closed to that user. The playbook only checks that the
file is a regular file owned by `root:root` with mode 0600, and stops when it is
not. systemd reads the file as root and hands each unit a private copy through
`LoadCredential=agent-chat-dsn:<path>`. The DSN never appears in an argument, an
environment variable, a configuration file, a template or a log.

The server, the prune run and the admin commands connect to PostgreSQL as the
OS user `agent-chat`. Its home directory is `/nonexistent` and the units set no
`PG*` variable, so `~/.pgpass` and `PGPASSWORD` are not available. Put every
connection setting in the DSN line, including `password=` when the server needs
one. If the server uses `peer` authentication for local sockets, a DSN with
`host=/run/postgresql` is accepted only when the role name equals the OS user
name, so the role `agent_chat` from section 1 of
[self-hosting.md](self-hosting.md) is refused. Name the role `agent-chat`, add a
`pg_ident.conf` map, or connect over TCP with a password. A refused login or an
empty file shows only as a code in the task "List the pending migrations":
`DATABASE_UNAVAILABLE` or `DSN_CREDENTIAL_UNREADABLE`. The product prints no
cause for the first; the PostgreSQL server log names it. See
[Logs and refusals](self-hosting.md#logs-and-refusals).

## Variables

Set them in the inventory. A copy of `deploy/ansible/inventory.example.yml`
lists all of them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `agent_chat_version` | none, required | Release tag `vX.Y.Z`. Any other form is refused. The playbook never picks a version. |
| `agent_chat_public_origin` | none, required | Canonical HTTPS origin that browsers use, with no path and no default port: `:443` is refused. The host name uses lowercase letters, digits, dots and hyphens; an optional port is at most 65535. |
| `agent_chat_bind_host` | `127.0.0.1` | Listener address of both services: `127.0.0.1` or `0.0.0.0`. |
| `agent_chat_port` | `8443` | Server port, 1024-65535. |
| `agent_chat_delivery_enabled` | `false` | Enables the HTTP delivery-reservation routes. |
| `agent_chat_dsn_file` | `/etc/agent-chat/credentials/agent-chat-dsn` | The DSN file that you provide. An absolute path of letters, digits, `.`, `_`, `/` and `-` only. |
| `agent_chat_prune_limit` | `100` | Rows per retention batch, 1-1000. |
| `agent_chat_prune_max_batches` | `50` | Batches per retention run, at least 1. |
| `agent_chat_mcp_enabled` | `false` | Installs and starts the MCP service. `false` stops and disables an installed one. |
| `agent_chat_mcp_public_origin` | none, required with MCP | HTTPS origin of the MCP hostname on your reverse proxy, in the same form as `agent_chat_public_origin`. The MCP service adds this host name to the loopback names it accepts. |
| `agent_chat_mcp_port` | `8951` | MCP port, 1024-65535. Must differ from `agent_chat_port` when MCP is enabled. |
| `agent_chat_mcp_enable_writes` | `false` | Adds the coordination write tools to MCP. |
| `agent_chat_migrate_reviewed` | none | The digest of the migration set you reviewed; see below. |

The MCP service reaches the server on `http://127.0.0.1:<agent_chat_port>`.
Flags must be real booleans. In the inventory write `true` or `false`; with
`-e` pass JSON, for example `-e '{"agent_chat_mcp_enabled": true}'`, because
`-e name=true` passes a string and the playbook refuses it. Numbers and
strings can use the plain `-e name=value` form.

## Run

```sh
git checkout vX.Y.Z   # a release that ships deploy/ansible/, or main until one does
cp deploy/ansible/inventory.example.yml inventory.yml
${EDITOR:-vi} inventory.yml
ansible-playbook -i inventory.yml deploy/ansible/playbook.yml
```

The play targets the group `agent_chat`. An ad hoc list such as `-i host,` has
no group and matches nothing, so Ansible exits without doing anything. Check
mode is not supported and the playbook refuses it.

The migration review comes before every change to the live host. The tasks run
in this order:

1. Check the variables, the Python version and the DSN file.
2. Create the service user and any install directory that is missing, and
   install the release into its own virtual environment. An install directory
   that exists keeps its owner and mode. The old release keeps serving.
3. Render the new configuration into that environment and check it with the
   release's own loader.
4. Run `migrate --check` from the new release against that configuration, and
   stop unless the reviewed digest matches.
5. Only then change the live host: record the activation marker, apply the
   reviewed migrations, set the install directories to `root:root` with mode
   0755, write the configuration and the units, stop the MCP service if MCP is
   turned off, switch `current`, restart what changed, enable and start the
   services, wait for `/readyz`, and remove the marker.

A second run with the same variables reports `changed=0`.

## Review the migrations

The service never runs DDL at startup, and neither does the playbook without
your review. It runs `migrate --check` from the new release, against the
configuration that it has rendered but not yet installed, before it changes
anything live. When migrations are pending the play stops, lists the files and
shows the digest:

```text
fatal: [chat-host.example.invalid]: FAILED! => {... "msg": "11 migration(s) are pending and have not been reviewed. Read the files listed above in the release you are installing, then rerun with -e agent_chat_migrate_reviewed=<digest>"}
```

Read the `agent_chat/*.sql` files of the tag you checked out, then rerun with
the digest:

```sh
ansible-playbook -i inventory.yml deploy/ansible/playbook.yml \
  -e agent_chat_migrate_reviewed=<digest>
```

A refusal changes nothing that runs: the live configuration, the units, the
`current` link, the schema and the running services stay as they were. The play
has only installed the new release next to the old one and rendered the new
configuration inside it, and it has created the service user and any install
directory that was missing. A rerun starts from there.

The playbook applies the set with `migrate --reviewed`. A digest that does not
match the pending set stops the play before anything runs. The product checks
the same digest again under its migration lock: if the pending set changes
between the check and the apply, it refuses with `REVIEW_MISMATCH` and runs
nothing. Only the apply counts as a change. When the schema is current the
digest is ignored, so a stale value in the inventory cannot apply a different
set later: the next release with pending migrations stops again and prints its
own digest.

## Provision the first principal

The admin commands need the DSN. Run `systemd-run` as root: it starts the
command as the service user with the credential, and `--pipe` passes your stdin
through, so the token comes from a private file. This is the operator example of
section 5 of [self-hosting.md](self-hosting.md) under systemd:

```sh
systemd-run --wait --pipe --collect --quiet \
  -p User=agent-chat \
  -p LoadCredential=agent-chat-dsn:/etc/agent-chat/credentials/agent-chat-dsn \
  /usr/local/lib/agent-chat/current/bin/python -I -m agent_chat.admin \
  principal ensure --config /etc/agent-chat/server.json \
  --kind operator --name operator --json < operator.token
```

The token is 64 lowercase hexadecimal characters in a mode-0600 file, as in the
walkthrough. Agents, viewers and producers use the same pattern with their own
arguments.

## Reverse proxy

Agent Chat does not terminate TLS. [deploy/traefik/dynamic.example.yml](../deploy/traefik/dynamic.example.yml)
shows the routes and the header handling. For this path change the two `url`
values from the container names to an address of this host that Traefik can
reach:

- Traefik running directly on this host, or in a container with host networking:
  `http://127.0.0.1:8443` and `http://127.0.0.1:8951`, with the default
  `agent_chat_bind_host`.
- Traefik on another host, or in a container with its own network on this host:
  `http://<host address>:8443` and `http://<host address>:8951`, with
  `agent_chat_bind_host: 0.0.0.0`. `<host address>` is the address at which the
  proxy reaches this host; inside such a container `127.0.0.1` is the container
  itself. The services have no access list of their own, so let a host firewall
  admit the proxy only.

Keep `passHostHeader: true`: the MCP service checks the host name. Keep
`/metrics` off the public routers as the example does; both services answer it
without authentication, so scrape it from the private network only.

## Upgrade and roll back

Check out the new tag, set `agent_chat_version`, and run the playbook. If it
stops at the review gate on a database that already holds data, back up
PostgreSQL with your normal `pg_dump` or physical-backup process before you
rerun with the digest. The apply cannot be reverted, and the rollback below
needs that backup.

The new release installs next to the old one, in its own virtual environment
`venvs/<tag>-<extras>`. The play installs the packages of an environment once
and never runs `pip` in it again. The configuration is rendered inside the new
environment, and `migrate --check` runs from there while the old release still
serves. Nothing live changes until the review gate passes: a refusal leaves
`current`, the schema, the live configuration, the units, the owner and mode of
an existing install directory and the running services alone.

The play is not transactional after the gate. If a task fails between
installing the configuration and switching `current`, the forced handlers can
restart the old release with the new configuration. Rerun the play to finish.
The play writes the activation marker
`/usr/local/lib/agent-chat/activation-pending` right after the gate (owner
root, mode 0600, no secret) and removes it as its last task, after the
readiness checks pass. The marker makes that rerun restart the services, also
when the controller died before its handlers ran and every file already
matches.

To roll back, set the previous tag and run again. The previous release must be
one the playbook covers. When `agent_chat_mcp_enabled` has the value that the
older run used, its virtual environment is still on disk, and the run only
repoints `current` at that directory. With the other value the play installs
that variant first. Migrations are append-only and are not reverted. If the
database records more migrations than the older release ships,
`migrate --check` stops with `SCHEMA_MISMATCH` before anything live changes;
restore a database backup taken before the upgrade first. The playbook never
deletes an old virtual environment: remove
`/usr/local/lib/agent-chat/venvs/<old tag>-<extras>` by hand once you no longer
need it.

## Check and operate

```sh
systemctl status agent-chat.service
journalctl -u agent-chat.service
curl -fsS http://127.0.0.1:8443/readyz
systemctl list-timers agent-chat-prune.timer
systemctl start agent-chat-prune.service
```

The last command starts one bounded retention run now. The run stops after
`agent_chat_prune_max_batches` batches of `agent_chat_prune_limit` rows. The
timer starts it daily with a random delay of up to an hour and catches up after
downtime. The MCP unit logs as `agent-chat-mcp`.

### Rotate the DSN

Replace the contents of the DSN file in place: keep the path, the owner
`root:root` and the mode 0600. Then restart the server:

```sh
sudo systemctl restart agent-chat.service
```

The prune service reads the new credential at its next start, and the MCP
service has no DSN. The playbook does not detect a changed DSN, because it
never reads the file.

## Limits

- One host and one instance. The playbook does not create PostgreSQL, TLS,
  firewall rules, backups or log shipping.
- It was run end to end on Debian 12 (systemd 252, Python 3.11) inside a
  systemd container with ansible-core 2.18. That run installed the release from
  a local directory, so the `git+https` install from the tag was not exercised.
  Other distributions with systemd 247 or newer and Python 3.11 should work but
  were not exercised.
- Setting `agent_chat_mcp_enabled` to `false` stops and disables the MCP service
  but leaves its unit, `/etc/agent-chat/mcp.json` and the `agent-chat-mcp` user
  on the host; delete them by hand if you do not need them.
- Switching `agent_chat_mcp_enabled` on or off installs a separate virtual
  environment and activates it like an upgrade.
- The install resolves the Python dependencies from the package index at run
  time. The lock file is for development only.
- The server and the prune unit share the `agent-chat` user; the MCP unit has
  its own, `agent-chat-mcp`, so it cannot read the server's credential. Run no
  other service under either user.
- Both services bind the address in `agent_chat_bind_host`; the units hold no
  address. To bind them apart, change the `bind_host` line in one of
  `deploy/ansible/templates/server.json.j2` or `mcp.json.j2`, and keep the
  value `127.0.0.1` or `0.0.0.0`: the readiness checks and the MCP service
  connect to `127.0.0.1`. A hand edit of `/etc/agent-chat/*.json` is overwritten
  by the next run.
