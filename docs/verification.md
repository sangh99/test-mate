# Verification

Recorded on 2026-10-13; the backlog, secondmate, posture, integrations and events, and fleet view and maintenance checks on 2026-10-14.

## Executed environment

| Component | Observed value |
| --- | --- |
| Operating system / architecture | macOS / ARM64 |
| Node executable used for the checks | v24.5.0; v24.16.0 for the supervisor and delivery checks |
| npm | 11.5.1; 11.13.0 for the supervisor checks |
| Git | 2.50.1 |
| TypeScript | 5.9.3 |
| Effect | 4.0.4 |
| Claude Agent SDK | 0.3.296 |
| Bundled Claude executable | 2.1.296 |
| no-mistakes, for the validation checks | v1.84.0 |
| GitHub CLI, for the forge and validation checks | 2.75.0 |

## Results

`npm test` compiled the application with strict TypeScript settings and passed all 47 deterministic tests, including six for durable steering.
After the supervisor was added, `npm run typecheck` passed and `npm test` again passed all 47 tests, with the migration tests now expecting schema version 3.
No automated test covers the supervisor; it was verified through the CLI as described below.
After delivery modes and local-only landing were added, `npm run typecheck` passed and `npm test` again passed all 47 tests, with the migration tests expecting schema version 4 and the test fixtures' ships naming `direct-PR` delivery with yolo off.
No automated test covers delivery, merge authority, or landing; they were verified through the CLI as described below.
After cleanup and clone refresh were added, `npm run typecheck` passed and `npm test` again passed all 47 tests, with the migration tests expecting schema version 7.
No automated test covers cleanup, discard authorization, clone refresh, or the start-from-target rule; they were verified through the CLI as described below.
After the project registry and capacity were added, `npm run typecheck` passed and `npm test` again passed all 47 tests, with the migration tests expecting schema version 8 and the event-pagination test reading after the creation events, which now include `intake.resolved`.
No automated test covers the registry, intake resolution, or capacity; they were verified through the CLI as described below.
After the backlog and captain holds were added, `npm run typecheck` passed and `npm test` again passed all 47 tests, with the migration tests expecting schema version 9.
No automated test covers the backlog, holds, attestation, divergence, or retention; they were verified through the CLI as described below.
After local secondmates were added, `npm run typecheck` passed and `npm test` again passed all 47 tests, with the migration tests expecting schema version 10.
No automated test covers secondmates; they were verified through the CLI as described below.
After dispatch, runtimes, and account pins were added, `npm run typecheck` passed and `npm test` again passed all 47 tests, with the migration tests expecting schema version 11, the interpreter tests feeding SDK messages through the Claude runtime's normalization, a failed result reported as `Worker run failed`, and a new task's stored record carrying `dispatch`.
No automated test covers dispatch, quota resolution, or account pins; they were verified through the CLI as described below.
After away and quiet posture, memory, and stow were added, `npm run typecheck` passed and `npm test` again passed all 47 tests, with the migration tests expecting schema version 12.
No automated test covers posture, triage, the return brief, memory, or stow; they were verified through the CLI as described below.
After the extension registry, process sources, the captain inbox, Relay, upstream signals, and the outbox were added, `npm run typecheck` passed and `npm test` again passed all 47 tests, with the migration tests expecting schema version 13.
No automated test covers them; they were verified through the CLI as described below.
After the fleet snapshot, bearings, the supervisor drain, self-update, and the Bash import were added, `npm run typecheck` passed and `npm test` again passed all 47 tests, with the migration tests expecting schema version 14.
No automated test covers them; they were verified through the CLI as described below.
The migration test that opens a fresh home from two processes at once used to fail intermittently with `database is locked` while switching the new database to WAL (3 of 8 runs of the 2026-10-14 `main` build); opening a home now retries that switch for a bounded time, and 12 consecutive runs then passed.
The queue concurrency test's fake attempts now overlap for 300 ms instead of 30 ms, after a GitHub Actions Linux run measured a peak of one concurrent attempt.

```text
tests 47
pass 47
fail 0
cancelled 0
skipped 0
```

The tests cover SQLite restart persistence, atomic transition refusal, exclusive ownership across connections and processes, generation fencing, stale decisions, open-decision retention, cancellation/completion races, explicit crash recovery, Git isolation, dirty-work preservation, SDK session resume, failure results, cumulative cost accounting, stream exhaustion, permission answers, cancellation, report persistence, bounded concurrent execution, CLI parsing, path traversal, symlink escapes, unrelated worktree rejection, immutable base commits, legacy task records decoding and round-tripping byte-for-byte, refusal of attempt writes to intake fields, and durable steering: live delivery and reply-stamp acknowledgement, sequence order and stable identity, coalesced-batch acknowledgement, completion refusal and settle timeout, transcript reconciliation on resume, uncertain-message requeue, and generation fencing.

The SDK protocol is injected in deterministic tests.
Those tests use real local databases, subprocess ownership probes, and Git worktrees; they do not contact an AI service.

The installed SDK's native executable was invoked with `--version` and returned:

```text
2.1.296 (Claude Code)
```

`npm pack` produced `firstmate-ai-0.1.0.tgz` containing compiled code, declarations, package metadata, and documentation.
Installing that tarball with `npm install --prefix <temporary-directory> --omit=dev <tarball>` succeeded with runtime dependencies only.
The installed npm `firstmate` executable successfully ran `--help` and `doctor --home <temporary-home> --json` outside the source checkout.
The doctor found Git 2.50.1 without making a model request.
Its authentication message now delegates verification to the SDK rather than treating an absent API key as missing authentication.

`npm run test:live` subsequently passed with `ANTHROPIC_API_KEY` absent, using the SDK's existing local authentication.
It completed a scout task, persisted its report, resumed the exact same SDK session, and received the expected response again.
The live test no longer skips when an API key is absent.

