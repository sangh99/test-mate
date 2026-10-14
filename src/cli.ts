#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Effect, Exit, Cause } from "effect";
import {
  applicationLayer, addTask, addProject, createSecondmate, launchSecondmate, stopSecondmate, retireSecondmate, pushPreferences, matchItem, routeItem, handoffItems, requestWork,
  recoverSecondmates, readReplies, reviewSecondmates, Transport, dispatchItem, resolveDispatch, loadConfig, Runtimes, knownRuntimes, completeScout, viewItem, updateProject, authorizeDiscard, cleanTask, evaluateMerge, landTask, publishTask, refreshTask, runTask, runQueued, supervise, validateTask, TaskStore, type Inspection, type ProjectSettings,
} from "./index.js";
import type { AnswerRequest } from "./store.js";
import { readFile } from "node:fs/promises";
import { enterPosture, leavePosture, renderBrief, returnBrief, showPosture, stowHome } from "./posture.js";
import { changeMemory, readMemory } from "./memory.js";
import { dismissMention, linkUpstream, listExtensions, sendAction } from "./extensions.js";
import { bearings, fleetSnapshot, renderBearings, writeBearings } from "./fleet.js";
import { locateInstallation, resumeUpdate, updateFirstmate } from "./update.js";
import { importBash, importKinds, type ImportKind } from "./imports.js";
import { activeStates, appError, encodeCreatedTask, encodeTask, InvalidInput, NotFound, projectNamePattern, type Effort, type IntakeResolution, type MemoryFile, type ProjectPosture } from "./domain.js";

