# Hardening audit

## Scope and boundaries

Baseline `247135a5b6dbd224b5a840a53fedb6dd09a118b2` on `master`. The checkout was clean when this task started; all changes in this session belong to this task. No reliable branch push date was available from the remote-tracking reflog or public push events, so local commit timing uses the past-day fallback.

The console still manages runner instances inside one existing VM. Instances share that VM's filesystem, user and Docker boundary. Authentik remains the identity provider. Testing uses synthetic identities, temporary keys and state, fake GitHub/systemd/runner executables, and loopback SSH/HTTP servers. No real runners, jobs, Authentik configuration, host services, firewall rules or remote settings were changed. Nothing was pushed or deployed.

All build/test commands after resource steering use `TMPDIR=/home/christian/.local/share/agent-tmp`, with serial execution and low compiler/test parallelism. Existing or unidentified temporary files were left alone. The shared design-context router was unavailable; UI changes preserve the existing design and address errors, pending states and accessibility.

## Issue ledger

| ID | Severity | Reproduction and root cause | Expected behavior and fix | Verification |
| --- | --- | --- | --- | --- |
| AUTH-01 | High | Discovery could supply its own trusted issuer; signed tokens could omit required claims | Verify the configured issuer, required claims, supported algorithms, nonce, audience, authorized party and allowed groups | Generated-key OIDC rejection cases, including wrong signatures, future claims and foreign/plaintext endpoints |
| AUTH-02 | High | Login state was not tied to the initiating browser; logout lacked an Origin boundary | Bind single-use state to a cookie, rotate sessions, reject forged/expired sessions and foreign logout origins | Auth route tests cover replay, redirects, cookie attributes, rotation and CSRF |
| AUTH-03 | Medium | 1,001 pending logins did not hit a limit; unauthenticated state could grow | Cap pending records at 1,000 and reclaim expired records; align loopback HTTP policy | Capacity regression reproduced before fix and now passes |
| LOG-01 | High | Default request logging included callback codes/state; health exceptions could echo upstream bodies | Log method, route pattern and address only; return sanitized health errors | Full-process synthetic secret markers absent from logs; health marker tests |
| CACHE-01 | Medium | Authenticated API responses lacked `no-store` | Apply cache policy to all API results and errors | Anonymous and signed-in process checks |
| LIFE-01 | High | Unknown GitHub state retained orphan deletion permissions | Disable mutations and creation when GitHub inventory is unavailable; never infer destructive cleanup from an outage | Outage and orphan lifecycle regressions |
| LIFE-02 | High | Concurrent requests, cap checks and stale busy snapshots could authorize conflicting work | Reject overlapping mutations, hold the slot across audit I/O, recheck sessions, disconnects, capacity and every matching registration before side effects | Concurrent/duplicate requests, cap races, busy duplicates, session expiry/revocation and HTTP disconnect tests; accepted residual drain race documented below |
| LIFE-03 | Medium | Partial creation/removal and confirmation failure obscured completed work | Retain recoverable metadata, report confirmed phases and operation state, prevent misleading retries | Partial VM/GitHub failures, timeouts, cancellation and confirmation regressions |
| GH-01 | Medium | Stalled, oversized or changing pagination could consume unbounded work or supply incomplete inventory | 10-second requests, 30-second inventory deadline, 2 MiB response limit, 100 pages and 10,000 runners; validate totals and records | Streaming, timeout, malformed inventory and pagination tests |
| SSH-01 | High | Transport needed proof of pinned-host rejection, exact argv and token isolation | Pin host keys, encode argv without shell interpolation, supply tokens through stdin and redact failures | Real SSH integration plus mocked transport tests |
| SSH-02 | Medium | Late callbacks after timeout could dispatch work or send tokens; synchronous connect throws bypassed cleanup | Settle once, close channels, guard callbacks, clear timers, bound combined output and preserve UTF-8 | Timeout, callback, output and synchronous-throw cases |
| VM-01 | High | Runner metadata could select unrelated services; runner-owned scripts could execute as root | Validate root-owned unit binding, create units directly, run configuration as the unprivileged runner user, refuse unsafe config and UID zero | Synthetic unit/config/symlink/argv/token regressions |
| VM-02 | High | Removing runner-owned `config.sh` hid an instance from capacity; partial registration was deleted on failure | Count managed directories and retain failed registrations; serialize privileged operations with a lock | Damaged directory, concurrent cap, partial registration, lock and timeout regressions |
| VM-03 | Medium | 20 valid labels exceeded the SSH wrapper's generic argument limit | Match per-field validation across API, config, wrapper and controller; support 799 joined label characters within the 4096-byte envelope | Maximum-label and invalid-input shell/API cases |
| AUDIT-01 | High | Audit failures could hide whether work started; shutdown could lose the only record | Fsync a UUID-linked pending intent before dispatch, bound write backlog, preserve known outcomes and show unresolved intents | Permission/symlink, concurrent append, backlog, intent and failed-outcome-write tests |
| UX-01 | Medium | Failed create closed the dialog; pending actions and failed refreshes left conflicting controls available | Retain inputs and recovery hints; disable pending/stale actions and restore them on retry | Synthetic browser regressions |
| UX-02 | Low | Proxy HTML errors, logout failures and health failures had poor recovery states | Parse failures safely, show actionable messages and retry controls; improve text contrast | Synthetic browser regressions and contrast checks |
| DEP-01 | High, advisory evidence | Production audit reported seven affected dependencies, including Fastify/static path handling and Zod constrained-collection resource exhaustion | Upgrade Fastify to 5.12.8, static to 10.1.10 and Zod to 4.6.7; refresh affected transitives | Production audit reports zero advisories; noncanonical HTTP-path regressions added; 98 Node tests, production type/build and rebuilt container smoke passed |
| TEST-01 | Medium | Baseline test script referenced missing configuration and test files | Add isolated test infrastructure and run Node and Python regressions in CI | Supported test compilation and serial suite |