After durable steering was added, the live suite gained a steering-evidence test and both live tests passed again with existing local authentication on the same day.
The steering test queued a message before a scout run and proved, against the pinned CLI, that the message was submitted on the streaming input, echoed back under its own UUID with `--replay-user-messages`, answered by a reply stamped `user_message_uuid` with that UUID, and stored in the session transcript under the same UUID.
The completion-and-resume test confirmed that switching the SDK prompt to streaming input kept completion and exact-session resume working.

```text
tests 1
pass 1
fail 0
skipped 0
```

The initial pack attempt could not write the sandboxed user's npm cache.
The successful pack used `--cache /private/tmp/firstmate-app-npm-cache`; no ownership or permissions on the user's cache were changed.

## Supervisor CLI verification

The supervisor was verified end to end through the built `firstmate` executable on macOS ARM64 with Node v24.16.0, against a temporary home and a temporary Git repository.
Task attempts ran the real bundled Claude executable (2.1.296), configured with `ANTHROPIC_BASE_URL` pointing at a local fake Messages API, a dummy `ANTHROPIC_API_KEY`, and a temporary `CLAUDE_CONFIG_DIR`, so no model was contacted.
The fake API answered with text, never answered, asked to run a Bash command, or refused the request, depending on the scenario.
One scripted run passed every scenario; the full command transcript is kept with the task's private evidence.

| Scenario | Observed through the CLI |
| --- | --- |
| Lease | A second `supervisor start` failed with `A live supervisor (PID n) already owns this home`, and `run-all` failed with `A live supervisor (PID n) owns queued execution for this home`; `supervisor stop` with no supervisor failed with `No live supervisor owns this home`. |
| Queued execution | A queued scout and ship finished `completed` and `ready`; while the supervisor then idled for 3 seconds the fake API received no requests. |
| Wake queue | Each finish became a `finished` captain wake; after a second `supervisor wakes`, acknowledging with the first generation failed with `A newer presentation superseded this queue generation`, and acknowledging with the second through one sequence retired only that wake. |
| Stale recovery | With `--stale-after 3`, a never-answered request produced `recovery.attempted` (attempt 1 of 2), `control.requested` (relaunch), `run.stopped` (interrupted), `control.applied`, and `run.started` with `resume: true`; the resumed attempt kept the one recorded session and finished `ready`. |
| Escalation | With `--recoveries 1`, a second stall produced `recovery.exhausted` and an interrupt; the captain received `escalated` with `Recovery stopped after 1 of 1 attempt(s) (stale)`, status showed `{"attempts":1,"exhausted":true}`, and no third attempt started. |
| Lifecycle control | `interrupt` stopped a running attempt as `interrupted` with no steering record and no resume, and `cancel` then made it `cancelled`; `relaunch --prompt` resumed the same session with that prompt. |
| Restart | `supervisor stop` reported the running task in `interrupted` and left one supervisor `resume` wake; the next supervisor resumed the exact session, which finished `ready`, with no recovery recorded. |
| Decisions and failures | An attempt waited on a Bash decision longer than a 3-second silence bound without any recovery; the captain received `decision` and, for a refused request, `failed`. |
| Crash | After the supervisor was killed with SIGKILL, status showed its lease with owner `absent` and the task `observedState: "unknown"`; the next supervisor reported the dead generation as `reclaimed`, recorded `recovery.attempted` with cause `orphaned`, and resumed the session to `ready`. |

## Delivery CLI verification

Delivery modes, merge authority, and local-only landing were verified the same way: the built `firstmate` executable on macOS ARM64 with Node v24.16.0 and Git 2.50.1, a temporary home and Git repository, and the real bundled Claude executable pointed at the fake Messages API.
For a ship's one Bash call, the fake API either wrote and committed a file on the task branch, wrote a file without committing it, or answered with text only, and the script allowed each Bash decision.
One scripted run passed every scenario; the full command transcript is kept with the task's private evidence.

| Scenario | Observed through the CLI |
| --- | --- |
| Intake | A ship without `--delivery`, without `--yolo`, or without both failed with `A ship needs an explicit delivery mode (no-mistakes, direct-PR, or local-only) and yolo on or off`; unknown values, a scout with either, a missing `--target` branch, and a commit `--base` with no `--target` were refused, and no task was created. |
| Other modes | A `direct-PR` ship stopped `ready` with its commit recorded; `approve` and `land` refused it, the latter with `landing it needs a forge, which is not available yet`. |
| Clean branch | A local-only ship that left an uncommitted file ended `failed` with `A local-only ship must stop on a clean branch`. |
| Approval | A committed local-only ship stopped `local-ready`; `land` failed with `Merge not authorized: Needs the captain's approval of <commit> (yolo is off)`, `approve --commit 0000000` was refused, and `approve` with a 12-character prefix recorded a `merge.approved` event naming the full commit. |
| Landing | `land` moved `main` from the base to the ready commit, reported `fastForward: true`, `basis: "captain"`, and the approval's sequence, and appended `task.landed`; `merge-base --is-ancestor` confirmed the commit on `main`, and `resume` and a second `land` were refused. |
| Refusals | With an approval recorded, `land` refused a clone with an untracked file, a `main` with a commit not in the task branch (`diverged ... not a fast-forward`), and a task branch committed to after `local-ready` (`moved from its ready commit`); each task stayed `local-ready`. |
| Yolo and flags | With yolo on, a flagged ship was refused with `Escalated (...): needs the captain's approval ... recorded after the flag; yolo cannot authorize it`, then landed with `basis: "captain"` once approved; an unflagged yolo ship landed with no approval and `basis: "yolo"`, and the supervisor raised one captain `landed` wake for it. |

## Forge delivery CLI verification

Direct-PR delivery was verified live against GitHub: the built `firstmate` executable on macOS ARM64 with Node v24.16.0, Git 2.50.1 and `gh` 2.75.0, a temporary home, a fresh clone of the throwaway repository https://github.com/sangh99/test-mate, and the real bundled Claude executable pointed at the fake Messages API.
The repository's default branch had an active ruleset requiring the status check `firstmate/required`; CI was simulated by posting commit statuses with `gh api`.
One scripted run passed every scenario below; the full command transcript is kept with the task's private evidence.

