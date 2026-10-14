import { Effect } from "effect";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TaskStore } from "./store.js";
import { Transport } from "./secondmates.js";
import { evaluateMerge } from "./delivery.js";
import { activeStates, appError, encodeTask, type LandingProof, type Task } from "./domain.js";

/** Landings, finished scouts, and closed items this recent are the snapshot's recent completions (default 7 days). */
export const recentDays = 7;
/** The most recent completions of each kind the snapshot lists. */
const recentLimit = 20;

export interface SnapshotOptions {
  /** Reads each open PR's current head and checks from its forge; off by default, so a snapshot reads only the home. */
  readonly prs?: boolean;
  /** How far back recent completions reach. */
  readonly days?: number;
}

const landed = (proof: LandingProof) => "via" in proof
  ? { target: proof.target, commit: proof.commit, url: proof.url as string | null, basis: proof.basis }
  : { target: proof.target, commit: proof.commit, url: null, basis: proof.basis };

/**
 * The fleet as one read-only projection of the home's records: tasks with
 * their observed owners, backlog items with what each waits on, open holds
 * and decisions, PRs, secondmates with their observed liveness, supervisor
 * health, posture, open captain wakes, what the extensions hold waiting, and
 * recent completions. Every fleet report reads this; it writes nothing, and
 * it contacts a forge only when `prs` asks for live PR state.
 */