const help = `Firstmate - local AI task orchestration

  firstmate init
  firstmate add --project <name|repo> --prompt <text> --kind scout
  firstmate add --project <name|repo> --prompt <text> [--kind ship] [--delivery <mode>] [--yolo on|off] [--surface <surface>] [--target <branch>]
                [--runtime <name>] [--model <name>] [--effort <level>]
  firstmate list
  firstmate fleet [--prs] [--days <n>]
  firstmate bearings [--file] [--prs] [--days <n>] [--json]
  firstmate show <task-id>
  firstmate run <task-id>
  firstmate run-all [--concurrency 2]
  firstmate resume <task-id> [--prompt <follow-up>]
  firstmate steer <task-id> --message <text>
  firstmate steers <task-id>
  firstmate requeue <steer-id>
  firstmate cancel <task-id>
  firstmate interrupt <task-id> [--reason <text>]
  firstmate relaunch <task-id> [--prompt <follow-up>] [--reason <text>]
  firstmate events <task-id> [--after <sequence>]
  firstmate decisions [<task-id>]
  firstmate answer <decision-id> --decision allow|deny [--answer <text>]
  firstmate approve <task-id> [--commit <sha>] [--waive <check>]... [--note <text>]
  firstmate flag <task-id> --reason <text>
  firstmate publish <task-id>
  firstmate validate <task-id>
  firstmate validations <task-id>
  firstmate holds [<task-id>]
  firstmate answer-hold <hold-id> --answer <text> [--action approve|fix|skip] [--findings <id,...>] [--release]
  firstmate checks <task-id>
  firstmate land <task-id>
  firstmate refresh <task-id>
  firstmate discard <task-id> --reason <text>
  firstmate cleanup <task-id>
  firstmate supervisor start [--concurrency 2] [--stale-after 600] [--recoveries 2] [--poll-ms 1000] [--forge-every 60] [--secondmate-every 5]
                             [--reannounce-after 900]
  firstmate supervisor status
  firstmate supervisor stop
  firstmate supervisor drain [--cancel]
  firstmate supervisor wakes
  firstmate supervisor ack --generation <id> --through <sequence>
  firstmate project add <name> --clone <repo> [--default-branch <branch>] [--delivery <posture>] [--yolo on|off]
                        [--branch-prefix <prefix>] [--capacity <n>|none] [--forge github|none]
  firstmate project update <name> [--default-branch ...] [--delivery ...] [--yolo ...] [--branch-prefix ...] [--capacity ...] [--forge ...]
  firstmate project list
  firstmate project show <name>
  firstmate project remove <name>
  firstmate backlog add <title> [--kind ship|scout|captain] [--project <name|repo>] [--prompt <text>] [--id <id>]
                        [--depends <id,...>] [--defer <date>] [--note <text>]
  firstmate backlog list [--status queued|in-flight|held|done] [--archived]
  firstmate backlog show <id>
  firstmate backlog update <id> [--title <t>] [--kind ...] [--project ...] [--prompt ...] [--depends <id,...>|none] [--defer <date>|none] [--note <text>]
  firstmate backlog dispatch <id> [--project ...] [--delivery ...] [--yolo ...] [--surface ...] [--target ...] [--base ...]
                             [--runtime ...] [--model ...] [--effort ...]
  firstmate backlog hold [<id>] --reason <question and options> [--until <date>] [--origin <task-id>] [--title <t>]
  firstmate backlog answer <id> --answer <captain's words> [--release] [--action approve|fix|skip] [--findings <id,...>]
  firstmate backlog remove <id>
  firstmate backlog complete <scout-task-id> (--items <id,...> | --none)
  firstmate backlog diverged
  firstmate backlog config [--done-keep <n>]
  firstmate secondmate create <id> --charter <text> --scope <text> [--projects <name,...>] [--at <home>] [--relaunches <n>]
  firstmate secondmate list
  firstmate secondmate show <id>
  firstmate secondmate launch <id> [--concurrency <n>] [--poll-ms <ms>] [--stale-after <s>] [--recoveries <n>]
  firstmate secondmate stop <id> [--reason <text>]
  firstmate secondmate retire <id>
  firstmate secondmate match <item-id>
  firstmate secondmate route <item-id> [--to <id>]
  firstmate secondmate handoff <id> --items <id,...>
  firstmate secondmate request <id> --project <name> --prompt <text> [--kind ship|scout] [--title <t>] [--surface <s>]
  firstmate secondmate requests [<id>]
  firstmate secondmate handoffs [<id>]
  firstmate secondmate recover
  firstmate secondmate review
  firstmate secondmate inbox
  firstmate preferences show
  firstmate preferences set --text <captain's shared preferences>
  firstmate preferences clear
  firstmate dispatch check
  firstmate dispatch resolve --prompt <text> [--kind ship|scout] [--project <name>] [--runtime ...] [--model ...] [--effort ...]
  firstmate account show
  firstmate account pin <runtime> --root <directory|ordinary>
  firstmate account unpin <runtime>
  firstmate posture away [--words <text> | --words-file <path>]
  firstmate posture quiet
  firstmate posture show
  firstmate posture brief [--session <id>] [--json]
  firstmate posture return [--json]
  firstmate posture quiet-off [--json]
  firstmate memory show
  firstmate memory append preferences|shared|learnings --text <text>
  firstmate memory replace preferences|shared|learnings --text <text>
  firstmate stow [--learning <text>]...
  firstmate source register <id> [--every <s>] [--when exit-zero|exit-nonzero|any|changed] [--timeout <s>] -- <command> [args...]
  firstmate source list
  firstmate source show <id>
  firstmate source result <id> <sequence>
  firstmate source handled <id> <sequence>
  firstmate source start <id>
  firstmate source retire <id>
  firstmate inbox note --text <text> [--request-id <id>]
  firstmate inbox list [--all]
  firstmate inbox show <note-id>
  firstmate inbox ack <note-id> [--note <how it was handled>]
  firstmate inbox reply <note-id> --text <text>
  firstmate inbox receipts [--after <sequence>]
  firstmate relay configure --endpoint <url> [--token-env <NAME>] [--every <s>]
  firstmate relay off
  firstmate relay status
  firstmate relay mentions
  firstmate relay show <request-id>
  firstmate relay link <request-id> --task <task-id>
  firstmate relay promise <request-id> --task <task-id> --summary <text>
  firstmate relay promises [<task-id>]
  firstmate relay release <promise-id> --reason <text>
  firstmate relay reply <request-id> --text <text> [--final]
  firstmate relay ack <request-id>
  firstmate relay dismiss <request-id>
  firstmate upstream link <item-or-task-id> --url <issue-or-pr-url>
  firstmate upstream links
  firstmate upstream unlink <link-id>
  firstmate upstream signals [--all]
  firstmate upstream ack <link-id> <token> --disposition filed|hold|no-action [--note <text>]
  firstmate upstream comment <link-id> --text <text>
  firstmate outbox list [--status awaiting-consent|consented|sending|sent|withdrawn]
  firstmate outbox show <id>
  firstmate outbox consent <id> [--note <text>]
  firstmate outbox send <id>
  firstmate outbox withdraw <id>
  firstmate extensions
  firstmate update --to <version|tag|tarball> [--wait <s>] [--dry-run]
  firstmate update status
  firstmate update resume
  firstmate import --from <bash home> [--clones <dir>] [--only projects,backlog,preferences,learnings] [--apply]
  firstmate import list
  firstmate doctor

Options:
  --home <directory>   Private state (default: FIRSTMATE_HOME or ~/.firstmate-ai)
  --project <name|repo> A registered project's name, or a repository root (unregistered unless registered by that clone)
  --base <ref>         Local Git base at task creation; a branch also overrides the target (default: the project's default branch, else HEAD)
  --delivery <mode>    Ship delivery: no-mistakes, direct-PR, or local-only (default: the project's posture; unregistered: no-mistakes)
                       For project add and update, the posture: one of those or no-mistakes-prod-only
  --yolo on|off        Merge posture: on lets unflagged work merge without approval (default: the project's; unregistered: off)
  --surface <surface>  What a ship on a no-mistakes-prod-only project changes: internal-only (ships direct-PR),
                       product-facing, mixed, or uncertain (ship no-mistakes); required there unless --delivery is given
  --target <branch>    Branch a ship lands on, locally or as its PR's base (default: --base when it is a branch, else the
                       project's default branch, else the checked-out branch)
  --clone <repo>       The repository root a project registers
  --default-branch <b> The project's base and target branch (default: the clone's checked-out branch)
  --branch-prefix <p>  Prepended to a task ID to name its branch (default: firstmate/)
  --capacity <n>|none  Most attempts running at once for the project (default: none, uncapped)
  --forge github|none  The project's forge (default: github, or none for local-only)
  --runtime <name>     Worker runtime override; only a verified runtime (claude) is dispatched
  --model <name>       Model override (default: the dispatch profile's, else the runtime's own default)
  --effort <level>     Effort override: low, medium, high, xhigh, or max (default: the profile's, else a
                       fallback of high for a ship and xhigh for a scout; the fallback never picks max)
  --root <dir>         An account pin: an absolute login directory, or ordinary for the default login
  --max-turns <n>      Turn limit per attempt (default: 30)
  --budget <USD>       Model budget per attempt (default: 5)
  --action <verb>      How an answer carries out a pipeline gate hold: approve, fix, or skip (gate holds only)
  --findings <ids>     Comma-separated gate findings a fix applies to (default: all)
  --release            Answer a work item's hold by returning it to the queue instead of closing it
  --depends <ids>      Backlog items that must be done before this one dispatches
  --defer <date>       No dispatch before this date (YYYY-MM-DD) or ISO date-time
  --until <date>       The captain's own deferral of a hold; the call resurfaces on that date
  --origin <task-id>   The scout or task whose work discovered a captain call
  --items <ids>        The captain-held items a scout's completion attests; --none attests there are none
  --done-keep <n>      Done items kept in the live backlog; older ones are archived (default: 10)
  --reason <text>      Why: for interrupt, relaunch, flag, discard, and secondmate stop
  --charter <text>     A secondmate's standing responsibility
  --scope <text>       What work a secondmate takes, in words the captain routes by
  --projects <names>   Registered projects a secondmate's home may run; local-only ones stay in the main home
  --at <home>          A secondmate's own home (default: <home>/secondmates/<id>)
  --relaunches <n>     Automatic relaunches of an exited secondmate before it is held for the captain (default: 3)
  --to <id|spec>       The secondmate a route goes to, chosen by its scope; for update, the firstmate-ai package to
                       install: a version, tag, or tarball path
  --secondmate-every <s> Seconds between the supervisor's reviews of its secondmates (default: 5)
  --text <text>        The captain's shared preferences, or a memory's new text, verbatim
  --words <text>       The captain's away words, recorded verbatim as the whole mandate
  --words-file <path>  Read the away words from a file, verbatim
  --session <id>       A past away or quiet session whose brief to render (default: the active one, else the latest)
  --learning <text>    A learning stow files into the learnings memory; repeatable
  --every <s>          Seconds between a source's runs (default: run once), or between Relay polls (default: 60)
  --when <condition>   When a source's run is a result: exit-zero (default), exit-nonzero, any, or changed output
  --timeout <s>        Stop a source's run after this many seconds (default: none)
  --request-id <id>    Makes an inbox note idempotent: a repeat returns the original note
  --endpoint <url>     The Relay endpoint; --token-env names the variable holding its bearer token
  --task <task-id>     The task a Relay mention's work runs as
  --summary <text>     What a promised final reply will report, in public-safe words
  --final              A Relay reply that is the final one; it reconciles the mention's open promise when sent
  --url <url>          An upstream issue or pull request URL
  --disposition <d>    How an upstream signal was handled: filed, hold, or no-action
  --reannounce-after <s> Seconds before an acknowledged but unhandled source result is announced again (default: 900)
  --prs                Read each open PR's live head and checks from its forge (default: the home's records only)
  --days <n>           How far back recent completions reach (default: 7)
  --file               Also replace today's dated report, <home>/reports/bearings-<YYYY-MM-DD>.md
  --cancel             Withdraw a drain request
  --wait <s>           Seconds running work may take to drain before an update is refused (default: 600)
  --dry-run            Plan an update and check its safety without changing anything
  --from <dir>         A Bash Firstmate home, or its data directory, to import from (only read)
  --clones <dir>       Where the Bash home's project clones are (default: <bash home>/projects)
  --only <kinds>       The record kinds to import (default: all)
  --apply              Import the plan; without it, import only shows the plan
  --json              Machine-readable output; suppress streaming text
  --help              Show this help

Run stays in the foreground. Answer approvals from another terminal using the
same --home. Steer a running task from another terminal; a steer for a task
that is not running waits for its next run or resume. Steering is text only;
use cancel to stop a task, or interrupt and relaunch to stop or restart its
running attempt. Ctrl+C interrupts the run and preserves work for explicit resume.
The supervisor runs queued tasks, recovers stalled ones, and records wakes
until Ctrl+C or supervisor stop; present wakes and acknowledge them once handled.
A finished ship stops ready; a local-only ship commits its work and stops
local-ready, and land fast-forwards its target in the project clone once
approve, or yolo, authorizes that exact commit. A direct-PR ship commits its
work, is pushed to origin and opened as a GitHub PR, and stops pr-open;
publish retries a failed push or PR, checks reads the PR's current head and
checks, and land merges it on the forge bound to that head once approve, or
yolo with every check green, authorizes it. Approve --waive names a red or
unreported check to waive. A flag requires an approval recorded after it,
even under yolo. The supervisor merges green yolo PRs on its own.
A no-mistakes ship stops ready, and validate submits its clean ready commit
to the no-mistakes pipeline, which owns review, fixes, tests, documentation,
push, PR and CI. The task is validating until the pipeline ends, then pr-open
with the PR the forge reports, or ready again with the failure recorded; its
PR then merges like a direct-PR ship's. Gate findings the pipeline classifies
auto-fix are fixed, and no-op ones approved, by host policy; any other
finding opens a hold, which only answer-hold closes, storing the answer
verbatim, and validate then carries it out. The supervisor validates ready
no-mistakes ships and carries out answered holds on its own.
After a forge landing, the project clone's local target is fast-forwarded to
the remote's, refused on a dirty clone or a target with local-only commits;
refresh retries it. A new ship's isolated copy starts from its target's head
when that contains its base. Cleanup removes a task's isolated copy and branch
and stops it cleaned: a landed ship's only when the copy is clean and the
branch holds nothing unlanded, a completed scout's once its report is saved,
and any other task's only under a discard authorization recorded since its
last attempt for the branch head as it is now. An open hold refuses cleanup.
Every refusal is recorded as an event; there is no force flag.
A registered project gives its tasks their delivery mode, yolo, base and target
branch, and branch prefix unless the task names its own; a task that names a
path is reported unregistered and defaults to no-mistakes with yolo off. A
project with a capacity never runs more attempts at once; a task beyond it
stays queued, and the supervisor starts it once a place frees. project add
defaults the posture to no-mistakes-prod-only when the clone has an origin
remote, else local-only. project remove only unregisters, never touches the
clone, and refuses while a task of the project holds unlanded work. A
malformed registry record is reported with how to fix it and is never skipped.
The backlog holds work items apart from tasks. backlog dispatch creates an
item's task and moves it in-flight in one step, refused while it waits on a
dependency not yet done, a deferral date, or the captain. Its task landing,
a scout's completion, or its cleanup closes it; a captain item never
dispatches. backlog hold holds any item, or a new captain item with --title,
for the captain with the question and options as its reason; only backlog
answer, storing the captain's words verbatim, closes it. A work item whose
task has not finished resumes in flight; any other closes, or with --release
returns to the queue. A completed scout is complete, and cleanup may discard
its isolated copy, only once backlog complete attests every captain call its
report raised is held (each held with --origin <scout>), or --none. backlog
diverged reports records of one captain call that disagree and closes
nothing; backlog list warns about them. The 10 most recent done items stay
listed (backlog config --done-keep changes it); older ones are archived.
A secondmate is a supervisor in its own home with a charter and a scope,
launched as a separate process; it is idle until work is routed to it and
never starts work of its own. secondmate match shows the routing decision
for an item, and secondmate route hands the item off to the secondmate the
captain names with --to, or to the only one whose home has its project; a
local-only project's work stays in the main home. A handoff moves queued
items between homes so each is in exactly one, and secondmate recover
finishes one an interruption left in transit. secondmate request routes new
work. Each request carries a correlation, and its replies are read from the
secondmate's published status, never its transcript. The main supervisor
relaunches an exited secondmate up to --relaunches times, then holds it for
the captain; secondmate launch resets that count. Shared preferences are
set in the main home only and pushed to every secondmate. secondmate retire
refuses while the secondmate runs or its home holds unlanded work.
Dispatch chooses each new task's runtime, model, and effort, in this order:
the task's own --runtime or --model (with --effort), else the best-fitting
rule of <home>/dispatch.json, else its default, else the static runtime.
A profile array is resolved from one quota-axi reading with every candidate's
evidence stored on the task (see show); unmeasured quota is disclosed
uncertainty, a tight array keeps its strongest reasoning, and ties are
refused for the captain to choose. dispatch check validates the file, and
dispatch resolve shows a decision without creating a task. An unverified
runtime is refused, never launched. Account pins are set only with account
pin; dispatch never changes them, and refuses a signed-out pin with the
login it needs.
posture away records the captain's away words verbatim as the whole mandate;
nothing parses them, and away never adds authority. While away the supervisor
acknowledges routine wakes silently and batches captain-relevant ones (review-
ready work, finished findings, holds, failures, escalations, decisions) for the
return. posture return, or any captain action such as add, approve, or answer,
ends away and prints the return brief, rendered from the home's records; reads
such as list and show do not. posture quiet keeps routine wakes silent while
the captain stays present and still reports captain-relevant ones at once;
only posture quiet-off ends it. posture brief renders a brief without ending
anything. memory keeps working preferences and learnings as files in
<home>/memory and the shared preferences as the record secondmates receive;
each is loaded into a worker's context when its session opens. stow files
learnings, notes each open item that has none, and records the open holds and
batched wakes, without checking repositories or PRs.
Extensions deliver into the wake queue through the records they commit with
their wakes; extensions lists them. The supervisor runs registered process
sources as argument arrays, never through a shell or a model: a run whose
--when condition holds is captured, then woken about, and is announced again
(at most three times) until source handled acknowledges that exact result. A
source that fails to start, or a run a stopped supervisor left behind, is a
wake; source start resumes it. An inbox note is a wake and counts as waiting
until inbox ack; inbox reply publishes its one durable reply, which inbox
receipts reads. Relay is off unless configured: mentions become wakes, relay
promise binds a promised final reply to a task, whose cleanup is refused
until that reply is sent or released, and a due promise is a wake. An
upstream link observes an issue or PR from now on; each new comment, review,
or state change is a signal acknowledged only with its exact token and a
disposition. Every public action (relay reply, upstream comment) is queued in
the outbox and sent only after outbox consent, once, under its own key; the
supervisor sends consented actions.
list, fleet, and bearings read one fleet snapshot of the home's records:
tasks, backlog items, holds, decisions, PRs, secondmates, supervisor health,
posture, open captain wakes, and what sources, the inbox, Relay, upstream
links, and the outbox hold waiting. bearings sorts it into Captain's Call,
Recently Landed, Underway, and Charted Next; --file also writes the dated
report. Only --prs contacts a forge; nothing here changes the home.
update installs a firstmate-ai package over this npm installation and
restarts the supervisors that were running, secondmates first. The plan is
recorded before anything changes; each running supervisor drains (starts
nothing new and stops once its attempts and validations end), so no work is
interrupted. A home with a foreground run or unknown liveness refuses the
update, and work still running after --wait withdraws the drain and refuses
it with nothing installed. A failed install restarts the supervisors on the
installed version; update resume finishes a run an interruption left behind.
A restarted supervisor runs detached and logs to <home>/supervisor.log.
import reads a Bash Firstmate home only when asked: its project registry,
queued backlog items with their captain holds, and the captain's
preferences, shared preferences, and learnings. It shows the plan and
changes nothing unless --apply is given; each record is imported once.
In-flight and done Bash items stay in the Bash home.
`;