| Scenario | Observed through the CLI and GitHub |
| --- | --- |
| Clean branch | A direct-PR ship that left an uncommitted file ended `failed` with `A direct-PR ship must stop on a clean branch`, and nothing was pushed. |
| Publish | A committed direct-PR ship ended `pr-open`; its task branch was on `origin` at the ready commit, and the recorded `pr` URL, number, head and target matched `gh pr view` exactly; `pr.opened` was appended. |
| Authority | `land` was refused without approval (`yolo is off`) and with `firstmate/required` unreported; after approval it was refused with the required check unreported, then red (`is failure`), then with a non-required check `firstmate/lint` red. |
| Waiver | An approval naming `--waive firstmate/lint` let `land` merge the PR as a merge commit, append `pr.merged` and `task.landed` with `via: "forge"`, `basis: "captain"`, the approval's sequence and the waived check; GitHub showed the PR merged and the merge commit on `main`. |
| Current head | After someone else pushed to the PR branch, `checks` read the new head, where the earlier green status did not count (`unreported`) and the earlier approval named a different commit; `land` refused with `head moved from the ready commit`, and the PR stayed open. |
| Failed publish | With no `origin` remote, the attempt ended `ready` with `pr.failed` and a captain `failed` wake; once the remote returned, `publish` opened the PR and moved the task to `pr-open`. |
| Update | A resumed ship with a new commit pushed it to its open PR and recorded `pr.updated` with the same URL and the new head. |
| No overwrite | A resumed ship whose PR branch someone else had pushed to failed to publish with `Refused to push: ... someone else pushed to it`, stayed `ready`, and the remote branch kept the other commit. |
| Yolo | The supervisor (`--forge-every 3`) left a yolo PR alone while its required check was unreported, then merged it once the check was green and raised a captain `landed` wake: `Merged https://github.com/sangh99/test-mate/pull/<n> (<head>) into main as <merge commit> under yolo`. |
| Yolo limit | A flagged yolo PR with green checks was not merged; the supervisor raised one `escalated` wake naming the flag and the PR URL. |

One forge review in an earlier run hit a GitHub `HTTP 500`; the supervisor reported it on stderr and the next review merged the PR.
That run also showed GitHub reporting a PR's previous head for a moment after a push, which is why publishing re-reads the head for a bounded time.

## Validation CLI verification

No-mistakes validation was verified live: the built `firstmate` executable on macOS ARM64 with Node v24.16.0, a temporary home, fresh clones of the throwaway repository https://github.com/sangh99/test-mate initialized with `no-mistakes init`, and the real installed no-mistakes v1.84.0 with its shared daemon and its own configured review agent.
The task worker was the real bundled Claude executable pointed at the fake Messages API, and CI was simulated by posting the ruleset's required status `firstmate/required` with `gh api`.
One scripted run passed every scenario below; the full command transcript is kept with the task's private evidence.

| Scenario | Observed through the CLI, no-mistakes and GitHub |
| --- | --- |
| Hold | `validate` on a ready ship recorded `validation.started` and `validation.run`, and the pipeline's Test step raised the `ask-user` finding `test-1`; `validate` recorded the gate, opened a hold quoting the finding verbatim, and returned `held` with the task `validating`. Driving again opened no second hold and sent nothing. |
| Answer | `answer-hold` refused an empty answer, a finding the gate lacks, and findings on an approval; it stored the captain's text verbatim and closed the hold, and a second answer was refused as already answered. |
| PR | The next `validate` recorded `validation.responded` with `by: "captain"` and the hold before sending the approval; the pipeline pushed and opened a PR, and once the required check was green it returned `checks-passed`. The task became `pr-open` with `validation.passed` and `pr.opened`, and its recorded PR URL, number, head and base matched `gh pr view` exactly. |
| Authority | `land` on the validated PR was refused without approval (`yolo is off`); after `approve` it merged with forge landing proof (`basis: "captain"`), and GitHub showed the PR merged. |
| Cancelled run | A run cancelled with `no-mistakes axi abort` while parked at a hold was read by the next `validate` as outcome `cancelled`: `validation.failed` was recorded, the task returned to `ready` at the same commit, and the captain received a `failed` wake. |
| Not initialized | In a clone never initialized for no-mistakes, `validate` recorded `The pipeline did not start a run: repo not initialized (run 'no-mistakes init' first)` as a failed validation, and the task returned to `ready`. |
| Dirty worktree | A no-mistakes ship that stopped with an uncommitted file was not submitted; its validation was recorded as failed and the task stayed `ready`. |
| Supervisor | A live supervisor validated a ready yolo ship on its own and stopped at its hold, raising a `hold` wake; once the captain answered (`carriedOutBy: "The live supervisor"`) it carried out the answer, the pipeline opened the PR, and after the check turned green the supervisor merged it under yolo with `published` and `landed` wakes carrying the full PR URL. |
| Upgrade | A version-5 home from the forge delivery verification opened at version 6 with its tasks and PR records unchanged. |

The finding policy's automatic `fix` and `approve` responses were not exercised live, because every live gate carried an `ask-user` finding; they are driven by the same response path the captain's approval used.

## Cleanup CLI verification

Cleanup and clone refresh were verified with the built `firstmate` executable on macOS ARM64 with Node v24.16.0, a temporary home, a fresh local Git repository with no remote, and a fresh clone of the throwaway repository https://github.com/sangh99/test-mate.
The task worker was the real bundled Claude executable pointed at the fake Messages API, and CI was simulated by posting the ruleset's required status `firstmate/required` with `gh api`.
One scripted run passed every scenario below; the full command transcript is kept with the task's private evidence.

