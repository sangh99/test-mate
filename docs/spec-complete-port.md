# Spec: complete the standalone Firstmate port

Status: ready for agent.
Scope: every capability the Bash Firstmate provides that the standalone `firstmate-ai` package does not yet provide.

## Problem Statement

A developer who installs `firstmate-ai` through npm gets a local, single-user core: isolated ship and scout tasks, foreground runs, durable approvals, durable steering, exact-session resume, and saved scout reports.
They cannot hand Firstmate a backlog and walk away.
Nothing watches the fleet between commands, so a stuck worker, a finished task, or a waiting approval goes unnoticed until they look.
Ship work stops at a local `ready` state: it is never validated by a pipeline, pushed, opened as a PR, checked against CI, merged under explicit authority, confirmed landed, or cleaned up, so isolated copies accumulate.
There is no project registry, so every task names a repository path and nothing records per-project delivery posture, branch prefix, or machine capacity.
There are no captain holds, no backlog, no persistent secondmates, no choice of worker runtime or account beyond the Claude SDK, no away or quiet posture, no operational memory, no Relay or inbox integrations, no fleet report, and no self-update.
A Bash Firstmate user who switches to the standalone app therefore loses most of what makes Firstmate a first mate rather than a task runner.

## Solution

The standalone app grows, in dependency order, the host services that the Bash application implements as helper scripts, porting each capability's externally observable contract rather than its shell mechanics.

1. A persistent supervisor owns queued execution and actionable events across all tasks, with a durable wake queue, explicit consumer acknowledgements, stuck-worker detection and bounded recovery, and no model calls while waiting.
2. Validation and delivery turn a `ready` ship into evidence: an explicit delivery mode, a validation pipeline run, a PR on a forge, CI results tied to the current head, a merge only under explicit authority, confirmed landing, and cleanup that refuses to remove unlanded work.
3. A project registry carries per-project delivery mode, merge posture, branch prefix, base branch and capacity, and feeds one structured fleet projection.
4. Captain holds and a backlog make decisions durable work items that only the captain's recorded answer closes.
5. Persistent secondmates, local and remote, run with isolated homes, charters, routed work, correlated replies and recovery.
6. Dispatch policy chooses a worker runtime, model and account from configured profiles and quota evidence.
7. Away and quiet postures, operational memory, connectors (Relay, inbox, mail, voice), registered event sources, fleet reports, and self-update complete the surface.

Throughout, the app keeps the guarantees already established: durable records over conversation memory, generation-fenced ownership, evidence-based state changes, preserved unlanded work, and honest reporting of uncertainty.

## User Stories

### Supervision and recovery

1. As a developer, I want to start one long-running supervisor for my home, so that queued tasks run and progress continues without me issuing `run` commands.
2. As a developer, I want the supervisor to refuse to start when another live supervisor owns the same home, so that two hosts never execute the same fleet.
3. As a developer, I want a supervisor that crashed to be recoverable only after its owner is proven dead, so that ambiguous ownership never leads to duplicate execution.
4. As a developer, I want every actionable event (a task finished, failed, needs a decision, was steered, stopped responding) written to a durable wake queue, so that nothing is lost across restarts.
5. As a developer, I want each wake acknowledged only after it has been handled, so that an interruption leaves it to be handled again rather than silently dropped.
6. As a developer, I want acknowledgements bound to a queue generation, so that a late acknowledgement from an old consumer cannot discard newer wakes.
7. As a developer, I want handling of a repeated wake to be idempotent, so that re-handling after a crash does not repeat side effects.
8. As a developer, I want routine waiting to make no model calls, so that an idle fleet costs nothing.
9. As a developer, I want the supervisor to detect a worker that has produced no SDK activity for a configured period, so that stuck work is surfaced.
10. As a developer, I want a stuck worker recovered through bounded steps (inspect, interrupt, resume the exact session) and then escalated, so that recovery never loops forever.
11. As a developer, I want a worker that repeatedly fails the same way to stop being retried and be reported, so that I see the failure instead of spend.
12. As a developer, I want a periodic fleet review that reconciles each task's durable state with its live owner and the forge, so that drift is corrected.
13. As a developer, I want an unchanged fleet never reported as progress, so that notifications stay meaningful.
14. As a developer, I want open decisions to stay visible until the actor who owns them closes them, so that unrelated progress never hides a pending question.
15. As a developer, I want the supervisor to start queued tasks automatically as dependencies, time gates, and project capacity allow, so that the backlog drains without me.
16. As a developer, I want the supervisor to stop cleanly on a signal and leave every task resumable, so that restarts are non-events.
17. As a developer, I want a steering message the worker never acknowledged to raise a wake after the settle bound, so that undelivered instructions are not silent.
18. As a developer, I want the supervisor's own state (last review, queue position, owned tasks) inspectable as JSON, so that I can debug it.