## Independent review

An independent Astra review withheld sign-off with six findings. Its snapshot digest was `d3031e73c8533d35a86c049dae61ead5aba3e0cc20cf4cf50137df54260efd7c`. A second independent Astra/high review inspected the follow-up fixes and related tests, found no new substantive issues and signed off within that scope. It performed read-only source review and `git diff --check`; it did not independently rerun the full suite or live acceptance.

| ID | Severity | Reproduction and root cause | Fix | Verification |
| --- | --- | --- | --- | --- |
| REV-01 | High | The pinned runner refuses deregistration while `.service` remains | Uninstall the verified unit and safely unlink its marker before deregistration; retain credentials on failure | Upstream-compatible refusal, successful retry and failure-preservation shell cases |
| REV-02 | Medium | `ok: true` with wrong field types or missing fields was accepted through TypeScript casts | Runtime schemas for every control response, numeric bounds and requested identity | VM-control unit cases and malformed-object real SSH integration |
| REV-03 | Medium | Empty interrupted-create directories consumed capacity but removal required missing `config.sh` | Clean verified unregistered remnants; preserve uncertain registration metadata | Empty remnant and missing-config registered-directory cases |
| REV-04 | High | The 25-second exit deadline could precede remote completion, with no durable intent | Persist intent, allow 300-second app grace and 330-second systemd grace; close finishing HTTP connections during shutdown | Active SIGTERM and SIGINT process tests pass; short synthetic actions exercise draining, not the full five-minute deadline |
| REV-05 | Medium | Failed audit append overwrote an explicitly completed operation with `failed` | Preserve explicit completed/not-started states | Audit and API outcome regressions |
| REV-06 | Medium | Octokit ignored the health client's `request.timeout` | Reuse bounded fetch with an effective abort signal and body-size bound | Stalled-health synthetic fetch regression |

The shutdown regression initially hung after a successful mutation response. Setting `Connection: close` on responses sent while shutting down fixed the persistent connection. The connected SSH fixture also initially leaked listeners because SSH2 does not expose `server.listening`. Its cleanup now checks `server.address()`, closes it and asserts a null address. Those failed runs are not counted as passing evidence.

