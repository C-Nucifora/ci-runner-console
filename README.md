# CI Runner Console

A web UI for managing self-hosted GitHub Actions runner **instances** on a single
dedicated CI VM: see them, start/stop/restart them, add more, and delete them
cleanly from both sides. Gated behind Authentik SSO.

Runs as a small Node service behind a reverse proxy or tunnel, either as a
systemd unit or as a container.

## What it talks to

Exactly two things:

1. **The GitHub API** — list registrations, mint registration/removal tokens, delete runners.
2. **The runner VM over SSH** — create/start/stop/remove instances and their systemd units.

No hypervisor, no NAS. Adding a runner provisions another instance *inside* the
existing VM; it never creates a virtual machine. If the VM runs out of capacity, a
human adds a second one by hand.

## Runner instances, not runner machines

Each instance is its own directory (`/opt/runners/<name>`), its own registration,
and its own systemd unit (`actions.runner.<scope>.<name>.service`). Each runs one
job at a time, so N instances means N concurrent jobs.

Instances share the VM's filesystem and Docker daemon, so **they are not isolated
from one another**. The security boundary is the VM, and adding instances does not
change it. That is acceptable here — one org's private repos, no public or fork
workloads — but it should not be described as isolation.

The console never copies a `.credentials` file between instances. Every instance
runs `config.sh` fresh against its own short-lived registration token, because two
runners sharing one registration fight over jobs and corrupt each other's state.

## Security model

**The SSH key is the crown jewel**, so it is deliberately not a general-purpose key.

The control plane's key is pinned in the VM's `authorized_keys` to a forced
command:

```
command="/usr/local/sbin/ci-runner-ctl-ssh",no-agent-forwarding,no-port-forwarding,no-pty,... ssh-ed25519 AAAA...
```

That wrapper accepts a base64-encoded JSON argv array, rejects anything that is not
a small flat array of strings, checks the first element against a fixed allowlist
(`list`, `headroom`, `status`, `logs`, `start`, `stop`, `restart`, `create`,
`remove`), and only then execs the real script. **There is no operation that passes
arbitrary shell through from the UI**, and a fully compromised control plane still
cannot request a shell, forward a port, or run an operation off the list. The
wrapper and privileged script both validate parameters. Each boundary must be
safe on its own; duplicate validation does not protect unsafe filesystem writes,
runner-controlled metadata, or partial failures.

Other properties:

- **Tokens travel on stdin**, never in argv, so registration and removal tokens
  never appear in either host's process table. They are never logged and never
  written to disk by us.
- **The host key is pinned.** The runner VM sits on a flat LAN the control plane
  does not own, so trust-on-first-use is not good enough.
- **Proxy identity headers are stripped on every request** (`X-Forwarded-User`,
  `X-authentik-*`, `X-Remote-User`, …) before any handler runs, and logged when
  seen. The app authenticates users itself over OIDC. This matters because it also
  listens on a LAN port that does not pass through the proxy.
- **Mutations have a durable audit intent** written before dispatch and an outcome
  written afterward, linked by an operation ID. An intent without an outcome is
  shown as unresolved and needs reconciliation before retrying. The JSONL file
  relies on service filesystem permissions and host administration for integrity.
- **The control plane does not run on the runner VM**, and nothing on the runner VM
  can reach it. Do not assume the network enforces this for you: unless you have
  an egress policy on the runner VM, a job can reach anything the VM can, so keep
  the isolation in the application and deployment layers where you control it.
- The service runs as an unprivileged user under a tightly confined systemd unit
  with no capabilities.

## Reconciliation

A runner exists in two places that can disagree, so every name seen on either side
gets a row and the row names the disagreement:

| State | Meaning |
|---|---|
| `online` | Registered, service running, GitHub sees it connected |
| `busy` | Online and executing a job |
| `stopped` | Service is not running. systemd is authoritative here, so a deliberate stop never flashes up as a fault while GitHub catches up |
| `disconnected` | Service **is** running locally but GitHub does not see it — the genuinely surprising case |
| `no-service` | Registered with GitHub but no systemd unit, so it will not survive a reboot |
| `orphan-github` | GitHub registration with nothing backing it on the VM |
| `orphan-local` | Registered instance on the VM that GitHub has no record of |
| `unregistered` | An instance directory that was never registered |

Orphans on either side stay deletable — that is how they get cleaned up. If GitHub
is unreachable the console says so and shows local state only, rather than
accusing every runner of being an orphan.

