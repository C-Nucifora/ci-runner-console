# Extended audit rounds

## Scope and completion rule

Starting revision: `3f8c4ec`, including the prior hardening and the user's accepted best-effort busy-job policy. The earlier audit is baseline evidence, not a new round. Complete at least three new rounds, then continue until two consecutive independent rounds leave no substantive unresolved defect in the coverage below. Every counted round must add bounded source-led synthetic experiments and fresh independent challenge; an existing green suite alone does not qualify.

Keep the single-VM instance model, Authentik authentication and existing stop/restart/remove with busy rechecks. The accepted job-start race is a residual risk, not a new defect or an approval for live testing. No actual runners, Authentik, jobs, home machines or production services may be changed.

The user now authorizes signed commits and normal pushes to dedicated topic branches on `C-Nucifora/ci-runner-console`. No force pushes, merges, releases or deployments. The parent owns integration and publication. Workers may only edit assigned tests or production files and must not publish independently.

## Coverage matrix

| Area | Required invariant | New sequences to challenge |
| --- | --- | --- |
| Identity and HTTP | Forged headers, cookies, origins, encoded paths and token claims cannot confer access | Cross-route malformed inputs, concurrent callbacks, provider failures, expired/revoked sessions |
| External responses and limits | Untrusted HTTP/SSH data has bounded resource cost and cannot authorize unsafe work | Partial reads, redirects, malformed structures, duplicate and changing records, timeout/cancellation ordering |
| Privileged VM boundary | Runner-writable data cannot select privileged paths, commands or unrelated units | Damaged registration/service markers, symlinks, recovery retries, subprocess failures, wrapper/controller disagreements |
| Lifecycle and reconciliation | Cap/duplicate/busy guards and unavailable GitHub state preserve recoverable state | Interleaved retries, partial VM/GitHub outcomes, token delays, disconnects, ambiguous inventory |
| Audit and shutdown | Durable intents precede side effects; outcomes and uncertainty remain truthful | Torn/failed/slow writes, interrupted shutdown, backlog pressure and subsequent recovery |
| Configuration and deployment | Secrets remain private and services remain confined | Invalid config, installation/deployment refusal, container constraints, listener and proxy inspection |
| Browser and operator recovery | Pending/stale state cannot authorize conflicting actions; failures remain actionable | Refresh/action races, modal transitions, sign-out, keyboard/mobile/error-state sequences |

## Host coordination

Start with two lightweight breakers. Share capacity status at `/home/christian/.local/state/agent-swarms/ci-runner-console.json`. Serialize every build/test/property/fuzz/browser job with `flock /home/christian/.local/state/agent-swarms/heavy.lock`; use `TMPDIR=/home/christian/.local/share/agent-tmp`, low compiler parallelism and one test worker. All owned listeners bind to `127.0.0.1`. Rootless Docker uses `unix:///run/user/1001/docker.sock`. Stop owned services and leave other projects' state alone.

## Publication inspection

Fetched `origin` before starting; no incoming commits beyond the local baseline. The intended remote is `https://github.com/C-Nucifora/ci-runner-console.git`. GitHub reports only the CI workflow and no repository hooks. The workflow triggers on pushes to `master`, pull requests and manual dispatch; the topic branch `hardening-audit-rounds` is excluded from push jobs. GitHub still validates workflow files on topic pushes and can report invalid workflows as failed runs. Do not claim hosted test execution from that validation alone. No reliable prior branch push timestamp was available from reflogs or public push events; use the skill's past-day fallback while preserving the five existing signed commits.

The parent published the five preserved, verified commits through `3f8c4ec` to `origin/hardening-audit-rounds` on 2026-11-12. This baseline publication is not a new clean round. No PR, merge, release or deployment was created. New round findings and fixes will be published separately after validation.

## Round 1

Status: resumed by the user after the verified checkpoint. Two fresh independent reviewers are challenging the HTTP/audit implementation and the parent VM/state follow-ups. Parent checkpoint checks passed as recorded below. Round one is not independently closed yet.

Results, regression commands, fixes, independent objections and published commit IDs will be recorded as evidence arrives.