### Validation, delivery, and landing

19. As a developer, I want each ship task to carry an explicit delivery mode chosen at intake (`no-mistakes`, `direct-PR`, `local-only`), so that the delivery path is never guessed.
20. As a developer, I want each ship task to carry an explicit merge posture (yolo on or off), so that merge authority is decided before work starts.
21. As a developer, I want a `no-mistakes` ship validated by the no-mistakes pipeline, which owns review, fixes, tests, documentation, push, PR and CI, so that no manual review gate is invented.
22. As a developer, I want validation findings that need my judgment escalated to me and the rest decided by the host's documented policy, so that the worker never answers its own finding.
23. As a developer, I want a `direct-PR` ship pushed and opened as a PR without the pipeline, so that fast-path work still produces a reviewable artifact.
24. As a developer, I want a `local-only` ship to stop on a clean ready branch, so that landing is a local fast-forward I approve.
25. As a developer, I want the PR URL recorded from the forge's response, never assembled, so that every link I receive is real.
26. As a developer, I want CI status tied to the PR's current head commit, so that a stale green result never authorizes a merge.
27. As a developer, I want a PR merged only after my explicit word, or automatically only when yolo is on and every required check is green, so that merge authority is never inferred.
28. As a developer, I want a red PR or one with an unreported required check refused for merge unless I name the check to waive in the moment, so that waivers are explicit and scoped.
29. As a developer, I want destructive, irreversible, or security-sensitive merges escalated even under yolo, so that standing authority has limits.
30. As a developer, I want a merge reported as landed only when the forge or local Git proves the commit is on the target branch, so that "merged" is never claimed falsely.
31. As a developer, I want a one-line outcome with the full PR URL after any autonomous merge, so that I can audit what landed.
32. As a developer, I want cleanup to remove a task's isolated copy and branch only after landing is proven or I explicitly authorize discarding the work, so that unlanded work is never lost.
33. As a developer, I want cleanup to refuse when the isolated copy has uncommitted or unpushed changes, so that a refusal is never bypassed by default.
34. As a developer, I want a scout's isolated copy discarded only after its report exists and its open captain calls are recorded, so that findings survive cleanup.
35. As a developer, I want merged PRs to refresh the project's local clone through a guarded fast-forward, so that new tasks start from current code.
36. As a developer, I want forge support behind an adapter (GitHub first; GitLab, Forgejo/Gitea and Gerrit later), so that delivery is not tied to one host.

### Projects, configuration, and capacity

37. As a developer, I want to register a project once with its clone location, default branch, delivery mode, merge posture and branch prefix, so that tasks name the project instead of a path.
38. As a developer, I want an unregistered project to default to `no-mistakes` with yolo off and the gap reported, so that the safe posture applies.
39. As a developer, I want a `no-mistakes-prod-only` posture that routes internal-only work to `direct-PR` and everything else to `no-mistakes`, so that tooling work moves faster without guessing from file location.
40. As a developer, I want a per-task base branch override, so that work can target a release or feature branch.
41. As a developer, I want a per-project capacity limit, so that the supervisor never runs more concurrent workers than my machine can handle.
42. As a developer, I want a spawn beyond capacity to leave the task queued rather than failed or blocked, so that it runs when capacity frees up.
43. As a developer, I want project removal to refuse while the project has unlanded work, so that removal never discards changes.
44. As a developer, I want configuration validated at load with actionable errors, so that malformed config is reported rather than routed around.
45. As a developer, I want all configuration stored in the private home with a documented schema, so that it is portable across Windows, macOS and Linux.