export const fleetSnapshot = Effect.fn("firstmate.fleetSnapshot")(function*(options: SnapshotOptions = {}) {
  const store = yield* TaskStore;
  const transport = yield* Transport;
  const { ledger } = store;
  const at = new Date().toISOString();
  const days = options.days ?? recentDays;
  const since = new Date(Date.parse(at) - days * 86_400_000).toISOString();
  const tasks = yield* store.list();
  const inspections = yield* Effect.forEach(tasks, task => store.inspect(task.id));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const supervision = yield* store.supervision();
  const posture = yield* store.posture();
  const items = yield* store.items();
  const holds = (yield* store.holds()).filter(hold => hold.status === "open");
  const live = new Map(yield* Effect.forEach(tasks.filter(task => task.run.pr && options.prs), task => evaluateMerge(task.id).pipe(
      Effect.map(({ pr, checks, verdict }) => ({ task: task.id, state: pr.state, head: pr.head, checks: checks.map(c => ({ name: c.name, conclusion: c.conclusion })), mergeable: verdict.authorized, refusal: verdict.authorized ? null : verdict.reasons, error: null as string | null })),
      Effect.catch(error => Effect.succeed({ task: task.id, state: null, head: null, checks: [], mergeable: null, refusal: null, error: error.message })),
      Effect.map(read => [task.id, read] as const))));
  const secondmates = yield* Effect.forEach((yield* store.secondmates()).filter(s => s.status === "active"), secondmate => Effect.gen(function*() {
    const liveness = yield* transport.liveness(secondmate.home).pipe(Effect.catch(error => Effect.succeed({ owner: "unknown" as const, pid: null, error: error.message })));
    const requests = (yield* store.requests(secondmate.id)).filter(request => request.status !== "replied");
    return {
      id: secondmate.id, scope: secondmate.scope, home: secondmate.home, projects: secondmate.projects, liveness,
      desired: secondmate.launch.desired, relaunches: { attempts: secondmate.launch.attempts, limit: secondmate.launch.limit }, exhausted: secondmate.launch.exhausted,
      openRequests: requests.map(request => ({ correlation: request.correlation, title: request.work.title, status: request.status, latest: request.replies.at(-1)?.state ?? null })),
    };
  }));
  const sources = yield* ledger.sources();
  const unhandled = (yield* Effect.forEach(sources, source => ledger.results(source.id))).flat().filter(result => result.handledAt === null);
  const landings = (yield* store.eventsSince(["task.landed"], since)).slice(-recentLimit);
  const findings = (yield* store.eventsSince(["task.result"], since))
    .filter(event => byId.get(event.taskId)?.intake.kind === "scout" && (event.data as { state: string }).state === "completed").slice(-recentLimit);
  const closed = (yield* store.itemEventsSince(["item.done"], since)).slice(-recentLimit);
  return {
    at, home: store.home, identity: yield* store.identity(),
    supervisor: {
      owner: supervision.owner, pid: supervision.supervisor?.pid ?? null, generation: supervision.supervisor?.generation ?? null, startedAt: supervision.supervisor?.startedAt ?? null,
      reviewedAt: supervision.supervisor?.reviewedAt ?? null, lastError: supervision.supervisor?.lastError ?? null,
      stopRequested: supervision.supervisor?.stopRequested ?? false, drainRequested: supervision.supervisor?.drainRequested ?? false,
      owned: supervision.owned, recovering: supervision.recovering, wakes: supervision.wakes,
    },
    posture: posture ? { id: posture.id, mode: posture.mode, enteredAt: posture.enteredAt, words: posture.words } : { id: null, mode: "present" as const, enteredAt: null, words: null },
    tasks: inspections.map(inspection => ({ ...inspection, task: encodeTask(inspection.task) })),
    backlog: yield* Effect.forEach(items, item => Effect.map(store.waiting(item), waiting => ({
      id: item.id, title: item.title, kind: item.kind, status: item.status, project: item.project, taskId: item.taskId, hold: item.hold, dependsOn: item.dependsOn, deferUntil: item.deferUntil, waiting, createdAt: item.createdAt,
    }))),
    holds: holds.map(hold => ({ id: hold.id, item: hold.itemId, task: hold.taskId, question: hold.question, until: hold.until, origin: hold.origin, since: hold.createdAt })),
    decisions: (yield* store.decisions()).filter(d => d.status === "pending").map(d => ({ id: d.id, task: d.taskId, tool: d.tool, since: d.createdAt })),
    prs: tasks.flatMap(task => task.run.pr ? [{
      task: task.id, url: task.run.pr.url, number: task.run.pr.number, head: task.run.pr.head, target: task.run.pr.target, taskState: task.run.state, yolo: task.policy.yolo ?? false, live: live.get(task.id) ?? null,
    }] : []),
    secondmates,
    projects: (yield* store.projectEntries()).map(entry => "malformed" in entry ? { name: entry.name, malformed: entry.malformed } : {
      name: entry.name, delivery: entry.project.delivery, yolo: entry.project.yolo, capacity: entry.project.capacity,
      running: tasks.filter(task => task.intake.projectName === entry.name && activeStates.has(task.run.state)).length,
    }),
    wakes: (yield* store.wakes("captain")).filter(wake => wake.status !== "acknowledged")
      .map(wake => ({ sequence: wake.sequence, kind: wake.kind, task: wake.taskId, subject: wake.subject ?? null, detail: wake.detail, at: wake.createdAt })),
    waiting: {
      sources: {
        results: unhandled.map(result => ({ source: result.source, sequence: result.sequence, exitCode: result.exitCode, capturedAt: result.capturedAt })),
        down: sources.filter(source => source.status === "stranded" || source.status === "failed").map(source => ({ id: source.id, status: source.status, problem: source.problem })),
      },
      inbox: (yield* ledger.notes("waiting")).map(note => ({ id: note.id, text: note.text, at: note.submittedAt })),
      mentions: (yield* ledger.mentions()).filter(m => m.status === "waiting").map(m => ({ requestId: m.requestId, at: m.receivedAt })),
      promises: (yield* ledger.commitments()).filter(c => c.status === "open").map(c => ({ id: c.id, requestId: c.requestId, task: c.taskId, summary: c.summary })),
      upstream: (yield* ledger.signals("waiting")).map(s => ({ link: s.link, token: s.token, triage: s.triage, url: s.url, excerpt: s.excerpt })),
      outbox: (yield* ledger.actions("awaiting-consent")).map(a => ({ id: a.id, channel: a.channel, subject: a.subject })),
    },
    recent: {
      since,
      landed: landings.map(event => ({ task: event.taskId, at: event.createdAt, ...landed(event.data as LandingProof) })),
      findings: findings.map(event => ({ task: event.taskId, at: event.createdAt, report: join(store.home, "reports", event.taskId, `${event.generation}.md`) })),
      done: closed.map(event => ({ item: event.itemId, at: event.createdAt, detail: (event.data as { detail: string }).detail })),
    },
  };
});
export type FleetSnapshot = Effect.Success<ReturnType<typeof fleetSnapshot>>;

