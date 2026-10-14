import { Effect, FiberSet } from "effect";
import { activeStates, InvalidInput, type FirstmateError, type Task, type Wake } from "./domain.js";
import { TaskStore, type Supervision, type WakeSpec } from "./store.js";
import { classify } from "./classifier.js";
import { runTask, type RunOptions } from "./orchestrator.js";
import { landTask } from "./delivery.js";
import { validateTask } from "./validation.js";
import { readReplies, recoverSecondmates, pushPreferences, reviewSecondmates, serveInbox } from "./secondmates.js";
import { triageWake } from "./posture.js";
import { Extensions, type ReviewContext } from "./extensions.js";

export interface SuperviseOptions {
  /** Most task attempts running at once (default 2). */
  concurrency?: number;
  /** Time between reviews of the database (default 1000 ms). */
  pollMs?: number;
  /** SDK silence after which a running attempt is stale (default 600000 ms). */
  staleMs?: number;
  /** Automatic recoveries per task before escalation; a successful result resets the count (default 2). */
  recoveries?: number;
  /** Time between forge reviews that merge open yolo PRs once authorized, and the least time before a validation that could not be driven is retried (default 60000 ms). */
  forgeMs?: number;
  /** Aborting stops the supervisor and interrupts its attempts, which the next supervisor resumes. */
  signal?: AbortSignal;
  /** Receives each captain wake as it is recorded, except under a posture: routine ones then stay silent and away ones go to `onBatched`; presenting is not acknowledging. */
  onWake?: (wake: Wake) => void;
  /** Receives each captain-relevant wake the away posture batched for the captain's return. */
  onBatched?: (wake: Wake, why: string) => void;
  /** Receives a review that failed; the next review retries it. */
  onError?: (error: FirstmateError) => void;
  /** Time between reviews of the main home's secondmates: their processes, handoffs, requests, replies, and preferences (default 5000 ms). */
  secondmateMs?: number;
  /** Receives each secondmate outcome a review records, such as a relaunch, an escalation, or a reply. */
  onNote?: (note: string) => void;
  /** How long an acknowledged process source result that is still unhandled waits before it is announced again (default 900000 ms). */
  reannounceMs?: number;
  /** Passed to every attempt the supervisor runs. */
  run?: Pick<RunOptions, "pollMs" | "steerSettleMs">;
}

/** How long a stopping supervisor waits for its attempts to record their interruption. */
const shutdownMs = 30_000;
/** How often the supervisor records that it is still reviewing. */
const beaconMs = 10_000;

const settingsOf = (options: SuperviseOptions) => {
  const settings = {
    concurrency: options.concurrency ?? 2, pollMs: options.pollMs ?? 1_000, staleMs: options.staleMs ?? 600_000, recoveries: options.recoveries ?? 2, forgeMs: options.forgeMs ?? 60_000,
    ...(options.secondmateMs !== undefined ? { secondmateMs: options.secondmateMs } : {}), ...(options.reannounceMs !== undefined ? { reannounceMs: options.reannounceMs } : {}),
  };
  if (options.secondmateMs !== undefined && !(options.secondmateMs >= 1)) return new InvalidInput({ message: "The secondmate review interval must be positive" });
  if (!Number.isInteger(settings.concurrency) || settings.concurrency < 1 || settings.concurrency > 32) return new InvalidInput({ message: "Concurrency must be between 1 and 32" });
  if (!Number.isInteger(settings.recoveries) || settings.recoveries < 0) return new InvalidInput({ message: "Recoveries must be a nonnegative integer" });
  if (!(settings.pollMs >= 1) || !(settings.staleMs >= 1) || !(settings.forgeMs >= 1)) return new InvalidInput({ message: "Poll interval, stale bound, and forge interval must be positive" });
  return settings;
};

const condition = (task: Task, kind: "stale" | "orphaned" | "resume", detail: string): WakeSpec => ({
  key: `${kind}:${task.id}:${task.run.generation}`, consumer: "supervisor", kind, taskId: task.id, generation: task.run.generation, ref: null, cause: null, detail,
});

const recoveryPrompt = (task: Task, attempt: number, limit: number, why: string) =>
  `The supervisor restarted this task (recovery attempt ${attempt} of ${limit}) because ${why}. ` +
  `Inspect existing work and prior tool results before repeating actions, then continue the task below.\n\n${task.intake.prompt}`;

