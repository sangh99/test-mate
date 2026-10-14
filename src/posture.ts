import { Effect } from "effect";
import { join } from "node:path";
import { TaskStore } from "./store.js";
import { changeMemory } from "./memory.js";
import { InvalidInput, NotFound, type LandingProof, type Posture, type PostureMode, type Task, type Triaged, type Wake } from "./domain.js";

/**
 * How a posture handles one captain wake. Only captain-relevant events are
 * batched for the captain: review-ready work, finished findings, holds, real
 * blockers, asks that may be destructive or security-sensitive, and
 * credential needs. Outcomes the supervisor carries on from under standing
 * authority are routine. The away words are never read here.
 */
export function triageWake(wake: Wake, task: Task | null): { verdict: "routine" | "captain"; why: string } {
  const routine = (why: string) => ({ verdict: "routine" as const, why });
  const captain = (why: string) => ({ verdict: "captain" as const, why });
  switch (wake.kind) {
    case "landed": return routine("a yolo landing is an outcome on record, listed under landings");
    case "published": return task?.policy.yolo ? routine("a yolo PR merges on its own once merge authority allows it")
      : captain("review-ready: the PR waits for the captain's merge decision");
    case "finished": {
      if (!task) return captain("the finished task could not be read");
      if (task.intake.kind === "scout") return captain("finished findings: a scout report to read");
      if (task.policy.delivery === "no-mistakes" && (task.run.state === "ready" || task.run.state === "validating")) return routine("the supervisor validates a no-mistakes ship on its own");
      if (task.policy.delivery === "direct-PR" && task.run.state !== "failed") return routine("a direct-PR ship is published next, and its PR is what the captain reviews");
      return captain(task.run.state === "local-ready" ? "review-ready: a local-only branch waits for the captain's landing" : `review-ready: the task stopped ${task.run.state}`);
    }
    case "failed": return captain("a real blocker: the failure needs the captain, and a credential or login need is reported this way");
    case "escalated": return captain("a real blocker: recovery is exhausted or a yolo merge was refused");
    case "decision": return captain("a tool call waits for the captain's answer and may be destructive or security-sensitive");
    case "hold": return captain("a hold only the captain's answer closes");
    case "steer": return captain("a real blocker: a steer's delivery cannot be proven");
    case "refresh": return captain("a real blocker: the clone refresh after a landing was refused");
    case "source-result": return captain("a registered process source captured a result to read and handle");
    case "source-down": return captain("a real blocker: a process source is stranded or failed to start, so nothing captures it");
    case "note": return captain("an inbox note waits to be handled and acknowledged");
    case "mention": return captain("a public Relay mention waits for its handling and any reply needs the captain's consent");
    case "followup": return captain("a promised final public reply is due and needs the captain's consent to send");
    case "upstream": return captain("an upstream contribution signal waits for its disposition");
    case "outbox": return captain("a real blocker: a consented public action failed to send");
    default: return routine("the supervisor's own recovery");
  }
}

/**
 * Enters away with the captain's words as the whole mandate, or quiet.
 * Quiet while away is the captain's return first, so it also returns the
 * brief of the away session it ended.
 */
export const enterPosture = Effect.fn("firstmate.enterPosture")(function*(mode: PostureMode, words?: string | null) {
  const store = yield* TaskStore;
  const active = yield* store.posture();
  const returned = mode === "quiet" && active?.mode === "away" ? yield* leavePosture("return", "posture quiet") : null;
  const entered = yield* store.enterPosture(mode, words);
  return { ...entered, returned };
});

/** Ends the active session (away by the captain's return, quiet by quiet-off) and renders its brief from the records. */
export const leavePosture = Effect.fn("firstmate.leavePosture")(function*(by: "return" | "quiet-off", command: string | null = null) {
  const store = yield* TaskStore;
  const posture = yield* store.endPosture(by, command);
  return yield* returnBrief(posture.id);
});

/** The home's posture now, with the counts of what the active session triaged. */
export const showPosture = Effect.fn("firstmate.showPosture")(function*() {
  const store = yield* TaskStore;
  const posture = yield* store.posture();
  const triaged = posture ? yield* store.triaged(posture.id) : [];
  return {
    mode: posture?.mode ?? "present" as const, posture,
    ...(posture ? { triaged: { routine: triaged.filter(t => t.verdict === "routine").length, captain: triaged.filter(t => t.verdict === "captain").length, open: triaged.filter(t => t.verdict === "captain" && t.open).length } } : {}),
    exit: posture?.mode === "away" ? "firstmate posture return, or any captain action" : posture?.mode === "quiet" ? "firstmate posture quiet-off only" : null,
    history: (yield* store.postures()).filter(p => p.endedAt).slice(-5).map(p => ({ id: p.id, mode: p.mode, enteredAt: p.enteredAt, endedAt: p.endedAt, endedBy: p.endedBy })),
  };
});

/** Wake kinds that report a real blocker: they are listed under what failed, not what waits. */
const blockers = new Set<Wake["kind"]>(["failed", "escalated", "steer", "refresh", "source-down", "outbox"]);

