# Helper migration inventory

The original `bin/` contains 219 files: 203 shell scripts, 9 Python files, 5 JavaScript modules, one jq program, and one Perl script.
This inventory accounts for every file by responsibility using the architecture document and script headers.
It is a migration worklist, not a claim that every script has been behaviorally audited or replaced.
The [machine-readable inventory](helper-inventory.json) records the exact file-to-family mapping.

## Migration approach

Port externally observable behavior into TypeScript services.
Preserve state transitions, authority checks, recovery obligations, and delivery evidence.
Replace terminal transport with SDK operations where those operations serve the same capability.
Keep optional integrations behind explicit adapters.
The existing shell scripts should not become a required runtime dependency, because that would preserve their platform assumptions on Windows.
Source file counts do not measure feature completeness; one safety-critical library may contain more behavior than many wrappers.

## Family coverage

| Family | Files | Status | Destination |
| --- | ---: | --- | --- |
| Bash development and lab tools | 16 | Development only | npm scripts, tests and standalone CI |
| Away posture and operational memory | 8 | Partial | Posture records with the verbatim away mandate, posture-aware wake triage in the supervisor, the ReturnBrief renderer, home Memory loaded into worker context, and Stow; planned memory tiers and budget, spend caps and the return catch-up gate |
| Relay, public commitments, mail and voice | 17 | Partial | Optional Relay connector behind an HTTP adapter with mention wakes, follow-up budget, and typed promised final replies that gate cleanup, and the consent-gated durable Outbox; planned mail and voice connectors |
| Persistent and remote secondmates | 33 | Partial | Local secondmate registry, Transport adapter, transactional Handoff, correlated requests and published replies, bounded relaunch, shared preferences; planned remote transport |
| Registered checks, process events and extensions | 13 | Partial | One extension registry opened by the supervisor, process-to-event sources with registration generations, durable captured results and handled acknowledgements; planned registered checks, condition-action watches, and trusted external adapters |
| Fleet projections and presentation | 6 | Partial | FleetSnapshot behind list, fleet and bearings (terminal, JSON, or a dated file) with opt-in live PR reads; planned visual fleet board |
| Model dispatch, accounts and quota | 6 | Partial | Dispatch profiles with precedence, quota-resolved profile arrays with per-candidate evidence, the effort fallback, and Claude account pins; planned vendor auth probes, tool exclusions, and mid-task quota wakes |
| Terminal and harness-specific mechanics | 35 | Replace mechanism | Worker runtime adapter with the Claude SDK as the verified reference; optional future runtime adapters |
| Validation, publishing and landing | 19 | Partial | Delivery modes, merge authority, local-only landing, GitHub direct-PR delivery through the Forge adapter, no-mistakes validation through the Pipeline adapter, clone refresh, and Cleanup; planned other forges |
| Continuous supervision and recovery | 30 | Partial | Supervisor, wake queue, event classifier, recovery ladder and per-project capacity; planned fleet review |
| Task lifecycle and durable steering | 18 | Partial | TaskStore steering records, lifecycle controls, the backlog and captain holds, Orchestrator streaming input; planned keyed-answer channels and board reconcile requests |
| Projects, configuration and process utilities | 18 | Partial | Worktrees, ProcessRunner, project registry with intake resolution and capacity, npm self-update that drains and restarts the supervisors, and opt-in Bash record import; planned Config beyond the registry |

Partial means some basic behavior exists, with legacy guarantees still to implement.
Replace mechanism means terminal plumbing is unnecessary for a Claude SDK runtime; its generic ownership, permission, or supervision contracts still need host services.
Development only identifies old repository tooling rather than an application capability.

## Suggested implementation order

1. Explicit holds; durable steering with evidence-backed acknowledgements is implemented, and so are a backlog of items apart from tasks and captain holds on any item that only the captain's verbatim answer closes.
2. Continuous supervision; the supervisor lease, durable consumer acknowledgements, actionable-event classification, SDK-activity liveness, bounded recovery and per-project capacity are implemented, while fleet review against forge state remains.
3. Validation and delivery; explicit delivery modes and merge posture, the merge-authority evaluation, proven local-only landing, GitHub direct-PR publishing, current-head checks, head-bound merges and forge landing proof, and no-mistakes validation with durable gates and holds, the guarded clone refresh after a forge landing, and cleanup that refuses unlanded work are implemented, while other forges remain.
4. Project registration, posture resolution and capacity are implemented, and so are backlog dependencies, defer dates, and fleet views from one structured projection.
5. Persistent secondmates and remote execution with host-bound identity, correlations and reply recovery.
6. Dispatch policy over verified runtimes, quota evidence and account pins is implemented, while runtimes other than Claude remain.
7. Away and quiet posture, the return brief, home memory and stow are implemented, and so are the extension registry, process sources, the captain inbox, Relay, upstream signals, the outbox, the fleet snapshot and bearings, self-update, and the opt-in Bash import; mail and voice connectors and the visual fleet board remain.