### Captain holds and backlog

46. As a developer, I want a durable backlog of work items separate from running tasks, so that I can queue ideas before dispatch.
47. As a developer, I want an item dispatched only through the host, which moves it to in-flight atomically, so that the backlog never disagrees with execution.
48. As a developer, I want completion and cleanup to move the item to done, so that backlog state follows proven outcomes.
49. As a developer, I want to hold any item for my decision with a reason and optional defer-until date, so that pending calls are durable work.
50. As a developer, I want a held item closed only with my recorded answer, so that the host never decides for me.
51. As a developer, I want captain calls discovered by a scout recorded as held items before the scout is considered complete, so that findings never lose their decisions.
52. As a developer, I want contradictory records of one decision surfaced for reconciliation, so that a divergence is never treated as proof that I ruled.
53. As a developer, I want dependencies between items, so that dependent work waits.
54. As a developer, I want backlog notes free of ephemeral identifiers and the configured number of recent done items retained, so that the backlog stays readable.

### Persistent and remote secondmates

55. As a developer, I want to create a persistent secondmate with its own isolated home, charter and scope, so that a domain of work has a dedicated supervisor.
56. As a developer, I want new work routed to the secondmate whose scope fits, so that I keep one point of contact.
57. As a developer, I want a secondmate idle by default and acting only on routed work, so that it never invents surveys or sweeps.
58. As a developer, I want routed requests carried with a correlation identity and replies returned through status or a document pointer, so that the main home never reads the secondmate's chat.
59. As a developer, I want an unconfirmed remote request resent only with its original correlation, so that the remote side deduplicates it.
60. As a developer, I want a secondmate that exits to be relaunched under a bounded policy and repeated exits investigated, so that recovery is not a loop.
61. As a developer, I want a secondmate on another machine bound to its host identity, so that two hosts never claim the same home.
62. As a developer, I want backlog handoff to a secondmate to be transactional, so that an item is never in two homes or none.
63. As a developer, I want shared captain preferences propagated to secondmates from the main home, so that preferences stay consistent.
64. As a developer, I want retiring a secondmate to refuse while it holds unlanded work, so that retirement is safe.

### Dispatch, runtimes, and accounts

65. As a developer, I want worker runtimes behind an adapter (Claude SDK today; Codex, OpenCode, Pi, Gemini and others later), so that I can choose the right tool per task.
66. As a developer, I want dispatch profiles that map task kinds to runtime, model and effort, so that routing follows my configured rules.
67. As a developer, I want routing precedence to be explicit per-task override, then best-fit rule, then default, then static runtime, so that dispatch is predictable.
68. As a developer, I want a profile array resolved from current quota evidence with every candidate accounted for, so that the choice is inspectable.
69. As a developer, I want missing quota data treated as disclosed uncertainty rather than a blocker, so that dispatch is not stalled by unmeasurable headroom.
70. As a developer, I want my strongest-reasoning choice preserved when every candidate is tight, and the tight choice reported, so that quality is never silently downgraded.
71. As a developer, I want account pins changed only by me, with a refusal reporting the login needed, so that the host never edits credentials.
72. As a developer, I want an unverified runtime refused rather than launched, so that dispatch only uses proven adapters.

### Away and quiet posture, memory

73. As a developer, I want to enter an away posture with my own words recorded verbatim as the mandate, so that the host acts within what I said.
74. As a developer, I want routine events handled silently and only captain-relevant ones batched for me while away, so that I return to a summary, not noise.
75. As a developer, I want a return brief rendered from durable records when I come back, so that I can pick up where I left off.
76. As a developer, I want a quiet posture that reduces routine notifications while I stay present and only an explicit command exits it, so that I can focus.
77. As a developer, I want my working preferences, shared preferences and curated learnings stored in the home and loaded at session start, so that context survives restarts.
78. As a developer, I want a stow command that files uncaptured knowledge and open work records before a reset, so that nothing important lives only in a conversation.

### Integrations and events