### HTTP breaker triage

Independent breaker added `test/round1-http-boundaries.test.ts` and executed it twice under the shared lock. Final result: nine passing cases and nine failing regression assertions, with two failed parent test groups, 1.96 seconds. The test uses owned loopback providers and temporary audit files, all cleaned up. No resource-exhaustion load was attempted.

| ID | Severity | Reproduction and expected behavior | Root cause | Status |
| --- | --- | --- | --- | --- |
| R1-A01 | Medium | Discovery, token and JWKS bodies larger than 2 MiB, including chunked transfer, still complete login; require bounded rejection | OIDC JSON readers have deadlines but no response byte ceiling | Fixed; checkpoint regression and full checks passed |
| R1-A02 | Medium | A null audit row makes `/api/audit` fail; incomplete rows can escape or shadow valid records with the same operation ID | Parsed audit JSON is cast without shape validation before deduplication | Fixed; checkpoint regression and full checks passed |
| R1-A03 | High | After an unfinished JSON append, the next operation executes with intent bytes on disk but no readable pending intent; outcome failure leaves it hidden | New JSON is appended onto the torn line | Fixed; checkpoint regression and full checks passed |

The same breaker disproved six redirect/interrupted-response candidates, eleven malformed signed-claim cases, forged/revoked cookie and duplicate-query cases, and concurrent callback replay. Four malformed VM response combinations failed closed and valid inventory then recovered. Existing skipping of malformed JSON syntax and an incomplete trailing line works; complete-but-invalid shapes and append recovery do not.

The parent added `npm run test:vm` to discover all `test/*boundaries.py` suites serially, and wired it into CI with runner-local TMPDIR. This ensures new Python regressions are not silently omitted. Validation of the combined command waits until fixes are integrated.

### Privileged recovery breaker triage

Independent breaker added `test/round1-vm-boundaries.py`. Its complete focused run produced twelve tests: eight passed and four failed, in 18.38 seconds after lock acquisition. The eight passing tests cover 53 bounded cases, including damaged canonical markers, symlink redirection, rooted paths, stop/disable/configuration failures and twenty wrapper/controller argv comparisons. Fixture systemd state is synthetic; actual host cache behavior was not exercised.

| ID | Severity | Reproduction and expected behavior | Root cause | Status |
| --- | --- | --- | --- | --- |
| R1-V01 | High | Remove a noncanonical installed unit's runner-owned marker: discovery hides the service and removal deletes its directory while the fake unit remains active; require verified discovery or safe refusal | Fallback depends on the marker, while cleanup checks only the canonical unit | Fixed after two failing reproductions; checkpoint checks passed |
| R1-V02 | Medium | Replace a canonical service marker with a directory: cleanup deletes the trusted unit before marker unlink fails, and retry becomes stranded; preserve trusted evidence or support retry | Fallible marker cleanup follows unit deletion | Fixed; checkpoint regression and full checks passed |
| R1-V03 | Medium | Fail daemon-reload once during removal, then retry: deregistration succeeds without completing reload; repeat the missing cleanup phase | Deleted unit/marker evidence makes the retry skip reload | Fixed; checkpoint regression and full checks passed |

The VM fixer also owns R1-P01 reconciliation and its affected state presentation, with separate file ownership from the OIDC/audit fixer. Stable active-runner controls and the accepted busy-check race must remain unchanged. Both fixers have finished; parent integration and the independent review status are recorded below.

VM/state implementation adds bounded verified-unit discovery with ambiguity refusal, unlinks the service marker before deleting the trusted unit, and repeats daemon-reload on removal retries. Reconciliation and frontend presentation distinguish changing/unknown service states and guard their actions while retaining stable controls. Fixer verification: eighteen round-one VM tests, twenty-eight original VM tests, ten reconciliation-state tests, typecheck and shell/browser-script syntax all passed under the shared lock. A fresh reviewer supplied cases for discovery ambiguity, nearby partial failures and state combinations; the checkpoint results are recorded below. Snapshot hashes are retained in `/home/christian/.local/share/agent-tmp/crc-round1-vm-review-snapshot.json`.

### Parent supplementary experiment