type Row = { readonly line: string; readonly detail?: readonly string[] };

const titleOf = (task: FleetSnapshot["tasks"][number]["task"]) => task.prompt.split("\n")[0]!.slice(0, 80);

/**
 * Bearings: the snapshot sorted into the four sections a captain resumes
 * from, in this order. Captain's Call holds only what needs the captain's own
 * action now; Recently Landed the recent completions; Underway live work
 * progressing on its own; Charted Next queued, gated, or deferred work and
 * integrity warnings. Each item appears once in the first section it fits.
 */
export function bearings(snapshot: FleetSnapshot) {
  const call: Row[] = [], landedRows: Row[] = [], underway: Row[] = [], charted: Row[] = [];
  const now = snapshot.at;
  const tasks = snapshot.tasks.map(t => t.task);
  const reviewReady = (task: typeof tasks[number]) => task.state === "local-ready" || (task.state === "pr-open" && !task.yolo) || (task.state === "ready" && task.delivery !== "no-mistakes" && task.kind === "ship");
  for (const hold of snapshot.holds) {
    const row = { line: `hold ${hold.id} on item ${hold.item}${hold.task ? ` (task ${hold.task})` : ""}: ${hold.question.split("\n")[0]}`, detail: [`Question and options: ${hold.question}`, `Held since ${hold.since}${hold.origin ? `, raised by ${hold.origin}` : ""}`, `Answer: firstmate backlog answer ${hold.item} --answer "<your words>"`] };
    if (hold.until && hold.until > now) charted.push({ line: `${row.line} [deferred until ${hold.until}]`, detail: row.detail });
    else call.push(row);
  }
  for (const d of snapshot.decisions) call.push({ line: `decision ${d.id}: task ${d.task} asks to run ${d.tool}`, detail: [`Asked at ${d.since}`, `Answer: firstmate answer ${d.id} --decision allow|deny`] });
  for (const task of tasks.filter(reviewReady)) {
    const pr = snapshot.prs.find(p => p.task === task.id);
    const live = pr?.live ? ` - ${pr.live.error ? `live read failed: ${pr.live.error}` : `${pr.live.state}, ${pr.live.mergeable ? "mergeable once you approve" : `not mergeable: ${(pr.live.refusal ?? []).join("; ")}`}`}` : "";
    call.push({
      line: `review ${task.id} (${task.state}): ${pr ? pr.url : task.commit ? `commit ${task.commit} on ${task.branch}` : task.branch}${live}`,
      detail: [`Task: ${titleOf(task)}`, ...(pr ? [`PR ${pr.url} into ${pr.target} at head ${pr.head}`] : []), task.state === "pr-open" || task.state === "local-ready" ? `Land: firstmate approve ${task.id}, then firstmate land ${task.id}` : `Next: firstmate show ${task.id}`],
    });
  }
  const blockers = new Set(["failed", "escalated", "steer", "refresh", "source-down", "outbox"]);
  for (const wake of snapshot.wakes.filter(w => blockers.has(w.kind))) call.push({ line: `blocker: wake ${wake.sequence} ${wake.kind} ${wake.task ?? wake.subject ?? ""}: ${wake.detail}`, detail: [`Recorded ${wake.at}; present it with firstmate supervisor wakes`] });
  for (const task of tasks.filter(t => t.state === "failed" && !snapshot.wakes.some(w => w.task === t.id && blockers.has(w.kind)))) {
    call.push({ line: `failed ${task.id}: ${(task.error ?? "no error recorded").split("\n")[0]}`, detail: [`Task: ${titleOf(task)}`, `Resume: firstmate resume ${task.id}, or discard: firstmate discard ${task.id} --reason <why>`] });
  }
  const { waiting } = snapshot;
  for (const note of waiting.inbox) call.push({ line: `inbox note ${note.id}: ${note.text.split("\n")[0]!.slice(0, 80)}`, detail: [`Handle, then firstmate inbox ack ${note.id}`] });
  for (const mention of waiting.mentions) call.push({ line: `Relay mention ${mention.requestId} waits for handling`, detail: [`firstmate relay show ${mention.requestId}`] });
  for (const signal of waiting.upstream) call.push({ line: `upstream signal on ${signal.url ?? `link ${signal.link}`} (${signal.triage}): ${signal.excerpt.split("\n")[0]!.slice(0, 80)}`, detail: [`firstmate upstream ack ${signal.link} ${signal.token} --disposition filed|hold|no-action`] });
  for (const action of waiting.outbox) call.push({ line: `outbox ${action.id}: the ${action.channel} action on ${action.subject} waits for your consent`, detail: [`firstmate outbox show ${action.id}`] });
  for (const result of waiting.sources.results) call.push({ line: `source ${result.source} result ${result.sequence} (exit ${result.exitCode ?? "none"}) waits to be handled`, detail: [`firstmate source result ${result.source} ${result.sequence}`] });
  for (const source of waiting.sources.down) call.push({ line: `source ${source.id} is ${source.status}${source.problem ? `: ${source.problem}` : ""}`, detail: [`firstmate source start ${source.id}`] });
  for (const mate of snapshot.secondmates.filter(m => m.exhausted)) call.push({ line: `secondmate ${mate.id} exhausted its relaunches (hold ${mate.exhausted})`, detail: [`firstmate secondmate launch ${mate.id} after reading its supervisor.log`] });

  for (const l of snapshot.recent.landed) landedRows.push({ line: `${l.task}: ${l.url ?? `commit ${l.commit}`} on ${l.target} (${l.at.slice(0, 10)})`, detail: [`Proof: ${l.basis}`] });
  for (const f of snapshot.recent.findings) landedRows.push({ line: `scout ${f.task} finished (${f.at.slice(0, 10)}); report ${f.report}` });
  // An item closed by its task's landing or finished scout is already listed through that task.
  const reported = new Set([...snapshot.recent.landed, ...snapshot.recent.findings].map(r => r.task));
  for (const d of snapshot.recent.done) {
    const taskId = snapshot.backlog.find(i => i.id === d.item)?.taskId;
    if (!taskId || !reported.has(taskId)) landedRows.push({ line: `item ${d.item} done: ${d.detail}` });
  }

  for (const task of tasks.filter(t => activeStates.has(t.state as Task["run"]["state"]) || t.state === "validating" || (t.state === "pr-open" && t.yolo) || (t.state === "ready" && t.delivery === "no-mistakes"))) {
    const inspection = snapshot.tasks.find(t => t.task.id === task.id)!;
    underway.push({ line: `${task.id} ${task.state}${inspection.owner !== "live" && activeStates.has(task.state as Task["run"]["state"]) ? ` (owner ${inspection.owner})` : ""}: ${titleOf(task)}`, detail: [`Branch ${task.branch}${task.delivery ? `, ${task.delivery}${task.yolo ? " yolo" : ""}` : ""}`, ...(inspection.lastActivityAt ? [`Last activity ${inspection.lastActivityAt}`] : [])] });
  }
  for (const mate of snapshot.secondmates) {
    if (mate.liveness.owner === "unknown") charted.push({ line: `warning: secondmate ${mate.id}'s state is unavailable (liveness unknown)`, detail: [`Home ${mate.home}`] });
    for (const request of mate.openRequests) underway.push({ line: `secondmate ${mate.id}: ${request.title} (${request.latest ?? request.status})` });
  }

  for (const task of tasks.filter(t => t.state === "queued")) charted.push({ line: `task ${task.id} queued: ${titleOf(task)}` });
  for (const task of tasks.filter(t => t.state === "interrupted")) charted.push({ line: `task ${task.id} interrupted, resumable: ${titleOf(task)}`, detail: [`firstmate resume ${task.id}, or the supervisor resumes it`] });
  for (const item of snapshot.backlog.filter(i => i.status === "queued")) {
    charted.push({ line: `item ${item.id} (${item.kind}): ${item.title}${item.waiting.length ? ` - waits on ${item.waiting.join("; ")}` : " - ready to dispatch"}`, detail: [`Filed ${item.createdAt.slice(0, 10)}${item.project ? ` for ${item.project}` : ""}`] });
  }
  for (const project of snapshot.projects) if ("malformed" in project) charted.push({ line: `warning: project ${project.name} is malformed: ${project.malformed}` });
  if (snapshot.supervisor.owner === "absent") charted.push({ line: "warning: no supervisor is running; queued work waits for firstmate supervisor start" });
  if (snapshot.supervisor.owner === "unknown") charted.push({ line: "warning: the supervisor's liveness is unknown from this host" });

  return {
    at: snapshot.at, home: snapshot.home, supervisor: snapshot.supervisor.owner, posture: snapshot.posture.mode,
    sections: [
      { title: "Captain's Call", rows: call, empty: "Captain, nothing needs your action right now." },
      { title: "Recently Landed", rows: landedRows, empty: `No recent completions are in the last ${Math.round((Date.parse(snapshot.at) - Date.parse(snapshot.recent.since)) / 86_400_000)} days.` },
      { title: "Underway", rows: underway, empty: "Nothing is underway." },
      { title: "Charted Next", rows: charted, empty: "Nothing is queued." },
    ],
  };
}
export type Bearings = ReturnType<typeof bearings>;