The SDK supplies the model loop, tools and sessions.
Firstmate retains responsibility for orchestration, durable obligations, authority, delivery and recovery.
Effect manages in-process execution; SQLite persists obligations across process failure.

## Contract examples

- `fm-send.sh` and `fm-task-inbox-lib.sh`: preserve durable message identity, acknowledgements and retry behavior; replace terminal doorbells with SDK input delivery.
- `fm-watch.sh` and `fm-wake-drain.sh`: preserve actionable-event classification and post-handling acknowledgements; replace pane polling with SDK events and explicit external probes.
- `fm-pr-merge.sh`, `fm-landed-lib.sh` and `fm-teardown.sh`: preserve independent merge authority, current-head checks, landing proof and refusal to discard unlanded work.
- `fm-procevent.sh`: preserve registration generation, durable captured results and handled acknowledgements; implement process lifecycle through Node and Effect.
- Remote and secondmate helpers: preserve host-local ownership and correlated delivery; replacing SSH command syntax alone is not enough.

## Architecture area coverage

The Bash application's `docs/architecture.md` divides into an event plane, a decision plane, execution ownership, and durable delivery evidence.
Its durable wake queue, generation-bound acknowledgements, status folding, busy-state adapters, watcher successor restoration, steering inboxes, and terminal composer checks all serve the guarantees listed in the standalone [architecture](architecture.md#guarantees).
Porting those shell mechanics line by line would preserve costs an SDK-based host no longer needs, so the standalone host owns the SDK query and its event stream directly.

| Bash architecture area | Standalone implementation |
| --- | --- |
| Ship/scout intake | Explicit task kinds, prompts, immutable bases, budgets and models |
| Task metadata and status logs | Typed task projection plus transactional event history |
| Worktree isolation | Native Git worktrees, preserved on every outcome |
| Busy terminal parsing and pane delivery | Direct SDK query lifecycle and message stream |
| Ownership/incarnation protection | Process lease plus random generation token |
| Open keyed decisions | Persistent per-request approvals, explicit answer, expiry on run closure |
| Supervisor cancellation | Durable cancel request plus SDK abort and scoped close |
| Restart recovery | Explicit resume of exact session and existing worktree; a supervisor also resumes the attempts it interrupted and, on its bounded ladder, attempts whose owner died |
| Model-free routine supervision | The supervisor waits on timers and SQLite reads; only task attempts call a model |
| Ship delivery | Delivery mode and yolo resolved from the task or its project's registration and recorded at intake; `ready`, `local-ready` and `pr-open` are distinct from `landed` |
| Scout reports | Immutable Markdown report per successful attempt |
| Multiple queued tasks | A supervisor runs queued tasks within one concurrency bound; `run-all` remains a one-shot snapshot |
| Steering inbox and worker acknowledgement | Durable steering records delivered through SDK streaming input; acknowledged only on reply-stamp evidence |
| Merge authority and local landing | One evaluation of captain approval, yolo, flags and waivers; a local-only ship lands by guarded fast-forward with local Git proof |
| Validation pipelines and forge delivery | A Forge adapter with a GitHub implementation publishes direct-PR ships, reads checks for the PR's current head, merges bound to that head only through the one authority evaluation, and lands only on forge proof; a Pipeline adapter drives no-mistakes for no-mistakes ships, decides auto-fix and no-op findings by host policy, holds every other finding for the captain, and delivers the PR it opens the same way; other forges are not implemented |
| Persistent or remote secondmates | Local secondmates: an isolated home with its own store and supervisor, launched as a separate process, idle until work is routed to it, with correlated requests, replies read from its published status, a transactional backlog handoff, a bounded relaunch policy that escalates as a captain hold, main-authoritative shared preferences, and guarded retirement; remote secondmates are not implemented |
| Runtime/harness/account dispatch catalog | A worker runtime adapter with only verified runtimes dispatchable (Claude today), `dispatch.json` rules and defaults with explicit precedence, profile arrays resolved from one `quota-axi` snapshot with per-candidate evidence on the task, and developer-only account pins checked before dispatch and launch; other runtimes are not implemented |
| Durable wake queue and post-handling acknowledgement | Wakes classified from the event log through a durable cursor, claimed by one consumer generation, and retired only by that generation's acknowledgement |
| Wedge detection and recovery | An SDK-activity silence bound raises stale wakes; interrupt and exact-session relaunch on a bounded per-task ladder that escalates when exhausted |
| Lifecycle control plane | Durable interrupt and relaunch requests that the owning attempt applies, separate from steering text |
| Away/quiet posture, memory curation | A posture record per home with the away words stored verbatim as the whole mandate, supervisor triage that acknowledges routine captain wakes silently and batches captain-relevant ones, a return brief rendered only from durable records, memory files and the shared preferences record loaded into each worker's context, and stow; tiered memory decay and the startup-memory budget are not implemented |
| Relay, inbox integrations, promised public replies | One extension registry the supervisor opens under its generation; process sources whose captured results are wakes until handled; captain inbox notes acknowledged after handling with one durable reply; optional Relay mentions with typed promised final replies that refuse their task's cleanup until reconciled; upstream signals acknowledged by exact token; and an outbox that sends a public action only on recorded consent, once under its own key; mail and voice connectors are not implemented |
| Fleet clone synchronization and self-update | A guarded clone refresh after each forge landing; `firstmate update` installs a `firstmate-ai` package over the npm installation after draining every supervisor, refuses with nothing changed when a home is unsafe or work does not drain in time, and restarts the main and secondmate supervisors from the new installation; remote secondmate homes are not updated |
| Fleet snapshot and bearings | One read-only projection behind `list`, `fleet`, and bearings, sorted into Captain's Call, Recently Landed, Underway and Charted Next in the terminal, as JSON, or as a dated report file; PRs are read live only with `--prs`; the visual fleet board is not implemented |
| Desktop or browser presentation | CLI in this version |

The Bash application continues to own its own state and integrations.
This package never imports the old private fleet records automatically; `firstmate import` reads a Bash home's project registry, queued backlog items and captain holds, preferences, and learnings only when asked, showing its plan before `--apply`.

The implementation drew on the local Claude Agent SDK documentation (configuration, permissions, hooks, sessions, user input, quickstart, and cost tracking), supplemented by the installed SDK's TypeScript declarations, and on the Effect v4 documentation, source, `LLMS.md`, and installed declarations.

## Complete file inventory

### Bash development and lab tools

Status: **Development only**.

Target: npm scripts, tests and standalone CI.

- `bin/fm-doc-audience-check.sh`
- `bin/fm-herdr-ci-cleanup.sh`
- `bin/fm-herdr-lab-viewer.py`
- `bin/fm-herdr-lab.sh`
- `bin/fm-install-actionlint.sh`
- `bin/fm-install-herdr.sh`
- `bin/fm-install-shellcheck.sh`
- `bin/fm-install-treehouse.sh`
- `bin/fm-jev-mem-guard.py`
- `bin/fm-jev-mem-guard.sh`
- `bin/fm-lab-home.sh`
- `bin/fm-lint-workflows.sh`
- `bin/fm-lint.sh`
- `bin/fm-live-lab.sh`
- `bin/fm-test-isolation-proof.sh`
- `bin/fm-test-run.sh`

### Away posture and operational memory

Status: **Partial**.

Target: Posture records with the verbatim away mandate, posture-aware wake triage in the supervisor, the ReturnBrief renderer, home Memory loaded into worker context, and Stow; planned memory tiers and budget, spend caps and the return catch-up gate.

`fm-afk-contract.sh`'s record is ported as the home's posture record: away with the captain's words stored verbatim as the whole mandate, which nothing parses, replaced words kept for the brief, and quiet, which only an explicit quiet-off ends.
`fm-afk-launch.sh` and `fm-afk-start.sh` launched a daemon that triaged wakes in a terminal; the supervisor now triages each captain wake itself under the posture, so their mechanism is replaced rather than ported.
`fm-afk-return.sh`'s return brief is rendered from the home's records (posture, open holds and decisions, open wakes with their triage, review-ready tasks, failures, landings, finished findings, and the backlog); its catch-up gate over open blockers and its teardown of landed workers are not ported.
The spend cap and expected return of an away entry, the startup-memory budget and tiered decay (`fm-startup-memory-budget*.sh`, `fm-startup-growth-check.sh`), and stow cascading to secondmates (`fm-stow-cascade.sh`) remain pending.

- `bin/fm-afk-contract.sh`
- `bin/fm-afk-launch.sh`
- `bin/fm-afk-return.sh`
- `bin/fm-afk-start.sh`
- `bin/fm-startup-growth-check.sh`
- `bin/fm-startup-memory-budget-lib.sh`
- `bin/fm-startup-memory-budget.sh`
- `bin/fm-stow-cascade.sh`

### Relay, public commitments, mail and voice

Status: **Partial**.

Target: Optional Relay connector behind an HTTP adapter with mention wakes, follow-up budget, and typed promised final replies that gate cleanup, and the consent-gated durable Outbox; planned mail and voice connectors.

Relay, the outbox, and promised final replies are implemented in `src/extensions.ts`, `src/relay.ts`, and `src/ledger.ts`.
Relay is off unless `relay configure` names an endpoint and the environment variable holding its token, replacing the `FMX_PAIRING_TOKEN` opt-in; the supervisor polls it through the Relay adapter (`fm-x-poll.sh`), each new mention is a wake, and `relay ack` and `relay dismiss` replace clearing the inbox file and `fm-x-dismiss.sh`.
`relay link` and `relay promise` replace `fm-x-link.sh` and `fm-public-followup.sh register`: a promise is a typed commitment bound to a task, due as a wake once the task's work ends, and `cleanup` refuses the task until its final reply is sent or the captain releases it, which replaces the terminal reconciliation of `fm-public-followup-collect.sh` and `fm-public-followup-emit.sh`.
Every reply (`fm-x-reply.sh`, `fm-x-followup.sh`) is an outbox action that is sent only after `outbox consent` records the captain's consent for that exact action, under its id as the idempotency key; the follow-up budget of three within seven days is enforced when a reply is queued.
This deliberately replaces fmx-respond's standing authorization for autonomous replies with per-action consent, as the port's spec requires.
Platform-aware thread splitting, inbound media, the `x-mode-error` wake, promises bound to secondmate homes, and the mail and voice connectors (`fm-mail*`, `fm-voice*`, `fm_voice_*`) remain pending; a mail or voice connector registers as an extension with its own outbound channel.

- `bin/fm-mail-check.sh`
- `bin/fm-mail.py`
- `bin/fm-mail.sh`
- `bin/fm-public-followup-collect.sh`
- `bin/fm-public-followup-emit.sh`
- `bin/fm-public-followup-lib.sh`
- `bin/fm-public-followup.sh`
- `bin/fm-voice-client.py`
- `bin/fm-voice-relay.py`
- `bin/fm-x-dismiss.sh`
- `bin/fm-x-followup.sh`
- `bin/fm-x-lib.sh`
- `bin/fm-x-link.sh`
- `bin/fm-x-poll.sh`
- `bin/fm-x-reply.sh`
- `bin/fm_voice_frame.py`
- `bin/fm_voice_records.py`

### Persistent and remote secondmates

Status: **Partial**.

Target: the secondmate registry and history in the main home's store, the `Transport` adapter, the transactional Handoff record, correlated requests with replies read from published status, the supervisor's relaunch policy, and shared preferences; planned remote transport.

Local secondmates are implemented in `src/secondmates.ts`.
`secondmate create` replaces `fm-home-seed.sh` for a local home: the new home records its identity and parent, gets a copy of its non-local-only projects' registrations and the shared preferences, and a failed registration removes the home it created.
The secondmate registry replaces `data/secondmates.md` and `fm-secondmate-registry-lib.sh`; routing by scope stays the captain's judgment, shown by `secondmate match` and recorded on the item, and the host only proposes the one secondmate whose home has the item's project.
`secondmate handoff` and `route` replace `fm-backlog-handoff.sh` and `fm-backlog-receive.sh` with a durable handoff record: the items leave the main backlog in transit under it, the secondmate home receives them once per correlation, and `secondmate recover` places an interrupted handoff forward or restores it when that home is gone or retired.
Correlated requests replace `fm-pending-reply-lib.sh`'s pending-reply record and `fm-secondmate-report.sh`: the request is durable before delivery, and its replies are the status lines the secondmate home's supervisor publishes from its own records (`fm-parent-channel-lib.sh`'s "scripts report facts" rule), never the transcript.
The main supervisor's relaunch policy replaces `fm-secondmate-liveness-lib.sh` and the local part of `fm-secondmate-restart.sh`, and shared preferences replace the `data/captain-shared.md` part of `fm-config-inherit-lib.sh` and `fm-config-push.sh`.
Remote homes (`fm-on.sh`, the `fm-remote-*` helpers), host-bound identity, config inheritance other than the shared preferences, the missed-reply recovery request and escalation, and the self-update restart pass remain pending.

- `bin/fm-backlog-handoff.sh`
- `bin/fm-backlog-receive.sh`
- `bin/fm-config-inherit-lib.sh`
- `bin/fm-config-push.sh`
- `bin/fm-home-seed.sh`
- `bin/fm-on.sh`
- `bin/fm-parent-channel-lib.sh`
- `bin/fm-pending-reply-lib.sh`
- `bin/fm-remote-delta-read.sh`
- `bin/fm-remote-doctor.sh`
- `bin/fm-remote-entrypoint.sh`
- `bin/fm-remote-file.sh`
- `bin/fm-remote-herdr-guard.sh`
- `bin/fm-remote-herdr-owner-lib.sh`
- `bin/fm-remote-home-provision.sh`
- `bin/fm-remote-home-seed.sh`
- `bin/fm-remote-inherit-push.sh`
- `bin/fm-remote-inherit.sh`
- `bin/fm-remote-job-lib.sh`
- `bin/fm-remote-job-reap-orphans.sh`
- `bin/fm-remote-job-worker.sh`
- `bin/fm-remote-readiness-lib.sh`
- `bin/fm-remote-secondmate-control.sh`
- `bin/fm-remote-secondmate-relaunch.sh`
- `bin/fm-secondmate-charter-lib.sh`
- `bin/fm-secondmate-liveness-lib.sh`
- `bin/fm-secondmate-nudge-lib.sh`
- `bin/fm-secondmate-parent-lib.sh`
- `bin/fm-secondmate-reconcile.sh`
- `bin/fm-secondmate-registry-lib.sh`
- `bin/fm-secondmate-report.sh`
- `bin/fm-secondmate-restart-lib.sh`
- `bin/fm-secondmate-restart.sh`

### Registered checks, process events and extensions

Status: **Partial**.

Target: One extension registry opened by the supervisor, process-to-event sources with registration generations, durable captured results and handled acknowledgements; planned registered checks, condition-action watches, and trusted external adapters.

The extension registry in `src/extensions.ts` replaces `fm-extension.sh`'s registration for in-process extensions: an event source or connector registers once, the supervisor opens it under its own generation, and it delivers into the wake queue only through records committed with their wakes.
Process sources replace `fm-procevent.sh` and `fm-procevent-lib.sh`'s generic runner: `source register` stores an argument array with a registration generation, the supervisor runs it as its own child (never through a shell) once or on an interval, a run whose deterministic `--when` condition holds is stored before its wake in one transaction, and `source handled` is the exact, idempotent acknowledgement that stops the bounded re-announcement.
A launch that fails and a run a dead supervisor stranded are wakes; a stranded process that is still alive holds the source until `source start`, as reconcile's orphaned state did.
The Lavish, quota, remote-reply, and condition-action (`when`) adapters, registered checks (`fm-check-*`), the launch barrier, keyed-answer bindings, external extension packages, and cross-home source ownership remain pending.

- `bin/fm-check-lib.sh`
- `bin/fm-check-register.sh`
- `bin/fm-check-unregister.sh`
- `bin/fm-extension-launch-barrier.mjs`
- `bin/fm-extension.mjs`
- `bin/fm-extension.sh`
- `bin/fm-procevent-extension-capture.pl`
- `bin/fm-procevent-lavish.sh`
- `bin/fm-procevent-lib.sh`
- `bin/fm-procevent-quota.sh`
- `bin/fm-procevent-remote-reply.sh`
- `bin/fm-procevent-when.sh`
- `bin/fm-procevent.sh`

### Fleet projections and presentation

Status: **Partial**.

Target: FleetSnapshot behind list, fleet and bearings (terminal, JSON, or a dated file) with opt-in live PR reads; planned visual fleet board.

The fleet snapshot replaces the bounded fleet-state reads of `fm-fleet-snapshot.sh` and `fm-bearings-snapshot.sh` with one projection of the home's own records, and bearings replaces the four-section digest and dated report the `bearings` skill composed from them.
Secondmates appear with their observed liveness and open requests rather than through a parent-side ledger cache, so `fm-home-summary-refresh.sh` has no counterpart; `fm-fleet-ledger.sh`'s activity ledger, `fm-fleet-view.sh`'s terminal board, and `fm-bearings-board.sh`'s interactive board remain unported.

- `bin/fm-bearings-board.sh`
- `bin/fm-bearings-snapshot.sh`
- `bin/fm-fleet-ledger.sh`
- `bin/fm-fleet-snapshot.sh`
- `bin/fm-fleet-view.sh`
- `bin/fm-home-summary-refresh.sh`

### Model dispatch, accounts and quota

Status: **Partial**.

Target: dispatch profiles with precedence, quota-resolved profile arrays with per-candidate evidence, the effort fallback, and Claude account pins; planned vendor auth probes, tool exclusions, and mid-task quota wakes.

Dispatch is implemented in `src/dispatch.ts` and the worker runtime adapter in `src/runtime.ts`, with the Claude runtime in `src/agent.ts`.
`dispatch.json` replaces `config/crew-dispatch.json` with deterministic rule conditions (kind, project, prompt match) instead of natural-language rules matched by judgment, and its load validation replaces bootstrap's `CREW_DISPATCH` diagnostics.
Profile-array resolution replaces the `quota-array-dispatch` procedure, `fm-quota-axi-lib.sh`, and `fm-quota-choose.sh`: one `quota-axi --json` read per dispatch, the eligibility, reasoning-class, and runway gates, `spendPriority` ranking, the strongest-reasoning rule when every candidate is tight, and refused ties.
`fm-dispatch-resolve.sh`'s typed resolver is not ported, because rule matching is deterministic; its `approval` and `min_confidence` fields have no counterpart.
Account pins replace `config/claude-account` and the Claude part of `fm-worker-account-lib.sh`, checked through the bundled `claude auth status`; Pi pins, `fm-vendor-auth-probe.sh`, `fm-exclude-tools-lib.sh`, and the `fm-procevent-quota.sh` mid-task quota wake remain pending.

- `bin/fm-dispatch-resolve.sh`
- `bin/fm-exclude-tools-lib.sh`
- `bin/fm-quota-axi-lib.sh`
- `bin/fm-quota-choose.sh`
- `bin/fm-vendor-auth-probe.sh`
- `bin/fm-worker-account-lib.sh`

### Terminal and harness-specific mechanics

Status: **Replace mechanism**.

Target: worker runtime adapter with the Claude SDK as the verified reference; optional future runtime adapters.

- `bin/backends/cmux.sh`
- `bin/backends/herdr-eventwait.py`
- `bin/backends/herdr-workspace-move.py`
- `bin/backends/herdr.sh`
- `bin/backends/orca.sh`
- `bin/backends/tmux.sh`
- `bin/backends/zellij.sh`
- `bin/fm-agent-process-lib.sh`
- `bin/fm-agy-trust.sh`
- `bin/fm-arm-command-policy.mjs`
- `bin/fm-arm-pretool-check.sh`
- `bin/fm-backend-hometag-lib.sh`
- `bin/fm-backend.sh`
- `bin/fm-cd-command-policy.mjs`
- `bin/fm-cd-pretool-check.sh`
- `bin/fm-claude-stop-autoarm.sh`
- `bin/fm-claude-trust.sh`
- `bin/fm-composer-lib.sh`
- `bin/fm-cursor-lib.sh`
- `bin/fm-devin-config.sh`
- `bin/fm-gemini-lib.sh`
- `bin/fm-harness.sh`
- `bin/fm-herdr-session-cleanup.sh`
- `bin/fm-hook-host-lib.sh`
- `bin/fm-kimi-turnend-hook.sh`
- `bin/fm-peek.sh`
- `bin/fm-sessionstart-cursor.sh`
- `bin/fm-sessionstart-nudge.sh`
- `bin/fm-sessionstart-run.sh`
- `bin/fm-subagent-pretool-check.sh`
- `bin/fm-supervisor-target-lib.sh`
- `bin/fm-tmux-lib.sh`
- `bin/fm-turnend-guard-cursor.sh`
- `bin/fm-turnend-guard-grok.sh`
- `bin/fm-turnend-guard.sh`

### Validation, publishing and landing

Status: **Partial**.

Target: Delivery modes, merge authority, local-only landing, GitHub direct-PR delivery through the Forge adapter, no-mistakes validation through the Pipeline adapter, clone refresh, and Cleanup; planned other forges.

Ship intake records a delivery mode and yolo posture, resolved from the task or its registered project, merge authority is evaluated in one place, and a local-only ship lands by a guarded fast-forward that marks it `landed` only on local Git proof.
A direct-PR ship is pushed and opened as a GitHub PR whose URL is recorded from the forge's response; its merge reads the required and reported checks for the PR's current head only, goes through the same authority evaluation, is bound to that head, and marks the task `landed` only when the forge shows the merge commit on the target, with a one-line outcome carrying the PR URL after a yolo merge.
A no-mistakes ship is validated by the no-mistakes pipeline through a Pipeline adapter that runs `no-mistakes axi` with argument arrays through a ProcessRunner; each gate and finding is recorded, auto-fix and no-op findings are decided by the host's documented policy, every other finding becomes a hold the captain answers, and the PR the pipeline opens is recorded from the forge and merged through the same authority.
After a forge landing the project clone's target is refreshed by a guarded fast-forward, as `fm-fleet-sync.sh` did after teardown, and a ship's isolated copy starts from its target's current head.
`firstmate cleanup` replaces the worktree and branch part of `fm-teardown.sh`: it removes a task's copy and branch only for a clean landed ship whose branch holds nothing unlanded, a scout whose report is saved, or under a discard authorization recorded for the current branch head, refuses while a hold on its pipeline gate is open or a scout's captain calls are not attested, and records every refusal; there is no force flag.
Upstream contribution signals replace the observation half of `fm-contributions.sh`: `upstream link` ties an issue or PR to a backlog item or task from the forge's state now, the supervisor observes it through the Forge adapter, each new comment, review, or state change is triaged from the forge's own fields into a wake, and `upstream ack` acknowledges one exact token with its disposition; maintainer verdicts bound to a judged head and cross-home contributions remain pending.
Pipeline branch custody recovery after a failed run, GitLab, Forgejo/Gitea and Gerrit adapters, merge-method selection, mergeability and merge-queue handling, PR reviewer requests, pruning of merged remote branches, and the captain-hold check before a merge remain pending; cleanup closes the task's backlog item (see Task lifecycle).

- `bin/fm-contributions.jq`
- `bin/fm-contributions.sh`
- `bin/fm-dod-lib.sh`
- `bin/fm-gate-refuse-lib.sh`
- `bin/fm-git-strip-ai-trailers.sh`
- `bin/fm-landed-lib.sh`
- `bin/fm-merge-authority-lib.sh`
- `bin/fm-merge-local.sh`
- `bin/fm-merge-outcome-lib.sh`
- `bin/fm-nm-run-lib.sh`
- `bin/fm-pipeline-spend.sh`
- `bin/fm-pr-check.sh`
- `bin/fm-pr-lib.sh`
- `bin/fm-pr-merge.sh`
- `bin/fm-pr-poll.sh`
- `bin/fm-pr-reviewers.sh`
- `bin/fm-pr-state.sh`
- `bin/fm-review-diff.sh`
- `bin/fm-teardown.sh`

### Continuous supervision and recovery

Status: **Partial**.

Target: Supervisor, wake queue, event classifier, recovery ladder and per-project capacity; planned fleet review.

The persistent supervisor is implemented: a home lease that refuses a second live owner, queued execution within one concurrency bound, a durable wake queue fed by classifying the event log through a cursor, consumer acknowledgement bound to a queue generation, liveness from SDK activity with a configurable silence bound, and a bounded per-task recovery ladder that escalates.
The supervisor also keeps each project within its registered capacity, as `fm-project-capacity-lib.sh` did for spawns: a task beyond it stays queued and starts once a place frees.
Posture-aware triage is implemented (see Away posture and operational memory), and so are process-event sources and the other extensions the supervisor opens (see Registered checks, process events and extensions); fleet review against forge state, dependencies and time gates, and secondmate liveness remain pending.
Terminal mechanics in this family, such as watcher re-arming, pane hashes, busy-state adapters and session locks, are replaced by the SDK stream and the leases rather than ported.

- `bin/fm-bootstrap.sh`
- `bin/fm-branch-dispatch.mjs`
- `bin/fm-branch-outcome.sh`
- `bin/fm-branch-prompt.sh`
- `bin/fm-branch-report.sh`
- `bin/fm-busy-event.sh`
- `bin/fm-busy-lib.sh`
- `bin/fm-classify-lib.sh`
- `bin/fm-crew-state.sh`
- `bin/fm-guard.sh`
- `bin/fm-host-mirror.sh`
- `bin/fm-inactive-reconcile.sh`
- `bin/fm-lock-lib.sh`
- `bin/fm-lock.sh`
- `bin/fm-push-transition-lib.sh`
- `bin/fm-session-lock-lib.sh`
- `bin/fm-session-start.sh`
- `bin/fm-startup-network.sh`
- `bin/fm-supervise-daemon.sh`
- `bin/fm-supervision-engine-lib.sh`
- `bin/fm-supervision-host.sh`
- `bin/fm-supervision-instructions.sh`
- `bin/fm-supervision-lib.sh`
- `bin/fm-transition-lib.sh`
- `bin/fm-wake-drain.sh`
- `bin/fm-wake-grant.sh`
- `bin/fm-wake-lib.sh`
- `bin/fm-watch-arm.sh`
- `bin/fm-watch-checkpoint.sh`
- `bin/fm-watch.sh`

### Task lifecycle and durable steering

Status: **Partial**.

Target: TaskStore steering records, lifecycle controls, the backlog and captain holds, Orchestrator streaming input; planned keyed-answer channels and board reconcile requests.

Durable steering is implemented: per-task records with stable identity and never-reused sequences, evidence-backed delivery and acknowledgement through the SDK's streaming input, and transcript reconciliation on resume.
Lifecycle control is implemented as durable interrupt and relaunch requests that the owning attempt applies, separate from steering text.
The backlog replaces the `tasks-axi` backlog and `fm-backlog-transition-lib.sh`'s fused transitions with item records in the home's SQLite store: dispatch creates an item's task and moves it in flight in one transaction, and a landing, a scout's attestation, or cleanup closes it in the transaction that changes the task, with dependencies, defer dates, host notes free of ephemeral identifiers, and a configured number of recent done items (default 10, like `done_keep`).
Captain holds replace `fm-captain-hold.sh`'s hold, answer (with `--release`), complete, verify, and diverged: one hold model holds any item with a reason, optional deferral and origin, closes only on the captain's verbatim answer, keeps a held item open when its task finishes, gates a scout's cleanup on an attested captain-call inventory, and reports contradictory records without closing anything; validation-gate holds recorded before the backlog migrate onto captain items.
The captain inbox replaces `fm-inbox.sh`'s `note`, `announce`, `reply`, and `receipts`: `inbox note` saves a note and its wake in one transaction (idempotent by `--request-id`), the note counts as waiting until `inbox ack` after handling, and `inbox reply` publishes its one durable reply under a per-home sequence that `inbox receipts --after` reads; `say`, `ask`, `status`, and `ready` remain pending.
Keyed-answer channels (`answers`, `bind`), board reconcile requests, wakes for holds that are not pipeline gates, the supervisor dispatching ready items, and the captain-hold check before a merge remain pending.

- `bin/fm-backlog-transition-lib.sh`
- `bin/fm-brief-heading-lib.sh`
- `bin/fm-brief.sh`
- `bin/fm-captain-hold.sh`
- `bin/fm-control-lib.sh`
- `bin/fm-control.sh`
- `bin/fm-decision-hold.sh`
- `bin/fm-hold-reason-lib.sh`
- `bin/fm-inbox.sh`
- `bin/fm-lease-lib.sh`
- `bin/fm-lease.sh`
- `bin/fm-operational-input.sh`
- `bin/fm-promote.sh`
- `bin/fm-send.sh`
- `bin/fm-spawn.sh`
- `bin/fm-task-inbox-lib.sh`
- `bin/fm-tasks-axi-lib.sh`
- `bin/fm-tasks-axi.sh`

### Projects, configuration and process utilities

Status: **Partial**.

Target: Worktrees, ProcessRunner, project registry with intake resolution and capacity, npm self-update that drains and restarts the supervisors, and opt-in Bash record import; planned Config beyond the registry.

The project registry replaces `data/projects.md`, `fm-project-mode.sh` and `config/project-capacity` with typed records in the home's SQLite store, validated on every load, and its CLI adds, lists, shows, updates and removes projects.
Intake resolves each ship's delivery mode, yolo, base and target branch and branch prefix from the task or its registration, routes a `no-mistakes-prod-only` project's ships by their declared surface, and defaults an unregistered project to `no-mistakes` with yolo off, reporting the gap.
Removal refuses while a project has unlanded work, and never touches the clone.
Forge bindings other than GitHub (`forge=gerrit`, `forge=forgejo`), capacity shared across homes and secondmates, origin-identity matching of clones, project creation and cloning, no-mistakes initialization, and the remaining configuration files remain pending.
`firstmate update` replaces `fm-update.sh` for an npm installation: instead of fast-forwarding a Git checkout, it installs a package, and instead of the persist-gated agent restart, it drains each supervisor, so no attempt is interrupted, and restarts it from the new installation; remote secondmate homes are not covered.
`firstmate import` reads `data/projects.md`, `data/backlog.md`, `data/captain.md`, `data/captain-shared.md`, and `data/learnings.md` from a Bash home only on request.

- `bin/fm-ensure-agents-md.sh`
- `bin/fm-env-lib.sh`
- `bin/fm-ff-lib.sh`
- `bin/fm-fleet-sync.sh`
- `bin/fm-forge-detect.sh`
- `bin/fm-line-cap-lib.sh`
- `bin/fm-marker-lib.sh`
- `bin/fm-path-lib.sh`
- `bin/fm-primary-scope-lib.sh`
- `bin/fm-project-capacity-lib.sh`
- `bin/fm-project-mode.sh`
- `bin/fm-project-origin-lib.sh`
- `bin/fm-tangle-lib.sh`
- `bin/fm-timeout-lib.sh`
- `bin/fm-timing-lib.sh`
- `bin/fm-tool-update-check.sh`
- `bin/fm-trace-context-lib.sh`
- `bin/fm-update.sh`