Hypothesis: reconciliation treats every service state except `active` as proof of a stopped service. A bounded matrix in `test/round1-reconcile-status.test.ts` supplies `activating`, `deactivating`, `reloading`, `refreshing`, `maintenance`, `unknown` and null states, plus stable active/inactive/failed controls. No services or network calls are involved.

Confirmed R1-P01, medium: all seven transitional/uncertain cases incorrectly return `state: stopped`, claim GitHub cannot send work, and enable Start. The stable-state control passes. Root cause is the `local.active !== 'active'` classification and complementary start predicate in `src/reconcile.ts`. Expected behavior is to distinguish transitional/unknown state from confirmed inactivity and avoid presenting a premature start action. This is separate from the accepted atomic busy-check race. The separate fixer implemented the state distinction. The independent reviewer added missing-registration cases, which the parent executed and used to correct the remaining guidance.

Executed under the shared lock with the designated TMPDIR: `node --import tsx --test --test-concurrency=1 test/round1-reconcile-status.test.ts`. Result: eight cases, seven failures and one pass, 634 ms test runtime. Log: `/home/christian/.local/share/agent-tmp/crc-round1-reconcile.log`. This parent experiment supplements, and does not substitute for, independent breaker evidence.

## Deferred work

The user requested a checkpoint and pause on 2026-11-12, then explicitly resumed the extended goal. The three-round minimum and two consecutive clean rounds have not been reached. Round 1 does not yet count as independently closed; rounds 2 and 3 have not started. The following priorities remain approved.


Round 2 will emphasize cross-request lifecycle, concurrency, partial failures and durable audit/shutdown recovery. Round 3 will emphasize browser/operator sequences, configuration/deployment boundaries and challenges near earlier fixes. Findings may change these priorities, but cannot remove required matrix coverage or substitute old tests for new experiments. Count a clean round only after its fresh independent challenge completes; record any remaining acceptance limits explicitly.

## Checkpoint review

The HTTP fixer extracted the existing GitHub response bound into `src/http.ts` and applied it to OIDC discovery, token, JWKS and health readers. Audit reads validate row shapes before deduplication and preserve valid legacy entries. Writes preserve torn prior bytes, add the missing newline and fsync the new intent before dispatch. Focused compilation passed. A 118-test run had two failures caused by a leaking fetch mock; the fixer corrected isolation but stopped before rerunning. Parent verification must cover that correction.

The independent VM reviewer preserved nine Python cases and 31 generated TypeScript cases. Its lock acquisition timed out before execution, so that worker reported zero executed tests and withheld sign-off. Two source objections remain for parent reproduction: ambiguous unit discovery becomes a false no-service inventory row; missing GitHub registrations with uncertain service state show disabled controls but misleading deletion or no-jobs guidance. The reviewer found the original removal and retry fixes sound in source. All worker fixtures and processes were stopped.

The parent executed the reviewer's preserved cases under the shared lock. TypeScript: 27 passed, four failed. Python: eight passed, one failed. These reproduced both source objections:

| ID | Severity | Reproduction and expected behavior | Root cause | Checkpoint fix |
| --- | --- | --- | --- | --- |
| R1-V04 | Medium | Two verified units bind one instance; list reports no installed service. Require uncertainty or safe refusal | Enumeration discards discovery failure | Strict inventory discovery fails before emitting rows; capacity counting still retains every managed directory |
| R1-P02 | Low | Missing GitHub registration plus null/deactivating service disables every action but advises deletion or claims no jobs | Missing-registration guidance precedes uncertain-service classification | Report service uncertainty and refresh/inspection guidance before registration cleanup advice |

The parent made these two bounded follow-up fixes without starting a new worker or round. The review test at the discovery limit now expects inventory refusal and independently confirms the directory still consumes capacity through headroom. Removal safety and credential-retention assertions remain unchanged. Full checks passed; no fresh independent sign-off is claimed for these parent follow-ups.