const onOff = (value: string) => {
  if (value !== "on" && value !== "off") throw new InvalidInput({ message: "--yolo must be on or off" });
  return value === "on";
};
const postures: readonly string[] = ["no-mistakes", "direct-PR", "local-only", "no-mistakes-prod-only"];
/** The project settings named on the command line; each one left out stays unset. */
function projectSettings(values: Record<string, string | boolean | string[] | undefined>): ProjectSettings {
  const text = (key: string) => typeof values[key] === "string" ? values[key] : undefined;
  const delivery = text("delivery");
  if (delivery !== undefined && !postures.includes(delivery)) throw new InvalidInput({ message: `--delivery must be ${postures.join(", ")}` });
  const capacity = text("capacity");
  if (capacity !== undefined && capacity !== "none" && !/^[1-9][0-9]*$/.test(capacity)) throw new InvalidInput({ message: "--capacity must be a positive integer or none" });
  const forge = text("forge");
  if (forge !== undefined && forge !== "github" && forge !== "none") throw new InvalidInput({ message: "--forge must be github or none" });
  const defaultBranch = text("default-branch");
  const yolo = text("yolo");
  const branchPrefix = text("branch-prefix");
  return {
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    ...(delivery !== undefined ? { delivery: delivery as ProjectPosture } : {}),
    ...(yolo !== undefined ? { yolo: onOff(yolo) } : {}),
    ...(branchPrefix !== undefined ? { branchPrefix } : {}),
    ...(capacity !== undefined ? { capacity: capacity === "none" ? null : Number(capacity) } : {}),
    ...(forge !== undefined ? { forge: forge === "none" ? null : "github" as const } : {}),
  };
}

/** The captain's answer as given on the command line; the text is kept exactly as typed. */
const answerRequest = (values: Record<string, string | boolean | string[] | undefined>) => Effect.gen(function*() {
  const action = values.action;
  if (action !== undefined && action !== "approve" && action !== "fix" && action !== "skip") return yield* Effect.fail(new InvalidInput({ message: "Use --action approve, fix, or skip" }));
  const text = values.answer;
  if (typeof text !== "string") return yield* Effect.fail(new InvalidInput({ message: "Missing --answer: the captain's own words; use --help" }));
  const findings = typeof values.findings === "string" ? values.findings.split(",").map(f => f.trim()).filter(Boolean) : [];
  const request: AnswerRequest = { text, ...(action ? { action } : {}), ...(findings.length ? { findings } : {}), ...(values.release ? { release: true } : {}) };
  return request;
});

const efforts: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
/** The task's explicit dispatch overrides. */
function overrides(values: Record<string, string | boolean | string[] | undefined>) {
  const text = (key: string) => typeof values[key] === "string" ? values[key] : undefined;
  const effort = text("effort");
  if (effort !== undefined && !efforts.includes(effort)) throw new InvalidInput({ message: `--effort must be one of ${efforts.join(", ")}` });
  const runtime = text("runtime");
  const model = text("model");
  return { ...(runtime !== undefined ? { runtime } : {}), ...(model ? { model } : {}), ...(effort !== undefined ? { effort: effort as Effort } : {}) };
}