Unavailable GitHub state disables mutations, including orphan cleanup. Failed
registration or removal retains recoverable local state. Refresh inventory before
retrying an operation whose response reports partial or completed work.

Busy checks are best effort. The pinned runner has no atomic drain command, so a
job can start between the final GitHub check and stop, restart, or removal. Its
shutdown wrapper can kill a job after 30 seconds. These controls do not guarantee
uninterrupted jobs; drain scheduling externally before using them.

The console allows five minutes for in-flight requests to finish during shutdown.
The systemd unit allows 330 seconds. Give containers an equivalent stop timeout;
an interrupted operation remains an unresolved audit intent until reconciled.

## Configuration

All configuration is environment variables; see `.env.example`. In production they
live in `/etc/ci-runner-console.env` (root-owned, `0600`) and are injected by
systemd. Any secret may instead be supplied as `<NAME>_FILE` pointing at a file,
which keeps it out of the process environment.

Nothing sensitive is in this repository.

## Deploying

```bash
deploy/deploy.sh <host>
```

Builds locally, ships only runtime dependencies, installs the systemd unit, and
restarts. It never transmits secrets and refuses to run if the environment file is
missing.

To prepare a runner VM:

```bash
scp vm/ci-runner-ctl vm/ci-runner-ctl-ssh vm/install-vm.sh runner@<vm>:/tmp/
ssh runner@<vm> 'bash /tmp/install-vm.sh' < ~/.ssh/ci-runner-console.pub
```

That installs the allowlist, pins the control-plane key to the forced command,
stages the pinned runner distribution (SHA-256 verified), and writes the cap to
`/etc/ci-runner-ctl.conf`. It is idempotent.

To create the Authentik application and provider:

```bash
ALLOW_AUTHENTIK_SETUP=1 AUTHENTIK_URL=https://<authentik> AUTHENTIK_PUBLIC_URL=https://<public> \
REDIRECT_URI=https://<console>/auth/callback \
AUTHENTIK_TOKEN=<admin api token> MEMBER_PKS=<user pks> \
python3 deploy/authentik-setup.py
```

## Verifying

For isolated checks without infrastructure credentials:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
python3 test/vm-boundaries.py
```

The tests use synthetic identities and temporary state. Development and preview
servers bind to `127.0.0.1`. Do not publish their ports through a public proxy. If
running the production image locally, publish explicitly to loopback with
`-p 127.0.0.1:8080:8080`; `EXPOSE` alone does not publish a container port.

The following is a separate **live acceptance** procedure. It changes Authentik
and runner state and requires explicit approval for the target infrastructure.

```bash
ALLOW_LIVE_CHECKS=1 AUTHENTIK_URL=... AUTHENTIK_TOKEN=... APP_URL=... GITHUB_TOKEN=... \
  GITHUB_RUNNERS_URL=https://api.github.com/repos/OWNER/REPO/actions/runners \
  python3 deploy/e2e-check.py
```

Signs in through Authentik as a temporary user (created and deleted per run) and
exercises the whole lifecycle against the live deployment, including that forged
proxy headers do not authenticate and that delete leaves no orphan on either side.
`REBOOT_TEST=1` refuses to run until a separately approved host and host-key setup
is available. Setting the live-check flag does not approve reboot testing.

`deploy/screenshot.py` renders the signed-in console in headless Chromium for light
and dark mode, and fails if the app did not actually mount.

## The concurrency cap

Enforced in two independent places: `RUNNER_CAP` in the app (which is what the UI
reasons about) and `MAX_RUNNERS` in `/etc/ci-runner-ctl.conf` on the VM. Keep them
in step; the VM's value is the backstop. Default is 3, which is a sensible ceiling
for 4 vCPU / 12 GiB — the UI shows remaining headroom so you can see when it is
optimistic.

## GitHub credentials

The credential layer is an interface with one method, so swapping the PAT for a
GitHub App (installation tokens, auto-refreshed, not tied to a person) is a new
class in `src/github/credentials.ts` rather than a change to every call site.
Similarly `RunnerRegistry` has repo- and org-scoped implementations, so moving from
repo runners to org runners is a config change once the org permission exists.

**Prefer a fine-grained PAT** scoped to the single target with only
_Self-hosted runners: read & write_ (org) or _Administration: read & write_ (repo),
with an expiry set. A classic PAT's `admin:org` is full org control and far more
than this needs.