Checkpoint browser verification passed all 40 assertions at 1280×800 and 320×812. It covers pending/stale controls, recovery errors, contrast, service uncertainty badges and grouping, and narrow-layout overflow. The new badge assertion initially counted an aria-hidden glyph as label text; it now checks the label after removing decorative elements. The owned preview tab was closed and the loopback fixture stopped, with its listener confirmed absent. Production typecheck passed. Test compilation found two incomplete mock casts in the new reconciliation tests; those casts were corrected before the queued full rerun.

### Final checkpoint checks

All commands used the shared heavy lock, the designated disk-backed TMPDIR and a 512 MiB Node heap limit. No live acceptance was attempted.

- `npm run typecheck`: passed.
- `npm run build:test` followed by `node --test --test-concurrency=1 dist-test/test/*.test.js`: 202 passed, zero failures, skips or cancellations. This verifies the corrected fetch mock and both parent follow-ups.
- `npm run test:vm`: 55 passed across the 18 round-one, nine independent-review and 28 original boundary cases.
- `npm run build`: server and web production builds passed.
- Shell syntax, browser-script syntax and `git diff --check`: passed.
- Synthetic browser regression: 40 assertions passed at each of 1280×800 and 320×812. This checkpoint did not repeat the earlier dark-mode or keyboard traversal checks.

The first combined run passed production typecheck, then stopped on the two test mock casts. The corrected full run exited zero. Evidence is retained locally in `crc-checkpoint-full.log`, `crc-checkpoint-full-rerun.log` and `crc-checkpoint-browser.json` under the designated TMPDIR. Earlier reproduction logs retain the four TypeScript and one Python review failures.

Remaining acceptance limits: round-one independent closure is deferred, including fresh challenge of the HTTP implementation and parent follow-ups. Rounds two and three have not started. Real systemd cache/override behavior, cross-account races, full shutdown deadlines and live Authentik/runner acceptance remain unverified. The user-accepted job-start race remains documented. All temporary services and workers are stopped. This is a verified publication checkpoint, not completion of the extended goal.

### Checkpoint publication

Topic branch: `hardening-audit-rounds`. Remote: `origin`, `https://github.com/C-Nucifora/ci-runner-console.git`. The branch's previous push is recorded in the remote-tracking reflog at 2026-11-12 08:50:15 AEST, revision `3f8c4ec`. The new signed commits use a shorter span since that push and preserve existing history.

- `30e5fc2`: bounded OIDC/health responses and audit row/append integrity, with regressions.
- `0aaa45c`: verified service discovery and retry-safe removal, with VM boundary regressions.
- `bdd6765`: service uncertainty classification, guidance and browser controls, with state and browser regressions.
- The following documentation/CI commit records this checkpoint and includes every Python boundary suite in `npm run test:vm`.

Before publication the parent fetched the intended remote and confirmed only the CI workflow, with no repository hooks. CI runs on master pushes, pull requests and manual dispatch, so valid topic pushes do not execute its jobs. GitHub nonetheless validates workflow syntax on topic pushes, as the checkpoint failure below demonstrated. No deployment is configured. No PR, merge, release or deployment is part of the checkpoint. Remote verification and final commit IDs are included in the handoff.

### Resumed workflow correction

The checkpoint push succeeded through `0c88cd9`, with a clean worktree and four verified signatures. GitHub then rejected the workflow before running any jobs: [run 43120526179](https://github.com/C-Nucifora/ci-runner-console/actions/runs/43120526179), line 17, column 15, `Unrecognized named-value: runner`, in the job-level `env` expression `runner.temp`. This corrects the earlier expectation that the branch filter would prevent any reported run.

R1-C01, medium: the checkpoint's new job-level environment used a context unavailable at that scope. Set `TMPDIR` through a step using the standard `RUNNER_TEMP` environment variable and `GITHUB_ENV` instead. Workflow validation uses actionlint 1.7.12, whose downloaded archive was verified against its published SHA-256 digest. Actionlint passed against the corrected workflow, and `git diff --check` passed. This changes only CI temporary-directory setup; no deployment, credentials, branch triggers or action pins change.

The latest user instruction resumes the unfinished rounds. Fresh independent HTTP/audit and VM/state review tasks are running with separate test-file ownership and the shared heavy-job lock. No earlier refused testing subtask is being retried.