/** The four sections as terminal text, one line per item. */
export function renderBearings(report: Bearings, file?: string): string {
  const lines = [`=== Bearings ${report.at} (supervisor ${report.supervisor}, ${report.posture}) ===`];
  for (const section of report.sections) lines.push(`${section.title}:`, ...(section.rows.length ? section.rows.map(row => `  - ${row.line}`) : [`  ${section.empty}`]));
  if (file) lines.push(`Full report: ${file}`);
  return `${lines.join("\n")}\n`;
}

/** The dated Markdown report: a title, a framing line, and the same sections with each item's detail. */
export function bearingsMarkdown(report: Bearings): string {
  const day = new Date(report.at);
  const date = localDate(day);
  const counts = report.sections.map(s => `${s.rows.length} ${s.title}`).join(", ");
  const lines = [`# Bearings - ${day.toLocaleDateString("en-US", { weekday: "long" })} ${date}`, "",
    `Generated ${report.at} from the home at ${report.home}; the supervisor is ${report.supervisor} and the captain is ${report.posture}.`,
    `This is a complete current snapshot, not a change list: ${counts}.`];
  for (const section of report.sections) {
    lines.push("", `## ${section.title}`, "");
    if (!section.rows.length) lines.push(section.empty);
    for (const row of section.rows) lines.push(`- ${row.line}`, ...(row.detail ?? []).map(d => `  - ${d}`));
  }
  return `${lines.join("\n")}\n`;
}

/** YYYY-MM-DD in the local time zone. */
const localDate = (day: Date) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;

/** Replaces today's dated report under `<home>/reports` from scratch and returns its path. */
export const writeBearings = Effect.fn("firstmate.writeBearings")(function*(report: Bearings) {
  const store = yield* TaskStore;
  const path = join(store.home, "reports", `bearings-${localDate(new Date(report.at))}.md`);
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(join(store.home, "reports"), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, bearingsMarkdown(report), { encoding: "utf8", mode: 0o600 });
      await rm(path, { force: true });
      await rename(temporary, path);
    },
    catch: appError,
  });
  return path;
});