79. As a developer, I want registered process-to-event sources whose results become wakes, so that external conditions trigger supervision without polling by a model.
80. As a developer, I want a captain inbox where notes are acknowledged after handling and can receive durable replies, so that asynchronous requests are tracked.
81. As a developer, I want optional Relay integration for public mentions, follow-ups and promised final replies, so that public commitments are honored.
82. As a developer, I want optional mail and voice connectors behind adapters, so that integrations never become core dependencies.
83. As a developer, I want upstream contribution signals triaged when work links to an upstream issue, so that external follow-ups are not forgotten.
84. As a developer, I want every outbound public action to require recorded consent, so that nothing is published by inference.

### Fleet view and maintenance

85. As a developer, I want one structured fleet snapshot (tasks, items, holds, PRs, secondmates, supervisor health), so that every report reads the same truth.
86. As a developer, I want a bearings report in chat or as a dated file, so that I can catch up quickly.
87. As a developer, I want an optional visual fleet board, so that complex states are easier to review.
88. As a developer, I want a self-update command that upgrades the npm package and restarts the supervisor and secondmates safely, so that fixes reach running homes.
89. As a developer, I want the app to run on Windows, macOS and Linux with CI proving each, so that installation via npm works everywhere.
90. As a developer, I want an import path for selected Bash Firstmate records, only on explicit request, so that migration is possible without automatic coupling.

## Implementation Decisions

- **Port contracts, not scripts.** Each helper family becomes a typed Effect v4 service; shell scripts never become a runtime dependency. The family-to-service mapping in the helper migration inventory is the worklist.
- **Implementation order** follows dependencies: supervisor; validation and delivery; projects and capacity; holds and backlog; secondmates; dispatch; posture, memory, connectors, reports, self-update.
- **One store per home.** All new durable state (wake queue, consumer acknowledgements, backlog items, holds, projects, PR and landing evidence, secondmate registry, correlations, outbox) lives in the existing SQLite database with mutations and their events committed in one transaction. Each addition bumps the schema version with a forward migration; an unknown newer version refuses to open.
- **Supervisor service.** Owns a home-level lease (local host and PID, like task leases) and refuses a second live owner. It runs task attempts in scoped fibers bounded by per-project capacity, consumes the event log through a durable cursor, classifies events into actionable wakes, and acknowledges each wake by generation after handling. Waiting is timer- and database-driven, never a model call. Recovery is a bounded ladder per task with a recorded attempt count; exhausting it escalates.
- **Liveness evidence** is SDK message activity per generation; a configurable silence bound turns into a stale wake. Interrupt and relaunch go through a lifecycle control operation separate from steering text.
- **Delivery service** with modes `no-mistakes`, `direct-PR` and `local-only`, and an orthogonal yolo flag, both required at task creation for ships and recorded on the task. Unregistered projects resolve to `no-mistakes` with yolo off.
- **Validation adapter** runs the no-mistakes pipeline as an external process through a process runner with argument arrays; its result and findings become durable records. Findings needing judgment become holds.
- **Forge adapter** interface: open PR, read PR state and head, read required checks for a head, merge with expected head, read landing proof. GitHub is the first implementation; others plug in later. PR URLs are stored only from forge responses.
- **Merge authority** is evaluated in one place: explicit captain approval or yolo, all required checks green on the current head, no destructive or security-sensitive flag, and any waiver named explicitly per check. Every merge goes through it; there is no lower-level path.
- **Landing and cleanup.** A task becomes `landed` only on forge or local Git proof that its commit is on the target branch. Cleanup removes a worktree and branch only when landed or when an explicit discard authorization is recorded, and refuses on dirty or unpushed state. New task states extend the transition table: `ready` → `validating` → `pr-open` → `landed` → `cleaned`, plus `local-ready` for local-only, with failure paths back to resumable states.
- **Project registry** records clone path, default branch, delivery mode, merge posture, branch prefix (default `firstmate/`), and capacity. Tasks reference a project by name; a path-only task is still accepted and reported as unregistered.
- **Backlog and holds** are their own records: items with status (queued, in-flight, held, done), dependencies, defer dates and notes. Dispatch and completion move items transactionally with task changes. Holds close only through a captain-answer operation that stores the answer verbatim.
- **Secondmates** reuse the home abstraction: each has its own home, store and supervisor, launched as a separate process. The parent communicates through a correlation-keyed request record and reads replies from the secondmate's published status, never its transcript. Remote secondmates use a transport adapter with host-bound identity and idempotent enqueue.
- **Worker runtime adapter** generalizes the current SDK service: open a session with streaming input, emit a normalized event stream (session id, text, tool use, reply stamps, results, cost), interrupt, and read a transcript. The Claude SDK is the reference implementation; other runtimes must pass an adapter verification suite before dispatch accepts them.
- **Dispatch policy** consumes configured profiles and a quota provider and returns a decision with per-candidate evidence; the decision is stored with the task.
- **Posture and memory** are home records: posture mode plus verbatim mandate, a return-brief renderer over durable records, and memory files for preferences and learnings.
- **Connectors** (Relay, inbox, mail, voice) and event sources register through one extension registry and deliver into the wake queue; outbound actions go through a durable outbox that requires recorded consent.
- **Fleet snapshot** is one read-only projection consumed by CLI `list`, bearings, and any visual board.
- **CLI** stays the primary interface: new command groups for supervisor, projects, backlog and holds, delivery and merge, secondmates, posture, and reports. All commands keep JSON output.

