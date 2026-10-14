# Firstmate AI

A standalone, npm-installable CLI for local AI task orchestration using Node.js, TypeScript, Effect v4, and the Claude Agent SDK.
It creates isolated Git worktrees, streams Claude's work, persists task history and approvals, and resumes the exact recorded SDK session.
Ship tasks stop ready for human review, local-only ships land by an approved local fast-forward, direct-PR ships are opened as GitHub PRs that land by an authorized merge, and no-mistakes ships are validated by the no-mistakes pipeline, which opens that PR; scout tasks produce durable Markdown reports.

This is the first executable migration of Firstmate's core lifecycle.
The [architecture](docs/architecture.md) explains the app's guarantees, modules, task lifecycle, and current scope.
The [helper migration inventory](docs/helper-migration.md) accounts for all 219 legacy helper files and identifies their replacement services and remaining work.

## Requirements

- Node.js 24 LTS with npm, and Git on `PATH`.
- An existing Claude Code login, `ANTHROPIC_API_KEY`, or a provider supported by the SDK.
- A local Git repository with at least one commit.
- For `direct-PR` and `no-mistakes` ships: the GitHub CLI `gh`, logged in, and an `origin` remote on GitHub.
- For `no-mistakes` ships: [no-mistakes](https://kunchenguid.github.io/no-mistakes/) installed with its daemon running, and the project clone initialized with `no-mistakes init`.

The host application runs without Bash scripts, tmux, Treehouse, a database server, or a TypeScript compiler on the end user's machine.
Claude's own command tool has its own platform requirements; on Windows use Git for Windows with Git Bash available to Claude.
Keep npm optional dependencies enabled: the pinned SDK distributes native Claude binaries for Windows, macOS, and Linux, including x64 and ARM64 variants.
This package uses Node's built-in `node:sqlite`, which is experimental in the tested Node 24 release and emits a warning.

## Build and install locally

Run these commands inside this directory:

```text
npm ci
npm test
npm pack
npm install --global ./firstmate-ai-0.1.0.tgz
firstmate --help
```

The package is not published to the npm registry.
Packing includes compiled JavaScript and declarations, so installing the tarball requires no build toolchain.
During development, use `node dist/cli.js` instead of `firstmate` after `npm run build`.
The directory can be copied out into its own repository; it has no runtime imports from the Bash Firstmate checkout.

## Run a task

For local subscription use, sign in with Claude Code using `claude auth login` and run Firstmate under the same operating-system account and Claude configuration.
The SDK handles the existing login; Firstmate does not extract or copy credentials.
Anthropic's [current subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) confirms that Agent SDK usage can draw from subscription limits.
If you prefer API authentication, configure the key in the shell running Firstmate.

macOS or Linux:

```sh
export ANTHROPIC_API_KEY='your-api-key'
```

Windows PowerShell:

```powershell
$env:ANTHROPIC_API_KEY = 'your-api-key'
```

Create the local home, register a project, and enqueue work:

```text
firstmate init
firstmate doctor
firstmate project add parser --clone /absolute/path/to/repository --delivery local-only
firstmate add --project parser --kind ship --prompt "Fix the parser and run its relevant tests" --budget 5 --max-turns 30
firstmate run <task-id>
```

On Windows, supply a Windows path such as `C:\work\my-project` for `--clone` and `--project`.
Task creation returns its ID and how its project and policy were resolved as JSON, and captures the selected local base commit immediately.
Use `--base origin/main` after your own fetch when that is the desired starting point; Firstmate does not silently fetch or change the source checkout.
Model, effort, and turn/budget limits are recorded per task; see [Dispatch](#dispatch) for how the runtime, model, and effort are chosen and overridden.
Budget limits apply to each attempt; explicit resume starts another attempt.
A ship's delivery mode (`--delivery no-mistakes`, `direct-PR`, or `local-only`) and merge posture (`--yolo on` or `off`) come from its project's registration unless the task names them, and a scout refuses both.
Its target branch is `--target`, else `--base` when that names a local branch, else the project's default branch, else, for an unregistered project, the branch checked out there; a ship whose target cannot be determined is refused.

## Projects

```text
firstmate project add <name> --clone <repo> [--default-branch <branch>] [--delivery <posture>] [--yolo on|off] [--branch-prefix <prefix>] [--capacity <n>|none] [--forge github|none]
firstmate project update <name> [any of the same settings]
firstmate project list
firstmate project show <name>
firstmate project remove <name>
```

A registered project records its clone, default branch, delivery posture, yolo, branch prefix, capacity, and forge in the home's database.
`project add` states each default it applied: the checked-out branch, `no-mistakes-prod-only` when the clone has an `origin` remote and `local-only` otherwise, yolo off, the `firstmate/` branch prefix, no capacity limit, and the GitHub forge unless the project is local-only.
A `no-mistakes`, `direct-PR`, or `no-mistakes-prod-only` project needs an `origin` remote.
`add --project` takes a project's name or a repository root; a root that some project registers uses that registration.
A task's explicit `--delivery` and `--yolo` win over the registration, and `--base <branch>` starts the task from and lands it on that branch instead of the default branch.
On a `no-mistakes-prod-only` project a ship declares its surface: `--surface internal-only` ships `direct-PR`, and `product-facing`, `mixed`, or `uncertain` ships `no-mistakes`; the surface is never inferred from file paths or names, and a ship that declares none is refused unless it names `--delivery`.
A task on an unregistered repository is accepted, reported as unregistered on stderr and in its `intake.resolved` event, and defaults to `no-mistakes` with yolo off.
With a capacity, at most that many of the project's attempts run at once; the supervisor leaves a task beyond it queued, records `task.deferred`, and starts it once a place frees, and `run` refuses it without changing it.
Updating a project changes only tasks created afterwards.
`project remove` unregisters the project without touching its clone, and refuses while any of its tasks holds unlanded work.
A malformed registry record is reported with what is wrong and the command that fixes it, and nothing that needs it proceeds; `project update` can repair it.

The run stays in the foreground and streams text to stderr.
Use a second terminal to inspect and answer requests:

```text
firstmate decisions <task-id>
firstmate answer <decision-id> --decision allow
firstmate answer <decision-id> --decision deny --answer "Use a narrower command"
```

Approval applies to the exact recorded tool input for that run only.
Inspect that input before approving shell commands; an approved shell command runs with your account's filesystem and network access.
For `AskUserQuestion`, pass `--answer` containing a JSON object mapping the exact question text to the answer, for example `{"Which option?":"Option A"}` using your shell's quoting rules.
There is no automatic approve-all mode.
Project/user settings are disabled to prevent inherited hooks and permission rules from silently changing execution policy.
Workers are instructed to read project instructions as task context.

## Observe, interrupt, and resume

```text
firstmate list
firstmate show <task-id>
firstmate events <task-id> --after 0
firstmate cancel <task-id>
firstmate interrupt <task-id> --reason "Wrong approach"
firstmate relaunch <task-id> --prompt "Resume from the parser module"
firstmate resume <task-id> --prompt "Continue from the existing changes"
firstmate steer <task-id> --message "Also update the changelog"
firstmate steers <task-id>
firstmate requeue <steer-id>
firstmate run-all --concurrency 2
```

`run-all` executes a snapshot of queued tasks with bounded concurrency, preserves every task's outcome, and returns a failing exit code if any run fails.
It does not run continuously; the [supervisor](#supervise) does.
`steer` durably queues follow-up text for a task from any terminal using the same home.
A live run feeds it to Claude between or during turns and stays open until the reply that answers it arrives; otherwise it waits for the next run or resume.
`steers` shows each message's status: `pending`, `submitted`, `delivered`, `acknowledged`, or `uncertain`.
A message is `acknowledged` only when Claude's reply is tied to it, never merely because it was queued or sent.
If a run stopped before that proof, resume checks the saved session transcript: delivered messages are named in the resume prompt, unsent ones are resent, and ones that cannot be checked become `uncertain` until `requeue` explicitly resends them.
Steering is text only.
`interrupt` stops the running attempt and leaves the task resumable, `relaunch` stops it and resumes the same session with an optional new prompt, and `cancel` stops the task.
A relaunch is resumed by a running supervisor, or by the next one to start.
Ctrl+C interrupts execution while keeping the task, session ID, and worktree.
`cancel` requests cancellation through durable state; the owning run observes it without sending signals to arbitrary processes.
A dead owner's old running record is presented as `observedState: "unknown"` until explicit resume, or a supervisor's recovery, reconciles it.
Recovery does not replay external actions automatically.
Before resuming after a hard host crash, inspect any surviving external commands; the database cannot prove that an external side effect finished.

`show` reports both the durable task and the current owner observation.
A ship's `ready` state means that Claude returned a successful result, not that independent validation, publishing, or landing was proven.
Review its reported checks and actual worktree changes before accepting them.

## Approve and land

```text
firstmate approve <task-id> --commit <sha> [--waive <check>] [--note "Reviewed"]
firstmate flag <task-id> --reason "Deletes production data"
firstmate publish <task-id>
firstmate validate <task-id>
firstmate validations <task-id>
firstmate holds [<task-id>]
firstmate answer-hold <hold-id> --action approve|fix|skip --answer "Your answer" [--findings <id,...>]
firstmate backlog answer <item-id> --action approve|fix|skip --answer "Your answer" [--findings <id,...>]
firstmate checks <task-id>
firstmate land <task-id>
firstmate refresh <task-id>
```

A local-only ship commits its work on its task branch and stops `local-ready` at that commit; uncommitted changes fail the attempt instead, leaving it resumable.
`approve` records your approval of the ready commit, which `--commit` must name when given; a later ready commit needs a new approval.
`flag` marks the merge destructive, irreversible, or security-sensitive, so only an approval recorded after the flag authorizes it, even with yolo on.
`land` needs your approval or yolo, then fast-forwards the target branch in the project clone to the ready commit and marks the task `landed` only once Git shows the commit on the target.
It refuses when the clone is on another branch or has uncommitted or untracked files, when the task branch moved from the ready commit, and when the target has diverged; resume the task to rebase it.

A direct-PR ship also commits its work and must stop on a clean branch.
Firstmate then pushes the ready commit to the task branch on the project's `origin` and opens a PR into the target, and the task becomes `pr-open` with the PR URL exactly as GitHub returned it.
It uses the `gh` CLI, which must be installed and logged in for the repository's host.
If the push or PR fails, the task stays `ready`; `publish` retries it.
A resumed ship updates its open PR, and refuses to push over a commit someone else pushed to its branch.
`checks` shows the PR's current head and the checks a merge must pass: every check the target branch requires, which counts as `unreported` until it reports for that head, and every other check reported for that head.
`land` merges the PR on GitHub only when you approved its head, or yolo is on, and every one of those checks is green; `approve --waive <check>` names a red or unreported check you accept.
The merge is bound to the approved head, so `land` refuses a PR whose head moved, and the task becomes `landed` only once GitHub shows the merge commit on the target.
With yolo on, a running supervisor merges a green, unflagged PR on its own and reports one line with the full PR URL.
A `no-mistakes` ship commits its work and stops `ready`; `validate` then hands its ready commit to the no-mistakes pipeline, which owns review, fixes, tests, documentation, push, PR and CI, with the task prompt as the pipeline's intent.
The worktree must be clean at the ready commit, or the validation is recorded as failed.
The task is `validating` while the pipeline runs, and becomes `pr-open` once the pipeline passes, with the PR URL and head exactly as GitHub reports them; from there `checks`, `approve` and `land` work as for a direct-PR ship.
Findings the pipeline classifies `auto-fix` are fixed, and `no-op` ones approved, by Firstmate's policy; every other finding, such as `ask-user`, opens a hold and `validate` stops.
`holds` lists open holds with each finding as the pipeline wrote it, and only `answer-hold` (or `backlog answer` on the held item) closes one, storing your answer verbatim with the action it takes; the next `validate` carries it out, passing your words to the pipeline.
A failed or cancelled pipeline run is recorded and leaves the task `ready`; `validations` shows each run's outcome, and `validate` starts a new run.
`validate` drives the pipeline in the foreground until it opens a PR, stops at a hold, or fails; Ctrl+C stops driving without stopping the pipeline's run, and the next `validate` reattaches.
Firstmate uses the shared no-mistakes daemon but never starts, stops, or updates it.

After `land` merges a PR, Firstmate fast-forwards the target branch in the project clone to the one on `origin`, so tasks started afterwards begin from the merged code.
It refuses when the clone has uncommitted or untracked files or its target has commits `origin` lacks; the landing still counts, and `refresh` retries once you have fixed the clone.
A ship's isolated copy starts from its target branch's current head, so a ship queued before a landing still starts from the landed code.

## Clean up

```text
firstmate cleanup <task-id>
firstmate discard <task-id> --reason "Why the work may go"
```

`cleanup` removes a task's isolated copy and its local branch and marks it `cleaned`; its record, events, and reports stay.
It removes a landed ship's copy only when the copy has no uncommitted or untracked files and the branch holds nothing beyond the landed commit, and a scout's only once its report is saved and `backlog complete` has recorded its captain calls (see [Backlog and captain holds](#backlog-and-captain-holds)).
Any other task's work is unlanded, and `cleanup` refuses it until `discard` records your authorization to throw it away; that authorization covers the branch as it is when you give it, so new commits need a new one.
An open hold on the task's pipeline gate refuses cleanup, and so does a running or validating task.
Cleanup closes the backlog item the task was dispatched from, unless that item is held for you.
Every refusal is recorded in the task's events, and there is no force flag.

## Backlog and captain holds

```text
firstmate backlog add "Title" [--kind ship|scout|captain] [--project <name|repo>] [--prompt <text>] [--depends <id,...>] [--defer <date>] [--note <text>]
firstmate backlog list [--status queued|in-flight|held|done] [--archived]
firstmate backlog show <item-id>
firstmate backlog update <item-id> [--title ...] [--depends <id,...>|none] [--defer <date>|none] [--note <text>]
firstmate backlog dispatch <item-id> [--delivery ...] [--yolo ...] [--surface ...] [--base ...]
firstmate backlog hold <item-id> --reason "Question; A: ..., B: ..." [--until <date>]
firstmate backlog hold --title "Call to make" --reason "Question; options" [--origin <scout-task-id>]
firstmate backlog answer <item-id> --answer "Your words" [--release]
firstmate backlog complete <scout-task-id> --items <id,...> | --none
firstmate backlog diverged
firstmate backlog config [--done-keep <n>]
firstmate backlog remove <item-id>
```

The backlog keeps work items apart from tasks, so you can queue ideas before any task exists.
`backlog dispatch` creates an item's task and marks the item `in-flight` in one step; it is refused while the item waits on a dependency that is not `done`, on its `--defer` date, or on you.
The item closes `done` when its ship lands, its scout's captain calls are recorded, or its task is cleaned up, and only then; a `captain` item is a question and never dispatches.
`backlog hold` holds any item for your decision with the question and options as its reason, and `--until` defers it to a date; `--title` creates a captain item for a call that gates no existing item.
Only `backlog answer` closes a hold, storing your answer exactly as you typed it; an empty answer is refused.
A captain item closes on your answer; a work item whose task is still unfinished resumes, and any other work item closes, or with `--release` goes back to the queue.
Work that lands while its item is held keeps the item held until you answer.
Before a completed scout counts as complete, hold each decision its report raises with `--origin <scout-task-id>`, then run `backlog complete` with those items, or `--none`; cleanup refuses the scout until then.
`backlog diverged` lists records of one decision that disagree, such as an open hold whose item is marked done; it changes nothing, `backlog list` warns while any exist, and you reconcile one by answering it in your own words or holding it again.
The 10 most recent done items stay listed; `backlog config --done-keep` changes that, and older ones move to `backlog list --archived`.

## Supervise

```text
firstmate supervisor start --concurrency 2 --stale-after 600 --recoveries 2 --forge-every 60 --secondmate-every 5 --reannounce-after 900
firstmate supervisor status
firstmate supervisor wakes
firstmate supervisor ack --generation <generation> --through <sequence>
firstmate supervisor stop
```

The supervisor runs in the foreground until Ctrl+C or `firstmate supervisor stop` from another terminal, and only one may hold a home at a time.
It starts queued tasks within its concurrency bound and each project's capacity; while it runs, `run` and `run-all` leave queued work to it.
Finished and failed tasks, opened PRs, failed publishing and validation, holds, pending decisions, steering that could not be proven delivered, escalated recoveries, yolo merges it cannot make, and landings authorized only by yolo become durable wakes, printed to stderr as they arrive unless you are [away or quiet](#away-quiet-memory-and-stow).
It validates each ready no-mistakes ship, and carries out a hold as soon as you answer it.
Every `--forge-every` seconds it tries to merge each open yolo PR, as `land` would.
`supervisor wakes` presents the open wakes under a new generation and prints the command that acknowledges them; acknowledge them only after handling them, with the latest generation.
An attempt that produces no SDK activity for `--stale-after` seconds is interrupted and resumed on its exact session, at most `--recoveries` times before the supervisor stops retrying and escalates it.
A supervisor stopped by a signal or a stop request leaves its attempts interrupted, and the next one resumes them; cancel an interrupted task to keep it stopped.
Waiting makes no model calls, but every resumed attempt does, within the task's per-attempt budget.
In the main home it reviews its secondmates every `--secondmate-every` seconds (default 5), as [Secondmates](#secondmates) describes; in a secondmate's home it serves only the work routed to it.
It also runs process sources, polls Relay, observes upstream links, and sends consented outbox actions, as [Events, inbox, Relay, and the outbox](#events-inbox-relay-and-the-outbox) describes.
`supervisor status` shows the supervisor's lease, settings, last review, open wakes, owned tasks, and recovery counts as JSON.

## Secondmates

```text
firstmate secondmate create <id> --charter "Standing responsibility" --scope "Work it takes" --projects <name,...> [--at <home>] [--relaunches 3]
firstmate secondmate launch <id> [--concurrency <n>] [--poll-ms <ms>]
firstmate secondmate list
firstmate secondmate show <id>
firstmate secondmate match <item-id>
firstmate secondmate route <item-id> [--to <id>]
firstmate secondmate handoff <id> --items <id,...>
firstmate secondmate request <id> --project <name> --prompt <text> [--kind ship|scout] [--title <t>]
firstmate secondmate requests [<id>]
firstmate secondmate handoffs [<id>]
firstmate secondmate recover
firstmate secondmate stop <id>
firstmate secondmate retire <id>
firstmate preferences set --text "Your shared preferences"
firstmate preferences show
firstmate preferences clear
```

A secondmate is a persistent supervisor for one domain of work, in a home of its own (by default `secondmates/<id>` inside the main home) with its own database, tasks, and backlog.
`secondmate create` seeds that home with the secondmate's charter and scope, the registrations of the projects it may run, and your shared preferences; a local-only project stays with the main home.
`secondmate launch` starts its supervisor as a separate background process that logs to `supervisor.log` in its home, and it stays idle until work is routed to it: it never dispatches anything you add to its backlog directly.
`secondmate match` shows which secondmates could take a backlog item and why; `secondmate route` hands the item to the one you name with `--to`, or to the only one whose home has the item's project, and records that decision on the item.
`secondmate handoff` moves queued items, with everything they depend on, out of the main backlog into the secondmate's, so each item is always in exactly one home; if the move is interrupted, `secondmate recover` (or the running main supervisor) finishes it, or returns the items to the main backlog when the secondmate's home is gone.
`secondmate request` asks it for new work.
The secondmate dispatches routed work and publishes each outcome under the request's correlation, with a pointer to a scout's report; `secondmate requests` reads those replies from its home, never from its conversation.
While the main supervisor runs, it relaunches a secondmate that exits up to `--relaunches` times, then holds a captain item for you instead; `secondmate launch` starts it again and resets the count.
`preferences set` records your shared preferences in the main home and pushes them to every secondmate, whose copies are read-only.
`secondmate stop` stops one without counting an exit, and `secondmate retire` refuses while it runs or its home holds any unlanded task, unfinished item, or unfinished request; a retired secondmate's home is kept.
Secondmates on other machines are not supported yet.

## Dispatch

```text
firstmate add --project <name> --prompt <text> [--runtime claude] [--model <model>] [--effort low|medium|high|xhigh|max]
firstmate dispatch check
firstmate dispatch resolve --prompt <text> [--kind ship|scout] [--project <name>] [--runtime ...] [--model ...] [--effort ...]
firstmate account pin claude --root </absolute/claude/config/dir|ordinary>
firstmate account show
firstmate account unpin claude
```

Each new task records how its runtime, model, and effort were chosen, and `show` prints that decision.
The task's own `--runtime` or `--model` wins; otherwise the best-fitting rule in `<home>/dispatch.json` applies, else its `default`, else Claude with its default model.
`--effort` overrides the effort at any step; with no effort named anywhere, a ship runs at `high` and a scout at `xhigh`, and `max` is used only when you name it.
A rule or default may list several profiles; Firstmate then reads `quota-axi` once and records every candidate's quota evidence on the task.
Missing quota is reported as uncertainty rather than blocking dispatch, a choice where every candidate is tight on quota keeps the strongest reasoning and says so, and candidates that tie are refused for you to choose with `--model`.
The file's schema is documented in [`docs/architecture.md`](docs/architecture.md#configuration); `dispatch check` validates it, a malformed file refuses every dispatch until you fix it, and `dispatch resolve` shows the decision a task would get without creating one.
Claude is the only verified runtime; any other runtime is refused rather than launched.
`account pin` makes this home's Claude workers use one login, by its config directory or `ordinary` for the default login; only you change it, and a task is refused with the exact `claude auth login` command when the pinned account is signed out.

## Away, quiet, memory, and stow

```text
firstmate posture away [--words "Your instructions while away" | --words-file <path>]
firstmate posture quiet
firstmate posture show
firstmate posture brief [--session <id>] [--json]
firstmate posture return [--json]
firstmate posture quiet-off [--json]
firstmate memory show
firstmate memory append preferences|shared|learnings --text <text>
firstmate memory replace preferences|shared|learnings --text <text>
firstmate stow [--learning <text>]...
```

`posture away` records that you are away, with your words stored exactly as you gave them as the whole mandate; nothing parses them, and being away never grants more authority than you already gave.
Running it again with no words changes nothing, and new words replace the old ones at once, which the brief still lists.
While you are away the running supervisor acknowledges routine wakes silently and batches the ones that need you: review-ready work, finished scout findings, holds, failures and escalations, and pending tool decisions.
`posture return`, or any command that acts for you, such as `add`, `approve`, `answer`, or `backlog add`, ends away and prints the return brief first; reading commands such as `list`, `show`, and `supervisor wakes` do not.
The return brief is rendered from the home's records, never from a conversation: your words, what waits on you, what failed, what landed, finished findings, what was handled silently, and the backlog.
`posture brief` renders it without ending anything, and `--session` renders an earlier session's.
`posture quiet` keeps routine wakes silent while you stay present, and still prints the wakes that need you as they arrive; ordinary commands keep it, and only `posture quiet-off` ends it.

`memory` keeps your working preferences and curated learnings as Markdown files in `<home>/memory`, beside the shared preferences that secondmates receive.
Each worker loads all three into its context when its session opens, at most 16 KiB of each, and records which versions it loaded as a `memory.loaded` event.
`memory append` adds a line and `memory replace` rewrites the text, or clears it when given blank text; `shared` changes only in the main home and is pushed to every secondmate at once.

`stow` files what the home holds before you reset a session: each `--learning` goes into the learnings memory, every open backlog item without notes gets a note recording its state, and the open holds and the batched wakes still open are recorded.
It never checks the backlog against repositories or pull requests.

## Events, inbox, Relay, and the outbox

```text
firstmate extensions
firstmate source register <id> [--every <s>] [--when exit-zero|exit-nonzero|any|changed] [--timeout <s>] -- <command> [args...]
firstmate source list | show <id> | result <id> <sequence> | handled <id> <sequence> | start <id> | retire <id>
firstmate inbox note --text <text> [--request-id <id>]
firstmate inbox list [--all] | show <note-id> | ack <note-id> [--note <how>] | reply <note-id> --text <text> | receipts [--after <sequence>]
firstmate relay configure --endpoint <url> [--token-env <NAME>] [--every <s>]
firstmate relay off | status | mentions | show <request-id> | ack <request-id> | dismiss <request-id>
firstmate relay link <request-id> --task <task-id>
firstmate relay promise <request-id> --task <task-id> --summary <text>
firstmate relay promises [<task-id>] | release <promise-id> --reason <text>
firstmate relay reply <request-id> --text <text> [--final]
firstmate upstream link <item-or-task-id> --url <issue-or-pr-url>
firstmate upstream links | unlink <link-id> | signals [--all]
firstmate upstream ack <link-id> <token> --disposition filed|hold|no-action [--note <text>]
firstmate upstream comment <link-id> --text <text>
firstmate outbox list [--status <status>] | show <id> | consent <id> [--note <text>] | send <id> | withdraw <id>
```

Everything here reaches you as a wake in `supervisor wakes`, and handling the record it names acknowledges it.
A process source is a command the running supervisor runs for you, once or every `--every` seconds, as an argument array without a shell; put the command after `--`.
A run is a result only when its `--when` condition holds (exit status zero by default, or `changed` output), and the result waits, announced again at most three times, until `source handled <id> <sequence>`, which prints `already-handled` on a repeat.
A source whose command cannot start, or whose process a crashed supervisor left running, wakes you; fix it and run `source start`.
`inbox note` drops a note into the home from anywhere, idempotently with `--request-id`; it counts as waiting until `inbox ack`, and `inbox reply` publishes the one reply its submitter reads with `inbox receipts`.

Relay is off until `relay configure` names its endpoint and the environment variable holding its token.
Each public mention becomes a wake; its text is untrusted.
`relay promise` records that a task's outcome will be reported publicly, and `cleanup` of that task is refused until the final reply (`relay reply --final`) is sent or you `relay release` the promise with a reason; once the task's work ends, the supervisor wakes you that the reply is due.
`upstream link` watches an upstream issue or pull request for a backlog item or task from now on; each new comment, review, or state change becomes a signal you acknowledge with its exact token and what you did about it.

Nothing is published without your consent: `relay reply` and `upstream comment` only queue an outbox action, `outbox consent` records your consent to that exact action, and only then does `outbox send`, or the running supervisor, send it, once, under its own key.

## Private data

The default home is `~/.firstmate-ai` and is separate from the Bash application's home.
Override it using `FIRSTMATE_HOME` or `--home`; all participating terminals must select the same home.
Keep the home outside the source repository and on a local filesystem.

```text
firstmate.sqlite       Task state, leases, decisions, steering, lifecycle controls, wakes, event history, the project registry, the backlog with its holds, secondmates with their requests and handoffs, account pins, away and quiet sessions, shared preferences, the home's posture, memory, and stow history, process sources and their results, inbox notes and replies, Relay mentions and promises, upstream links and signals, and the outbox
dispatch.json          Optional dispatch rules, default profiles, and quota source, written by you
memory/                Your working preferences (preferences.md) and learnings (learnings.md)
secondmates/<id>/      Each secondmate's own home, unless created elsewhere with --at
firstmate.sqlite-wal   SQLite write-ahead log while open
worktrees/<task-id>/   Preserved Git worktree for each task
reports/<task-id>/     Immutable scout report per execution generation
```

Prompts, tool approval inputs, responses, and reports are private local data and may contain project content.
API keys are read through the SDK environment and are not copied into task configuration.
Claude keeps its own session transcripts in its SDK-managed configuration directory; backing up only the Firstmate database does not back up those transcripts.
Estimated cost is the latest SDK cumulative session total, not an authoritative billing total.

## Development and verification

```text
npm run typecheck
npm test
npm pack --dry-run
```

The tests exercise real Git worktrees, SQLite persistence and process ownership, interruption, approvals, and an injected SDK protocol adapter without spending model tokens.
These adapter tests do not prove live Claude behavior or authentication.
`npm run test:live` performs a real completion-and-resume smoke test and a steering-evidence test using the SDK's normal authentication, including an existing Claude login.
It consumes subscription usage or API billing according to the selected authentication, with three attempts each configured with a $0.50 SDK budget limit.
It fails on authentication errors rather than skipping when an API key is absent.
The standalone CI definition in `.github/workflows/ci.yml` tests Windows, macOS, and Linux when this directory is the repository root.
It is not active as a nested workflow in the parent Bash repository.
See [verification](docs/verification.md) for the actual results and remaining platform checks.