const landed = (proof: LandingProof) => "via" in proof
  ? { target: proof.target, commit: proof.commit, url: proof.url as string | null, merge: proof.mergeCommit as string | null, basis: proof.basis }
  : { target: proof.target, commit: proof.commit, url: null, merge: null, basis: proof.basis };

/**
 * The return brief of a session, built only from durable records: its words,
 * what waits on the captain (open holds, pending decisions, open captain
 * wakes with how the session triaged them, review-ready tasks), failures,
 * landings and finished findings in its window, what it handled silently,
 * and the backlog. The default is the active session, else the latest one.
 */
export const returnBrief = Effect.fn("firstmate.returnBrief")(function*(id?: string) {
  const store = yield* TaskStore;
  const posture: Posture | undefined = id ? yield* store.postureById(id) : (yield* store.posture()) ?? (yield* store.postures()).at(-1);
  if (!posture) return yield* Effect.fail(new NotFound({ message: "No away or quiet session is on record; firstmate posture away starts one" }));
  const since = posture.enteredAt;
  const to = posture.endedAt ?? new Date().toISOString();
  const tasks = yield* store.list();
  const byId = new Map(tasks.map(task => [task.id, task]));
  const triaged = yield* store.triaged(posture.id);
  const verdicts = new Map(triaged.map(t => [t.wake, t]));
  const openWakes = (yield* store.wakes("captain")).filter(wake => wake.status !== "acknowledged");
  const { record, owner } = yield* store.supervisor();
  const items = yield* store.items();
  const results = yield* store.eventsSince(["task.result"], since);
  const landings = yield* store.eventsSince(["task.landed"], since);
  const done = yield* store.itemEventsSince(["item.done"], since);
  const routine = triaged.filter(t => t.verdict === "routine");
  const described = (wake: Wake) => ({
    sequence: wake.sequence, kind: wake.kind, task: wake.taskId ?? wake.subject ?? null, detail: wake.detail, at: wake.createdAt,
    triage: verdicts.get(wake.sequence)?.why ?? (wake.createdAt >= since ? "not triaged: recorded while no supervisor read this session" : "open from before this session"),
  });
  const brief = {
    posture: { id: posture.id, mode: posture.mode, enteredAt: posture.enteredAt, endedAt: posture.endedAt, endedBy: posture.endedBy },
    window: { from: since, to, seconds: Math.max(0, Math.round((Date.parse(to) - Date.parse(since)) / 1000)) },
    instructions: {
      words: posture.words, since: posture.wordsAt, superseded: posture.superseded,
    },
    supervisor: { owner, generation: record?.generation ?? null, reviewedAt: record?.reviewedAt ?? null, lastError: record?.lastError ?? null },
    waiting: {
      holds: (yield* store.holds()).filter(hold => hold.status === "open").map(hold => ({ id: hold.id, item: hold.itemId, task: hold.taskId, question: hold.question, until: hold.until, since: hold.createdAt })),
      decisions: (yield* store.decisions()).filter(d => d.status === "pending").map(d => ({ id: d.id, task: d.taskId, tool: d.tool, since: d.createdAt })),
      wakes: openWakes.filter(wake => !blockers.has(wake.kind)).map(described),
      review: tasks.filter(task => task.run.state === "local-ready" || (task.run.state === "pr-open" && !task.policy.yolo) || (task.run.state === "ready" && task.policy.delivery !== "no-mistakes"))
        .map(task => ({ task: task.id, state: task.run.state, delivery: task.policy.delivery ?? null, commit: task.run.commit ?? null, pr: task.run.pr?.url ?? null })),
    },
    failed: {
      wakes: openWakes.filter(wake => blockers.has(wake.kind)).map(described),
      tasks: tasks.filter(task => task.run.state === "failed" && task.run.updatedAt >= since && !openWakes.some(wake => wake.taskId === task.id && blockers.has(wake.kind)))
        .map(task => ({ task: task.id, error: task.run.error ?? null, at: task.run.updatedAt })),
    },
    landed: landings.map(event => ({ task: event.taskId, at: event.createdAt, ...landed(event.data as LandingProof), cleanupDue: byId.get(event.taskId)?.run.state === "landed" })),
    findings: results.filter(event => byId.get(event.taskId)?.intake.kind === "scout" && (event.data as { state: string }).state === "completed")
      .map(event => ({ task: event.taskId, at: event.createdAt, report: join(store.home, "reports", event.taskId, `${event.generation}.md`) })),
    handled: {
      routine: routine.length, captain: triaged.length - routine.length,
      latest: routine.slice(-5).map(t => ({ wake: t.wake, kind: t.kind, task: t.taskId, detail: t.detail, why: t.why })),
    },
    backlog: {
      queued: items.filter(i => i.status === "queued").length, inFlight: items.filter(i => i.status === "in-flight").length,
      held: items.filter(i => i.status === "held").length, done: done.map(event => ({ item: event.itemId, at: event.createdAt, detail: (event.data as { detail: string }).detail })),
    },
  };
  return brief;
});
export type ReturnBrief = Effect.Success<ReturnType<typeof returnBrief>>;