## Testing Decisions

- **One primary seam: the application layer.** Tests compose the application layer with injected external adapters and drive behavior through the same Effect programs the CLI uses, asserting on durable records, events, files and Git state, never on internal fiber or helper structure. This is how the existing orchestrator and steering tests work, using an injected SDK query factory and transcript reader.
- **Adapters injected at that seam:** worker runtime (fake CLI simulator, as in the existing test helpers), forge, validation pipeline, process runner, clock, quota provider, remote transport and connectors. No test contacts a model, forge or network.
- **Real local resources:** real SQLite databases, real Git repositories and worktrees, and subprocess ownership probes, as the existing store and platform tests already do.
- **CLI tests** run the built executable with a temporary home, only for argument parsing and JSON contracts.
- **Contract tests per adapter interface** run against every implementation, so that a new runtime or forge proves the same behavior before it is accepted.
- **Live tests** stay opt-in and budget-capped (existing live test pattern): runtime adapters and the GitHub forge against a disposable repository.
- **Good tests** state a user-visible guarantee: a wake survives a crash, a red PR is refused, cleanup refuses unlanded work, a hold stays open until answered. Each safety refusal gets a test that tries to bypass it.
- **Prior art:** the store tests (ownership, generation fencing, transactional rollback), the orchestrator tests (cancellation, approvals, resume), the steering tests (evidence-based acknowledgement, reconciliation), and the platform tests (path and isolation checks).
- **CI** runs the deterministic suite on Windows, macOS and Linux once the package is its own repository root.

## Out of Scope

- Terminal multiplexer backends (tmux, Herdr, Zellij, cmux, Orca) and pane parsing; the SDK transport replaces them.
- Harness-specific turn-end guards, prompt hooks and session-start nudges for interactive coding CLIs.
- Bash development and lab tooling, which is replaced by npm scripts and the TypeScript test suite.
- Automatic import of Bash Firstmate private records; only an explicit opt-in import is considered.
- An operating-system sandbox for workers; isolated worktrees and approvals remain the boundary, and this limitation stays documented.
- A hosted or multi-user service; the app remains local to one developer, with remote secondmates as the only cross-machine feature.
- Network-shared homes.

## Further Notes

- The Bash Firstmate's `AGENTS.md`, `docs/architecture.md`, `docs/configuration.md` and skill files are the behavioral reference for each capability; consult them per slice rather than porting from memory.
- Each slice should update the helper migration inventory's family status and the verification record with what was proven live versus only through injected adapters.
- Durable steering is already implemented; its evidence model (state changes only on proof, uncertainty surfaced rather than inferred) is the template for wakes, delivery evidence and secondmate replies.
- The npm package name `firstmate-ai`, Node 24 baseline, Effect 4.0.4 and Claude Agent SDK 0.3.296 pins remain until a slice needs to change them.
