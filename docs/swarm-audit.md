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

## Current status

| Round | Result | Publication |
| --- | --- | --- |
| 1 | Confirmed defects fixed and reviewed; 219 Node and 69 VM tests passed | Through `ce70d9e` |
| 2 | Lifecycle, durability, shutdown and HTTP deadlines fixed and independently challenged | Through `f1f7c1e`; combined verification: 304 Node tests |
| 3 | Deployment cleanup and UI response ordering fixed and independently challenged | Through `f1f7c1e`; 79 Python tests, 140 new browser assertions and baseline checks passed |
| 4 | Audit short-read loss fixed; 313 Node and 83 Python tests passed | Included in final draft PR |

Clean-round streak: zero. Live acceptance remains separate and unperformed. The final user request ends further audit rounds; the earlier two-clean-round target is unmet and deferred.

## Host coordination

Start with two lightweight breakers. Share capacity status at `/home/christian/.local/state/agent-swarms/ci-runner-console.json`. Serialize every build/test/property/fuzz/browser job with `flock /home/christian/.local/state/agent-swarms/heavy.lock`; use `TMPDIR=/home/christian/.local/share/agent-tmp`, low compiler parallelism and one test worker. All owned listeners bind to `127.0.0.1`. Rootless Docker uses `unix:///run/user/1001/docker.sock`. Stop owned services and leave other projects' state alone.

## Publication inspection

Fetched `origin` before starting; no incoming commits beyond the local baseline. The intended remote is `https://github.com/C-Nucifora/ci-runner-console.git`. GitHub reports only the CI workflow and no repository hooks. The workflow triggers on pushes to `master`, pull requests and manual dispatch; the topic branch `hardening-audit-rounds` is excluded from push jobs. GitHub still validates workflow files on topic pushes and can report invalid workflows as failed runs. Do not claim hosted test execution from that validation alone. No reliable prior branch push timestamp was available from reflogs or public push events; use the skill's past-day fallback while preserving the five existing signed commits.

The parent published the five preserved, verified commits through `3f8c4ec` to `origin/hardening-audit-rounds` on 2026-11-12. This baseline publication is not a new clean round. No PR, merge, release or deployment was created. New round findings and fixes will be published separately after validation.

## Round 1

Status: round one integrated after independent breaker, fixer and follow-up review work. All reproduced findings have verified fixes. The final clock correction follows the independent reviewer's minimal fix and passes its unchanged regressions. Round two will challenge the final corrections alongside new lifecycle and shutdown sequences. No clean-round streak is credited yet because the follow-up reviews continued to reveal substantive defects.

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

The user requested a checkpoint and pause on 2026-11-12, then explicitly resumed the extended goal. At that checkpoint, the three-round minimum and two consecutive clean rounds had not been reached. Rounds 2 and 3 have since completed; see the current status above. The following recorded priorities guided the resumed work.


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

### Fresh VM/state follow-up

The fresh independent reviewer signed off on R1-P01/P02 within the synthetic API/reconciliation scope. Seven new state/API tests passed, including twelve rejected mutation requests before token or VM mutation calls. Test compilation passed. New VM experiments passed five cases and failed three assertions across two cases, with source unchanged from the checkpoint:

| ID | Severity | Reproduction and expected behavior | Root cause | Response |
| --- | --- | --- | --- | --- |
| R1-V05 | Medium | Inject `realpath` failure for one of two existing instances; inventory must fail and capacity must retain both | Enumeration treats failed path inspection as absence | Capacity counting retains direct instance directories; inventory and buffered instance lookup propagate path-inspection failure; create refuses uncertain discovery |
| R1-V06 | Low | Two verified service bindings must not produce successful direct status with a null unit | Direct status discards `unit_for` errors | Preserve genuine absence, reject ambiguity and inspection failures |

The parent made bounded follow-up changes and extended the capacity regression to cover create both below and at the cap. The independent source review found no substantive objection, and parent execution passed all 69 Python boundary tests plus seven state/API follow-up tests. The application does not consume direct status, but the forced-command interface exposes it.

