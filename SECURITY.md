# Security

## Reporting a vulnerability

Please report privately through GitHub's
[private vulnerability reporting](https://github.com/metaspartan/sparktop/security/advisories/new)
rather than opening a public issue.

Include what you did, what happened, and what you expected. A proof of concept
helps but is not required. This is a small project maintained by one person, so
expect an acknowledgement within a few days rather than within hours.

## What sparktop touches

Worth understanding before you deploy it, because the interesting risk is in the
credentials rather than in the metrics:

- **SSH credentials for every monitored node.** Keys are preferred. Passwords are
  supported for nodes where installing a key is inconvenient, and are sealed with
  AES-256-GCM under a key derived from `SPARKTOP_SECRET` before touching disk.
  `config/nodes.json` is written `0600` and is gitignored.

  This protects the file, not the running process: anything that can read the
  environment can decrypt. It is strictly better than plaintext and not a
  substitute for keys.

- **No privileges on the nodes.** Every value sparktop reads is available to an
  unprivileged user — no root, no passwordless sudo, no agent installed. Docker
  metrics need the login user in the `docker` group, which is the only
  permission worth granting deliberately.

- **The dashboard is unauthenticated by default**, on the assumption it sits on a
  trusted LAN. Set `SPARKTOP_TOKEN` to require a bearer token on the API and
  WebSocket. Do that before exposing it to anything wider.

- **Container control is opt-in.** Starting, stopping and re-imaging containers
  is disabled unless `SPARKTOP_ENABLE_CONTROL=1`. Reading metrics without auth is
  a defensible default; stopping a container without auth is not, which is why
  the capability is off rather than merely confirm-on-click. Container names and
  image references are validated against strict patterns before they reach a
  command line — never escaped and interpolated.

- **The container runs read-only**, as a non-root user, with all capabilities
  dropped.

## Dependencies

The runtime dependency tree is deliberately small: `ssh2` is the collector's only
runtime dependency, and the TUI has none. Dependencies are scanned with
[OSV-Scanner](https://google.github.io/osv-scanner/) on every push and weekly on
a schedule. Run the same scan locally with `bun run scan`.

## Scope

Out of scope: anything requiring an attacker to already control the machine
running sparktop, or to already hold the SSH credentials it uses. Reports that
the dashboard is unauthenticated by default are expected — that is documented
above, and `SPARKTOP_TOKEN` is the answer.