## Verification

- Final serial Node run, after dependency upgrades, using `npm run build:test` then `node --test --test-concurrency=1 dist-test/test/*.test.js`: **98 passed, zero failed or cancelled**, including 14 connected API-to-SSH cases and both active-shutdown signal cases.
- Test TypeScript compilation passed. Production dependency audit now reports zero vulnerabilities after targeted upgrades; this is an advisory scan, not proof that every dependency is defect-free.
- Production server/frontend type checking and production build passed. All **28 Python privileged-boundary tests** passed.
- Browser fixture: **33 assertions passed** at 1280×800 and 320×812 in both light and dark mode. These cover failure recovery, pending/stale controls, dialog labels, four text-contrast checks and horizontal overflow. Native keyboard Tab traversal, Escape dismissal/focus restoration, dark primary-button hover contrast and synthetic successful logout navigation passed. Earlier worker verification also passed 29 assertions at 375×812. This is targeted accessibility coverage, not certification.
- Docker image build passed. A unique synthetic container on Christian's rootless daemon passed `/healthz`, three negative API authorization/cache checks, UID 1000, read-only root filesystem, zero effective capabilities and `NoNewPrivs=1`. Inspection confirmed `127.0.0.1:32773` publishing on the final dependency set. Graceful SIGTERM exit returned zero; the container was removed. This verifies the image under explicitly supplied confinement flags, not a deployed container configuration.
- Owned browser tab and fixture server were closed; socket inspection confirmed their port and both container test ports were no longer listening. Container smoke used a temporary directory under the designated TMPDIR and removed its own state.
- Shell and browser-script syntax, `git diff --check`, and `systemd-analyze verify` passed. No dedicated lint command is defined; ShellCheck was unavailable.
- GitHub's public release digest matches both pins for `actions-runner-linux-x64-2.336.0.tar.gz`: `04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d`. No live runner installer was executed.

## Exposure and deployment inspection

Pre-existing public HTTP/HTTPS, SSH and port 3773 listeners were inspected and left unchanged. The installed nginx site has no proxy route to this checkout's test services. Test HTTP and SSH listeners use explicit `127.0.0.1` addresses. Vite development and preview defaults now use loopback. Container checks use only Christian's rootless daemon at `unix:///run/user/1001/docker.sock`, with unique names and loopback port publishing.

Deployment/e2e scripts were read before any use. `deploy/deploy.sh` installs and restarts a remote service. `deploy/e2e-check.py` mutates Authentik and runners and now requires explicit live opt-in; reboot mode refuses before credentials or external calls. Neither live procedure was executed. Unit syntax checks do not prove effective systemd confinement or every override location on the deployed VM.

## Open risks and acceptance

**High, accepted residual risk: no atomic busy-job drain.** The pinned runner's `runsvc.sh` forwards SIGTERM as SIGINT; `RunnerService.js` forwards SIGINT and schedules SIGKILL after 30 seconds. A job can start after the final GitHub busy check. Repeated checks reduce stale decisions but cannot guarantee uninterrupted jobs. On 2026-11-12, the user chose to retain stop/restart/remove, recheck busy state and clearly document the race. The console refuses known busy runners but does not require external draining. Operators needing uninterrupted jobs must prevent new assignments and drain existing jobs externally before using these controls. This decision closes the policy blocker; it does not eliminate the race. The independent follow-up review excludes this accepted risk.

SSH disconnection does not prove remote cancellation. A timeout or missing audit outcome requires inventory reconciliation before retrying. Audit JSONL is append-only by convention and permissions, not tamper-proof storage. Unresolved history outside the bounded recent-log view still requires inspection of the retained file.

Live acceptance remains unperformed and separately approval-gated. Missing inputs are an approved deployment target, actual Authentik provider and group/proxy configuration, pinned runner-VM access, and a disposable GitHub runner target/job setup. The VPS cannot reach home machines; no home-host SSH was attempted. Successful real OIDC sign-in, effective deployed confinement, reboot recovery, real runner drain behavior and full accessibility certification are not claimed.