Hosted CI succeeded on `75f5bc9`: [run 43121341319](https://github.com/C-Nucifora/ci-runner-console/actions/runs/43121341319). Installation, typecheck, Node tests, all Python VM suites and production build passed on GitHub's Ubuntu runner with Node 24. This validates the workflow correction; it does not cover subsequent uncommitted review fixes.

The next independent discovery reviewer found no substantive source defect in R1-V05/V06 or their callers. It added seven cases covering every lookup caller, early/late inspection failures, redirected/legacy paths, symlinks, invalid directory names, cap boundaries, status absence/stale hints, second-inspection failures and unrelated ambiguity. Both of its lock waits expired before execution; zero tests ran in that worker. Parent execution subsequently passed all seven preserved cases as part of the complete 69-test VM run. No additional production change was requested.

### Fresh HTTP/audit follow-up

The independent review passed seven new probes for decoded gzip limits, bodyless responses, caller aborts, reader cleanup, HTTP-error rejection/redaction, split UTF-8 audit rows and fsync ordering. It reproduced R1-A04, medium: a 250 ms backward wall-clock adjustment writes a negative duration in either outcome branch; strict reader validation hides that outcome and displays the pending intent instead. Both subcases failed, with TAP totals of seven passes and three failures including their parent group.

The parent clamps elapsed durations to zero in both branches. Reader validation remains strict. The review's successful/failing operation regressions remain unchanged; combined verification is pending. No other substantive HTTP/audit objection emerged. The reviewer's separate compilation attempts expired waiting for the shared lock, so they are not counted as executed checks.

VM follow-up verification exited zero under the shared lock: shell syntax, all five Python boundary suites with 69 total tests, and seven state/API follow-up tests. Evidence: `crc-round1-vm-followup-fixed.log` in the designated TMPDIR. Signed commit `a5f6391` preserves the VM changes and independent regressions and was pushed with its remote hash verified. The audit-duration correction is signed commit `ed8b1aa`.

### Round-one integration result

Final combined verification passed: 219 Node tests with zero failures, cancellations or skips; production typecheck; test compilation; server and web production builds. The separate complete VM run passed 69 Python tests and seven state/API follow-up tests. The independent HTTP review's two backward-clock regressions now preserve success/failure outcomes with nonnegative durations. Full log: `crc-round1-integration-final.log` under the designated TMPDIR. No further browser run was needed for these audit/controller-only follow-ups; the latest frontend revision retains its 40 passing assertions at both desktop and mobile widths.

Independent scope: the state/API review signed off; the discovery follow-up found no substantive source issue and its seven preserved cases passed under parent execution; the HTTP/audit review found only the clock-duration defect, corrected exactly as requested and verified without relaxing reader validation. Some direct lookup error text still says "no such runner" after inspection failure, but returns failure and is never interpreted as authoritative absence by callers. This is recorded as a diagnostic limitation, not a destructive-cleanup exception.

No known reproduced defect from round one remains unresolved. The accepted busy-job race and unavailable live acceptance remain explicit limits. Fresh challenge of the final corrections is carried into round two; the required three-round minimum and two-round clean streak are not yet met.

## Round 2

Status: starting after publication of round-one fixes. Two independent breakers will own separate regression files. One will challenge lifecycle interleavings, duplicate/cap races, cancellation and partial recovery. The other will challenge process shutdown, durable intent/outcome ordering and resource limits, including the clock-duration correction. Both must identify new bounded sequences beyond the existing suites and preserve earlier findings, fixes and acceptance limits in their review. Source reads remain lightweight; executable checks are batched under the shared lock.

### Round-two lifecycle triage

The independent lifecycle breaker compiled its focused test and ran 21 new cases in one lock acquisition: 20 passed, one failed. Successful probes cover delayed overlap rejection, post-token capacity disagreement, changing duplicate identities, GitHub outages at six removal phases, lost deletion acknowledgement, revocation/cancellation and uncertain-service recovery. Evidence: `crc-round2-lifecycle.log` under the designated TMPDIR.

R2-L01, medium: moving the wall clock backward one hour during create confirmation extends its 60-second polling deadline and holds the global mutation slot. The bounded regression reached 63 synthetic seconds and 22 reads before its guard stopped the broken loop. VM creation remains recoverable and its response still identifies completed local work. The parent changes deadline/expiry/sleep calculations to `performance.now()`, retaining wall-clock timestamps for audit history. The existing offline-deadline test now advances the monotonic clock; the new regression also covers a forward correction and requires the full intended polling budget. Focused verification and independent review remain pending.

Hosted CI passed for the complete round-one publication `ce70d9e`: [run 43126311389](https://github.com/C-Nucifora/ci-runner-console/actions/runs/43126311389).

### Round-two audit/shutdown triage

The independent breaker added `test/round2-process-audit.test.ts`. Initial strict compilation passed; its 20-test run had 18 passes and two directory-durability failures. Refining the disconnect client to an unpooled HTTP connection exposed two additional failures that the pooled client masked. Both refined cases compiled and failed as intended. Logs are `crc-round2-process-audit-ce70d9e.log` and `crc-round2-process-disconnect-ce70d9e.log` in the designated TMPDIR. All fixtures were cleaned up.

| ID | Severity | Reproduction and expected behavior | Root cause | Response |
| --- | --- | --- | --- | --- |
| R2-A01 | Medium | New audit file/ancestor directories dispatch after file fsync without required directory fsync; persist directory entries first | Only file contents are synchronized | Separate fixer assigned directory durability and failure/retry coverage |
| R2-P01 | Medium | Unpooled client disconnects during mutation or outcome write; child outlives a shortened 150 ms deadline by more than 750 ms | HTTP close resolves before detached work and clears the watchdog/handlers | Separate fixer assigned retaining the unreferenced watchdog until process exit |

Sixteen unchanged probes passed for initial storage recovery, descriptor cleanup, backlog pressure in both outcome branches, backward ISO timestamps, repeated signals, forced deadlines, SIGKILL, torn outcomes and restart recovery. Directory ordering proves missing synchronization, not actual host power-loss data loss. Shortened fixture timers do not certify the full production or native systemd deadlines. No live acceptance was performed.

### Independent lifecycle timing review

Fresh source review found no new substantive defect in R2-L01. All deadline calculations use the monotonic clock, and the regressions keep session expiry separate from confirmation timing. The reviewer added seven probes in `test/round2-lifecycle-review.test.ts`: a slow inventory read leaves a 1,250 ms final sleep with online/offline/absent outcomes; revocation and disconnect during reads or sleeps preserve completed creation and release the mutation slot. These probes have not yet been compiled or executed. Scoped whitespace review passed.

The 60-second confirmation budget is a polling deadline, not a hard response deadline. An in-flight bounded inventory read can finish after it expires; cancellation is checked after reads and sleeps. That behavior predates the timing fix and remains an explicit limit. Parent execution and combined round-two review are pending.

Lifecycle focused verification passed after acquiring the shared lock: strict compilation of `test/round2-lifecycle.test.ts` and `test/lifecycle.test.ts`, followed by 47 tests with zero failures, cancellations or skips in 5.18 seconds. This includes both backward and forward clock corrections, the original offline-deadline case and the breaker state sequences. Evidence: `crc-round2-lifecycle-fixed.log` under the designated TMPDIR. The seven fresh review probes were added after that command was queued and remain pending in the combined batch.

### Audit and shutdown implementation

The separate fixer syncs audit file contents, the containing directory and uncached ancestors before dispatch. Initial failures retry the complete ancestor chain; file and directory descriptors close on errors. After initialization, appends still sync the containing directory to cover audit-file recreation. The shutdown handler keeps its unreferenced watchdog and signal handlers after HTTP closure, since disconnected work may still be active. Normal exit remains possible when no referenced work remains. Existing fsync failure mocks now distinguish files from directories, retaining their original intent-file assertions.

Focused strict compilation and 115 tests passed, including directory sync/close failure, same-writer/reopened recovery, cached readiness, repeated writes, disconnected requests, restart evidence, forced deadlines and normal shutdown. Whitespace checks passed. Evidence: `crc-round2-fixer-check.log` under the designated TMPDIR. Full integration, the seven lifecycle review probes and fresh independent audit/shutdown review remain pending. Actual power loss and the full production watchdog duration were not exercised.

### Fresh audit and shutdown review

Independent source review supports R2-A01 and R2-P01 with no new substantive finding. Directory error cleanup, full-chain retry and cached ancestor handling remain correct in the reviewed diff; the shutdown watchdog and handlers survive HTTP closure. Round-one audit protections remain intact. The reviewer added eight probes across `test/round2-audit-review.test.ts` and `test/round2-shutdown-review.test.ts` for blocked directory sync, directory-open failure, descriptor cleanup, ancestor retry, repeated signals after HTTP closure, natural drain and deadline expiry.

The reviewer waited 45 seconds for the shared lock, then exited 75 without compiling or running tests. Whitespace checks passed. The parent's full serial integration batch remains queued and will include these new files along with the seven lifecycle review probes. No executable signoff or clean-round credit is claimed before those results. Evidence: `crc-round2-independent-review.log` under the designated TMPDIR.

### Integration fixture correction

The full round-two batch passed production/test compilation and ran 292 Node tests: 290 passed and two failed before opening SSH fixtures. Both failures were `Cannot parse privateKey: Malformed OpenSSH private key` from `new ssh2.Server`, while consuming keys generated immediately beforehand. The dependency's Ed25519 generator strips every leading zero byte from the DER public bit string; its parser correctly requires a 32-byte Ed25519 public key. Thus a randomly generated leading-zero key breaks setup. The application does not generate these keys.

R2-T01, low: generated fixture keys intermittently invalidate SSH integration/process checks. The parent switches those synthetic generated keys to ECDSA P-256, whose uncompressed public point starts with the required nonzero format byte. No transport, host-key mismatch, token, failure/retry, shutdown or lifecycle assertion is removed or relaxed. Existing configuration coverage still uses Node-generated Ed25519 public keys. A bounded generator probe and full rerun are pending. The build was not reached because the test command failed. All fifteen new independent review probes passed in this first integration run. Evidence: `crc-round2-integration.log` under the designated TMPDIR.

### Round-three preparation during resource wait

While the round-two rerun waits for the shared test slot, independent lightweight preparation covers deployment inputs and browser/operator state sequences. Draft files use a `.pending` suffix so they are neither compiled nor executed by round-two checks. This preparation does not count as a completed audit round.

The deployment reviewer prepared six test methods with 22 scenarios. The parent inspected the strict fake PATH, SSH argument allowlist, discarded remote installation heredoc and live-e2e refusal environment. The probes never forward a command to a real remote shell; they check sequencing rather than deployed package contents. The parent removed an unnecessary HOME override from the fixture. One source hypothesis remains unconfirmed: nonzero SSH staging output may reach cleanup before validation. It will be reproduced or disproved after round-two publication. No deployment or live acceptance is authorized by these probes.

The operator reviewer prepared eight separately selectable probes in `test/round3-browser-regression.js.pending`. They challenge out-of-order inventory success/error/refusal, late log selection/dismissal, log refusal retry, create network failure/retry and mutation refusal. The parent reviewed their fetch allowlist, loopback/original-fixture checks, response gates and cleanup. Each probe requires a fresh fixture reload; setup errors are reported separately from failed behavior assertions. Two source hypotheses concern unsequenced inventory and log completions. Neither is confirmed before browser execution. The draft does not establish 401 navigation or native keyboard coverage.

The generator probe deterministically supplied a 32-byte Ed25519 DER public value beginning with zero, observed a 31-byte SSH value and the expected private-key parse refusal. All 128 generated ECDSA pairs parsed as public and private keys. The full rerun no longer failed SSH setup, but the existing OIDC stalled-body deadline regression exceeded its ten-second parent watchdog during discovery. This is a new unresolved integration failure; no fixture or production cause is assigned yet. Independent timeout/cleanup reproduction is required before publication. The production build again was not reached. Evidence: `crc-round2-integration-rerun.log`.

The timeout rerun totals were 286 passes, four failures and two cancellations. Later deadline subtests report `parentAlreadyFinished` after the discovery stalled-body case; they are not separate root causes. All work is preserved while one independent worker isolates native-fetch signal lifetime, deadline and cleanup behavior on Node 22.22.1. No production timeout change or weakened assertion has been made.

### Reviewed local commits while timeout investigation continues

The parent fetched `origin` and rechecked the branch's last push at 2026-11-12 10:18:03 AEST, still `ce70d9e`. A subsequent read-only GitHub repository-events query returned no matching topic-branch push, so the remote-tracking reflog remains the timestamp evidence. Three local commits preserve independently reviewed changes whose affected checks passed in the integration runs:

- `ee22f9f`: monotonic confirmation deadline and lifecycle/interleaving review regressions.
- `0a7da1b`: directory durability, disconnected shutdown protection and independent fault probes.
- `c238bfb`: valid generated SSH fixture keys, preserving transport assertions.

All three use configured SSH signing; signatures were verified with a temporary allowed-signers file. Messages follow the lowercase eight-word rule, with chronological timestamps between 11:16:41 and 11:31:06 AEST. They remain local. Push is withheld pending the unresolved OIDC deadline and a passing full batch. Draft round-three probes and this ledger remain outside those commits.

## Round 3

The parent allows independent execution to overlap the unresolved round-two HTTP investigation. Deployment and frontend source are unchanged by round-two fixes; this avoids leaving reviewed probes idle behind an unrelated failure. Round-two publication still requires a green integration batch. The earlier publication-before-execution plan is superseded; no round is counted complete early.

The parent reviewed and activated both independent drafts. A single shared-lock batch runs the six deployment test methods, checks browser JavaScript syntax, then starts the existing frontend-only fixture with an ephemeral explicit loopback port. A five-minute process timeout bounds the browser fixture lifetime after lock acquisition. The deployment probes use strict fake executables and never execute remote installation text or read credentials. Browser checks use fresh fixture reloads and synthetic fetch responses. Existing host listeners were inspected and remain untouched. Results and hypotheses will be triaged separately from harness failures.

### Confirmed timeout defect

R2-H01, medium: the independent worker reproduced a native-fetch abort-propagation failure under bounded forced GC on Node 22.22.1. Undici finalized its internal request controller and removed the source-signal listener while `boundedFetch` awaited its body. A strongly retained timeout still fired, but reading remained pending until the owned fixture closed. The no-GC control passed and the GC regression failed. This proves a production-path defect; the earlier uninstrumented integration occurrence cannot be attributed retrospectively with certainty.

The worker's scratch candidate passed all 40 selected checks, including response bounds, redirects, caller aborts, cleanup and claims. Parent integration applies the suggested five-line fix: directly cancel the reader on abort, throw the signal reason after reads and remove the listener during cleanup. Independent challenge and full integration remain required. Evidence: `crc-http-timeout-probe/findings.md`, the failing regression and candidate logs under the designated TMPDIR.

### Round-three reproductions and triage

The deployment suite executed six test methods in 5.21 seconds. Five methods passed; two subcases in the sixth failed, covering 22 total scenarios. The browser ran eight probes at each of 1280×800 and 320×812: 58 assertions passed and 14 failed, with zero harness errors or unexpected application fetches. All three recovery-only probes passed at both widths. The fixture bound only `127.0.0.1:5173`; T3 accessed it through its localhost tunnel. The parent allowed that verified loopback tunnel name in the probe guard. The owned tab closed, fixture PID 1482503 received SIGTERM, its session exited 143, and the listener was confirmed absent.

| ID | Severity | Reproduction and expected behavior | Root cause | Response |
| --- | --- | --- | --- | --- |
| R3-D01 | High | Failed SSH staging returns an arbitrary path or shell metacharacters; cleanup must never use unvalidated stdout | `set -e` invokes EXIT before the later validation, while the trap accepts any nonempty stage | Parent restricts cleanup to the exact staging-path allowlist; regression and independent challenge pending |
| R3-U01 | Medium | Resolve newer inventory or refusal before older success/error; latest state and controls must remain authoritative | Every refresh completion writes state without request ordering | Separate UI fixer assigned |
| R3-U02 | Low | Resolve older log selection after a newer selection or dismissal; preserve selected logs and keep dismissed dialog closed | Log completions ignore later selections and dismissal | Separate UI fixer assigned |

The deployment fixture captured the constructed cleanup commands but never executed them. UI failures do not demonstrate an API authorization bypass; server-side guards remain required. Browser results are saved in `crc-round3-browser-before.json`; shell results in `crc-round3-deployment-before.log`. The shared design router is unavailable, so the UI work is limited to behavior within the existing interface. No new branding or layout decision is needed.

### Round-two and round-three integration review

The independent HTTP/deployment reviewer found no new substantive source defect. Ten new HTTP probes challenge abort ordering, rejected cancellation, listener cleanup and combined signals under GC. Four deployment methods cover thirty strict-fake scenarios near the staging allowlist and failure paths. The reviewer's shared-lock wait expired before execution; the parent includes both files in the next combined serial batch. Source signoff alone does not close these findings.

The UI fixer restricts inventory and log completions to the latest request generation. Cleanup and dialog dismissal invalidate pending requests. Mutation controls wait for a newer pending reconciliation refresh before becoming available. It changed only the two components; original browser assertions remain unchanged. Focused whitespace review passed, but the worker could not acquire the test lock. Fresh independent review is preparing nearby mutation, log-error and navigation probes.

The parent rechecked the intended origin, configured signing and last topic push at 10:18:03 AEST. Fetch showed no incoming master commits beyond the current branch. GitHub still reports only the CI workflow and zero hooks. Existing public host listeners are unchanged; no test service is running. One combined lock acquisition is queued for production/test compilation, serial Node/Python suites, build and syntax checks. While it waits, a second lightweight worker prepares inactive round-four boundary probes; preparation does not count as execution or a clean round.

### Round-two and round-three verified completion

The combined batch passed production/frontend typecheck, test compilation, all 304 Node tests, all 79 Python boundary tests, production build and shell/browser syntax checks. Zero Node failures, cancellations or skips. This includes the unchanged GC timeout regression, ten independent abort probes, fifteen independent lifecycle/audit/shutdown probes and both deployment suites. Evidence: `crc-round23-integration.log` under the designated TMPDIR. R2-L01, R2-A01, R2-P01, R2-T01, R2-H01 and R3-D01 are closed within their synthetic scope.

Fresh independent UI source review found no new substantive defect and added seven nearby probes. Parent browser execution passed all eight original round-three probes and all seven review probes at 1280×800 and 320×812: 140 assertions, zero failures, zero harness errors and no unexpected application fetches. The unchanged baseline suite passed all 40 assertions at each width and again in 320px dark mode. Native Escape closed log/create dialogs and restored focus. The session-expiry probe navigated an owned iframe to the loopback login refusal endpoint with `/settings` retained; successful synthetic logout reached `/__signed-out`. These do not certify real Authentik logout/sign-in.

The keyboard traversal reached both create fields and Cancel. Native browser focus briefly reported the document body when leaving the last enabled modal control, then returned to the first field; no claim of complete keyboard or assistive-technology certification is made. Both native Escape checks passed. Evidence: `crc-round3-browser-after.json`. Initial browser automation attempts rejected trailing whitespace in injected JavaScript, and an initial baseline invocation returned an unresolved promise; neither was counted. Corrected tool invocation returned every assertion above. No application or test assertion was changed.

R3-U01 and R3-U02 are closed within the verified browser scope. Owned preview tab closed, fixture PID 1519147 stopped, session exited 143 and port 5173 was confirmed absent. The batch released heavy.lock; future unrelated suites will release and reacquire it separately following cross-project coordination.

Rounds two and three are complete with findings and verified fixes. They do not establish a clean-round streak. At least three meaningful new rounds have now run, but two consecutive independent clean rounds remain required. Round-four preparation has only inactive probes so far. Live/native acceptance limits and the accepted non-atomic job-start race remain unchanged.

Verified implementation batches are `ee22f9f` for monotonic confirmation, `0a7da1b` for audit/shutdown durability, `c238bfb` for generated fixture keys, `7f619d6` for HTTP reader aborts, `18b462a` for staging cleanup and `235cb32` for UI response ordering. The parent is publishing these reviewed signed commits with this ledger to `origin/hardening-audit-rounds`. The topic branch has no deployment trigger. No PR, merge, release or deployment is requested or performed.

## Round 4

Two independent breakers prepared new boundary and recovery probes while earlier checks queued. After round-three verification, the parent inspected their strict fakes, finite case counts, temporary-state cleanup and no-network setup, then activated them. The boundary probes cover failed-login replay/recovery, nine signed group lookalikes, malformed-to-valid replies across eight VM operations, wrapper framing, configuration permissions, hardlinked marker cleanup and literal log-count limits. Recovery probes cover short file reads, interleaved operation histories/redaction and mixed inventory outages/recovery in both input orders. The short-read issue is a source hypothesis, not a confirmed finding before execution. Each bounded suite will release heavy.lock separately. No clean-round credit yet.

### Final bounded handoff

The 2026-11-13 final instruction supersedes continued rounds. No new workers or audit rounds were started. The existing workers had finished and their probe files were collected. The old shell processes were absent after the server restart. The original Node attempt failed compilation because a test passed `undefined` to an assertion overload; replacing it with `Error` retains the rejection assertion. The previous VM attempt completed all four probes successfully.

| ID | Severity | Reproduction and root cause | Fix | Verification |
| --- | --- | --- | --- | --- |
| R4-A01 | Medium | Both existing short-read probes returned no audit entries despite complete outcomes on disk. A single FileHandle.read was treated as the entire tail. | Continue positional reads until the original one-MiB buffer is filled or EOF returns zero; preserve complete-line parsing, redaction, order and deduplication. | Before fix: six Node probes passed, two failed. Added an EOF termination regression; final suite results follow. |

The owner reviewed the three pending probe files and the final reader change. Earlier independent review remains documented above; no fresh independent signoff is claimed for R4-A01. Tests use synthetic state and strict fakes. No live acceptance or browser rerun is included in this final batch. Historical desktop/mobile results remain valid only for their recorded scope.

Last-push evidence is the remote-tracking reflog at 2026-11-12 12:03:01 AEST, `f1f7c1e`. GitHub public push events returned no matching record. New signed commits use a short interval near final verification, within the period since that push. The existing neutral branch is `hardening-audit-rounds`; the PR base is `master` at `247135a5b6dbd224b5a840a53fedb6dd09a118b2`. Workflow inspection found verification only on pull requests and master pushes, with read-only contents permission and no deployment trigger. No protections are disabled.

The PR remains draft. Acceptance needs an approved deployment target, real Authentik provider/group/proxy configuration, pinned runner-VM access, and a disposable GitHub runner/job target. The VPS cannot reach home machines. Effective deployed confinement, full production shutdown deadlines, power-loss durability and complete assistive-technology acceptance remain unverified. The accepted non-atomic busy-job race remains documented in hardening-audit.md. No live infrastructure was changed.

Final verification on 2026-11-13 passed test compilation, all 313 Node tests with one worker, all 83 Python tests, server/frontend typechecks, production build and `git diff --check`. There is no configured lint command. Separate bounded jobs acquired and released the shared lock. Evidence under `/home/christian/.local/share/agent-tmp`: `crc-final-probes-before.log`, `crc-final-node.log`, `crc-final-vm.log` and `crc-final-build.log`. The before-fix log retains both failures; the original compiler failure remains in `crc-round4-node-before.log`. No tests were weakened or skipped. No temporary service was started during final verification, and no old owned test/service process remained. The final change has owner review and passing regressions, but no new independent reviewer.

The user requested publication and then pause. Further audit rounds and live acceptance are not scheduled. The website and dashboard work streams are outside this repository and were left to their owners.