function json(value: unknown) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
/** Tasks print as their flat stored record. */
const shown = (inspection: Inspection) => ({ ...inspection, task: encodeTask(inspection.task) });
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}; use --help`);
  return value;
}

/**
 * Whether a command is a captain action that ends away: anything that
 * changes the home except running or stopping the supervisor, posture, and
 * stow. Reading records, including presenting wakes, does not return the
 * captain; acknowledging them does.
 */
function captainAction(command: string, verb: string | undefined, values: Record<string, unknown>): boolean {
  const reads: Record<string, readonly string[] | true> = {
    init: true, list: true, show: true, events: true, decisions: true, steers: true, holds: true, validations: true, checks: true, doctor: true,
    posture: true, stow: true, dispatch: true, extensions: true,
    source: ["list", "show", "result"], inbox: ["note", "list", "show", "receipts"], relay: ["status", "mentions", "show", "promises"], upstream: ["links", "signals"], outbox: ["list", "show"],
    supervisor: ["start", "status", "stop", "drain", "wakes"], memory: ["show"], fleet: true, bearings: true, update: ["status"], import: ["list"], project: ["list", "show"], backlog: ["list", "show", "diverged"], preferences: ["show"], account: ["show"],
    secondmate: ["list", "show", "match", "requests", "handoffs", "inbox"],
  };
  const read = reads[command];
  if (read === true) return false;
  if (command === "backlog" && verb === "config" && values["done-keep"] === undefined) return false;
  // A planned update or import that is not carried out changes nothing.
  if ((command === "update" && verb === undefined && values["dry-run"]) || (command === "import" && verb === undefined && !values.apply)) return false;
  return !read?.includes(verb ?? "");
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    home: { type: "string" }, project: { type: "string" }, prompt: { type: "string" }, kind: { type: "string" },
    base: { type: "string" }, model: { type: "string" }, "max-turns": { type: "string" }, budget: { type: "string" },
    concurrency: { type: "string" }, after: { type: "string" }, decision: { type: "string" }, answer: { type: "string" }, message: { type: "string" },
    reason: { type: "string" }, "stale-after": { type: "string" }, "forge-every": { type: "string" }, recoveries: { type: "string" }, "poll-ms": { type: "string" },
    generation: { type: "string" }, through: { type: "string" }, action: { type: "string" }, findings: { type: "string" },
    delivery: { type: "string" }, yolo: { type: "string" }, target: { type: "string" }, surface: { type: "string" },
    clone: { type: "string" }, "default-branch": { type: "string" }, "branch-prefix": { type: "string" }, capacity: { type: "string" }, forge: { type: "string" }, commit: { type: "string" }, waive: { type: "string", multiple: true }, note: { type: "string" },
    id: { type: "string" }, title: { type: "string" }, depends: { type: "string" }, defer: { type: "string" }, until: { type: "string" }, origin: { type: "string" },
    items: { type: "string" }, none: { type: "boolean" }, release: { type: "boolean" }, "done-keep": { type: "string" }, status: { type: "string" }, archived: { type: "boolean" },
    charter: { type: "string" }, scope: { type: "string" }, projects: { type: "string" }, at: { type: "string" }, relaunches: { type: "string" }, to: { type: "string" },
    "secondmate-every": { type: "string" }, text: { type: "string" }, runtime: { type: "string" }, effort: { type: "string" }, root: { type: "string" },
    words: { type: "string" }, "words-file": { type: "string" }, session: { type: "string" }, learning: { type: "string", multiple: true },
    every: { type: "string" }, when: { type: "string" }, timeout: { type: "string" }, "request-id": { type: "string" }, all: { type: "boolean" },
    endpoint: { type: "string" }, "token-env": { type: "string" }, task: { type: "string" }, summary: { type: "string" }, final: { type: "boolean" },
    url: { type: "string" }, disposition: { type: "string" }, "reannounce-after": { type: "string" },
    prs: { type: "boolean" }, days: { type: "string" }, file: { type: "boolean" }, cancel: { type: "boolean" }, wait: { type: "string" }, "dry-run": { type: "boolean" },
    from: { type: "string" }, clones: { type: "string" }, only: { type: "string" }, apply: { type: "boolean" },
    json: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help || positionals.length === 0) { process.stdout.write(help); return; }
  const [command, id, name] = positionals;
  const sourceRegister = command === "source" && id === "register";
  const limit = ["source", "upstream"].includes(command!) && ["result", "handled", "ack"].includes(id!) ? 4 : ["project", "backlog", "secondmate", "account", "memory", "source", "inbox", "relay", "upstream", "outbox"].includes(command!) ? 3 : 2;
  if (!sourceRegister && positionals.length > limit) throw new Error("Unexpected positional arguments; quote the task prompt");
  const commands = ["init", "add", "list", "show", "run", "run-all", "resume", "steer", "steers", "requeue", "cancel", "interrupt", "relaunch",
    "events", "decisions", "answer", "approve", "flag", "publish", "validate", "validations", "holds", "answer-hold", "checks", "land", "refresh", "discard", "cleanup", "supervisor", "project", "backlog", "secondmate", "preferences", "dispatch", "account", "posture", "memory", "stow", "source", "inbox", "relay", "upstream", "outbox", "extensions", "fleet", "bearings", "update", "import", "doctor"];
  if (!commands.includes(command!)) throw new Error(`Unknown command: ${command}`);
  if (command === "supervisor" && !["start", "status", "stop", "drain", "wakes", "ack"].includes(id!)) throw new Error("Use supervisor start, status, stop, drain, wakes, or ack");
  if (command === "update" && id !== undefined && id !== "status" && id !== "resume") throw new Error("Use update --to <spec>, update status, or update resume");
  if (command === "import" && id !== undefined && id !== "list") throw new Error("Use import --from <bash home>, or import list");
  if (command === "project" && !["add", "update", "list", "show", "remove"].includes(id!)) throw new Error("Use project add, update, list, show, or remove");
  const backlogVerbs = ["add", "list", "show", "update", "dispatch", "hold", "answer", "remove", "complete", "diverged", "config"];
  if (command === "backlog" && !backlogVerbs.includes(id!)) throw new Error(`Use backlog ${backlogVerbs.join(", ")}`);
  const secondmateVerbs = ["create", "list", "show", "launch", "stop", "retire", "match", "route", "handoff", "request", "requests", "handoffs", "recover", "review", "inbox"];
  if (command === "secondmate" && !secondmateVerbs.includes(id!)) throw new Error(`Use secondmate ${secondmateVerbs.join(", ")}`);
  if (command === "preferences" && !["show", "set", "clear"].includes(id!)) throw new Error("Use preferences show, set, or clear");
  if (command === "dispatch" && !["check", "resolve"].includes(id!)) throw new Error("Use dispatch check or resolve");
  if (command === "account" && !["show", "pin", "unpin"].includes(id!)) throw new Error("Use account show, pin, or unpin");
  const postureVerbs = ["away", "quiet", "show", "brief", "return", "quiet-off"];
  if (command === "posture" && !postureVerbs.includes(id!)) throw new Error(`Use posture ${postureVerbs.join(", ")}`);
  if (command === "memory" && !["show", "append", "replace"].includes(id!)) throw new Error("Use memory show, append, or replace");
  const eventVerbs: Record<string, readonly string[]> = {
    source: ["register", "list", "show", "result", "handled", "start", "retire"],
    inbox: ["note", "list", "show", "ack", "reply", "receipts"],
    relay: ["configure", "off", "status", "mentions", "show", "link", "promise", "promises", "release", "reply", "ack", "dismiss"],
    upstream: ["link", "links", "unlink", "signals", "ack", "comment"],
    outbox: ["list", "show", "consent", "send", "withdraw"],
  };
  if (eventVerbs[command!] && !eventVerbs[command!]!.includes(id!)) throw new Error(`Use ${command} ${eventVerbs[command!]!.join(", ")}`);
  const memoryFile = command === "memory" && id !== "show" ? (["preferences", "shared", "learnings"] as const).find(file => file === name) : undefined;
  if (command === "memory" && id !== "show" && !memoryFile) throw new Error("Name the memory: preferences, shared, or learnings");
  if (values["words-file"] !== undefined && values.words !== undefined) throw new Error("Give the away words with --words or --words-file, not both");
  const home = resolve(values.home ?? process.env.FIRSTMATE_HOME ?? join(homedir(), ".firstmate-ai"));
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Interrupted by user"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const program = Effect.gen(function*() {
    const store = yield* TaskStore;
    const options = { signal: abort.signal, ...(!values.json ? { onText: (text: string) => process.stderr.write(text) } : {}) };
    // A captain action is the captain's return: away ends and its brief is printed before the action runs.
    if (captainAction(command!, id, values) && (yield* store.posture())?.mode === "away") {
      process.stderr.write(renderBrief(yield* leavePosture("return", positionals.slice(0, 3).join(" "))));
    }
    switch (command) {
      case "init": return { home: store.home, database: join(store.home, "firstmate.sqlite") };
      case "add": {
        const kind = values.kind ?? "ship";
        if (kind !== "ship" && kind !== "scout") return yield* Effect.fail(new InvalidInput({ message: "Kind must be ship or scout" }));
        const { delivery, yolo, surface } = values;
        if (delivery !== undefined && delivery !== "no-mistakes" && delivery !== "direct-PR" && delivery !== "local-only") {
          return yield* Effect.fail(new InvalidInput({ message: "--delivery must be no-mistakes, direct-PR, or local-only; a project's no-mistakes-prod-only posture is resolved with --surface" }));
        }
        if (surface !== undefined && surface !== "internal-only" && surface !== "product-facing" && surface !== "mixed" && surface !== "uncertain") {
          return yield* Effect.fail(new InvalidInput({ message: "--surface must be internal-only, product-facing, mixed, or uncertain" }));
        }
        const task = yield* addTask({
          ...(delivery ? { delivery } : {}), ...(yolo !== undefined ? { yolo: yield* Effect.try({ try: () => onOff(yolo), catch: appError }) } : {}), ...(values.target !== undefined ? { target: values.target } : {}),
          ...(surface ? { surface } : {}),
          project: required(values.project, "--project"), prompt: required(values.prompt, "--prompt"), kind,
          ...(values.base ? { base: values.base } : {}), ...overrides(values),
          ...(values["max-turns"] ? { maxTurns: Number(values["max-turns"]) } : {}),
          ...(values.budget ? { maxBudgetUsd: Number(values.budget) } : {}),
        });
        const resolution = (yield* store.events(task.id)).find(event => event.type === "intake.resolved")?.data as IntakeResolution;
        if (resolution.gap) process.stderr.write(`${resolution.gap}\n`);
        return { ...encodeCreatedTask(task), resolution };
      }
      case "list": return (yield* fleetSnapshot()).tasks;
      case "fleet": case "bearings": {
        const days = values.days === undefined ? undefined : Number(values.days);
        if (days !== undefined && !(days > 0)) return yield* Effect.fail(new InvalidInput({ message: "--days must be a positive number" }));
        const snapshot = yield* fleetSnapshot({ ...(values.prs ? { prs: true } : {}), ...(days !== undefined ? { days } : {}) });
        if (command === "fleet") return snapshot;
        const report = bearings(snapshot);
        const file = values.file ? yield* writeBearings(report) : null;
        if (values.json) return { ...report, file };
        process.stdout.write(renderBearings(report, file ?? undefined));
        return undefined;
      }
      case "show": return shown(yield* store.inspect(required(id, "task ID")));
      case "run": return encodeTask(yield* runTask(required(id, "task ID"), options));
      case "resume": return encodeTask(yield* runTask(required(id, "task ID"), { ...options, resume: true, ...(values.prompt ? { prompt: values.prompt } : {}) }));
      case "run-all": {
        const results = yield* runQueued(Number(values.concurrency ?? 2), options);
        if (results.some(result => Exit.isFailure(result.exit))) process.exitCode = 1;
        return results.map(({ id, exit }) => ({ id, ...(Exit.isSuccess(exit) ? { task: encodeTask(exit.value) } : { error: Cause.pretty(exit.cause) }) }));
      }
      case "steer": {
        const steer = yield* store.steer(required(id, "task ID"), required(values.message, "--message"));
        const { owner } = yield* store.inspect(steer.taskId);
        return { ...steer, delivery: owner === "live" ? "Queued for the live run" : "Queued until the next run or resume" };
      }
      case "steers": return yield* store.steers(required(id, "task ID"));
      case "requeue": return yield* store.requeueSteer(required(id, "steer ID"));
      case "cancel": return encodeTask(yield* store.cancel(required(id, "task ID")));
      case "interrupt": return yield* store.requestControl(required(id, "task ID"), { verb: "interrupt", reason: values.reason ?? "Requested by the captain", prompt: null });
      case "relaunch": {
        const control = yield* store.requestControl(required(id, "task ID"), { verb: "relaunch", reason: values.reason ?? "Requested by the captain", prompt: values.prompt ?? null });
        const { owner } = yield* store.supervisor();
        return { ...control, resumedBy: owner === "live" ? "The live supervisor, once the attempt stops" : "The next supervisor to start" };
      }
      case "approve": return yield* store.approve(required(id, "task ID"), {
        ...(values.commit ? { commit: values.commit } : {}), waivers: values.waive ?? [], note: values.note ?? "",
      });
      case "flag": return yield* store.flag(required(id, "task ID"), required(values.reason, "--reason"));
      case "publish": {
        const { task, pr } = yield* publishTask(required(id, "task ID"));
        return { task: encodeTask(task), pr };
      }
      case "validate": {
        const { task, validation, outcome, hold, detail } = yield* validateTask(required(id, "task ID"), options);
        if (outcome === "failed") process.exitCode = 1;
        return { task: encodeTask(task), validation, outcome, hold, detail };
      }
      case "validations": return yield* store.validations(required(id, "task ID"));
      case "holds": return (yield* store.holds(id)).filter(hold => hold.status === "open");
      case "answer-hold": {
        const hold = yield* store.answerHold(required(id, "hold ID"), yield* answerRequest(values));
        if (!hold.subject || !hold.taskId) return hold;
        const { owner } = yield* store.supervisor();
        return { ...hold, carriedOutBy: owner === "live" ? "The live supervisor" : `firstmate validate ${hold.taskId}` };
      }
      case "checks": return yield* evaluateMerge(required(id, "task ID"));
      case "land": {
        const { task, proof, outcome } = yield* landTask(required(id, "task ID"));
        process.stderr.write(`${outcome}\n`);
        return { task: encodeTask(task), landed: proof, outcome };
      }
      case "refresh": {
        const { task, outcome } = yield* refreshTask(required(id, "task ID"));
        process.stderr.write(`${outcome}\n`);
        return { task: encodeTask(task), outcome };
      }
      case "discard": return yield* authorizeDiscard(required(id, "task ID"), required(values.reason, "--reason"));
      case "cleanup": {
        const { task, cleaned } = yield* cleanTask(required(id, "task ID"));
        return { task: encodeTask(task), cleaned };
      }
      case "supervisor": switch (id) {
        case "start": return yield* supervise({
          ...(values.concurrency ? { concurrency: Number(values.concurrency) } : {}),
          ...(values["stale-after"] ? { staleMs: Number(values["stale-after"]) * 1000 } : {}),
          ...(values.recoveries ? { recoveries: Number(values.recoveries) } : {}),
          ...(values["poll-ms"] ? { pollMs: Number(values["poll-ms"]) } : {}),
          ...(values["forge-every"] ? { forgeMs: Number(values["forge-every"]) * 1000 } : {}),
          ...(values["secondmate-every"] ? { secondmateMs: Number(values["secondmate-every"]) * 1000 } : {}),
          ...(values["reannounce-after"] ? { reannounceMs: Number(values["reannounce-after"]) * 1000 } : {}),
          signal: abort.signal,
          onNote: note => process.stderr.write(`${note}\n`),
          onError: error => process.stderr.write(`Supervisor review failed and will retry: ${error.message}\n`),
          ...(!values.json ? {
            onWake: wake => process.stderr.write(`Wake ${wake.sequence} ${wake.kind} ${wake.taskId ?? wake.subject}: ${wake.detail}\n`),
            onBatched: (wake, why) => process.stderr.write(`Batched for the return: wake ${wake.sequence} ${wake.kind} ${wake.taskId ?? wake.subject} (${why})\n`),
          } : {}),
        });
        case "status": return yield* store.supervision();
        case "stop": return yield* store.requestStop();
        case "drain": return yield* store.requestDrain(!values.cancel);
        case "wakes": {
          const { generation, wakes } = yield* store.presentWakes("captain");
          const through = wakes.at(-1)?.sequence;
          return { generation, wakes, ...(through ? { acknowledge: `firstmate supervisor ack --generation ${generation} --through ${through}` } : {}) };
        }
        default: return yield* store.acknowledgeWakes("captain", required(values.generation, "--generation"), Number(required(values.through, "--through")));
      }
      case "events": {
        const after = Number(values.after ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) return yield* Effect.fail(new InvalidInput({ message: "--after must be a nonnegative integer" }));
        return yield* store.events(required(id, "task ID"), after);
      }
      case "decisions": return (yield* store.decisions(id)).filter(decision => decision.status === "pending");
      case "answer": {
        if (values.decision !== "allow" && values.decision !== "deny") return yield* Effect.fail(new InvalidInput({ message: "Use --decision allow or --decision deny" }));
        return yield* store.answer(required(id, "decision ID"), values.decision, values.answer ?? "");
      }
      case "project": {
        const settings = yield* Effect.try({ try: () => projectSettings(values), catch: appError });
        switch (id) {
          case "add": {
            const { project, defaulted } = yield* addProject(required(name, "project name"), required(values.clone, "--clone"), settings);
            if (defaulted.length) process.stderr.write(`Defaulted ${defaulted.map(key => `${key} to ${JSON.stringify(project[key])}`).join(", ")}; project update changes them\n`);
            return { ...project, defaulted };
          }
          case "update": return yield* updateProject(required(name, "project name"), settings);
          case "list": {
            const entries = yield* store.projectEntries();
            const tasks = yield* store.list();
            if (entries.some(entry => "malformed" in entry)) process.exitCode = 1;
            return entries.map(entry => "malformed" in entry ? entry : {
              ...entry.project, running: tasks.filter(task => task.intake.projectName === entry.name && activeStates.has(task.run.state)).length,
            });
          }
          case "show": {
            const project = yield* store.project(required(name, "project name"));
            if (!project) return yield* Effect.fail(new NotFound({ message: `No project is registered as "${name}"` }));
            const tasks = (yield* store.list()).filter(task => task.intake.projectName === project.name);
            const holders = yield* store.holders(project.name);
            const unlanded = yield* store.unlanded(project.name);
            return {
              ...project, running: holders.map(task => task.id), unlanded: unlanded.map(task => task.id),
              tasks: tasks.map(task => ({ id: task.id, kind: task.intake.kind, state: task.run.state, delivery: task.policy.delivery ?? null, branch: task.intake.branch })),
              events: yield* store.projectEvents(project.name),
            };
          }
          default: return yield* store.removeProject(required(name, "project name"));
        }
      }
      case "backlog": {
        const list = (text: string | undefined) => (text ?? "").split(",").map(part => part.trim()).filter(Boolean);
        const kinds = ["ship", "scout", "captain"] as const;
        const kind = values.kind === undefined ? undefined : kinds.find(k => k === values.kind);
        if (values.kind !== undefined && !kind) return yield* Effect.fail(new InvalidInput({ message: "--kind must be ship, scout, or captain" }));
        switch (id) {
          case "add": return yield* viewItem(yield* store.addItem({
            title: required(name, "item title"), kind: kind ?? "ship",
            ...(values.id !== undefined ? { id: values.id } : {}), ...(values.project !== undefined ? { project: values.project } : {}),
            ...(values.prompt !== undefined ? { prompt: values.prompt } : {}), dependsOn: list(values.depends),
            ...(values.defer !== undefined ? { deferUntil: values.defer } : {}), ...(values.note !== undefined ? { note: values.note } : {}),
          }));
          case "list": {
            const statuses = ["queued", "in-flight", "held", "done"];
            if (values.status !== undefined && !statuses.includes(values.status)) return yield* Effect.fail(new InvalidInput({ message: `--status must be ${statuses.join(", ")}` }));
            const items = values.archived ? yield* store.archivedItems() : (yield* store.items()).filter(item => values.status === undefined || item.status === values.status);
            const divergences = yield* store.diverged();
            if (divergences.length) process.stderr.write(`RECORD DIVERGENCE: ${divergences.length} captain call record(s) disagree; see firstmate backlog diverged