/**
 * Supervises the home until stopped: holds its supervisor lease, classifies
 * the event log into durable wakes through a cursor, recovers stale and
 * orphaned attempts on a bounded ladder, carries out relaunches, runs
 * queued tasks within the concurrency bound, drives no-mistakes validations, and merges authorized yolo PRs. Waiting is timers and SQLite
 * reads; the only model calls are the task attempts themselves.
 */
export const supervise = Effect.fn("firstmate.supervise")(function*(options: SuperviseOptions = {}) {
  const settings = settingsOf(options);
  if (settings instanceof InvalidInput) return yield* Effect.fail(settings);
  const store = yield* TaskStore;
  return yield* Effect.scoped(Effect.gen(function*() {
    const supervision: Supervision = yield* store.supervise(settings);
    const { concurrency, staleMs, recoveries } = settings;
    const runs = yield* FiberSet.make();
    // Tasks with an attempt forked by this supervisor, from fork until the attempt ends, with their registered project.
    const running = new Map<string, string | undefined>();
    const halt = new AbortController();
    const runOptions: RunOptions = {
      ...options.run, signal: halt.signal, supervisor: supervision.generation, activityMs: Math.max(1, Math.min(1_000, Math.floor(staleMs / 4))),
    };
    // Set from the record at each review: a draining supervisor starts nothing new and stops once its attempts and validations end.
    let draining = false;
    // Queued tasks this supervisor recorded as deferred for capacity, and registry problems it already reported.
    const deferred = new Set<string>();
    const reported = new Set<string>();
    const start = (task: Task, extra: RunOptions = {}) => Effect.suspend(() => {
      running.set(task.id, task.intake.projectName);
      deferred.delete(task.id);
      return FiberSet.run(runs, runTask(task.id, { ...runOptions, ...extra }).pipe(Effect.exit, Effect.ensuring(Effect.sync(() => running.delete(task.id)))));
    });
    /**
     * Whether the task's project has a place for another attempt, counting
     * attempts this supervisor forked that have not taken their lease yet.
     * A queued task without one stays queued, recorded once as deferred; a
     * malformed project is reported once and starts nothing.
     */
    const hasPlace = (task: Task) => Effect.gen(function*() {
      const room = yield* store.room(task.id);
      if (!room) return true;
      const holders = new Set(room.holders);
      for (const [id, project] of running) if (id !== task.id && project === room.project) holders.add(id);
      if (holders.size < room.capacity) return true;
      if (task.run.state === "queued" && !deferred.has(task.id)) {
        deferred.add(task.id);
        yield* store.defer(task.id, { project: room.project, capacity: room.capacity, holders: [...holders] });
      }
      return false;
    }).pipe(Effect.catch(error => Effect.gen(function*() {
      if (!reported.has(error.message)) {
        reported.add(error.message);
        yield* supervision.note({ lastError: error.message }).pipe(Effect.ignore);
        options.onError?.(error);
      }
      return false;
    })));
    // Tasks whose validation this supervisor is driving, and when driving one last failed.
    const driving = new Set<string>();
    const drivingFailedAt = new Map<string, number>();
    /**
     * Reports captain wakes as the home's posture says. Present, each one is
     * reported. Under away or quiet each is triaged: a routine wake is
     * acknowledged silently, a captain-relevant one stays open and is
     * reported at once in quiet or batched for the return in away.
     */
    const notify = (wakes: readonly Wake[]) => Effect.gen(function*() {
      const captain = wakes.filter(wake => wake.consumer === "captain");
      if (!captain.length) return;
      const posture = yield* store.posture();
      const entries = posture ? yield* Effect.forEach(captain, wake => Effect.map(wake.taskId ? Effect.option(store.get(wake.taskId)) : Effect.succeedNone, task => ({ wake, ...triageWake(wake, task._tag === "Some" ? task.value : null) }))) : [];
      const triaged = posture ? yield* supervision.triage(posture.id, entries) : null;
      if (!posture || !triaged) { for (const wake of captain) options.onWake?.(wake); return; }
      for (const entry of entries) {
        if (entry.verdict === "routine") continue;
        if (posture.mode === "quiet") options.onWake?.(entry.wake);
        else options.onBatched?.(entry.wake, entry.why);
      }
    });

    const classifyEvents = Effect.gen(function*() {
      while (true) {
        const from = yield* supervision.cursor();
        const events = yield* supervision.history(from);
        const last = events.at(-1);
        if (!last) return;
        yield* notify(yield* supervision.classified(from, last.sequence, events.flatMap(event => classify(event) ?? [])));
      }
    });

    /** Compares each attempt's lease with what this host observes: a dead owner is orphaned, a silent live one stale. */
    const review = Effect.gen(function*() {
      const found: WakeSpec[] = [];
      for (const { task, generation, owner, activeAt } of yield* supervision.attempts()) {
        if (task.run.generation !== generation) continue;
        if (owner === "absent" && activeStates.has(task.run.state)) found.push(condition(task, "orphaned", "Its owner exited without stopping it"));
        if (owner !== "live" || task.run.state !== "running") continue;
        // A state change, such as an answered decision, restarts the silence as SDK activity does.
        const silentMs = Date.now() - Math.max(Date.parse(activeAt ?? task.run.updatedAt), Date.parse(task.run.updatedAt));
        if (silentMs >= staleMs) found.push(condition(task, "stale", `it produced no SDK activity for ${Math.round(silentMs / 1000)} s`));
      }
      yield* notify(yield* supervision.raise(found));
    });

    /** The next ladder step: another recovery while attempts remain, otherwise escalation. */
    const ladder = (task: Task, cause: "stale" | "orphaned", why: string) => Effect.map(supervision.ladder(task.id), ({ attempts }) => attempts < recoveries
      ? { type: "recovery.attempted" as const, data: { attempt: attempts + 1, limit: recoveries, cause, detail: why } }
      : { type: "recovery.exhausted" as const, data: { attempts, limit: recoveries, cause, detail: why } });

    /** Stale: the live owner is asked to stop, and a relaunch resumes its exact session unless the ladder is exhausted. */
    const recoverStale = (wake: Wake) => Effect.gen(function*() {
      const { task, owner } = yield* store.inspect(wake.taskId!);
      if (task.run.generation !== wake.generation || task.run.state !== "running" || owner !== "live") return true;
      const step = yield* ladder(task, "stale", wake.detail);
      yield* supervision.recover(task.id, step, step.type === "recovery.attempted"
        ? { verb: "relaunch", reason: `Stale: ${wake.detail}`, prompt: recoveryPrompt(task, step.data.attempt, recoveries, wake.detail) }
        : { verb: "interrupt", reason: `Recovery exhausted: ${wake.detail}`, prompt: null });
      return true;
    });

    /**
     * Orphaned: no owner remains to stop, so the exact session is resumed
     * directly. The wake is acknowledged once a new generation holds the task.
     */
    const recoverOrphan = (wake: Wake) => Effect.gen(function*() {
      const { task, owner } = yield* store.inspect(wake.taskId!);
      if (task.run.generation !== wake.generation || !activeStates.has(task.run.state) || owner !== "absent") return true;
      if (draining || running.has(task.id) || running.size >= concurrency || !(yield* hasPlace(task))) return false;
      const step = yield* ladder(task, "orphaned", wake.detail);
      yield* supervision.recover(task.id, step);
      if (step.type === "recovery.exhausted") return true;
      yield* start(task, { resume: true, prompt: recoveryPrompt(task, step.data.attempt, recoveries, "its previous owner exited without stopping it") });
      return false;
    });

    /** Relaunch and resume: an interrupted generation resumes its exact session once its owner has let go. */
    const resumeStopped = (wake: Wake) => Effect.gen(function*() {
      const { task, owner } = yield* store.inspect(wake.taskId!);
      if (task.run.generation !== wake.generation || task.run.state !== "interrupted" || owner === "unknown") return true;
      if (draining || owner === "live" || running.has(task.id) || running.size >= concurrency || !(yield* hasPlace(task))) return false;
      const prompt = wake.kind === "relaunch" ? (yield* store.controls(task.id)).find(c => c.id === wake.ref)?.prompt : null;
      yield* start(task, { resume: true, ...(prompt ? { prompt } : {}) });
      return false;
    });

    /** True once the wake is handled; an unfinished one stays claimed and is handled again on the next review. */
    const handled = (wake: Wake) => {
      switch (wake.kind) {
        case "stale": return recoverStale(wake);
        case "orphaned": return recoverOrphan(wake);
        case "relaunch": case "resume": return resumeStopped(wake);
        default: return Effect.succeed(true);
      }
    };
    /** Each claimed wake is acknowledged only after it has been handled. */
    const handle = Effect.gen(function*() {
      for (const wake of yield* supervision.claim()) if (yield* handled(wake)) yield* supervision.acknowledge(wake.sequence);
    });

    /**
     * Merges each open yolo PR that merge authority now authorizes; its
     * landing records the outcome wake. A refusal is escalated once per ready
     * commit, unless a check is still pending or unreported and may yet pass.
     */
    let forgeAt = 0;
    const reviewForge = Effect.gen(function*() {
      if (draining || Date.now() - forgeAt < settings.forgeMs) return;
      forgeAt = Date.now();
      for (const task of yield* store.list()) {
        if (task.run.state !== "pr-open" || task.policy.yolo !== true || running.has(task.id) || driving.has(task.id)) continue;
        yield* landTask(task.id).pipe(Effect.asVoid, Effect.catch(error => error._tag === "MergeRefused" && !error.waiting
          ? Effect.asVoid(supervision.raise([{
            key: `refused:${task.id}:${task.run.commit}`, consumer: "captain", kind: "escalated", taskId: task.id, generation: task.run.generation, ref: task.run.pr?.url ?? null, cause: null,
            detail: `Yolo cannot merge: ${error.message}`,
          }]).pipe(Effect.flatMap(notify)))
          : error._tag === "MergeRefused" ? Effect.void : Effect.sync(() => options.onError?.(error))));
      }
    });

    /**
     * Drives the pipeline for each no-mistakes ship that needs it: a ready
     * commit not yet submitted, and a validating ship with no open hold and
     * no live driver. A validation driven to a hold stops until the captain
     * answers it; a failed one waits for an explicit validate.
     */
    const driveValidations = Effect.gen(function*() {
      if (draining) return;
      const holds = yield* store.holds();
      for (const task of yield* store.list()) {
        if (task.policy.delivery !== "no-mistakes" || driving.has(task.id) || running.has(task.id)) continue;
        if (Date.now() - (drivingFailedAt.get(task.id) ?? 0) < settings.forgeMs) continue;
        const validations = yield* store.validations(task.id);
        if (task.run.state === "ready") {
          if (validations.some(v => v.commit === task.run.commit)) continue;
        } else if (task.run.state === "validating") {
          const current = validations.findLast(v => v.status === "running");
          if (holds.some(h => h.status === "open" && h.subject?.validation === current?.id)) continue;
        } else continue;
        if ((yield* store.inspect(task.id)).owner !== "absent") continue;
        driving.add(task.id);
        yield* FiberSet.run(runs, validateTask(task.id, { signal: halt.signal }).pipe(
          Effect.tapError(error => Effect.sync(() => {
            drivingFailedAt.set(task.id, Date.now());
            if (error._tag !== "RunInterrupted") options.onError?.(error);
          })),
          Effect.exit, Effect.ensuring(Effect.sync(() => driving.delete(task.id)))));
      }
    });

    /** Starts queued tasks in creation order within the concurrency bound; one whose project is at capacity stays queued. */
    const startQueued = Effect.gen(function*() {
      for (const task of yield* store.list()) {
        if (draining || running.size >= concurrency) return;
        if (task.run.state === "queued" && !running.has(task.id) && (yield* hasPlace(task))) yield* start(task);
      }
    });

    /**
     * A secondmate home serves only the work routed to it. The main home
     * reviews its secondmates: interrupted handoffs and undelivered requests,
     * shared preferences, replies from their published status, and their
     * processes under the bounded relaunch policy. Each step fails alone.
     */
    const identity = yield* store.identity();
    const secondmateMs = options.secondmateMs ?? 5_000;
    let secondmatesAt = 0;
    // A failure that repeats on every review, such as a secondmate home that is gone, is reported once.
    const failures = new Set<string>();
    const failedOnce = (note: string) => { if (failures.has(note)) return; failures.add(note); options.onNote?.(note); };
    const step = <A, E extends FirstmateError, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.catch(error => Effect.sync(() => options.onError?.(error))));
    const reviewHomes = Effect.gen(function*() {
      if (identity) {
        yield* step(serveInbox().pipe(Effect.map(lines => lines.forEach(line => options.onNote?.(`Published ${line.state}${line.item ? ` for ${line.item}` : ""}: ${line.detail}`)))));
        return;
      }
      if (Date.now() - secondmatesAt < secondmateMs) return;
      secondmatesAt = Date.now();
      yield* step(recoverSecondmates().pipe(Effect.map(outcomes => outcomes.forEach(o => (o.outcome.startsWith("still") ? failedOnce : options.onNote)?.(`Recovered ${o.kind} ${o.id} for ${o.secondmate}: ${o.outcome}`)))));
      yield* step(pushPreferences().pipe(Effect.map(results => results.forEach(r => r.outcome === "error" ? failedOnce(`Preferences for ${r.id}: not pushed (${r.error})`) : r.outcome === "pushed" && options.onNote?.(`Preferences for ${r.id}: pushed`)))));
      yield* step(readReplies().pipe(Effect.map(replies => replies.forEach(r => options.onNote?.(`Reply from ${r.secondmate} for request ${r.correlation}: ${r.status.state}: ${r.status.detail}`)))));
      if (!draining) yield* step(reviewSecondmates().pipe(Effect.map(notes => notes.forEach(note => options.onNote?.(note)))));
    });

    /**
     * Opens every registered extension under this supervisor's generation.
     * Each delivers its wakes through notify, so they are reported as the
     * posture says; each review fails alone and is retried at the next tick.
     */
    const registry = yield* Extensions;
    const context: ReviewContext = {
      generation: supervision.generation, deliver: notify, error: error => options.onError?.(error), note: note => options.onNote?.(note),
      forgeMs: settings.forgeMs, reannounceMs: options.reannounceMs ?? 900_000,
    };
    const extensions = yield* Effect.forEach(registry.entries, entry => entry.open ? entry.open(context) : Effect.succeed(null));
    const reviewExtensions = Effect.forEach(extensions, opened => opened ? step(opened.review) : Effect.void, { discard: true });

    let reviewedAt = 0;
    const tick = Effect.gen(function*() {
      draining = (yield* supervision.current()).drainRequested === true;
      yield* classifyEvents;
      yield* review;
      yield* handle;
      yield* reviewHomes;
      yield* reviewExtensions;
      yield* startQueued;
      yield* driveValidations;
      yield* reviewForge;
      if (Date.now() - reviewedAt >= beaconMs) {
        reviewedAt = Date.now();
        yield* supervision.note({ reviewedAt: new Date(reviewedAt).toISOString() });
      }
    }).pipe(Effect.catch(error => supervision.note({ lastError: error.message }).pipe(Effect.ignore, Effect.andThen(Effect.sync(() => options.onError?.(error))))));

    let reason: "signal" | "request" | "drained" | undefined;
    while (!reason) {
      yield* tick;
      const current = yield* supervision.current();
      if (options.signal?.aborted) reason = "signal";
      else if (current.stopRequested) reason = "request";
      else if (current.drainRequested && running.size === 0 && driving.size === 0) reason = "drained";
      else yield* Effect.sleep(settings.pollMs);
    }

    // Each attempt this supervisor interrupts leaves a resume wake for the next one, so a restart resumes it.
    const interrupted = (yield* supervision.attempts()).filter(a => running.has(a.task.id) && a.pid === process.pid && a.owner === "live").map(a => a.task);
    yield* supervision.raise(interrupted.map(task => condition(task, "resume", "The supervisor stopped while it was running")));
    for (const opened of extensions) if (opened) yield* opened.close;
    halt.abort(new Error("Supervisor stopped"));
    yield* FiberSet.awaitEmpty(runs).pipe(Effect.timeout(shutdownMs), Effect.ignore);
    return { generation: supervision.generation, reclaimed: supervision.reclaimed?.generation ?? null, reason, interrupted: interrupted.map(task => task.id) };
  }));
});