const duration = (seconds: number) => {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${seconds % 60}s` : `${seconds}s`;
};
const indent = (text: string, by = "    ") => text.split("\n").map(line => `${by}${line}`).join("\n");

/** The brief as text, in the same order as its JSON. */
export function renderBrief(brief: ReturnBrief): string {
  const lines: string[] = [];
  const section = (title: string, rows: readonly string[], empty = "  (nothing)") => { lines.push(title, ...(rows.length ? rows : [empty])); };
  const { posture, window } = brief;
  lines.push(`=== Return brief (${posture.mode} ${window.from} -> ${window.to}, ${duration(window.seconds)}${posture.endedAt ? `, ended by ${posture.endedBy}` : ", still active"}) ===`);
  lines.push(`Supervisor: ${brief.supervisor.owner}${brief.supervisor.reviewedAt ? `, last review ${brief.supervisor.reviewedAt}` : ""}${brief.supervisor.lastError ? `, last error: ${brief.supervisor.lastError}` : ""}`);
  if (posture.mode === "away") {
    section("Your instructions (verbatim):", [
      ...(brief.instructions.words === null ? [] : [indent(brief.instructions.words, "  > ")]),
      ...brief.instructions.superseded.map(s => `  replaced at ${s.to}: ${s.words === null ? "(no words)" : JSON.stringify(s.words)}`),
    ], "  (no away instructions recorded)");
  }
  section("Waiting on you:", [
    ...brief.waiting.holds.map(h => `  - hold ${h.id} on ${h.item}${h.task ? ` (task ${h.task})` : ""}: ${h.question}${h.until ? ` [deferred until ${h.until}]` : ""}`),
    ...brief.waiting.decisions.map(d => `  - decision ${d.id}: ${d.task} asks to run ${d.tool}`),
    ...brief.waiting.wakes.map(w => `  - wake ${w.sequence} ${w.kind} ${w.task}: ${w.detail} (${w.triage})`),
    ...brief.waiting.review.map(r => `  - review ${r.task}: ${r.state}${r.pr ? ` ${r.pr}` : r.commit ? ` at ${r.commit}` : ""}`),
  ]);
  section("Tried and failed:", [
    ...brief.failed.wakes.map(w => `  - wake ${w.sequence} ${w.kind} ${w.task}: ${w.detail} (${w.triage})`),
    ...brief.failed.tasks.map(f => `  - ${f.task}: ${f.error ?? "failed"}`),
  ]);
  if (brief.waiting.wakes.length || brief.failed.wakes.length) lines.push("  firstmate supervisor wakes presents the open wakes; acknowledge them once handled");
  section("Landed:", brief.landed.map(l => `  - ${l.task}: ${l.url ?? l.commit} on ${l.target} (${l.basis})${l.cleanupDue ? `; cleanup due: firstmate cleanup ${l.task}` : ""}`));
  section("Finished findings:", brief.findings.map(f => `  - ${f.task}: ${f.report}`));
  lines.push("Handled silently:", `  ${brief.handled.routine} routine wake(s) acknowledged silently; ${brief.handled.captain} captain-relevant wake(s) ${posture.mode === "away" ? "batched for the return" : "reported at once"}`,
    ...brief.handled.latest.map(t => `  - wake ${t.wake} ${t.kind} ${t.task}: ${t.detail}`));
  lines.push("Backlog:", `  ${brief.backlog.queued} queued, ${brief.backlog.inFlight} in flight, ${brief.backlog.held} held; ${brief.backlog.done.length} done in this window`,
    ...brief.backlog.done.map(d => `  - ${d.item}: ${d.detail}`));
  return `${lines.join("\n")}\n`;
}

/**
 * Files what the home holds before a reset: the captain's uncaptured
 * learnings into the learnings memory, a host note on every open item that
 * has none, and a durable record listing the open holds and the batched
 * captain wakes still open. The backlog is not reconciled with repository or
 * PR state.
 */
export const stowHome = Effect.fn("firstmate.stowHome")(function*(learnings: readonly string[]) {
  const store = yield* TaskStore;
  if (learnings.some(text => !text.trim())) return yield* Effect.fail(new InvalidInput({ message: "A --learning must not be empty" }));
  for (const text of learnings) yield* changeMemory("learnings", "append", text);
  const filed = yield* store.stow(learnings.length);
  return {
    sequence: filed.sequence, posture: filed.posture ? { id: filed.posture.id, mode: filed.posture.mode } : null, learnings: learnings.length,
    noted: filed.noted.map(item => ({ id: item.id, status: item.status, note: item.notes.at(-1)!.text })),
    holds: filed.holds.map(hold => ({ id: hold.id, item: hold.itemId, question: hold.question })),
    batched: filed.batched.map((t: Triaged) => ({ wake: t.wake, kind: t.kind, task: t.taskId, detail: t.detail })),
  };
});