`);
            return yield* Effect.forEach(items, viewItem);
          }
          case "show": {
            const item = yield* store.item(required(name, "item ID"));
            return { ...(yield* viewItem(item)), holds: yield* store.itemHolds(item.id), events: yield* store.itemEvents(item.id),
              task: item.taskId ? shown(yield* store.inspect(item.taskId)) : null };
          }
          case "update": return yield* viewItem(yield* store.updateItem(required(name, "item ID"), {
            ...(values.title !== undefined ? { title: values.title } : {}), ...(kind !== undefined ? { kind } : {}),
            ...(values.project !== undefined ? { project: values.project } : {}), ...(values.prompt !== undefined ? { prompt: values.prompt } : {}),
            ...(values.depends !== undefined ? { dependsOn: values.depends === "none" ? [] : list(values.depends) } : {}),
            ...(values.defer !== undefined ? { deferUntil: values.defer === "none" ? null : values.defer } : {}),
            ...(values.note !== undefined ? { note: values.note } : {}),
          }));
          case "dispatch": {
            const { delivery, yolo, surface } = values;
            if (delivery !== undefined && delivery !== "no-mistakes" && delivery !== "direct-PR" && delivery !== "local-only") {
              return yield* Effect.fail(new InvalidInput({ message: "--delivery must be no-mistakes, direct-PR, or local-only" }));
            }
            if (surface !== undefined && surface !== "internal-only" && surface !== "product-facing" && surface !== "mixed" && surface !== "uncertain") {
              return yield* Effect.fail(new InvalidInput({ message: "--surface must be internal-only, product-facing, mixed, or uncertain" }));
            }
            const { task, item } = yield* dispatchItem(required(name, "item ID"), {
              ...(values.project !== undefined ? { project: values.project } : {}), ...(delivery ? { delivery } : {}), ...(surface ? { surface } : {}),
              ...(yolo !== undefined ? { yolo: yield* Effect.try({ try: () => onOff(yolo), catch: appError }) } : {}),
              ...(values.target !== undefined ? { target: values.target } : {}), ...(values.base ? { base: values.base } : {}),
              ...overrides(values), ...(values["max-turns"] ? { maxTurns: Number(values["max-turns"]) } : {}),
              ...(values.budget ? { maxBudgetUsd: Number(values.budget) } : {}),
            });
            const resolution = (yield* store.events(task.id)).find(event => event.type === "intake.resolved")?.data as IntakeResolution;
            if (resolution.gap) process.stderr.write(`${resolution.gap}\n`);
            return { item: yield* viewItem(item), task: { ...encodeCreatedTask(task), resolution } };
          }
          case "hold": {
            const { item, hold } = yield* store.holdItem(name ?? null, {
              reason: required(values.reason, "--reason"), until: values.until ?? null, origin: values.origin ?? null,
              ...(values.title !== undefined ? { title: values.title } : {}), ...(values.project !== undefined ? { project: values.project } : {}),
            });
            return { item: yield* viewItem(item), hold };
          }
          case "answer": {
            const { item, hold } = yield* store.answerItem(required(name, "item ID"), yield* answerRequest(values));
            return { item: yield* viewItem(item), hold };
          }
          case "remove": return yield* store.removeItem(required(name, "item ID"));
          case "complete": return yield* completeScout(required(name, "scout task ID"), list(values.items), values.none === true);
          case "diverged": {
            const divergences = yield* store.diverged();
            if (divergences.length) process.exitCode = 1;
            return divergences;
          }
          default: return values["done-keep"] === undefined ? yield* store.backlogSettings()
            : yield* store.setBacklogSettings({ doneKeep: /^[0-9]+$/.test(values["done-keep"]) ? Number(values["done-keep"]) : Number.NaN });
        }
      }
      case "secondmate": {
        const transport = yield* Transport;
        const list = (text: string | undefined) => (text ?? "").split(",").map(part => part.trim()).filter(Boolean);
        const observed = (secondmate: { home: string }) => transport.liveness(secondmate.home).pipe(Effect.catch(error => Effect.succeed({ owner: "unknown" as const, pid: null, error: error.message })));
        switch (id) {
          case "create": return yield* createSecondmate({
            id: required(name, "secondmate id"), charter: required(values.charter, "--charter"), scope: required(values.scope, "--scope"), projects: list(values.projects),
            ...(values.at !== undefined ? { home: values.at } : {}), ...(values.relaunches !== undefined ? { relaunches: /^[0-9]+$/.test(values.relaunches) ? Number(values.relaunches) : Number.NaN } : {}),
          });
          case "list": return yield* Effect.forEach(yield* store.secondmates(), secondmate => Effect.map(observed(secondmate), liveness => ({ ...secondmate, liveness })));
          case "show": {
            const secondmate = yield* store.secondmate(required(name, "secondmate id"));
            yield* readReplies(secondmate.id).pipe(Effect.ignore);
            return {
              ...secondmate, liveness: yield* observed(secondmate),
              unlanded: secondmate.status === "active" ? yield* transport.unlanded(secondmate.home).pipe(Effect.catch(error => Effect.succeed([`unreadable: ${error.message}`]))) : [],
              requests: yield* store.requests(secondmate.id), handoffs: yield* store.handoffs(secondmate.id), events: yield* store.secondmateEvents(secondmate.id),
            };
          }
          case "launch": {
            const args = [
              ...(values.concurrency ? ["--concurrency", values.concurrency] : []), ...(values["poll-ms"] ? ["--poll-ms", values["poll-ms"]] : []),
              ...(values["stale-after"] ? ["--stale-after", values["stale-after"]] : []), ...(values.recoveries ? ["--recoveries", values.recoveries] : []),
            ];
            return yield* launchSecondmate(required(name, "secondmate id"), args.length ? args : undefined);
          }
          case "stop": return yield* stopSecondmate(required(name, "secondmate id"), values.reason ?? "Stopped by the captain");
          case "retire": return yield* retireSecondmate(required(name, "secondmate id"));
          case "match": return yield* matchItem(required(name, "item ID"));
          case "route": return yield* routeItem(required(name, "item ID"), values.to);
          case "handoff": return yield* handoffItems(required(name, "secondmate id"), list(required(values.items, "--items")));
          case "request": {
            const kind = values.kind ?? "ship";
            if (kind !== "ship" && kind !== "scout") return yield* Effect.fail(new InvalidInput({ message: "--kind must be ship or scout" }));
            const { surface } = values;
            if (surface !== undefined && surface !== "internal-only" && surface !== "product-facing" && surface !== "mixed" && surface !== "uncertain") {
              return yield* Effect.fail(new InvalidInput({ message: "--surface must be internal-only, product-facing, mixed, or uncertain" }));
            }
            const prompt = required(values.prompt, "--prompt");
            return yield* requestWork(required(name, "secondmate id"), {
              prompt, kind, project: required(values.project, "--project"), title: values.title ?? prompt.split("\n")[0]!.slice(0, 80), ...(surface ? { surface } : {}),
            });
          }
          case "requests": {
            yield* readReplies(name);
            return yield* store.requests(name);
          }
          case "handoffs": {
            const handoffs = yield* store.handoffs(name);
            return yield* Effect.forEach(handoffs, handoff => Effect.gen(function*() {
              const secondmate = yield* store.secondmate(handoff.secondmate);
              const received = yield* transport.received(secondmate.home, handoff.correlation).pipe(Effect.catch(error => Effect.succeed(`unreadable: ${error.message}`)));
              const location = handoff.phase === "restored" ? "main backlog (restored)" : received === true ? `secondmate ${secondmate.id}'s backlog` : "in transit, owned by the main home";
              return { ...handoff, items: handoff.items.map(item => item.id), receivedBySecondmate: received, location };
            }));
          }
          case "recover": return yield* recoverSecondmates();
          case "review": return {
            recovered: yield* recoverSecondmates(), preferences: yield* pushPreferences(), replies: yield* readReplies(), processes: yield* reviewSecondmates(),
          };
          default: {
            const identity = yield* store.identity();
            if (!identity) return yield* Effect.fail(new InvalidInput({ message: "This is a main home; its requests are listed by firstmate secondmate requests" }));
            return { identity, inbox: yield* store.inbox() };
          }
        }
      }
      case "preferences": switch (id) {
        case "show": return { identity: yield* store.identity(), preferences: yield* store.preferences() };
        case "set": {
          const preferences = yield* store.setPreferences(required(values.text, "--text"));
          return { preferences, pushed: yield* pushPreferences() };
        }
        default: {
          const preferences = yield* store.setPreferences(null);
          return { preferences, pushed: yield* pushPreferences() };
        }
      }
      case "dispatch": {
        if (id === "check") {
          const config = yield* loadConfig();
          return { config, verifiedRuntimes: [...(yield* Runtimes).verified.keys()], knownRuntimes };
        }
        const kind = values.kind ?? "ship";
        if (kind !== "ship" && kind !== "scout") return yield* Effect.fail(new InvalidInput({ message: "Kind must be ship or scout" }));
        const project = values.project !== undefined && projectNamePattern.test(values.project) ? yield* store.project(values.project) : null;
        return yield* resolveDispatch({ kind, projectName: project?.name ?? null, prompt: required(values.prompt, "--prompt"), ...overrides(values) });
      }
      case "account": switch (id) {
        case "show": return yield* store.accountPins();
        default: {
          const runtime = required(name, "runtime");
          if (!knownRuntimes.includes(runtime)) return yield* Effect.fail(new InvalidInput({ message: `Unknown runtime "${runtime}" (known: ${knownRuntimes.join(", ")})` }));
          return yield* store.setAccountPin(runtime, id === "pin" ? required(values.root, "--root <directory|ordinary>") : null);
        }
      }
      case "posture": switch (id) {
        case "away": case "quiet": {
          const words = values["words-file"] !== undefined ? yield* Effect.tryPromise({ try: () => readFile(values["words-file"]!, "utf8"), catch: appError }) : values.words;
          const { posture, change, replaced, returned } = yield* enterPosture(id, words);
          if (returned) process.stderr.write(renderBrief(returned));
          process.stderr.write(id === "quiet"
            ? `Quiet ${change === "refreshed" ? "is already active" : "is active"}: routine wakes stay silent, captain-relevant ones are still reported at once; ordinary commands keep it, only firstmate posture quiet-off ends it\n`
            : `Away ${change === "entered" ? "is active" : change === "words-replaced" ? "continues under your new words" : "continues unchanged"}: ${posture.words === null ? "no instructions were recorded" : "your words are recorded verbatim as the whole mandate"}; anything that needs you waits for your return, and destructive, irreversible, and security-sensitive actions are never pre-authorized\n`);
          return { posture, change, replaced, ...(returned ? { returned } : {}) };
        }
        case "show": return yield* showPosture();
        default: {
          const brief = id === "brief" ? yield* returnBrief(values.session) : yield* leavePosture(id === "return" ? "return" : "quiet-off", `posture ${id}`);
          if (values.json) return brief;
          process.stdout.write(renderBrief(brief));
          return undefined;
        }
      }
      case "memory": {
        if (id === "show") return { home: store.home, memory: yield* readMemory() };
        const memory = yield* changeMemory(memoryFile as MemoryFile, id === "append" ? "append" : "replace", required(values.text, "--text"));
        return { memory, ...(memoryFile === "shared" ? { pushed: yield* pushPreferences() } : {}) };
      }
      case "stow": return yield* stowHome(values.learning ?? []);
      case "source": {
        const { ledger } = store;
        const sequence = () => {
          const value = Number(required(positionals[3], "result sequence"));
          if (!Number.isSafeInteger(value) || value < 1) throw new InvalidInput({ message: "A result sequence is a positive integer" });
          return value;
        };
        switch (id) {
          case "register": {
            const when = values.when ?? "exit-zero";
            if (!["exit-zero", "exit-nonzero", "any", "changed"].includes(when)) return yield* Effect.fail(new InvalidInput({ message: "--when must be exit-zero, exit-nonzero, any, or changed" }));
            return yield* ledger.registerSource({
              id: required(name, "source id"), argv: positionals.slice(3), when: when as "exit-zero",
              every: values.every === undefined ? null : Number(values.every), timeout: values.timeout === undefined ? null : Number(values.timeout),
            });
          }
          case "list": return yield* ledger.sources();
          case "show": {
            const source = yield* ledger.source(required(name, "source id"));
            const results = yield* ledger.results(source.id);
            return { source, results: results.map(({ stdout, stderr, ...result }) => ({ ...result, stdoutBytes: stdout.length, stderrBytes: stderr.length })) };
          }
          case "result": return yield* ledger.result(required(name, "source id"), yield* Effect.try({ try: sequence, catch: appError }));
          case "handled": {
            const handled = yield* ledger.handleResult(required(name, "source id"), yield* Effect.try({ try: sequence, catch: appError }));
            process.stderr.write(`${handled.outcome}: ${handled.source} ${handled.sequence}\n`);
            return handled;
          }
          case "start": return yield* ledger.restartSource(required(name, "source id"));
          default: return yield* ledger.retireSource(required(name, "source id"));
        }
      }
      case "inbox": {
        const { ledger } = store;
        switch (id) {
          case "note": {
            const saved = yield* ledger.addNote(required(values.text, "--text"), values["request-id"] ?? null);
            process.stderr.write(`${saved.outcome}: ${saved.note.id}\n`);
            return saved;
          }
          case "list": return yield* ledger.notes(values.all ? undefined : "waiting");
          case "show": return yield* ledger.note(required(name, "note id"));
          case "ack": return yield* ledger.ackNote(required(name, "note id"), values.note ?? null);
          case "reply": return yield* ledger.replyNote(required(name, "note id"), required(values.text, "--text"));
          default: {
            const after = values.after === undefined ? 0 : Number(values.after);
            if (!Number.isSafeInteger(after) || after < 0) return yield* Effect.fail(new InvalidInput({ message: "--after must be a nonnegative reply sequence" }));
            return yield* ledger.receipts(after);
          }
        }
      }
      case "relay": {
        const { ledger } = store;
        switch (id) {
          case "configure": return yield* ledger.configureRelay({
            endpoint: required(values.endpoint, "--endpoint"), tokenEnv: values["token-env"] ?? null, every: values.every === undefined ? 60 : Number(values.every),
          });
          case "off": return { relay: yield* ledger.configureRelay(null) };
          case "status": return { relay: yield* ledger.relay(), cursor: yield* ledger.relayCursor(), waiting: (yield* ledger.mentions()).filter(m => m.status === "waiting").length,
            openPromises: (yield* ledger.commitments()).filter(c => c.status === "open").length };
          case "mentions": return yield* ledger.mentions();
          case "show": {
            const mention = yield* ledger.mention(required(name, "request id"));
            return { mention, promises: (yield* ledger.commitments()).filter(c => c.requestId === mention.requestId), replies: (yield* ledger.actions()).filter(a => a.channel === "relay" && a.subject === mention.requestId) };
          }
          case "link": return yield* ledger.linkMention(required(name, "request id"), required(values.task, "--task"));
          case "promise": return yield* ledger.promise(required(name, "request id"), required(values.task, "--task"), required(values.summary, "--summary"));
          case "promises": return yield* ledger.commitments(name);
          case "release": return yield* ledger.releaseCommitment(required(name, "promise id"), required(values.reason, "--reason"));
          case "reply": {
            const requestId = required(name, "request id");
            yield* ledger.mention(requestId);
            const queued = yield* ledger.queue("relay", requestId, required(values.text, "--text"), values.final === true);
            process.stderr.write(`Queued ${queued.action.id}; nothing is sent until firstmate outbox consent ${queued.action.id}\n`);
            return queued;
          }
          case "ack": return yield* ledger.ackMention(required(name, "request id"), "handled");
          default: return yield* dismissMention(required(name, "request id"));
        }
      }
      case "upstream": {
        const { ledger } = store;
        switch (id) {
          case "link": return yield* linkUpstream(required(name, "backlog item or task id"), required(values.url, "--url"));
          case "links": return yield* ledger.links();
          case "unlink": return yield* ledger.unlink(required(name, "link id"));
          case "signals": return yield* ledger.signals(values.all ? undefined : "waiting");
          case "ack": {
            const disposition = values.disposition;
            if (disposition !== "filed" && disposition !== "hold" && disposition !== "no-action") return yield* Effect.fail(new InvalidInput({ message: "--disposition must be filed, hold, or no-action" }));
            return yield* ledger.ackSignal(required(name, "link id"), required(positionals[3], "signal token"), disposition, values.note ?? null);
          }
          default: {
            const queued = yield* ledger.queue("upstream", required(name, "link id"), required(values.text, "--text"), false);
            process.stderr.write(`Queued ${queued.action.id}; nothing is sent until firstmate outbox consent ${queued.action.id}\n`);
            return queued;
          }
        }
      }
      case "outbox": {
        const { ledger } = store;
        switch (id) {
          case "list": {
            const status = values.status;
            if (status !== undefined && !["awaiting-consent", "consented", "sending", "sent", "withdrawn"].includes(status)) return yield* Effect.fail(new InvalidInput({ message: "--status must be awaiting-consent, consented, sending, sent, or withdrawn" }));
            return yield* ledger.actions(status as "sent" | undefined);
          }
          case "show": return yield* ledger.action(required(name, "outbox id"));
          case "consent": return yield* ledger.consent(required(name, "outbox id"), values.note ?? null);
          case "send": return yield* sendAction(required(name, "outbox id"));
          default: return yield* ledger.withdraw(required(name, "outbox id"));
        }
      }
      case "extensions": return yield* listExtensions();
      case "update": {
        const onNote = (note: string) => process.stderr.write(`${note}\n`);
        if (id === "status") return { installation: yield* Effect.try({ try: () => locateInstallation(), catch: appError }).pipe(Effect.catch(error => Effect.succeed({ error: error.message }))), updates: yield* store.maintenance.updates() };
        if (id === "resume") return yield* resumeUpdate(onNote);
        const wait = values.wait === undefined ? undefined : Number(values.wait);
        return yield* updateFirstmate({ spec: required(values.to, "--to <version|tag|tarball>"), ...(wait !== undefined ? { waitMs: wait * 1000 } : {}), ...(values["dry-run"] ? { dryRun: true } : {}), onNote });
      }
      case "import": {
        if (id === "list") return yield* store.maintenance.imports();
        const only = (values.only ?? "").split(",").map(k => k.trim()).filter(Boolean);
        const unknown = only.filter(k => !(importKinds as readonly string[]).includes(k));
        if (unknown.length) return yield* Effect.fail(new InvalidInput({ message: `--only takes ${importKinds.join(", ")}` }));
        const result = yield* importBash({ from: required(values.from, "--from <bash home>"), ...(values.clones ? { clones: values.clones } : {}), only: only as ImportKind[], ...(values.apply ? { apply: true } : {}) });
        if (!values.apply) process.stderr.write("Dry run: nothing was imported; add --apply to import the records marked import\n");
        return result;
      }
      case "doctor": {
        const { git } = yield* Effect.promise(() => import("./worktrees.js"));
        const gitVersion = yield* Effect.tryPromise({ try: () => git(store.home, ["--version"]), catch: appError }).pipe(Effect.catch(error => Effect.succeed(error.message)));
        const installation = yield* Effect.try({ try: () => locateInstallation(), catch: appError }).pipe(Effect.catch(error => Effect.succeed({ error: error.message })));
        return { node: process.version, platform: process.platform, installation, architecture: process.arch, home: store.home, git: gitVersion,
          authentication: process.env.ANTHROPIC_API_KEY ? "API key present (not verified)" : "Delegated to Claude SDK: existing Claude login or configured provider (not verified)",
          runtimes: { verified: [...(yield* Runtimes).verified.keys()], known: knownRuntimes },
          sdk: "0.3.296", effect: "4.0.4", note: "No model request was made. Keep npm optional dependencies enabled for the SDK binary." };
      }
    }
  });
  try {
    const result = await Effect.runPromise(program.pipe(Effect.provide(applicationLayer(home))));
    if (result !== undefined) json(result);
  }
  finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