| Scenario | Observed through the CLI, Git and GitHub |
| --- | --- |
| Unlanded | `cleanup` on a `local-ready` ship and on a `pr-open` ship was refused as unlanded, naming `discard`; the copy and branch stayed, and `cleanup.refused` was appended with the reason. |
| Dirty | `cleanup` on a landed ship whose copy held an untracked file was refused, listing `?? notes.txt`, with the copy and branch intact. |
| Landed | Once the file was removed, `cleanup` moved the local-landed ship to `cleaned` with `task.cleaned` (`basis: "landed"`); the copy was gone from disk and `git worktree list`, the branch was deleted, and a second `cleanup` and a `resume` were refused. A forge-landed ship, including one whose clone refresh had been refused, cleaned up the same way. |
| Discard | `discard` refused a missing reason and an already cleaned task; it recorded `discard.authorized` with the branch head. A commit made afterwards made `cleanup` refuse, naming both heads; a new authorization then let `cleanup` remove the copy with its late commit and an uncommitted file (`basis: "discard"`, the authorization's sequence). |
| Scout | A scout that failed before saving a report was refused (`the scout has no saved report`) with its copy kept; a completed scout with a saved report was cleaned (`basis: "report"`) though its copy held a scratch file, and its report remained. |
| Start from target | A ship added while another was `local-ready` recorded the old `main` as its base; run after that ship landed, its `worktree.ready` recorded the new `main` head as `start`, and its copy's history contained the landed commit. A ship added after a forge landing and refresh started from the refreshed head. |
| Refresh | `land` merged a PR while the clone held an untracked file: the task became `landed`, local `main` stayed put, and `clone.refused` was recorded. After the file was removed, `refresh` fast-forwarded local `main` to the merge commit with `clone.refreshed` (`fastForward: true`); another `refresh` reported it already current. With a local-only commit on `main`, the refresh after a landing was refused as not a fast-forward and `main` kept that commit. |
| Upgrade | A new home opened at schema version 7. |

## Projects CLI verification

The project registry, intake resolution, and capacity were verified with the built `firstmate` executable on macOS ARM64 with Node v24.16.0, a temporary home, fresh local Git repositories with no remote, and a fresh clone of the throwaway repository https://github.com/sangh99/test-mate.
The task worker was the real bundled Claude executable pointed at the fake Messages API, and CI was simulated by posting the ruleset's required status `firstmate/required` with `gh api`.
One scripted run passed every scenario below; the full command transcript is kept with the task's private evidence.

| Scenario | Observed through the CLI, Git, SQLite and GitHub |
| --- | --- |
| Register and list | `project add` registered a clone without a remote as `local-only` and the test-mate clone as `no-mistakes-prod-only` with forge `github`, naming each defaulted setting on stderr; a second name for a registered clone, a `direct-PR` posture without `origin`, a forge on `local-only`, and a name with a slash were refused. `project list` printed every field and the running count. |
| Registry posture | A ship added by project name recorded the registered `local-only` delivery and yolo on, with `intake.resolved` naming `from: "registry"`; a scout recorded the project with no policy, and a ship naming the clone path matched the registration (`matchedBy: "clone"`). |
| Explicit override | `--delivery no-mistakes --yolo off` on a `local-only`, yolo-on project recorded the explicit values with `from: "explicit"`. |
| Unregistered | A ship on an unregistered repository recorded `no-mistakes` with yolo off and `projectName` absent, and its gap was printed on stderr and recorded in `intake.resolved`; with explicit choices the gap named them as explicit. |
| Prod-only routing | On the `no-mistakes-prod-only` project a ship with no surface was refused, naming `--surface`; `internal-only` resolved to `direct-PR` and `product-facing`, `mixed`, and `uncertain` to `no-mistakes`, each recorded as `policy.surface`. An explicit `--delivery` won without a surface; a surface beside an explicit delivery or on a flat posture, and an unknown surface, were refused. The internal-only ship ran, was published as a direct-PR ship, landed on `main` after approval, and refreshed the clone's `main`. |
| Base branch override | A ship added with `--base release` recorded the `release` head as its base and `release` as its target, its copy started from that head, and its yolo landing advanced `release` while `main` stayed put; a ship added without `--base` recorded the registered default branch's head and target. |
| Capacity | With capacity 2 and three queued ships under a supervisor with concurrency 4, two ran to a pending decision while the third stayed `queued` with one `task.deferred` naming the two holders; once one decision was answered and its task ended `local-ready`, the supervisor started the third, and all three ended `local-ready`. `project show` listed the running tasks and their `fm-cap/` branches. |
| Removal | `project remove` on the project with three `local-ready` ships was refused, listing each task and how to land or discard it; an unused project was removed, its clone left on disk. |
| Malformed record | A record edited in SQLite to an unknown posture, a string yolo, and capacity 0 was reported by `project list` (exit 1), `project show`, intake by name and by clone path, `run` of its queued task, and the supervisor's `lastError`, which left that task `queued`; each message named both shape errors and the fixing commands. `project update` reported what remained after each partial repair (yolo, then capacity) and saved the record once valid. A record that was not JSON was reported as such. |
| Upgrade | A home created by the `main` build at schema version 7 with a ship opened at version 8 with the `projects` and `project_events` tables, its task unregistered and runnable to `local-ready`; a project could be added and removed there, and the older build then refused the home as newer. |

## Backlog and holds CLI verification

The backlog and captain holds were verified with the built `firstmate` executable on macOS ARM64 with Node v24.16.0, a temporary home, and fresh local Git repositories with no remote.
Task workers were the real bundled Claude executable pointed at the fake Messages API.
One scripted run passed every scenario below; the full command transcript is kept with the task's private evidence.

| Scenario | Observed through the CLI, Git, and SQLite |
| --- | --- |
| Add and list | Four items (ship, dependent ship, scout, deferred ship) were added with no task created; `backlog list` named why each waited. A missing dependency, a dependency cycle, and an unparseable defer date were refused. |
| Dispatch | `backlog dispatch` created a queued task with the item's prompt and registered project, and the item and its `items.task_id` row read `in-flight` with that task, with `item.dispatched` on the item and `item.linked` on the task; dispatching it again was refused. |
| Dependency and completion | The dependent item was refused while its dependency was in flight and stayed waiting while that ship was `local-ready`; once `land` proved the landing, the dependency closed `done` with outcome `landed`, and the dependent item became ready and dispatched. Cleanup of the landed task left the done item unchanged. |
| Defer date | A future defer date refused dispatch, a past one or `--defer none` made the item ready, and an ISO date-time was honored. |
| Hold and answer | An in-flight item was held with a reason and a deferral, shown as a deferred call. Answering without `--answer`, with an empty or blank answer, or with a gate action, removing the held item, and dispatching a held item were refused; cancelling its task left it held. A two-line answer with leading and trailing spaces was stored byte-identical (`cmp`), and the item, whose task had not finished, resumed in flight. A captain item created with `--title` refused `--release` and closed on its answer; a queued work item released by `--release` returned to the queue. |
| Finished while held | A ship whose item was held when it landed recorded the outcome on the item, which stayed held with `item.finished`, and the answer then closed it with outcome `landed`. |
| Scout captain call | A completed scout with a saved report was refused cleanup until its captain calls were attested. A captain item held with `--origin <scout>` made `--none` refused, the scout's own item and an unknown item were refused as inventory, and attesting the held item closed the scout's item with outcome `report`; cleanup then succeeded, and the captain item stayed held. |
| Divergence | With a held item's status set to done directly in SQLite, and an answered hold's record reset to open, `backlog diverged` (exit 1) reported `open-hold-on-unheld-item` and `answer-recorded-but-hold-open`, `backlog list` printed `RECORD DIVERGENCE`, and every hold stayed open. Answering each item's open hold with the captain's words reconciled both, and `backlog diverged` printed `[]`. |
| Retention | The default `doneKeep` was 10; setting 1 archived the three older done items, `backlog list --archived` listed them, `backlog show` reported an archived item as such, its id stayed reserved, and a negative value was refused. Host notes held only task ids, commits, and the target branch. |
| Upgrade | A home created by the `main` build at schema version 8, with a validation hold seeded in its store and read back by the older CLI, opened at version 9: the hold kept its id, task, and gate, gained `itemId` `gate-<id>`, and its captain item was listed `held` with no divergence. The gate answer without `--action` was refused; with it, the hold closed, the item closed `done`, `hold.answered` was appended to the task, and the older build then refused the home as newer. |

## Secondmates CLI verification

Local secondmates were verified with the built `firstmate` executable on macOS ARM64 with Node v24.16.0, a temporary main home with secondmate homes inside it, a fresh Git repository with a local bare `origin` registered `direct-PR`, and one with no remote registered `local-only`.
Task workers were the real bundled Claude executable pointed at the fake Messages API, and routed work was scouts, so no forge was involved.
One scripted run passed every scenario below; the full command transcript is kept with the task's private evidence.

| Scenario | Observed through the CLI and SQLite |
| --- | --- |
| Create | `secondmate create` seeded a home recording its id, parent, and scope, with its own copy of the `app` registration; a local-only project, a reused id, and creating a secondmate from a secondmate home were refused. |
| Idle by default | After `secondmate launch` (confirmed by the home's supervisor lease) and six seconds of reviews, the secondmate had created no task and the fake API had received no request; an item added directly in its backlog stayed queued. |
| Routing | `secondmate match` showed the one fitting candidate with its scope and reason; `route` without `--to` handed the item to it with basis `sole-project-match`, the main backlog no longer listed it, and `backlog show` named the handoff. Routing a local-only item was refused and recorded on the item as `item.routed` with basis `local-only`. |
| Correlated request and reply | A `request` for new work was delivered under its correlation; the secondmate queued, dispatched, and finished it, and `secondmate requests` mirrored its published lines (`accepted`, `dispatched`, `completed` with the scout report's path as the document, and a final `finished`) as `request.replied` events. A request for a local-only project was refused. |
| Relaunch and reconcile | With the secondmate's attempt blocked on the fake API, killing its supervisor with SIGKILL made the running main supervisor record the exit and relaunch it (attempt 1 of 2); the relaunched supervisor found its attempt orphaned, resumed the exact session (`recovery.attempted`, `run.started` with `resume: true`), finished it, and published the reply. |
| Exhaustion | Two more kills used the second relaunch and then exhausted the policy: the third exit was recorded but not relaunched, a captain item `secondmate-web-keeps-exiting` was held with the question, and the record kept three exits. `secondmate launch` then reset the count. |
| Handoff | A handoff that would strand a dependency either way was refused. With the secondmate's database held locked, a handoff of the connected pair failed after preparing: both items were in transit under the handoff record, and neither home's live backlog had them. `secondmate recover` delivered it again and recorded it placed, and both items were in the secondmate's backlog with their dependency. A handoff reset to `prepared` in SQLite after the secondmate received it was recognized by its correlation and recorded placed without placing the item twice. A handoff whose secondmate home was deleted before recovery was restored to the main backlog with `item.restored`. |
| Preferences | `preferences set` pushed the text to the secondmate home, whose copy names the main home; setting them there was refused. A copy edited in place in SQLite was replaced by the running main supervisor's review, and `preferences clear` removed the copy. |
| Retirement | `retire` was refused while the secondmate ran and while its home held a running, then interrupted, scout, its in-flight item, the unfinished request, and an unrouted item, each refusal recorded. `secondmate stop` stopped it without the main supervisor counting an exit. After a relaunch finished the scout, the captain attested the scouts and removed the unrouted item, and retirement succeeded; launching a retired secondmate was refused, and its home was kept. |
| Upgrade | A home created by the `main` build at schema version 9, with a project and a held item, opened at version 10 with both intact as a main home, and the older build then refused it as newer. |

## Dispatch CLI verification

Dispatch, runtimes, and account pins were verified with the built `firstmate` executable on macOS ARM64 with Node v24.16.0 and quota-axi 0.1.61, a temporary home, and a fresh Git repository registered `local-only`.
Task workers were the real bundled Claude executable pointed at the fake Messages API, extended to log each request's model and effort; deterministic quota cases used saved documents in `quota-axi --json` format through `quota.source: file`.
One scripted run passed every scenario below; the full command transcript is kept with the task's private evidence.

| Scenario | Observed through the CLI and SQLite |
| --- | --- |
| Precedence | With no `dispatch.json`, a task took the static runtime, Claude with its default model. With rules and a default, `--model` won as `override`; a ship mentioning docs took the `docs` rule (kind and match) over `any-ship` (kind only); a scout of `app` took `app-scouts`; a scout of another project took `default`; and with no rule fitting and no default, `static`. Two rules fitting equally were refused. A scout dispatched by rule ran, and its streamed requests reached the fake API with the rule's `model=claude-haiku-5-5` and `effort=low`; `dispatch.resolved` recorded the decision. |
| Effort fallback | With no effort named, a ship resolved `high` and a scout `xhigh`, each noting the fallback; `max` appeared only for an explicit `--effort max`. |
| Unverified runtime | `--runtime codex` and `--runtime nonsense` were refused, and so was a `dispatch.json` profile array naming `codex`; no task was created. |
| Malformed profile | A file with an unknown top-level field, an empty profile array, a duplicate rule name, an invalid kind and regular expression, an unknown profile field, an invalid effort, an array without reasoning classes and with a duplicate profile, a profile without a runtime, a relative quota path, and a negative horizon was reported in one message naming every problem by path, by `dispatch check` and by `add`; a file that was not JSON was refused the same way; no task was created. |
| Profile array | From a snapshot where Opus's model-scoped window projected exhaustion before the two-hour horizon, the task chose Sonnet, whose known `spendPriority` was highest among the candidates that last, and `show` printed all three candidates with their scopes, percentages, `spendPriority`, runway against the horizon, verdicts, and uncertainties, plus the snapshot's source and time. The run's requests carried `model=claude-sonnet-5-5` and `effort=high`. |
| Missing quota | With the snapshot's Claude provider `auth_required`, and with `quota.source: none`, no candidate was blocked: each listed its unmeasured quota and unknown runway as uncertainty, and the strongest reasoning class was chosen because no evidence distinguished them. |
| All tight | With Haiku exhausted and Opus and Sonnet projecting exhaustion inside the horizon, every candidate was `tight`, and Opus, the strongest reasoning class, was chosen despite the lowest `spendPriority`, with a note reporting the tight choice. |
| Tie | Two candidates of the same reasoning class with no measured quota were refused as tied with both listed; `--model` then settled it. |
| Account pin | A relative root was refused. Pinned to an empty directory, `add` and `dispatch resolve` were refused with `claude auth status` reporting `loggedIn false` and the exact `CLAUDE_CONFIG_DIR="<root>" claude auth login` command, and the pin was unchanged afterwards; a missing directory was refused the same way. A pin set after a task was created stopped its attempt before any worktree existed, with the same login. Pins for an unknown runtime were refused. |
| Real quota-axi | `quota.source: quota-axi` ran `quota-axi --json --provider claude`, whose Claude credential was unreadable on this machine; the decision recorded the snapshot and each candidate's disclosed uncertainty, and chose by reasoning class. |
| Upgrade | A home created by the `main` build at schema version 10, with a project and a queued scout created with `--model`, opened at version 11; the scout had no decision and ran on Claude with its model and the SDK's default effort, a new task recorded its decision, and the older build then refused the home as newer. |

## Posture and memory CLI verification

Away and quiet posture, the return brief, memory, and stow were verified with the built `firstmate` executable on macOS ARM64 with Node v24.16.0, a temporary home, a fresh Git repository registered `local-only`, and one registered `direct-PR` whose origin was a local bare repository, so its pushes succeeded and its GitHub PR could not be opened.
Task workers were the real bundled Claude executable pointed at the fake Messages API, extended to save the memory section of each request's system prompt; the supervisor ran in the background with concurrency 1.
One scripted run passed every scenario below; the full command transcript is kept with the task's private evidence.

| Scenario | Observed through the CLI and SQLite |
| --- | --- |
| Memory | `memory append` and `replace` wrote `memory/preferences.md` and `memory/learnings.md` and the shared preferences, each recorded as `memory.changed` with its hash; a blank append was refused and a blank replace cleared. A scout's attempt recorded `memory.loaded` with the three hashes, and the fake API received the worker's system prompt with the working preferences, shared preferences, and learnings verbatim under the memory heading. |
| Shared preferences to a secondmate | A new secondmate home held the main home's shared preferences as a read-only copy naming the main home. An append in the main home was pushed at once, the secondmate home's copy matched its hash, an edit there was refused, and its own learnings were writable; a scout run in the secondmate home recorded `memory.loaded` with the pushed hash, and its worker received the shared text and the secondmate's learnings. |
| Away and triage | Away words read from a file, two lines with quotes and a trailing newline, were stored byte for byte; away again without words was a refresh. Under away, the supervisor printed no `Wake` line: the direct-PR ship's `finished` wake was triaged routine and acknowledged, while three scouts' `finished` wakes and the ship's publish `failed` wake were triaged captain, stayed pending in the wake queue, and were printed only as batched for the return. New words replaced the mandate and kept the replaced words. |
| Return brief | `posture brief` and `posture return` rendered the same brief from records: the current and replaced words, the open batched wakes with their triage, the review-ready ship, the publish failure under what failed, the finished scout reports, the one routine wake handled silently, and the backlog. After the return, `posture brief --session` rendered it again as JSON. `list` and `supervisor wakes` left away standing, and `backlog add` ended a new away session and printed its brief first, recorded as `posture.exited` with the command. |
| Quiet | Under quiet, `add`, `backlog add`, and `memory append` left it standing, and `posture return` was refused; the supervisor printed the scout's `finished` and the ship's `failed` wakes at once and kept the ship's routine `finished` silent. Away replaced quiet, quiet while away returned the captain first, and only `posture quiet-off` ended quiet. |
| Stow | `stow --learning` appended the learning, gave a host note describing its state to each of four open items without notes (including the held item's question), left an item that already had a note unchanged, and recorded `stow.filed` with the noted items, the open hold, and the six captain wakes still open; it ran no Git or forge command. |
| Upgrade | A home created by the `main` build at schema version 11, with a project, shared preferences, a queued item, and a queued scout, opened at version 12 present with no posture history and all records intact; the scout ran with the shared preferences loaded into its worker's context, away was entered, and the older build then refused the home as newer. |

## Remaining verification boundaries

- Completion and session resume were verified with live Claude authentication.
  Live mutation-approval hooks and all tool execution paths remain unverified by that narrow smoke test.
- Live steering was verified for a message queued before the run.
  A message arriving mid-turn, CLI coalescing of several queued messages, and the idle settle timeout are covered only by the injected-protocol tests.
- The deterministic suite and `npm pack --dry-run` passed on Windows, macOS, and Linux in GitHub Actions, as recorded under [Fleet view and maintenance CLI verification](#fleet-view-and-maintenance-cli-verification); every CLI scenario ran only on macOS.
- Cross-platform native SDK startup and live approval-hook behavior require execution on each target platform.
- `node:sqlite` emitted its documented experimental-feature warning in the tested Node release.
- This is a local core migration, not verification of legacy Relay or remote secondmate behavior.
- A pinned Claude account was verified only as refused when signed out; a launch under a signed-in pin, and the `ordinary` pin, were not exercised, because the verification ran against the fake Messages API with a dummy key that a pinned launch unsets.
- Dispatch was verified only with Claude candidates, so quota evidence from a provider other than `claude`, a schema-6 snapshot with several accounts, and profile floors were not exercised.
- Secondmates were verified only on one host with scouts as routed work; a routed ship's publishing and landing in a secondmate home, two secondmates sharing a project's clone and capacity, and a secondmate exiting on its own rather than by SIGKILL were not exercised.
- No-mistakes validation was verified only on a repository with no runnable product, so the pipeline never raised `auto-fix` or `no-op` findings, review questions, protected-path refusals, or fix rounds; a pipeline that pushes its own fix commits, and a CI monitor that rebases a PR, were not exercised.
- Forge delivery was verified only against GitHub with commit statuses as checks; check runs from GitHub Actions, classic branch protection, merge queues, and forks were not exercised.
- Capacity was verified for queued starts under one supervisor; the waits of a stale relaunch, an orphan resume, and `run-all` for a place were not exercised through the CLI.
- The supervisor was verified only through the CLI against a fake API, not with a live model.
  Whether a long live tool call emits SDK messages often enough for the default 600-second silence bound was not measured.
- The `steer` wakes for uncertain and unsettled steering were not exercised through the CLI.
- The `refresh` wake was not exercised through a supervisor, and the refresh of a target not checked out in the clone (the `update-ref` path) was not exercised.
- A validation gate holding a dispatched ship's own item was not exercised, because the pipeline raised no gate needing the captain in the validation checks; a gate hold was exercised only as a migrated record.
- After verification runs that killed supervisor processes, two Claude Code processes remained whose Firstmate parent had exited, each blocked on a fake API request or a pending approval, and one ignored SIGTERM.
  Orphan recovery proves only the Firstmate owner dead and does not track or stop such a process.

## Integrations and events CLI verification

The extension registry, process sources, the captain inbox, Relay, promised final replies, upstream signals, and the outbox were verified with the built `firstmate` executable on macOS ARM64 with Node v24.16.0 and a temporary home, with no model contacted.
Relay ran against a local HTTP stand-in that required a bearer token, served queued mentions after a cursor, and recorded each reply once per idempotency key; upstream signals used the throwaway repository `sangh99/test-mate` through GitHub CLI 2.75.0.
One scripted run passed every scenario below; the full command transcript is kept with the task's private evidence.

| Scenario | Observed through the CLI, SQLite, the fake relay, and GitHub |
| --- | --- |
| Process source result | A once source registered with the argument `a b; echo pwned` received it as one argument and nothing else ran; registering it again unchanged was `unchanged`. The supervisor captured result 1 and printed its `source-result` wake; `source handled` printed `handled` and retired the wake, a repeat printed `already-handled`, and an unknown sequence was refused. |
| Condition and re-announcement | A `--every 1 --when changed` source ran eight times and captured only the two runs whose output changed. After `supervisor ack` retired result 1's wake while it stayed unhandled, the supervisor announced it again (announcement 2 of 3) until `source handled`. |
| Failed to start and stranded | A source whose command did not exist became `failed` with a `source-down` wake. A supervisor killed with SIGKILL left its `sleep` run alive; the next supervisor raised a `source-down` wake naming the live process and held the source `stranded` instead of running it twice, until `source start`. Re-registering the failed source replaced its registration and retired its wake. |
| Captain inbox | `inbox note` saved a note with its `note` wake; the same `--request-id` returned it as `replay` with no new wake. It counted as waiting until `inbox ack`, which retired the wake (a repeat was `already-handled`); `inbox reply` published reply sequence 1, a second reply was refused, and `inbox receipts --after` read it by cursor. |
| Relay mention and consent | With Relay configured, the supervisor polled the fake relay and recorded the mention with its `mention` wake. `outbox send` of the queued reply without consent was refused and recorded, and the relay received nothing; after `outbox consent` it was sent once, and sending again returned `already-sent` with the same receipt. |
| Promised final reply | A promise bound a mention to a task; after the task was cancelled and discard was authorized, `cleanup` was refused naming the open promise, the supervisor raised a `followup` wake, and cleanup stayed refused while the final reply awaited consent. Sending the consented `--final` reply reconciled the promise and retired its wake, and cleanup then succeeded. The relay logged exactly one request per outbox key. |
| Upstream signal | A throwaway issue was linked to a backlog item from its state at link time. A comment and the issue's closing became `comment` and `closed` signals with wakes; `upstream ack` refused an unknown token, acknowledged the exact tokens with their dispositions, and was idempotent. |
| Upstream comment through the outbox | `outbox send` without consent was refused and GitHub showed no comment; after consent it was posted once, sending again was `already-sent`, and a send retried from the `sending` state found the comment by its key's marker instead of posting again. The posted comment was not reported back as a signal. |
| Upgrade | A home created by the `main` build at schema version 12, holding supervisor wakes and a captain wake its away session triaged, opened at version 13 with every wake's sequence, task, and status and its triage intact and no foreign-key violations; the return brief still listed the triaged wake, an inbox wake was presented and acknowledged with it, and the older build then refused the home as newer. |

## Fleet view and maintenance CLI verification

The fleet snapshot, bearings, the supervisor drain, self-update, and the Bash import were verified with the built `firstmate` executable on macOS ARM64 with Node v24.5.0 and npm 11.5.1 against temporary homes, with workers on the real bundled Claude executable against a local fake Messages API, so no model was contacted.
Self-update ran an installed copy: the branch packed with `npm pack` as 0.1.0 and as 0.1.1 (only the version changed), 0.1.0 installed with `npm install --global --prefix <temporary prefix>`, and neither published.
GitHub operations used the throwaway repository `sangh99/test-mate` through GitHub CLI 2.75.0.
One scripted run passed every scenario below; the full command transcript is kept with the task's private evidence.

| Scenario | Observed through the CLI, SQLite, npm, and GitHub |
| --- | --- |
| Snapshot | One home held a review-ready local-only ship, a landed one, a finished scout, a direct-PR ship whose PR the forge opened, a queued task, a queued item, an item depending on it and held with a future `--until`, a held captain item, a launched secondmate, quiet posture, an inbox note, a captured source result, and an upstream comment awaiting consent. `fleet` listed each with its state, the secondmate `live`, the supervisor `absent`, and the landing and the scout's report as recent; `list` printed exactly its task rows. |
| Bearings | The text and `--json` forms put the open hold, both review-ready ships, the note, the outbox action, and the source result under Captain's Call, the landing and the report under Recently Landed, and the deferred hold, the queued task, the ready item, and a no-supervisor warning under Charted Next. `--file` wrote `reports/bearings-<date>.md` with each item's detail, and a second run replaced it rather than appending. The database's event, home event, wake, and item event counts were unchanged by every form, `--prs` included. |
| Live PRs | `fleet --prs` read the open PR's head and its required check `firstmate/required` as `unreported` and reported it not mergeable for that reason and the missing approval; without `--prs` no forge call was made. After the hold was answered, the note handled, and the queued task cancelled, bearings moved each of them, and showed the running supervisor `live`. |
| Refused: foreground run | With a task running in the foreground, `update` was refused naming it, recorded as a refused run, and changed nothing: the version stayed 0.1.0 and the same supervisor kept running. |
| Refused: no drain in time | With the supervisor running a task that never ends, `update --wait 3` drained the idle secondmate, withdrew the main supervisor's drain after three seconds, restarted the secondmate on 0.1.0 under a new PID, and was refused naming the task; the task kept running under the same supervisor and nothing was installed. |
| Dry run | `update --dry-run` printed the npm argument array and each home's restart arguments, reproduced from its supervisor's recorded settings, and recorded nothing. |
| Interrupted and resumed | An update killed with SIGKILL while draining left its run recorded as `draining` with the drain still requested; a new `update` was refused as unfinished, and `update resume` withdrew the drain, restarted the secondmate that had stopped, and closed the run `failed` with 0.1.0 still installed. |
| Safe update | With no work running, `update` drained both supervisors (the original exited with reason `drained`), installed 0.1.1, and restarted the secondmate and then the main supervisor from the new installation under new PIDs with the same settings; `doctor` reported 0.1.1, the old PIDs were gone, task states were unchanged, and a task queued afterwards was run by the restarted supervisor. The home recorded `update.refused`, `update.started`, `update.failed`, and `update.finished` events, and no Firstmate process was left running afterwards. |
| Import | A copy of the Bash home's `data` directory, extended with queued items, a dependency, an encoded captain hold, a dated `future` hold, an item blocked by in-flight work, a `secondmate` row, a Gerrit-bound project, and a project without a clone, was planned without `--apply` (the home stayed empty) and then imported: one project with its posture and the `fm/` prefix, four items in dependency order with the decoded captain question and date as an open hold, the future hold as a deferral and note, and the preferences and learnings verbatim. Every other record was skipped with its reason; a second `--apply` imported nothing, `--only learnings` imported only learnings, and the Bash files' digests were unchanged, the original's included. |
| Upgrade | A home created by the `main` build at schema version 13, with a lease left by a supervisor killed with SIGKILL, queued work, a hold, an inbox note, and away posture, opened at version 14 with the `updates` and `imports` tables; the snapshot and bearings read every record, a new supervisor reclaimed the lease and stopped with reason `drained` on `supervisor drain`, and the older build then refused the home as newer. |
| Cross-platform CI | The workflow ran `npm ci`, `npm test`, and `npm pack --dry-run` on ubuntu-latest, macos-latest, and windows-latest for this branch's tree pushed to `sangh99/test-mate`. Its first runs failed on Windows, where a home and a project under a temporary directory compared as an 8.3 short name against its long form, so the home-inside-project refusal did not fire; containment now compares native real paths, of a path's nearest existing ancestor when it does not exist yet. |
