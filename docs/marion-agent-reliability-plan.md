# Marion Agent Reliability Plan

Status: **plan only, nothing implemented.** Written 2026-11-27 on branch `docs/reliability-plan` (off `main` @ `83630e8`).
Sources: `.worktrees/rock-solid-batch/docs/RELIABILITY-PLAN.md` (read-only, uncommitted) plus a re-check of `main` @ `83630e8`.
Line numbers are from `main` unless stated otherwise. **(proposed)** means it does not exist yet.
Revision 2 (2026-11-27; committed on `feat/rock-solid-batch` in `a68d563`): Jensen's QA revisions applied to the draft committed in `49467c9` (§§1.3–1.4, 3.1–3.6, 4.2a, 4.4, 5, 6.1, 7). The RC stays separate and unsigned.
Revision 3 (2026-11-27; committed on `feat/rock-solid-batch` in `a68d563`): Jensen's §8 QA revisions (§§3.1–3.2, 3.4, 4.2a, 8.3.5, 8.4, 8.5, 8.7). All §8 causes stay unverified.
Revision 3, gate 6 alignment (2026-11-27, committed with the RC on `feat/rock-solid-batch` after Jensen's HOLD on `5ee8688`): the account-mismatch row (§3.1 `account_mismatch`, §3.2 blocker, §8.3.3 H-P7), the narrowed sign-in classifier shared by the sign-in card and `downstreamClass` (§1.3 gate 2), agy's unknown-model wording as a runner-settings failure with one launch (§3.5), and reconciled grant pass/fail rules (§8.7 gates 2 and 8). `docs/RELIABILITY-PLAN.md` is a separate, untracked draft and is unchanged.

## 0. Ownership

| Owner | Responsibilities |
|---|---|
| **Kanye** | Fix inventory, implementation, release coordination (candidate fingerprint, merge/ship requests). |
| **Jensen Huang (QA)** | QA priorities, acceptance tests and pass criteria, **independent sign-off**. |

Rule: nothing merges or ships without Jensen's independent QA sign-off **and** the required owner approval. Pending or declined approvals are never bypassed.

---

## 1. Current Release Candidate: `feat/rock-solid-batch`

- Worktree: `.worktrees/rock-solid-batch`. Base `6a077616` ("Cloud trust follow-ups, unlimited concurrency, Gemini effort tests"). HEAD = base; all candidate changes are **uncommitted** (20 modified + 16 untracked at the time of writing, including the excluded items below).
- `main` has moved to `83630e8` (sidebar star polish: `Sidebar.tsx`, `shell.css`, sidebar tests). That commit touches no candidate files, but the candidate has to be rebased or merged onto it before shipping, and QA must re-run on the result.

### 1.1 Included scope

| Item | Files (in the candidate worktree) |
|---|---|
| Compact roster (`list_team`) | `server/src/agent/tools.ts` (`list_team` ~790), `server/src/agent/prompt.ts`, `tests/team-roster.mjs`, `tests/prompt-team.mjs` |
| Tasks fixes | `server/src/agent/task-tools.ts` (new), `web/src/components/config/TasksView.tsx`, `web/src/lib/eventStream.ts` (new), `web/src/lib/events.ts`, `web/src/configStore.ts`; tests `tests/task-tools.mjs`, `tests/tasks-reconnect.mjs` |
| Dictation fixes | `server/src/lib/dictationErrors.ts` (new), `server/src/voice.ts`, `web/src/voice/{dictation.ts,composerDictation.tsx,api.ts,dictationRetry.ts (new)}`; tests `tests/dictation-errors.mjs`, `tests/dictation-retry.mjs` |
| **Regression fix 1**: hide Retry when `retryable: false` | `web/src/voice/dictationRetry.ts` (`retryActions` → `retry: kept && retry.retryable === true`), `web/src/components/Composer.tsx:472` (`retryActions(retryHere, …)`) |
| Gemini flags | `server/src/agent/subscriptions.ts` (`GEMINI_SETTINGS_KEYS`, `geminiSettingsJson`, `googleSettings`); `tests/gemini-settings.mjs` |
| **Regression fix 2**: tightened `GoogleSignInRequired` matcher | `server/src/agent/sign-in.ts` (Rev 3: `GOOGLE_SIGN_IN`, `ACCOUNT_MISMATCH`, `PROXY_AUTH`, `isGoogleSignInFailure`, `isSignInFailure`; re-exported from `subscriptions.ts`, thrown in `spawnSubscriptionReply`); `runner-settings.ts` `downstreamClass`; `tests/gemini-sign-in.mjs` |

Other modified files in the tree (`db.ts`, `store.ts`, `types.ts`, `features/{coordination,templates,universal-skills}.ts`, `styles/team.css`, `tests/github-access.mjs`) must each be traced to one of the items above before the fingerprint is taken. Anything that can't be traced is out of scope.

### 1.2 Explicitly excluded (kept untouched / deferred)

| Item | Where it lives | Handling |
|---|---|---|
| Stale-row recovery (`recoverOrphanRows`, `pendingRowSeqs`, `finalizeRunningRow`, standalone `recoverStaleRows()` startup call) | `/tmp/claude-501/deferred-patches/stale-row-recovery/stale-row-recovery.patch` (21,635 bytes, sha256 `1caf2423…23bb9`; touches `loop.ts`, `agent-sessions.ts`, `index.ts`, `tests/stale-rows-recovery.mjs`). **Volatile storage** (see §6.1.1) | Separate follow-up (§5). Never folded into the RC |
| Marion Life sync draft | `.life-sync-draft/marion-life-sync-draft.patch` (not applied) | Deferred; needs Barry + owner approval |
| Planning docs | `docs/RELIABILITY-PLAN.md` (candidate tree, untracked), this document (`docs/reliability-plan` branch) | Not part of the candidate |
| `undefined`, `undefined-shm`, `undefined-wal` | Untracked SQLite files in `main` and the candidate tree | **Do not delete** and do not commit. Owner decides later |

### 1.3 Candidate QA gates (all required; owner: Jensen)

The RC stays **separate from this plan and unsigned**. Nothing in §§2–5 is part of it, and none of these gates may be waived, merged into another, or substituted.

1. **Fingerprint:** the exact commit SHA, or the staged tree hash (`git write-tree`) plus base SHA. Every result below is tied to that fingerprint. Any change to the tree invalidates prior results. Current pre-staging evidence is in §1.4.
2. **Both regression fixes verified:**
   - Fix 1: an error with `retryable: false` shows Discard only (no Retry) in the Composer; `retryable: true` still shows Retry.
   - Fix 2: real sign-in diagnostics raise `GoogleSignInRequired`; unrelated Gemini errors that only mention "Google" or "login" do not.
     Rev 3 classifier rules (`server/src/agent/sign-in.ts`, shared by the Gemini sign-in card and `downstreamClass` in `runner-settings.ts`, so the two never disagree; `tests/gemini-sign-in.mjs`):

     | Diagnostic | Sign-in card (`GoogleSignInRequired`) | `downstreamClass` |
     |---|---|---|
     | Genuine Google/agy sign-in ("not authenticated", "please sign in with Google", `agy acp --login`, OAuth token expired, `invalid_grant`) | Yes, exactly one card | `auth` |
     | agy: "signed in to Gemini Enterprise, but couldn't load the saved credentials" | Yes, exactly one card | `auth` |
     | **Account mismatch:** "Wrong Google account: please log in with …", "Account mismatch: not authenticated as …" | **No** (signed in, to the wrong account; §3.1 `account_mismatch`) | not `auth` |
     | Proxy authentication: HTTP 407, "Proxy Authentication Required", "Proxy returned 407. Login required." | No | not `auth` |
     | "log in to file …", `/tmp/--login`, unknown option `--login`, `bash --login` | No | not `auth` |
     | Claude/Codex sign-in wording ("Sign in to Claude Code", `codex login`, Unauthorized, token expired) | n/a (not Gemini) | `auth` |

     Pass: every row behaves as listed. Fail: any account-mismatch, 407 or `--login`/log-file look-alike produces a sign-in card or `auth`, or the Enterprise saved-credentials string does not.
3. **All 11 previously blocked suites** run in an environment that is **authorized for writable files and local listeners**, each passing with its exit code captured. The nine green targeted suites (`logs-cand2/`: dictation-errors, dictation-retry, gemini-settings, github-access, prompt-team, task-tools, tasks-reconnect, team-roster, universal-skills) **do not substitute** for these, and Gate 3 is not removed. The 11 (from `.audit-rock-solid/QA-REPORT-resume.md`):
   - `listen EPERM` (9): `dictation-delete`, `dictation-leave`, `drafts-keep`, `features`, `live-dictation`, `local-offline`, `shot`, `sidebar-drop-live`, `ui-sweep`.
   - Exit 13, listen never settles (2): `chat-controls`, `settings-audio`.
   - The "7 listener suites" split is **not recorded** in any artifact found (§1.4). Whoever reported it must name the 7 before this gate can be checked off.
   - The environment check must record the **actual** writable/listener flags in effect (not assumed), and the run must show each suite's server actually bound.
4. `npm run typecheck` and `npm run build` exit 0.
5. **Authenticated real Gemini:** record the actual flags passed to the CLI, and show **one** successful request launch (launch count `=== 1`). "Eventually succeeded" after a retry or relaunch does not pass.
6. All exit codes and logs are saved as artifacts tied to the fingerprint.
7. **No merge or shipment** without Jensen's independent sign-off and the required owner approval. Pending or declined approvals are never bypassed.

### 1.4 RC evidence (read-only, verified 2026-11-27 ~09:20)

- **Blocked-run transcript.** No transcript or command list for the 11 blocked suites is committed anywhere in the repo or worktrees. What exists:
  - Names and reasons: `.audit-rock-solid/QA-REPORT-resume.md` (91-suite run: 68 exit 0, 7 skipped, 16 non-zero, 11 of them "not run").
  - Runner command: `.audit-rock-solid/probes/run-suite.sh` (`cd <root> && perl -e 'alarm shift; exec @ARGV' 180 node --import tsx tests/<t>`). The `suite-cand2/` logs and `suite-cand2.txt` named in `.audit-rock-solid/README.md` are **missing**.
  - Per-suite logs in volatile storage only: `/tmp/claude-501/suite-logs/suite-<name>.mjs.log` (00:47, run against `.worktrees/rock-solid-batch`). Eight show `listen EPERM … 127.0.0.1:8818`; `chat-controls`/`settings-audio` show an unsettled `listen(0, '127.0.0.1')`; **`sidebar-drop-live` has no log there**.
- **Stale-row hunks by snapshot** (`tracked_diff_sha` = SHA-256 of the tracked diff vs `6a07761`):

  | Snapshot | `tracked_diff_sha` | Stale-row hunks |
  |---|---|---|
  | `fingerprint-before.txt` (00:35) | `c6a152b6…` | **Absent** (20 M; per audit README the three files were first edited at 00:37) |
  | snapshot 2/3, audited `cand2` (00:37–00:44) | `349e8d73…` | **Present** (23 M incl. `loop.ts`, `agent-sessions.ts`, `index.ts`; untracked `tests/stale-rows-recovery.mjs`). The 8/8 stale-row pass was on this copy |
  | `fingerprint-after.txt` (00:46) | `9af9b8b4…` | Present (23 M, 17 untracked); added regression fixes 1–2 |
  | Tree at ~09:20 | `git diff HEAD \| shasum -a 256` = `f12dc0df4fbc12b5dbfd8b2ff36be7e836f605226a4fd7e303c10f477dc51447` | **Absent** |
| **Tree at 09:24:50** (latest reading) | `e895a1e40fbd8cb6088f8a5f66924a328fefe57c2f4092fee320350bc06d9b44` | **Absent**. Changed by another session during this review: `server/src/agent/subscriptions.ts` (09:23:39) and `tests/gemini-sign-in.mjs`. **The RC tree is still being edited, so there is no stable fingerprint yet** |

  So cand2 audit results (and anything at `349e8d73`/`9af9b8b4`) **included** the stale-row hunks and do not apply to the current RC. Prior hashes were computed by an earlier session; the method is assumed equivalent but not proven.
- **Exclusion evidence for the current tree:** HEAD `6a07761` (`feat/rock-solid-batch`), 20 modified + 16 untracked. `loop.ts`, `agent-sessions.ts`, `index.ts` are unmodified vs HEAD (reverted at 09:15:35); the tracked diff has 0 matches for `recoverOrphanRows|pendingRowSeqs|finalizeRunningRow`; `tests/stale-rows-recovery.mjs` is absent; the deferred patch passes `git apply --check` forward (i.e. not applied). Untracked manifest (`git ls-files --others --exclude-standard | shasum -a 256` per file, then hashed) = `7519240b84308210444f59fe3902eeb991f2707cc93143ba2a631c0db4287bda` at 09:24:50 (16 files; it was `f7bf76be…c405` at ~09:20). Excluding `docs/RELIABILITY-PLAN.md`, `.life-sync-draft/marion-life-sync-draft.patch` and `undefined*`, it is `f216e0fe1721a73146c0f5f8ce3fa8abbd0554ac9b9f8e2f95239f20c5f932f0` (11 files). Changes since 00:46: `tests/dictation-retry.mjs` and `web/src/voice/dictationRetry.ts` changed hash; `tests/gemini-sign-in.mjs` added. This plan file is on a different branch and is not in the RC tree.
- **This is not the approved fingerprint.** No commit or `git write-tree` exists for the RC; Gate 1 is still open.

---

## 2. P0: Preserve work and approvals across interruption

**Goal:** a Mac shutdown, runner crash, or restart never loses approved work, never runs unapproved work, and never quietly drops a pending approval.

### 2.1 Current behaviour (verified on `main`)

- `inflight_turns(id, bot_id, generation, label, started_at)` (`db.ts:111`) has no run id and no resume state. It is inserted at `loop.ts:489` and deleted in `finally` at `loop.ts:611`.
- `resumeInterruptedTurns()` (`loop.ts:675`) reads every row and then runs **`DELETE FROM inflight_turns`** (`loop.ts:677`) before anything has resumed. A crash in that window loses the record.
- `resumeAttempts` / `MAX_RESUMES = 2` (`loop.ts:660`) are in memory only, so the count resets on restart.
- **Approval supersede bug:** `loop.ts:503-507` calls `finishPending(…, 'denied-by-new-message')` for **any** non-`resume` trigger that is not a side run. That includes routines (`routines.ts:35` `runRoutine` → `{type:'routine'}`), bot messages, and `[Interrupted work]` system triggers. An automated trigger can therefore expire a user's pending approval.
- `finishPending` (`loop.ts:856`) marks the approval `expired` and the calls `denied`.
- `recoverAgentSessions()` (`agent-sessions.ts:119`) marks every `running` relayed session `stopped` and never resumes it.
- The folder lock (`agent/folder-lock.ts`) is in memory, so it is lost on restart.

### 2.2 Design (proposed)

- **Persist before acknowledging.** Before a state transition is acknowledged (to the UI, to a provider, or to the next step), write the following in the same SQLite transaction:
  - `run_id`: stable for the whole logical run, including its resumes.
  - Last durable checkpoint: last committed row seq and tool-call ids with known outcomes.
  - Launch identity: `launch_id`, provider, session id if known, and `launch_state ∈ {intent, launched, acked}`.
  - Approval state snapshot: approval id, `call_id`, tool, an args hash, and scope.
- **Schema:** add `run_id`, `resume_state` (JSON), `trigger_type`, `launch_id`, `launch_state`, `updated_at` to `inflight_turns`. Add `run_id` and `resume_state` to `agent_sessions`. Add `args_hash` and `scope` to `approvals`.
- **Keep and claim, don't delete.** `resumeInterruptedTurns()` marks rows `waiting` instead of deleting them. Rows are deleted only on completion, on a user stop, or when attempts run out (status `needs_attention`). The attempt count moves into `resume_state.attempts`.
- **Approval rules on resume:**
  - A pending approval stays `pending` and visible. Recovery never moves it to `expired`. Only `trigger.type === 'user'` supersedes it (fix for `loop.ts:503-507`).
  - Declined, revoked, or expired calls never launch. The `[Interrupted work]` prompt lists them as "declined, do not retry".
  - Only **explicitly approved** interrupted work is eligible to resume, and only if the persisted approval still matches the action: same tool, same `args_hash`, same scope (folder/bot/generation). On any mismatch, the call becomes a fresh approval card.
  - Each call goes through `policyFor` (`tools.ts`) again on resume.
- **Uncertain side effects:** if `launch_state = intent` or `launched` but not `acked`, or a tool call has no recorded outcome, the run goes to `needs_reconciliation`, **not** blind replay. Reconciliation checks for a live provider session or process, the outputs written, and the folder state. It then either adopts the surviving session or asks the user.
- **Sub-agents:** recovery is parent-mediated only. Child sessions are never restarted on their own.

### 2.3 Acceptance tests (owner: Jensen)

| Test | Scenario | Pass criteria |
|---|---|---|
| `approval-preserve` | Pending approval, then a routine, a bot message, an `[Interrupted work]` trigger, and a restart | `approvals.status` stays `pending`, `pending_turns` survives, and the card stays visible. A real user message still supersedes it |
| `approval-declined-resume` | Declined or revoked call, then crash, then resume | The declined call is never executed. It is listed as declined in the recovery prompt |
| `approval-scope-mismatch` | Approved call; args or folder changed before resume | No launch; a fresh approval card appears |
| `restart-resume` | Seeded rows; `resumeInterruptedTurns()` called twice | Rows kept, one claim per `run_id`, attempts survive the restart. Stale (> 6 h) and wrong-generation rows are not auto-resumed but move to a **visible** `needs_attention` card; they are never silently deleted, and any pending approval they hold stays pending |
| **Abrupt shutdown during approval prompt** (manual, real Mac) | Hard power-off while the card is shown | After boot the card is still pending; nothing ran |
| **Runner crash during launch** | Kill the runner between `intent` and `acked` | `needs_reconciliation`; no second launch until reconciled |
| **Restart during launch** | Restart the app after the provider launched, before ack | The surviving session is adopted, or the user is asked; never two sessions |

---

## 3. P0: Classify and safely recover from outages and crashes

### 3.1 Classification: `classifyFailure(error, probe)` (proposed, new `server/src/agent/failure.ts`)

| Class | Evidence | Resume condition |
|---|---|---|
| `interrupted` (Mac sleep/off, app crash, or restart; cause unknown) | Leftover `inflight_turns` at process start; a wall-clock gap; Electron `powerMonitor` suspend/resume. Leftover rows are **interruption evidence only, not proof the Mac was offline** (a crash or forced quit leaves the same rows) | Process up and preflight (§3.2) passes |
| `network` | `ENOTFOUND`/`ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN`/fetch `TypeError` | Probe stable for 30 s; backoff from 5 s to a 5 min cap |
| `provider_outage` | 5xx from the provider | Provider-only probe; bounded backoff |
| `quota_wait` | `isUsageLimitError`/`UsageLimitError` (`usage-limit.ts`), 429 with usage-limit semantics | **Separate wait state** (§3.6), never folded into 5xx or auth |
| `provider_auth` | **Confirmed sign-out only:** the provider's own auth check completed and reported signed out or an expired/ineligible subscription (`requireClaudeSubscription` with a real auth-status result; `GoogleSignInRequired` from the tightened RC matcher, §1.1) | **No auto-resume.** `blocked_auth` (§3.2) plus one notice |
| `account_mismatch` | The provider reports a **signed-in** account that is not the expected one ("Wrong Google account: please log in with …", "Account mismatch: not authenticated as …", a CLI signed in to a different account than at T0, a different workspace user id hash). Never matched as a sign-out by the sign-in classifier (§1.3 gate 2) | **No auto-resume, no sign-in prompt, no restore screen.** `blocked_account_mismatch` (§3.2) with the account named; resume only after the owner switches account and a passing auth probe reports the expected one |
| `check_failed` | The auth check itself could not complete: spawn error, 12 s timeout, non-zero exit without a signed-out result, Keychain prompt or denial, unparseable output (H-P1, §8.3.3) | **Not a sign-out.** State `check_failed` (§3.2); re-check with bounded backoff; never shows a sign-in prompt or `Review and restore access` (§8.5) |
| `runner` | Non-zero CLI exit with no network error, missing executable, settings parse error, invalid model/effort | **No auto-resume.** `needs_attention` |
| `user_stop` | `ctrl.signal.aborted` | Never resume |

Outage waits (`network`, `provider_outage`, `quota_wait`, `interrupted`) do **not** consume `MAX_RESUMES`. Today a Wi-Fi flap can burn both attempts within 9 s (`scheduleResume` delays of 3 s and 6 s, `loop.ts:663-671`).

### 3.2 Preflight: a launch **and** resume gate

Preflight runs before **every** provider launch: a fresh user turn, a routine, a bot message, and every resume. It is not only a recovery check. If any check fails, nothing launches, the reason is logged, and the run stays waiting in the state below.

| Blocker | Detection | Outcome state | User-visible next step |
|---|---|---|---|
| Missing folder access | Folder unreadable/unwritable, macOS TCC denial, folder trust not granted, `folderInUse` | `blocked_folder_access` | "Grant access to <folder>" (opens the trust/permission flow). Resume after access is re-checked |
| Existing pending approval | Pending row in `approvals`/`pending_turns` for this bot/run (re-read, never cached) | `waiting_approval` | Points at the existing card. **No new card, no launch** until the user decides |
| Existing declined/revoked approval | Persisted decision for the same tool + `args_hash` + scope | `declined` | "Declined. Not retried." Only a new user message can start new work |
| Confirmed sign-out | The CLI auth check completed and reported signed out, an expired Claude subscription, or `GoogleSignInRequired` from the tightened matcher (class `provider_auth`, §3.1) | `blocked_auth` | "Sign in to <provider>". No auto-resume; resume only after a passing auth probe |
| Account mismatch | Auth check completed: signed in, but to a different account/workspace than expected (class `account_mismatch`, §3.1). **Never mapped to `blocked_auth`** and never a sign-in card | `blocked_account_mismatch` | "<provider> is signed in as a different account. Switch to <expected> in <provider>." No sign-in prompt, no `Review and restore access`; filed as **No longer recognized** (§8.3.5); resume only after a passing probe for the expected account |
| Auth check failed | The auth check could not complete: spawn error, timeout, Keychain prompt/denial, unparseable output (class `check_failed`, §3.1). **Never mapped to `blocked_auth`** | `check_failed` | "Couldn't check <provider> sign-in, retrying". No sign-in prompt, no restore screen; re-check with bounded backoff; resume after a passing check |
| Quota / usage limit | `UsageLimitError` or provider reset/retry guidance | `quota_wait` (§3.6) | "Usage limit on <provider>, retrying at <reset time>" or "…retrying with backoff (no reset time given)" |
| Invalid runner settings | Unknown model, empty or invalid effort, settings parse error | `blocked_runner_settings` | "Fix <setting> for <runner>". **Not retried with unchanged settings** |
| Mac / network failure | No route to the required provider host | `waiting_network` | "Waiting for network". Resume after 30 s stable probe |
| Provider failure | 5xx / provider probe fails | `waiting_provider` | "Provider unavailable, retrying". Bounded backoff |
| Runner failure | Executable missing, spawn fails | `blocked_runner` | "Reinstall/repair <runner>" |

Rules:
- **One persisted status/card per unresolved blocker** per run, keyed `(run_id, blocker)`. It survives polling and restart, and is updated in place, not duplicated. It is cleared only when that blocker's check passes.
- Every check also covers: existing live runs (`activeRunCount`/`isBotBusy`, `activeProviderRuns()`, `agent_sessions.status='running'` for the same `run_id`; **reattach** a surviving session instead of launching), bot `generation` unchanged, bot not hidden.
- While any blocker is unresolved, the launch count for that run is **zero**.

### 3.3 Duplicate-launch prevention and fencing

- **Durable claim:** `UPDATE inflight_turns SET resume_state=json_set(resume_state,'$.claimed',?) WHERE run_id=? AND json_extract(resume_state,'$.claimed') IS NULL`. Zero changed rows means another trigger already holds the run.
- **Fencing token.** Each claim gets a monotonically increasing `claim_token` stored with the row. A lease can be taken over only after expiry **and** reconciliation finds no live session; takeover increments the token. **Immediately before launch**, the claimant re-checks in the same transaction that writes `launch_state='intent'` that its token is still the current one; if not, it aborts without launching. The provider launch records the token, and late acks with an old token are ignored.
- **PID plus lease expiry alone do not stop a stale worker** (for example one that was suspended during sleep and wakes after its lease expired) from launching. Only the current-token check does.
- One shared `ReachabilityMonitor` per provider host wakes all waiting runs, with jitter. Recovery triggers (wake, network restore, startup, timer, quota reset) all go through the same claim and fencing check.

### 3.4 Acceptance tests (owner: Jensen)

| Test | Scenario | Pass criteria |
|---|---|---|
| `outage-sleep` | Mac sleep mid-run, then wake | One resume after probe; surviving session reused if alive |
| `outage-network` / `wifi-flap` | `ECONNRESET`; probe toggles 5× in 20 s | Class `network`; 0 `MAX_RESUMES` used; exactly 1 resume after 30 s stable |
| `outage-provider` | (a) 503 (b) 429 / usage limit (c) confirmed sign-out (`GoogleSignInRequired` from the tightened matcher) (d) bad settings (e) auth check timeout/spawn failure | (a) `waiting_provider`, backoff (b) `quota_wait` per §3.6 (c) `blocked_auth` (d) `blocked_runner_settings`; (c, d) no auto-resume (e) `check_failed`, never `blocked_auth`, no sign-in prompt |
| `outage-runner` | Runner killed | Classified `runner`; no blind relaunch |
| `rapid-reconnect` | Network up/down/up within the debounce window | No resume until stable; ≤ 1 active session |
| `simultaneous-triggers` | Wake + network restore + startup fire together | Exactly 1 claim succeeds; ≤ 1 active session per `run_id` |
| `crash-after-launch-before-ack` | Kill between provider launch and ack | Reconcile; reuse the surviving session; no second launch |
| `preflight-blockers` | One case per §3.2 blocker, for both a fresh launch and a resume | Distinct state and next-step text per blocker; launch count `0` while blocked; exactly one card per `(run_id, blocker)` after 10 polls **and** after a restart; card cleared and one launch only once the check passes |
| `preflight-existing-approval` | Pending approval, then a routine/bot trigger and a resume | `waiting_approval`; no second card; 0 launches |
| `stale-claimant-fencing` | Claimant A takes the lease and is suspended; lease expires; B takes over (token+1) and launches; A wakes | A's pre-launch token check fails; A launches nothing; A's late ack is ignored; ≤ 1 session. (This is the *after-expiry* case, separate from racing for the initial claim) |
| `leftover-rows-not-offline` | Leftover rows from a forced quit with network up the whole time | Classified `interrupted`; nothing reports "Mac was offline" |

**Pass criteria (overall):** a surviving session is reused; an approved interrupted run has **at most one** active session; unknown or unauthorized work does not relaunch; nothing launches while a blocker is unresolved.

### 3.5 Fixture: Greek `rt_fzpoML-AEEjk` (scheduled chat runner, pre-tool failure)

- **What the logs show (per QA review):** Greek's scheduled run `rt_fzpoML-AEEjk` failed **before any tool call**. The logs establish a pre-tool failure; they do **not** establish which flag caused it (invalid model or empty effort). The plan must not assume either.
- **Fixture source:** the run id appears only in volatile snapshot DBs (`/tmp/claude-501/ew-20261127T120048Z/snap.db`, `/tmp/claude-501/marion-watch-20261127T160030Z/snap.db`), not in the repo. Copy the minimal sanitized row data into a test fixture (owner approval for the copy).
- **Tests (each independent):**

| Test | Setup | Pass criteria |
|---|---|---|
| `greek-invalid-model` | Scheduled chat-runner settings with an invalid model, effort valid | Preflight → `blocked_runner_settings` naming the model; 0 launches; no retry with the same settings across polls and restart |
| `greek-empty-effort` | Valid model, effort `""` | Effort is treated as unset: CLI args **omit `--effort`** entirely (never `--effort ""`); the run launches once |
| `greek-unchanged-settings` | Settings-invalid failure, then a resume trigger with settings unchanged | No relaunch; the existing card stays. A relaunch is allowed only after the settings hash changes |
| `gate5-gemini-unrecognized-model` | Gemini chat/routine/bot-to-bot on bare `gemini-4-neon`; `agy models` unavailable; agy rejects it: `invalid model selection (--model "gemini-4-neon" --effort ""): model gemini-4-neon is not recognized as a known model or custom model in settings` | Exactly **1** launch with the exact flags (`--mode --sandbox --disable-slash-commands --settings --input-format --output-format --model`, no `--effort`); **never** retried without `--effort` (a retry happens only if attempt 1 really passed `--effort` and the CLI refused that flag); classified `blocked_runner_settings` (setting `model`), one card, no relaunch with unchanged settings |
| `greek-runner-vs-downstream` | (a) scheduled chat runner's own model/effort invalid (b) runner settings valid but the downstream Claude request fails | Distinct classification and card text: (a) "scheduled chat runner settings" (b) the downstream Claude request error (provider/quota/auth class). Neither is reported as the other |

### 3.6 Quota / usage-limit wait (`quota_wait`)

- **Separate state** from `provider_outage` (5xx) and `provider_auth`. It never triggers sign-in prompts or 5xx backoff.
- **Persisted with the run:** provider, `run_id`, last durable checkpoint, approval scope (approval ids + `args_hash` + scope), and the reset source (`provider_reset_at`, `retry_after`, or `none`).
- **Timing:** honor the provider's reset time or retry guidance when given. If none is given, use bounded backoff (proposed 5 min → 60 min cap) and show "no reset time given". **Never invent a reset time.**
- **No silent provider swap.** Switching provider needs an explicit user action.
- **Visibility:** the wait stays visible as one card for its whole duration. The 6-hour max age and attempt exhaustion **do not** apply silently to `quota_wait`: on expiry the run becomes a visible `needs_attention` card; interrupted work is never deleted and a pending approval is never discarded or expired.
- **Resume:** after reset, preflight (§3.2) and the claim/fencing check (§3.3) run again. If a session is already active, reattach; otherwise exactly one eligible resume.

| Test | Scenario | Pass criteria |
|---|---|---|
| `quota-pre-launch` | Provider reports quota at preflight | `quota_wait`; 0 launches; card shows reset or "no reset time given" |
| `quota-mid-run` | Usage limit after some tool calls | Checkpoint persisted; on reset resumes from it; completed calls not re-run |
| `quota-overnight-restart` | 8 h simulated wait spanning a restart; reset at hour 7 | No launch before reset; state, card and approval survive; exactly 1 resume after reset; not dropped by the 6 h cutoff |
| `quota-no-guidance` | Limit with no reset info | Bounded backoff schedule; no fabricated reset time |
| `quota-revoked-while-waiting` | Approval revoked (or scope changed) during the wait | No launch at reset; card shows declined/fresh approval |
| `quota-competing-wakeups` | Reset timer + network restore + startup + user poke together | Exactly 1 claim; reattach if active, otherwise exactly 1 launch; no early or unauthorized launch |
| `quota-no-swap` | Another provider is available | Still waits on the original provider; no swap without user action |

---

## 4. P1: Independently hosted heartbeat monitor and iPhone outage alerts

### 4.1 Why it must be off-box
`notify.ts` → `pushToDevices` → `webpush.ts::sendPush` all run **inside the Mac process**. When the Mac is off, asleep, or offline, nothing can send the alert. The monitor **and** the notification sender must therefore be hosted independently of the Mac.

### 4.2 Design (proposed)
- **Mac side (this repo, behind `LIFE_HEARTBEAT=1` or a similarly named flag, default off):**
  - Heartbeat every **60 s**, plus immediately on start, on wake, and on network restore.
  - Payload: `mac_id`, `seq`, `sent_at`, `app_version`, counts only (`active_runs`, `waiting_runs`, `pending_approvals`, `needs_attention`), and an optional `sleep_notice`. **No chat content and no tool arguments.**
  - Failed heartbeats are dropped, not queued.
- **Monitor side (independent host):**
  - **Missed heartbeats mean "host unreachable"**, not proof of a root cause. The alert text says "Marion Agent on <Mac> unreachable since hh:mm", never "crashed" or "offline because…".
  - Thresholds (proposed, to be confirmed and recorded in config):
    - Outage: no heartbeat for **> 3 min**, or for > `sleep_notice.expected_until` + 10 min.
    - Recovery: heartbeats healthy for a **healthy window of 2 min** (≥ 2 consecutive beats).
  - Incident state is **persisted remotely** (`incident_id`, `mac_id`, `opened_at`, `state`, alerts sent).
  - Dedup key: `(incident_id, alert_type ∈ {outage, recovery})`. Dedup survives a monitor restart.
  - The Mac's recovery summary (auto-resumed vs needs attention) is attached to the recovery alert when available. The Mac persists the last acknowledged `incident_id` so it doesn't send the summary twice.
- **Scope limit:** heartbeat delivery only detects **host unreachability**. A quota wait (or any other blocker) while the Mac is up and still sending beats produces **no** heartbeat incident.

### 4.2a Blocker-state signal (proposed, minimal)

- **Authenticated** (same secret/Bearer as heartbeats), sent by the Mac when a §3.2 blocker (e.g. `quota_wait`, `blocked_auth`, `check_failed`) has been unresolved for a sustained period (proposed ≥ 15 min). Payload: `mac_id`, `blocker` type, `run_count`, `since`, `signal_id`. No chat content, tool args, or provider details beyond the provider name.
- **Separate incident and recovery semantics** from host-unreachable incidents: key `(mac_id, blocker)`, its own incident id, its own outage/recovery alerts. A host-unreachable incident does not close a blocker incident, or vice versa.
- **Recovery requires sustained health for the relevant blocker** (that blocker clear for the full healthy window). Resumed heartbeats alone never close a blocker incident, and never close a host incident before the healthy window.
- **Idempotency:** every send carries a stable `signal_id`/`incident_id`; the monitor dedups on `(incident_id, alert_type)` and passes the same id as the push collapse/idempotency key. If the push channel cannot guarantee end-to-end exactly-once (APNs/web-push give at-least-once with collapse IDs), that limitation is **documented** and the alert text is written so a duplicate is harmless.

### 4.3 Hosting and notification access needed

| Option | Needs | Notes |
|---|---|---|
| A. Marion Life (`marionberry.app/api/mcp`, new `agent_heartbeat` tool) | **Coordination and approval from Barry** + owner; Life-side scheduler, incident store, APNs/web-push credentials for the user's iPhone | Reuses the existing contract (`docs/MARION-LIFE-CONTRACT.md`: JSON-RPC `tools/call`, Bearer `mb_…`). Code lives outside this repo |
| B. Independent host (small serverless function + KV + scheduled check, sending via a push service) | Hosting account, a persistent store, push credentials (APNs key or a push relay), and a secret for heartbeat auth | No Barry dependency; one more service to own |

Either way, the decision is needed before implementation (§7, decision 7).

### 4.4 Acceptance tests (owner: Jensen)

| Test | Pass criteria |
|---|---|
| **Mac powered off**, on a **real iPhone** | Exactly 1 outage alert after the threshold; exactly 1 recovery alert after power-on plus the healthy window |
| Transient drop below threshold | 0 alerts |
| Flapping (repeated up/down around threshold) | 1 outage + 1 recovery per incident; recovery only after the full healthy window |
| Duplicate events (replayed heartbeats or summaries) | No duplicate alerts |
| Monitor restart mid-incident | Incident resumes from remote state; no repeat alert |
| **Overnight quota**, on a **real iPhone**, Mac awake and heartbeating | Exactly 1 blocker alert after the sustained threshold; 0 host-unreachable alerts; exactly 1 recovery after the quota blocker stays clear for the healthy window |
| Retry of the same signal (network error, monitor retries) | 1 user-visible alert |
| Crash between send and acknowledgment (Mac or monitor), then resend | 1 user-visible alert (end-to-end idempotency), or the documented delivery limitation is shown to hold |
| Heartbeats resume while the blocker persists | Host incident (if any) recovers; blocker incident stays open |
| Offline unit model (`tests/heartbeat.mjs`, stubbed, simulated clock) | Payload has no content fields; cadence; thresholds; dedup; separate host vs blocker incidents |

**Pass criteria:** one outage alert and one recovery alert per incident (host or blocker), none for drops below the threshold, no duplicate user-visible alerts on retry or crash-before-ack, and recovery only after sustained health of the relevant blocker for the configured healthy window.

---

## 5. Separate follow-up: Stale-row recovery

- Own tracked item, **kept out of the current release candidate**.
- Patch: `/tmp/claude-501/deferred-patches/stale-row-recovery/stale-row-recovery.patch` (21,635 bytes, sha256 `1caf242303450f24d482a512a416d500592377a6ae83e750a34c46c9a0223bb9`), plus a test copy `/tmp/claude-501/deferred-patches/stale-row-recovery/stale-rows-recovery.mjs` (sha256 `83d1540b…a11d`, same as the audit's untracked test). It touches `server/src/agent/loop.ts`, `server/src/features/agent-sessions.ts`, `server/src/index.ts`, and adds `tests/stale-rows-recovery.mjs`. **8/8 offline tests passed on audit copy `cand2` (`349e8d73…`)** (`.audit-rock-solid/logs-cand2-stale.log`; not re-run for this plan). It is not in the current RC tree (§1.4).
- Note: `recoverStaleRows()` already exists on `main` (`agent-sessions.ts:143`) but `index.ts` does not call it standalone at startup. The patch adds that call, plus `recoverOrphanRows(botId)` and `pendingRowSeqs` (protects rows that belong to a pending approval).
- Required before merge: restart tests (crash mid-run, restart with a pending approval, double startup) and **migration tests** against a copy of a real DB from the previous schema. Also: rebase onto the current `main`, re-run on the new fingerprint, and get Jensen's sign-off.
- Interaction with §2: stale-row recovery must not finalize rows that belong to a `run_id` that §2 marks `waiting` or `needs_reconciliation`. Land it before §2, or design the two together.

---

## 6. Codebase map and concrete file targets

| Area | File (on `main`) | Facts / target |
|---|---|---|
| In-flight runs | `server/src/db.ts:111` `inflight_turns` | Add `run_id`, `resume_state`, `trigger_type`, `launch_id`, `launch_state`, `updated_at` (§2) |
| Pending batch | `server/src/db.ts:107` `pending_turns(bot_id PK, state)` | One per bot; unchanged |
| Approvals | `server/src/db.ts:118` `approvals` | Add `args_hash`, `scope` (§2) |
| Run loop | `server/src/agent/loop.ts` (1185 lines): `runTurn`; insert :489; supersede :503-507; delete :611; `stillPending` :614; `scheduleResume` ~:663; `CONTINUE_MARK`/`MAX_RESUMES` :659-660; `resumeInterruptedTurns` :675 (`DELETE` :677); `finishPending` :856 | Supersede fix; keep and claim; persisted attempts; classification hook |
| Startup | `server/src/index.ts:112-115` | Order: `resumeInterruptedTurns()` → `recoverAgentSessions()`. Reorder so reconciliation runs before resume |
| Relayed sessions | `server/src/features/schema.ts:77`, `server/src/features/agent-sessions.ts` (`recoverAgentSessions` :119, `recoverStaleRows` :143) | Add `run_id`/`resume_state`; parent-mediated recovery |
| Folder lock | `server/src/agent/folder-lock.ts` | In memory; rebuild from durable state on startup |
| Policy | `server/src/agent/tools.ts` `policyFor` | Re-checked on every resumed call |
| Routines | `server/src/routines.ts:35` `runRoutine` | Must stop expiring approvals |
| Provider errors | `server/src/agent/usage-limit.ts`, `server/src/agent/subscriptions.ts` (`GoogleSignInRequired`, `activeProviderRuns`) | Feed `classifyFailure` |
| New | `server/src/agent/failure.ts` **(proposed)** | `classifyFailure`, `ReachabilityMonitor` |
| Browser offline | `web/src/lib/offlineQueue.ts`, `web/src/lib/outbox.ts` | Existing; regression only |
| Notifications | `server/src/features/notify.ts`, `webpush.ts`; `NotificationKind` at `server/src/types.ts:529` | Has no outage/recovery kind; Mac-local only |
| Heartbeat client | `server/src/features/heartbeat.ts` **(proposed)** | Behind a flag |
| Tests (new, proposed) | `tests/{approval-preserve,approval-declined-resume,approval-scope-mismatch,restart-resume,wifi-flap,provider-outage,duplicate-sessions,simultaneous-triggers,crash-after-launch,heartbeat}.mjs` | Offline, temp DB, no real network or pushes; `node --import tsx` |
| Regression suites (exist) | `tests/{offline-queue,local-offline,life-outbox,background-work,concurrent-prompts,busy-ack}.mjs` | Re-run every phase |

Not present anywhere on `main`: `classifyFailure`, `run_id`, `resume_state`, `agent_heartbeat`, `outage_id`/`incident_id`.

### 6.1 Technical caveats and blockers

1. **Volatile backup storage: flag to the owner.** Everything below lives only under `/tmp/claude-501`, which can be cleared on reboot. Copy it somewhere durable **with owner approval**; do not fold it into the RC:
   - `/tmp/claude-501/deferred-patches/stale-row-recovery/stale-row-recovery.patch` and `stale-rows-recovery.mjs` (the separate stale-row patch; the only copy outside git).
   - `/tmp/claude-501/deferred-patches/marion-life-sync/marion-life-sync-draft.patch` (backup; same hash `60147ab0…` as `.life-sync-draft/` in the RC tree) and `RELIABILITY-PLAN.md` (same hash `b2b9a94e…` as the RC tree copy).
   - `/tmp/claude-501/suite-logs/` (blocked-suite logs, §1.4) and the Greek snapshot DBs (§3.5).
2. **The 11 blocked suites are now named** (§1.3 Gate 3), but the "7 listener suites" grouping is not in any artifact. `suite-cand2/` logs are missing and `sidebar-drop-live` has no surviving log.
3. **Candidate base drift:** the candidate is on `6a07761` and `main` is on `83630e8`. The QA fingerprint must be taken on the rebased tree.
4. **The candidate is entirely uncommitted.** A fingerprint needs either a commit or `git write-tree` from a staged index. Staging changes the candidate worktree, so it needs owner approval.
5. **`undefined*` SQLite files** suggest a test writes a DB at an unset path. The source test is unidentified; it may also pollute the QA environment.
6. **Real Gemini gate** needs an authenticated personal Google account on the QA machine. That is not available in an offline or sandboxed run.
7. **Heartbeat hosting** is blocked on decision 7 (Barry for Marion Life, or an independent host).
8. **Real power-off / iPhone tests** need physical hardware and cannot be automated in CI.

---

## 7. Open owner decisions

1. Approve the candidate fingerprint method (commit vs. staged tree) and the rebase onto `83630e8`.
2. Confirm the 11 blocked suites (§1.3), identify the "7 listener" subset, and authorize the writable, listener-capable environment to run them in.
3. Approve the schema migration (§2.2) and the "keep and claim" change to startup.
4. Behaviour change: only a real user message supersedes a pending approval.
5. Retry budget: outage waits don't consume `MAX_RESUMES`; 30 s stability window; 5 min backoff cap; 6 h max age (visible `needs_attention`, never silent deletion; not applied to `quota_wait`); quota backoff cap when no reset is given; claim lease length and fencing token.
6. Sub-agent policy: parent-mediated recovery only.
7. Heartbeat hosting: Marion Life (needs Barry) vs. an independent host; push credentials; outage threshold (3 min), healthy window (2 min), sleep grace, quiet hours; blocker-signal threshold (15 min proposed); only counts, ids and blocker types leave the Mac.
8. Stale-row recovery: ordering relative to §2, and a durable home for the patch.
9. `undefined*` files: keep untouched until the owner decides; identify the source test.
10. Marion Life sync draft: which batch, if any.

---

## 8. P0: Access survives in-place updates

**Scope: out of the current release candidate.** This section adds no work to `feat/rock-solid-batch`. The §1 candidate scope, the §1.3 QA gates and Jensen's sign-off on the candidate stay separate and unchanged. Nothing here is implemented, and nothing is installed or changed on Henly's live app.

**Goal:** an in-place update never makes the owner grant access again that is still valid. Access that is really missing is asked for once, through the official route, and only for the feature that needs it.

### 8.0 Ownership

| Owner | Responsibilities |
|---|---|
| **Kanye** | Root-cause inventory (§8.2–8.3), implementation, updated draft of this section. |
| **Jensen Huang (QA)** | Acceptance criteria (§8.7), **independent verification** of every hypothesis marked confirmed and of every fix. |

### 8.1 Current status

- **Henly reported repeated reauthorization** after in-place updates.
- **No grant category, build pair or root cause is verified yet.** The issue has not been reproduced. Every item in §8.3 is a **hypothesis** taken from reading the code on `main` @ `83630e8`, which matches this branch's code. None is an established cause. Likelihood labels are estimates.
- The inventory came from read-only code inspection. No credentials, Keychain items, TCC database, provider tokens, `.env`, `composio.key` or `app_secrets` values were read.

### 8.2 What an in-place update changes (facts from code)

| Step | Where | Fact |
|---|---|---|
| Trigger | `server/src/features/app-update.ts` `startUpdate()` (:103), `autoUpdateTick()` (:171) | The server spawns a detached `bash` (:148). It runs `scripts/package-distributions.sh --installer-output …` and then `Install Marion Agent.command --replace-running --app-dir <dir>` (:142). Auto-update can run this with nobody at the Mac. |
| Build identity | `scripts/package-distributions.sh:56-57` | `BUILD_ID` = `<commit>.<randomUUID>.<fingerprint>`, so every build is unique, even for the same commit. |
| Speech helper | `scripts/package-distributions.sh:86-91` | `marion-transcribe` (`scripts/macos/Transcribe.swift`, `SpeechAnalyzer`/`SpeechTranscriber`) is recompiled on every build. |
| Bundle | `Marion Agent Installer/Install Marion Agent.command:128-133` | A fresh upstream `Electron.app` is renamed and gets `payload/Info.plist` (`CFBundleIdentifier` `com.henlyfilms.marion-agent`, version fixed at `1.1.1`). There is **no entitlements file and no hardened runtime**. `Info.plist` has `NSMicrophoneUsageDescription` but **no `NSAppleEventsUsageDescription` or `NSSpeechRecognitionUsageDescription`**. |
| Signing | same file :146-163 | The installer uses the self-signed `Marion Agent Local Signing` cert if `security find-certificate` finds it (:150-153). Otherwise it signs ad-hoc (`-`). `sign()` (:154-156) discards codesign stderr. On **any** failure it switches to ad-hoc for the rest of the run. Nothing records which signer was used. The cert comes from `scripts/macos/make-signing-identity.sh`, which no code runs. It is only mentioned in a comment. |
| Swap | same file :170-177, `cleanup()` :96-107 | The old bundle moves to `$work/previous.app`, the new one moves into place, and `$work`, including the previous app, is deleted. The app is then reopened (:184). |
| App data | `main.cjs:189` `app.getPath('userData')`; `server.cjs:4` | `~/Library/Application Support/Marion Agent`. `DB_PATH ||= $MARION_APP_DATA/marion-agent.db`. The installer doesn't touch this folder. |
| Server runtime | `server-host.cjs` `prepareRuntime()` :56-81, `pruneRuntimes()` :83-90, `launch()` :98-134 | The server runs **detached** from a copied `node` at `<userData>/server-runtime/<BUILD_ID>/node`. That path is new for every build, and older copies are pruned. A busy older-build server stays adopted (`ensure()` :176-195) until `watch()` (:213-228) swaps it when it is idle. |

### 8.3 Per-category audit and hypothesis inventory

Mechanism classes: **S** = signing identity and helpers, **D** = data paths and migrations, **C** = credential store or account changes, **X** = independent of updates or by design (listed so it isn't confused with an update regression).

#### 8.3.1 macOS permissions (TCC)

What the code asks macOS for:
- **Microphone:** the renderer `media` permission (`main.cjs:39-51`).
- **Screen Recording:** `display-capture` and `desktopCapturer.getSources`, plus `setDisplayMediaRequestHandler(…, { useSystemPicker: true })` (`main.cjs:53-58`).
- **Automation:** `osascript` that tells Terminal to run a command (`server/src/features/sign-in-cards.ts:15-18`), `choose folder` (`folders.ts` `pickFolder` :85-95), and the installer quitting the app itself (`Install…:77-82`).
- **Files & Folders:** the server reads shared folders under `~/Desktop` and `~/Documents` (`folders.ts` `searchRoots` :124).
- **Speech:** `marion-transcribe` through `MARION_NATIVE_TRANSCRIBER` (`main.cjs:199-209`, `server/src/native-speech.ts:10`), on macOS 26 and later.
- **Notifications:** `web/src/lib/notifications.ts:21`. Electron allows them automatically at `main.cjs:42,49`. On the macOS side they are keyed by bundle id.
- **Accessibility:** only mentioned in error mapping (`server/src/lib/macPermissions.ts:17`). No AX API call was found.

| ID | Class | Hypothesis | Code evidence | Confirm by |
|---|---|---|---|---|
| H-T1 (high) | S | Builds are signed **ad-hoc**. Their designated requirement is only the cdhash, so each build is a new TCC client, and Microphone, Screen Recording, Automation and Files & Folders all reset on every update. | `Install…:150` (`signer=-` default); the cert is optional and never created automatically | `codesign -dr -` on build N and N+1 (this shows the requirement, not secrets) |
| H-T2 (high) | S | **Silent ad-hoc fallback** even when the cert exists. `find-certificate` checks for the certificate, not a usable private key. An unusable key, an untrusted cert or a locked login keychain during an unattended `autoUpdateTick` gives an ad-hoc build with no log. One failing helper also switches the main bundle to ad-hoc. | `Install…:151-156` (`2>/dev/null \|\| { signer=-; … }`) | Per-build signer record; resets that line up with auto-updates |
| H-T3 (expected, one-time) | S / X | The first build after the cert is created changes the requirement from cdhash to the cert leaf, which causes one reset by design. | `make-signing-identity.sh:24` | Happens only once, on the first cert-signed build |
| H-T4 (medium) | S / D | The process that touches protected folders, runs `osascript` and starts the speech helper is the copied `node` under `server-runtime/<BUILD_ID>/`. If TCC attributes access to that binary rather than to the app (for example when the server was started from Terminal by `Launch Marion Agent.command` or `scripts/launch.mjs`), the grant is keyed by binary or path. That path changes every build and the old copy is pruned. | `server-host.cjs:63-74,83-90,104-116`; `package-distributions.sh:56-57` | Which client System Settings lists (app vs `node`/Terminal); the server's parent at grant time |
| H-T5 (medium) | S | **The server outlives the app.** A busy older-build server is re-adopted after the swap, but its responsible bundle was moved away and deleted. TCC checks through that process may fail or prompt until `watch()` replaces the server. | `server-host.cjs` `ensure()` :176-195, `watch()` :213-228; `Install…` `cleanup()` :96-107 | Happens only on updates while bots are busy, and clears after the idle swap |
| H-T6 (low–medium) | S | Electron helper apps and `marion-transcribe` (rebuilt on every build) are re-signed with `--deep`. If one of them becomes the TCC client, an ad-hoc signature gives it a new identity on every build. | `Install…:157-162`; `package-distributions.sh:86-91` | Which client name appears in TCC prompts |
| H-T7 (low) | D | **Two installed copies** (`/Applications` and `~/Applications`) share a bundle id but have different signatures. A grant attaches to one copy, and LaunchServices opens the other. | `Install…:43-52` | List every copy and the path of the running app |
| H-T8 (medium) | X | **Misclassification.** Any `EPERM`/`EACCES`/"permission denied" error is reported as a Files & Folders or Full Disk Access block, so ordinary POSIX errors look like a lost macOS grant. | `macPermissions.ts:42` `RULES` | The System Settings state is unchanged when the message appears |
| H-T9 | X | macOS asks again on its own: periodic Screen Recording re-confirmation, the user's own toggles, OS upgrades. | n/a (OS) | Prompt wording and timing do not depend on the update |
| H-T10 (low) | S | Missing `NSAppleEventsUsageDescription` and `NSSpeechRecognitionUsageDescription` may suppress or garble prompts. This is not a reset cause in itself, but it affects remediation copy. | `payload/Info.plist` | Check the prompt text on a QA account |

#### 8.3.2 Marion folder grants

Facts:
- Grants are rows in `bot_folders(bot_id, path, label, write, created_at)` (`server/src/features/folders.ts:15-22`), plus `bots.full_access` (`hasFullAccess` :33), both in `marion-agent.db`.
- There is **no pending, declined or revoked state.** Removing a folder is a hard `DELETE` (`removeBotFolder` :79).
- Schema changes are additive: `CREATE TABLE IF NOT EXISTS` and the idempotent `addColumn` (`db.ts:173-177`). No destructive migration was found on these tables.

| ID | Class | Hypothesis | Code evidence | Confirm by |
|---|---|---|---|---|
| H-F1 (high if the dev launcher is used) | D | `Launch Marion Agent.command` / `scripts/launch.mjs` (port 8787, no `DB_PATH`) uses `<repo>/data/marion-agent.db`, not the app's database. Switching between the two shows a different folder list, Life key, Composio session and workspace user. | `scripts/launch.mjs:46`; `server/src/env.ts:62` vs `server.cjs:4` | Database path and port in use at each checkpoint |
| H-F2 (medium) | D | `<userData>/.env` is loaded with `--env-file-if-exists` before `server.cjs:4` applies `\|\|=`. A `DB_PATH` set there, or inherited, moves the database without any notice. | `server-host.cjs:104`; `server.cjs:4` | Log the resolved database path (path only) |
| H-F3 (correlates with H-T1/T4) | S | The Marion row is intact, but macOS denies the folder, so `MacPermissionError` tells the user to allow it again. This looks like a lost folder grant. | `folders.ts` `rethrowIfMacBlocked`; `macPermissions.ts` | The row is present while the access probe fails |
| H-F4 (medium–low) | C / D | Grants belong to bots owned by the workspace user (`desktop_workspace` slot 1). A new or swapped database makes `workspaceUserId` create a new "Local workspace" user, and every grant appears to be gone. | `routes.ts:69-77`; `db.ts:26-29` | Hash of the workspace user id before and after |
| H-F5 (design gap) | D | There are no tombstones, so a restore can't tell "removed by the owner" from "lost". A removed or declined record must exist before any restore UI ships. | `folders.ts:79` | n/a (design) |
| H-F6 (by design) | X | Cloud launches use a new temporary Git launch folder that is deleted afterwards, so Claude Code's "trust folder" card repeats every time. This is not a reset. | `server/src/features/cloud-cards.ts:99-101` | The card names the temporary launch folder |

#### 8.3.3 Provider sign-ins (Claude Code, Codex, Gemini/`agy`, GitHub `gh`)

Facts:
- **Marion stores no provider tokens.** The vendor CLIs own their credentials.
- `cliEnvironment()` (`server/src/agent/subscriptions.ts:137-140`) passes only `HOME, USER, LOGNAME, PATH, LANG, LC_ALL, TMPDIR, CODEX_HOME`.
- `executable()` (:103-118) looks for the CLI in `PATH`, then `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. For Codex it also inserts ChatGPT.app's bundled `codex` before the standard paths.
- How each sign-in is checked:
  - Claude: `requireClaudeSubscription` (:264-275), which runs `claude … auth status --json`.
  - GitHub: `server/src/features/github-repos.ts:48`, which runs `gh auth status --hostname github.com`.
  - Gemini: inferred from stderr (:660).

| ID | Class | Hypothesis | Code evidence | Confirm by |
|---|---|---|---|---|
| H-P1 (high) | C | **"Not recognized", not "signed out".** `requireClaudeSubscription` turns any failure into `claudeLoginMessage`: a spawn error, the 12 s timeout, a non-zero exit, or a Keychain prompt or denial while the CLI reads its own store. It also rejects unexpected `authMethod`, `apiProvider` or `subscriptionType` values. The first CLI launch after an update is a plausible window for a timeout. The result is cached for 60 s. | `subscriptions.ts:264-275`, `:308` | Exit code and elapsed time (no output contents) on failure; `claude auth status` in Terminal still passes |
| H-P2 (high on `main`) | X | The loose Gemini matcher `/authenticat\|sign.in\|log.in/i` throws `GoogleSignInRequired` on unrelated diagnostics. The tightened matcher is RC regression fix 2 (§1.1). This section only references it and changes nothing. | `subscriptions.ts:660` | Compare against the candidate matcher |
| H-P3 (medium) | D | `PATH` is built in `main.cjs:208` by whichever app *launched* the server. An adopted older server, a dev server started from Terminal, or the ChatGPT.app Codex insertion can resolve a **different CLI binary or install** than before, with a different auth store. | `main.cjs:207-210`; `subscriptions.ts:103-118` | Record the resolved executable paths for each build (paths only) |
| H-P4 (medium) | C / X | Keychain items stored by a CLI (Claude Code credentials, the `gh` keyring) have access lists tied to that CLI's binary. CLI self-updates or Homebrew upgrades, which are independent of Marion, trigger Keychain prompts that show up while Marion is in use. | n/a (vendor) | Whether CLI versions changed between checkpoints |
| H-P5 (medium–low) | C | A different config folder under Marion. `cliEnvironment` drops `XDG_CONFIG_HOME`, `GH_CONFIG_DIR`, `CLAUDE_CONFIG_DIR` and similar variables. If the owner's shell sets them, the CLI looks signed out under Marion only. | `subscriptions.ts:137-140` | Variable **names** present in the shell (no values) |
| H-P7 (medium) | C / X | **Account mismatch, not a sign-out.** The CLI is signed in, but to a different Google/provider account or workspace than before ("Wrong Google account: please log in with …", "Account mismatch: not authenticated as …"). The old loose matcher read these as sign-in and showed a sign-in card that cannot fix them. | `server/src/agent/sign-in.ts` `ACCOUNT_MISMATCH`; `runner-settings.ts` `downstreamClass` | Account shown by the CLI vs the account at T0 (account id hash only); filed as **No longer recognized** |
| H-P6 | X | Account changes: the plan is no longer in `claudePlans`, the `gh` token scopes changed, or a token expired or was revoked at the provider. | `subscriptions.ts:270-272`; `server/src/features/cloud-repo.ts:87-91` | Provider-side status |

#### 8.3.4 Integrations (Composio, Marion Life MCP, mobile/browser pairing)

Facts:
- **Composio key:** read from `dirname(DB_PATH)/composio.key` (`server/src/composio.ts:11-17`) or from the `COMPOSIO_API_KEY` env variable (`env.ts:43`, which takes precedence through `keyManagedByEnvironment` :10).
- **Composio connections:** stored at Composio under `userIds: [<workspace user id>]` (`connectedToolkits` :134-138, `connectionsDetail` :141-143). The session is cached locally in `composio_sessions(user_id, session_id)` (`db.ts:167-170`, `sessionFor` :159-171).
- **Marion Life key:** kept in `app_secrets`, a plain SQLite table (`server/src/features/schema.ts:39-42`, `getSecret`/`setSecret` :132-139), under `life_link_key:<userId>` (`server/src/features/life-link.ts:31`).
- **Mobile/browser pairing:** comes from `mobile-pairing.json` and `browser-pairing.json` in userData (`main.cjs:168-177`, `env.ts:13-27`). Session keys are `HMAC(passphrase, origin, token)` (`server/src/lib/auth.ts:36`), and mobile sessions last 30 days (`auth.ts:12,45`).
- **No Keychain or Electron `safeStorage` use was found** anywhere in `server/src`, `web/src`, the installer or the app payload. Marion's own integration secrets therefore don't depend on the code signature.

| ID | Class | Hypothesis | Code evidence | Confirm by |
|---|---|---|---|---|
| H-I1 (high impact) | C / D | Composio connections and the Life key are keyed by the workspace user id. Any database swap or new database (H-F1, F2, F4) creates a new `usr_` id. Connections then look missing even though they are still active under the old id. | `composio.ts:134-171`; `life-link.ts:31`; `routes.ts:69-77` | Hash of the workspace user id; Composio connection count per toolkit |
| H-I2 (medium) | C | A key change, or a change in env-vs-file precedence (the dev launcher and the app can differ), points at another Composio project. `updateComposioKey` also clears every `composio_sessions` and `app_link_attempts` row. | `composio.ts:10-17,25-60` | Which key source is in use (file or env), recorded as source only |
| H-I3 (expected, one-time) | D | `lifeLinkSettings` deletes the legacy Supabase key and asks for a Marion Life key. This invalidation is intentional and must not recur. | `life-link.ts:38-47` | The message appears once only |
| H-I4 (medium) | D / C | Environment order `{...baseEnvironment(), ...process.env, ...environment()}` lets inherited `MARION_MOBILE_*`/`MARION_BROWSER_*` values override the pairing files. Pairing is read only when the server launches, so an adopted server keeps the old pairing. A change of passphrase or origin invalidates every phone and browser session, because it changes the HMAC key. | `server-host.cjs:106-113`; `auth.ts:36` | Hash of the pairing origin and of the presence of a passphrase (never the value) |
| H-I5 | X | Sessions expire (30 days on mobile, `browserSessionHours()` in a browser), the Life key is revoked in Life (401/403 at `life-link.ts:168`), or a Composio connection expires or is revoked at the provider. | as cited | Provider or Life status |
| H-I6 (low) | D | The in-memory `sessionCache` and `toolsCache` are lost when the server is swapped. If `composio().use(session_id)` fails, a new session is created without notice. That is harmless while the user id stays the same. | `composio.ts:159-171` | Count of new sessions after the update |

#### 8.3.5 Classification taxonomy (fill in for every observed reset)

| Field | Values |
|---|---|
| Build pair | `BUILD_ID` before → after; signer requirement for each (`codesign -dr -`); install path(s); update route (in-app, auto, manual installer, dev launcher) |
| Grant | Category (§8.3.1–8.3.4) and the specific grant (for example: Microphone; folder "<label>" on bot X; Claude Code; Composio Gmail) |
| Evidence | Hypothesis ID with exact files and symbols, **or** OS or provider evidence (System Settings state, prompt screenshot, provider status as pass/fail) |
| Outcome | **Lost** (the record is gone: TCC entry, `bot_folders` row, `app_secrets` key, Composio connection) · **No longer recognized** (the record exists but doesn't match: signing requirement, database or user id, CLI binary or config, misclassified error) · **Independently expired or revoked** (OS, provider or user action unrelated to the update) · **Check failed (transient)** (timeout, spawn error, Keychain prompt, network or 5xx during the check; state `check_failed`, §3.1–3.2; access not lost) · **Expected by design** (H-T3, H-I3, H-F6). Only **Lost** is grant loss; the other outcomes must be distinguished from it (§8.7 gate 8) |
| Recurrence | Once vs on every update (from the second update) |
| Status | open / confirmed (needs Jensen's independent check) / refuted |

### 8.4 Authorized QA verification protocol

- **Environment:** a QA macOS user account or QA Mac approved by the owner. **Never install on Henly's live `/Applications/Marion Agent.app` without approval.** Builds come from committed revisions outside the RC worktree.
- **No credentials exposed:**
  - Record states as booleans, counts, exit codes, paths and hashes only.
  - Never read or print Keychain items, `TCC.db`, `.env`, `composio.key`, `app_secrets` values, tokens or pairing passphrases.
- **Positive fixtures before the first update:**
  - One valid grant in every category.
  - One optional grant that is not needed by the features under test, left unset.
- **Negative fixtures before the first update** (each must stay in effect until the owner explicitly restores it through the official route):
  - **Denied OS permission:** one TCC permission the app uses (for example Screen Recording) denied in System Settings for the QA account.
  - **Revoked folder access:** one folder removed from a bot (`removeBotFolder`). **Verification of this fixture's state is blocked** until the tombstone decision (§8.8 decision 3) or an equivalent owner-approved mechanism exists, because today's hard `DELETE` leaves no record that tells "revoked" from "never granted" (H-F5). Until then only its failing probe is recorded and its gate is reported **blocked**, not passed.
  - **Revoked Marion Life access:** the QA Life key revoked in Marion Life.
  - **Signed-out provider:** one provider CLI signed out on the QA account (for example `gh auth logout` or a Codex logout).
  - **Disconnected integration:** one Composio toolkit disconnected through Composio.
  - **Declined approval** and **pending approval:** one of each.
- **Update route:** **two real in-place updates through the production updater** (`app-update.ts` `startUpdate()`/`autoUpdateTick()` → `Install Marion Agent.command --replace-running`). The manual installer and the dev launcher do not count.
  - **U1 (N → N+1), unattended:** triggered by `autoUpdateTick()` with nobody at the Mac (screen locked, no input during install).
  - **U2 (N+1 → N+2), busy-server handover:** triggered while a bot run is active, so the older-build server is adopted (`ensure()`) and later swapped by `watch()` once idle. Probes after U2 run both before and after the `watch()` swap.
- **Checkpoints** (no update may start until the previous checkpoint is recorded):
  - **T0 baseline (build N):** every positive probe passes and every negative probe fails as expected. **A failing T0 stops the protocol**; nothing after it counts.
  - **C0 no-update relaunch control (build N):** a normal quit and a "Quit and Stop Background Work" relaunch with no update. Grant state, functional results and prompt counts must equal T0 exactly.
  - **T1 / T2 (after U1):** T1 = first launch after the update; T2 = relaunch, done twice (normal quit, and "Quit and Stop Background Work" to force a fresh server).
  - **T3 / T4 (after U2):** T3 = first launch after the update; T4 = relaunch, done twice as for T2.
  - Every checkpoint is compared against T0 and C0 on grant state, functional results and prompt counts.
- **Record at each checkpoint:**
  - Build id, signer requirement, every installed copy, the server runtime path and whether it was adopted, the database path, and a hash of the workspace user id.
  - For each grant: **recorded state** and **actual access**. A status row, badge or connection count alone is not a probe. Concrete functional probes per category:
    - **macOS permissions (TCC):**
      - Microphone: 3 s dictation produces audio input.
      - Screen Recording: a screen recording starts and captures a non-blank frame.
      - Automation: a sign-in card opens Terminal through `osascript` (exit 0), **and** `pickFolder` (`choose folder`) opens and returns the QA path chosen.
      - Files & Folders: a bot reads a fixture file in a shared `~/Desktop` folder and in a shared `~/Documents` folder; a bot with `write` creates and deletes a fixture file **inside** its granted folder (scoped write), and the same write to a sibling folder outside the grant is refused.
      - Speech: a native transcription of a fixture clip returns the expected text.
      - Notifications: one notification delivered.
      - **Accessibility: N/A.** No AX API is used (§8.3.1); recorded as N/A, and any Accessibility prompt counts as a failure.
    - **Marion folder grants:** a `full_access` bot reads a fixture file outside its listed folders; a bot **without** `full_access` asked to read an ungranted folder is denied, with no grant created and no scope widened.
    - **Providers:** one prompt each to Claude, Codex and Gemini returns a reply with launch count `=== 1`; a real read-only GitHub call (`gh api user` or `gh repo view <QA repo>`, exit code only, output not stored).
    - **Integrations:**
      - Composio: one real read-only tool call per connected toolkit succeeds (connection counts alone do not pass).
      - Marion Life: `whoami` ok **and** one read-only Life MCP tool call succeeds.
      - Paired browser: an authenticated request (for example the bot list) returns 200 without re-pairing.
      - Paired phone: an authenticated request returns 200 without re-pairing.
    - **Negative fixtures:** each one's probe (the matching probe above) **fails** with access denied, at every checkpoint, until explicit restoration.
  - Every OS or provider prompt shown, with count, wording and screenshot.

### 8.5 Preservation and remediation design (proposed)

- **Preserve valid grants where the platform supports it, with their original scope:**
  - **Signing:**
    - Make the signer explicit and recorded (sidecar next to `BUILD_ID` and in `marion-update.json`).
    - Remove the silent `2>/dev/null` fallback.
    - Refuse to install an ad-hoc build over a cert-signed build without an explicit owner choice.
    - Check that a usable identity exists, not just that a certificate exists.
    - Developer ID signing and notarization are an owner decision.
  - **Helpers and runtime:** a stable server runtime path (or app-attributed spawning) so a grant isn't keyed to `server-runtime/<BUILD_ID>`. Retire an adopted old server before the old bundle is deleted, or make the effect harmless.
  - **Data:** log the database path and the workspace user id hash at startup. Never create a new workspace user without notice when a previous database existed. Keep one database for app and dev runs, or label clearly which one is active.
  - **Providers:** separate "signed out" from "check failed" (timeout, spawn, Keychain) in `requireClaudeSubscription`. Only a **confirmed sign-out** maps to `blocked_auth` (class `provider_auth`); a failed check maps to the distinct `check_failed` state (§3.1–3.2) and never shows a sign-in prompt or `Review and restore access`. Record resolved CLI paths. Keep the RC Gemini matcher fix as shipped by the RC.
  - **Integrations:** bind them to the stable workspace id. Clear `composio_sessions` only on an explicit key change.
- **Remediation for real reauthorization:** one **`Review and restore access`** screen. It is shown only when a probe confirms that access **required by the feature being used** is missing. It lists only that missing access. For each item it shows:
  - **what** is missing;
  - **why** the feature needs it;
  - **a direct route** to the official prompt or settings page: the real macOS permission request or the matching System Settings → Privacy & Security pane, the provider's own sign-in (the existing sign-in cards in `sign-in-cards.ts`), Composio's official connect flow (`startConnect`), or Marion Life's own key page.

  Each item appears **once** per missing grant and feature. Dismissing it does not bring it back on its own.

  It is **never** shown for `check_failed` (transient) or for an account/workspace mismatch ("No longer recognized", §8.3.5); those are diagnosed, not restored (§8.7 gate 8).
- **Hard guardrails:** never grant automatically, never widen scope, never restore revoked or declined grants, never duplicate pending approvals, and never bypass macOS prompts. Restore is a route the owner takes, never an action Marion takes for them. Verified by the §8.4 negative fixtures and §8.7 gate 2.

### 8.6 Implementation targets (proposed, after the RC ships and with owner approval)

`Install Marion Agent.command` (`sign()`, signer record), `scripts/package-distributions.sh` (signer and requirement in build metadata), `server-host.cjs` (`prepareRuntime`, `ensure`, `watch`), `server/src/features/app-update.ts` (auto-update refuses a downgrade in signing identity), `server/src/lib/macPermissions.ts` (narrow the `EPERM` rule), `server/src/agent/subscriptions.ts` (`requireClaudeSubscription` failure classes), `server/src/features/folders.ts` (removed/declined tombstones), `server/src/composio.ts`, `server/src/features/life-link.ts`, a new restore-access view in `web/src` **(proposed)**, and new offline tests `tests/{access-preserve,access-restore,signing-identity}.mjs` **(proposed)**.

### 8.7 QA gates (owner: Jensen Huang)

0. **Preconditions:** a passing T0 baseline and C0 control (§8.4), then **two real in-place updates through the production updater**: U1 unattended and U2 busy-server handover. A manual install or dev-launcher run does not count.
1. **Valid grants still work with zero new prompts** at the first launch **and** the relaunches after **both** updates (T1–T2 after U1, T3–T4 after U2), confirmed by the §8.4 functional probes for every category, not just the recorded state. The no-update relaunch control (C0) matches T0 on grant state, functional results and prompt counts.
2. **Negative fixtures stay negative.** Denied OS permission, revoked folder, revoked Marion Life access, signed-out provider, disconnected integration and declined approval: their functional probes **fail** at every checkpoint until the owner explicitly restores them (a negative fixture that passes a probe is a **fail** of this gate, not a recovery); scope is unchanged (no new rows, no widened folder or `full_access`); nothing re-enables them or offers them for automatic restore; **no duplicate prompts** after dismissal, after relaunch, or after the second update. The revoked-folder part is **blocked** pending the tombstone decision (§8.8 decision 3) or an equivalent mechanism to verify that state.
3. **Pending approvals stay pending, with no duplicates**, across dismissal, relaunch and both updates.
4. **Missing required access appears once**, on `Review and restore access`, with the right next step (the official prompt or settings route).
5. **Optional or unrelated access triggers no prompt.** Accessibility is N/A and must not prompt.
6. **Recurrence:** every check above passes after U2 as well as after U1, so resets that recur are caught.
7. **No install on Henly's live app without approval.** Current RC gates (§1.3) and sign-off stay separate and unchanged.
8. **Classification gate.** Fixtures, each run after both updates:
   - **Expiry:** an expired session or token (for example a mobile session past its 30 days, a short-lived browser session, a provider token expired at the provider).
   - **Account/workspace mismatch:** a different database path or workspace user id hash, a different Composio key source/project, or a CLI signed in to a different account than at T0.
   - **Transient failure:** an auth-check timeout or spawn failure, network down during the check, a Keychain prompt delaying the CLI, a Composio or Life 5xx.

   - **Account mismatch wording:** agy/CLI output "Wrong Google account: please log in with …" and "Account mismatch: not authenticated as …" (offline replay in `tests/gemini-sign-in.mjs` plus the real fixture above).

   Reconciled pass/fail rules (one rule per outcome, the same in §3.1–3.2, §8.3.5 and §8.5):

   | Fixture | Expected outcome (§8.3.5) | State | Pass | Fail |
   |---|---|---|---|---|
   | Valid grant | — (still valid) | none | Probe passes, 0 new prompts | Any prompt, restore item or failed probe |
   | Expired session/token | Independently expired | `blocked_auth` only for a feature that needs it | Exactly one official re-sign-in route, not counted as update loss | Counted as **Lost**, a restore screen, or duplicate prompts |
   | Account/workspace mismatch | No longer recognized | `blocked_account_mismatch` | Diagnosed with the account named; 0 sign-in cards, 0 restore items, 0 reconnects | A sign-in card (`GoogleSignInRequired`), `blocked_auth`, `downstreamClass` = `auth`, or any restore/reconnect |
   | Transient check failure | Check failed (transient) | `check_failed` | Clears on its own after a passing check; 0 prompts | `blocked_auth`, a sign-in prompt or a restore item |
   | Grant really gone | Lost | `blocked_*` for the feature | Appears once on `Review and restore access` with the official route (gate 4) | Silent re-grant, widened scope, or duplicates |

   Pass: each is filed under its own §8.3.5 outcome (**Independently expired**, **No longer recognized**, **Check failed (transient)**) and is demonstrably distinguished from **Lost** (grant loss). Transient failures map to `check_failed`, never `blocked_auth` (§3.1–3.2, §8.5), and clear on their own once the check passes. **Mismatch and transient failures trigger no restoration:** no `Review and restore access`, no sign-in prompt, no reconnect. Expiry routes only to the official re-sign-in for a feature that needs it and is not counted as an update-caused loss.
9. **Evidence.** Redacted per-grant **before/after evidence tied to both build pairs** (N → N+1 and N+1 → N+2): for every applicable gate, the functional probe outcome and the prompt count at T0, C0 and every post-update checkpoint, with build ids and signer requirements. Status rows, badges and connection counts **alone do not pass** any gate.

Every observed reset is filed with the §8.3.5 taxonomy. **All proposed causes in §8.2–8.3 stay unverified hypotheses** until Jensen verifies each one independently; a hypothesis moves to "confirmed" only then, and passing these gates does not by itself confirm a cause.

### 8.8 Open owner decisions (this section only)

1. Approve the QA macOS account or machine and the build pair (N → N+1 → N+2).
2. Signing strategy: the local cert vs Developer ID and notarization, and whether updates refuse to fall back to ad-hoc.
3. Add removed/declined tombstones for folder grants (needed for guardrail 2).
4. Ask Henly for details of the observed resets: which prompts, approximate dates or builds, how each update ran (in-app, auto, installer, dev launcher), and whether both `/Applications` and `~/Applications` copies exist.
