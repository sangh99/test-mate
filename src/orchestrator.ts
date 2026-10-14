import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Cause, Effect, Exit, Option, Semaphore, Stream, type Scope } from "effect";
import {
  appError, AppError, InvalidInput, InvalidTransition, LiveOwner, RunFailed, RunInterrupted, TaskCancelled,
  type Control, type DeliveryMode, type Effort, type FirstmateError, type Steer, type Surface, type Task,
} from "./domain.js";
import { TaskStore, type Attempt, type TaskChange } from "./store.js";
import { contains, Worktrees } from "./worktrees.js";
import { resolveIntake } from "./projects.js";
import { Runtimes, staticRuntime, type RuntimeInput, type RuntimeSession, type ToolVerdict } from "./runtime.js";
import { resolveDispatch } from "./dispatch.js";
import { conclude, interpret, startStream, type StreamEffect, type StreamState } from "./interpreter.js";
import { publishTask } from "./delivery.js";
import { composeMemory } from "./memory.js";

export interface NewTask {
  /** A registered project's name, or a clone path (unregistered unless that clone is registered). */
  project: string;
  prompt: string;
  kind: "ship" | "scout";
  /** A local ref; defaults to a registered project's default branch, else HEAD. */
  base?: string;
  /** Resolved from the project registry when left out; refused for a scout. */
  delivery?: DeliveryMode;
  /** Merge posture; resolved from the project registry when left out; refused for a scout. */
  yolo?: boolean;
  /** The local branch a ship lands on; see `resolveTarget` for the default. */
  target?: string;
  /** What the ship changes, declared for a `no-mistakes-prod-only` project; refused for a scout. */
  surface?: Surface;
  /** Explicit dispatch overrides; see `resolveDispatch` for the precedence they head. */
  runtime?: string;
  model?: string;
  effort?: Effort;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** The backlog item this task is dispatched from; it moves to in-flight as the task is created. */
  item?: string;
}

/**
 * Creates a queued task. Its project, base, branch prefix, and a ship's
 * delivery policy are resolved by `resolveIntake` and recorded with how they
 * were resolved, in the `intake.resolved` event; its runtime, model, and
 * effort are chosen by `resolveDispatch` and recorded with the task.
 */
export const addTask = Effect.fn("firstmate.addTask")(function*(input: NewTask) {
  const store = yield* TaskStore;
  if (!input.prompt.trim()) return yield* Effect.fail(new InvalidInput({ message: "Task prompt must not be empty" }));
  const maxTurns = input.maxTurns ?? 30;
  const maxBudgetUsd = input.maxBudgetUsd ?? 5;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
    return yield* Effect.fail(new InvalidInput({ message: "maxTurns must be a positive integer and maxBudgetUsd must be positive" }));
  }
  const chosen = [input.delivery !== undefined && "delivery mode", input.yolo !== undefined && "yolo", input.target !== undefined && "target", input.surface !== undefined && "surface"]
    .filter(Boolean);
  if (input.kind === "scout" && chosen.length) {
    return yield* Effect.fail(new InvalidInput({ message: `A scout delivers a report, not a merge; remove its ${chosen.join(", ")}` }));
  }
  const intake = yield* resolveIntake(input);
  if (contains(intake.project, store.home)) return yield* Effect.fail(new InvalidInput({ message: "Firstmate home must be outside the source checkout" }));
  const dispatch = yield* resolveDispatch({
    kind: input.kind, projectName: intake.projectName ?? null, prompt: input.prompt,
    ...(input.runtime !== undefined ? { runtime: input.runtime } : {}), ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
  });
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const task: Task = {
    id, createdAt: timestamp,
    intake: {
      project: intake.project, ...(intake.projectName !== undefined ? { projectName: intake.projectName } : {}), base: intake.base,
      kind: input.kind, prompt: input.prompt, branch: `${intake.branchPrefix}${id}`,
      worktree: join(store.home, "worktrees", id), model: dispatch.model, maxTurns, maxBudgetUsd, dispatch,
    },
    policy: intake.policy,
    run: {
      state: "queued", generation: null, sessionId: null, costUsd: 0,
      output: "", error: null, cancelRequested: false, updatedAt: timestamp,
    },
  };
  return yield* store.create(task, intake.resolution, input.item);
});

export interface RunOptions {
  resume?: boolean;
  prompt?: string;
  signal?: AbortSignal;
  onText?: (text: string) => void;
  pollMs?: number;
  /** How long an idle session may leave a submitted steer unacknowledged after a result. */
  steerSettleMs?: number;
  /** The least time between writes of SDK activity as liveness evidence (default 1000 ms). */
  activityMs?: number;
  /** The supervisor generation running this attempt; other first runs are refused while a supervisor is live. */
  supervisor?: string;
}

/** The runtime's streaming input: open until the attempt proves no steering is outstanding. */
class InputStream implements AsyncIterable<RuntimeInput> {
  private readonly queue: RuntimeInput[] = [];
  private wake: (() => void) | undefined;
  // One permit serializes claiming, writing and closing, so a claimed steer
  // never meets a closed stream and closure is decided once.
  private readonly lock = Semaphore.makeUnsafe(1);
  closed = false;
  /** Set when a result left steering unacknowledged; the settle bound runs from here. */
  idleSince: number | undefined;
  constructor(private readonly attempt: Attempt) {}
  push(id: string, text: string) {
    if (this.closed) throw new Error("Input stream is closed");
    this.queue.push({ id, text });
    this.wake?.();
  }
  close() { this.closed = true; this.wake?.(); }
  /** Writes newly enqueued steers into the open stream. */
  feed(): Effect.Effect<void, FirstmateError> {
    return this.lock.withPermits(1)(Effect.suspend(() => this.closed ? Effect.void
      : this.attempt.claimSteers().pipe(Effect.map(steers => { for (const steer of steers) this.push(steer.id, steer.text); }))));
  }
  /** Closes once the store proves nothing is pending or unacknowledged. */
  closeIfSettled(): Effect.Effect<void, FirstmateError> {
    return this.lock.withPermits(1)(Effect.suspend(() => this.closed ? Effect.void
      : this.attempt.closeInput().pipe(Effect.map(settled => { if (settled) this.close(); }))));
  }
  end(): Effect.Effect<void> { return this.lock.withPermits(1)(Effect.sync(() => this.close())); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.queue.shift();
      if (next) { yield next; continue; }
      if (this.closed) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

/** The attempt's abort controller: follows the caller's signal and aborts when the scope closes. */
const abortScope = (signal: AbortSignal | undefined) => Effect.acquireRelease(Effect.sync(() => {
  const abort = new AbortController();
  const external = () => abort.abort(signal?.reason);
  signal?.addEventListener("abort", external, { once: true });
  if (signal?.aborted) external();
  return { abort, external };
}), ({ abort, external }) => Effect.sync(() => {
  signal?.removeEventListener("abort", external);
  abort.abort();
})).pipe(Effect.map(({ abort }) => abort));

type Changes = Stream.Stream<TaskChange, FirstmateError>;

/**
 * Aborts the attempt once the task is cancelled or superseded, or once a
 * lifecycle control names this generation, which the stop then applies.
 */
const watchRevocation = (attempt: Attempt, changes: Changes, abort: AbortController, controlled: (control: Control) => void) => changes.pipe(
  Stream.filter(change => attempt.revokedBy(change.task) || change.control !== null),
  Stream.runHead,
  Effect.map(revoked => {
    if (Option.isNone(revoked)) return;
    const { task, control } = revoked.value;
    if (control && !attempt.revokedBy(task)) {
      controlled(control);
      abort.abort(new Error(`Lifecycle control ${control.verb}: ${control.reason}`));
    } else abort.abort();
  }),
  Effect.catch(error => Effect.sync(() => abort.abort(error))));

const deny = (message: string): ToolVerdict => ({ behavior: "deny", message });
const allow = (tool: string, input: Record<string, unknown>, answer: string): ToolVerdict => {
  if (tool !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
  let answers: unknown;
  try { answers = JSON.parse(answer); } catch { return deny("Answer must be a JSON object mapping questions to answers"); }
  if (!answers || typeof answers !== "object" || Array.isArray(answers) || Object.values(answers).some(v => typeof v !== "string")) {
    return deny("Answer must map questions to strings");
  }
  return { behavior: "allow", updatedInput: { ...input, answers } };
};

/** The runtime's permission callback: each request waits for a durable answer, cancellation, or abort. */
const permissions = (attempt: Attempt, changes: Changes, abort: AbortController, onText: RunOptions["onText"]) => {
  const decide = Effect.fn("firstmate.decide")(function*(tool: string, input: Record<string, unknown>) {
    const decision = yield* attempt.requestDecision(tool, input);
    onText?.(`\nApproval needed: ${decision.id} (${tool}). Use firstmate decisions and firstmate answer in another terminal.\n`);
    const verdict = (change: TaskChange) => attempt.revokedBy(change.task) ? Effect.succeed(deny("Task cancelled or superseded"))
      : attempt.decision(decision.id).pipe(Effect.map(answer => answer?.status === "allow" ? allow(tool, input, answer.answer)
        : answer?.status !== "pending" ? deny(answer?.answer || "Request denied or expired") : undefined));
    const result = yield* changes.pipe(Stream.mapEffect(verdict), Stream.filter(result => result !== undefined), Stream.runHead);
    // A feed that ends without a verdict never grants permission.
    return Option.getOrElse(result, () => deny("Task cancelled or superseded"));
  });
  return async (tool: string, input: Record<string, unknown>, context: { signal: AbortSignal }): Promise<ToolVerdict> => {
    const signal = AbortSignal.any([abort.signal, context.signal]);
    signal.throwIfAborted();
    // An abort rejects with its own reason rather than with fiber interruption.
    return Effect.runPromise(decide(tool, input), { signal }).catch(error => { signal.throwIfAborted(); throw error; });
  };
};

/** The opening prompt, naming steers an earlier run delivered but never answered. */
const promptFor = (task: Task, options: RunOptions, unanswered: readonly Steer[]) =>
  (options.prompt ?? (options.resume
    ? `Continue the task below. Inspect existing work and prior tool results before repeating actions.\n\n${task.intake.prompt}` : task.intake.prompt))
  + (unanswered.length ? `\n\nSteering messages ${unanswered.map(s => `#${s.sequence}`).join(", ")} are in your conversation history but were not answered before the previous run stopped. Address them as part of this turn.` : "");

/**
 * Feeds newly enqueued steers into the live run on each task change, and
 * after a result closes the input once outstanding steers are answered.
 */
const pumpSteers = (input: InputStream, changes: Changes, abort: AbortController) => changes.pipe(
  Stream.takeWhile(() => !input.closed && !abort.signal.aborted),
  Stream.runForEach(() => input.feed().pipe(Effect.andThen(Effect.suspend(() => input.idleSince === undefined ? Effect.void : input.closeIfSettled())))),
  Effect.catch(error => Effect.sync(() => abort.abort(error))));

/**
 * Marks the session idle and, if it stays idle with steering unacknowledged
 * beyond the settle bound, records the unsettled steers and aborts.
 */
const boundSettle = (attempt: Attempt, input: InputStream, abort: AbortController, settleMs: number, scope: Scope.Scope) => Effect.suspend(() => {
  if (input.closed) return Effect.void;
  const since = input.idleSince = Date.now();
  // Any later SDK message clears or replaces `idleSince`, which disarms this bound.
  const expire = Effect.suspend(() => !input.closed && input.idleSince === since
    ? attempt.unacknowledged().pipe(
      Effect.flatMap(steers => attempt.record("steer.unsettled", { ids: steers.map(s => s.id) })),
      Effect.ignore,
      Effect.andThen(Effect.sync(() => abort.abort(new Error("Steering acknowledgement timed out; resume reconciles delivery")))))
    : Effect.void);
  return Effect.asVoid(Effect.forkIn(Effect.sleep(settleMs).pipe(Effect.andThen(expire)), scope));
});

/** Reads the runtime stream to its end, noting activity and applying each frame's effects before reading the next. */
const consume = (session: RuntimeSession, start: StreamState, input: InputStream, active: Effect.Effect<void, FirstmateError>,
  apply: (effect: StreamEffect) => Effect.Effect<void, FirstmateError>) =>
  Effect.suspend(() => {
    const iterator = session[Symbol.asyncIterator]();
    // Like a for-await body that throws, a failed effect stops the iterator.
    const stop = Effect.promise(async () => { await Promise.resolve(iterator.return?.()).catch(() => undefined); });
    return Effect.gen(function*() {
      let state = start;
      while (true) {
        const next = yield* Effect.tryPromise({ try: () => iterator.next(), catch: appError });
        if (next.done) return state;
        input.idleSince = undefined;
        yield* active.pipe(Effect.tapError(() => stop));
        const step = interpret(state, next.value);
        state = step.state;
        yield* Effect.forEach(step.effects, apply, { discard: true }).pipe(Effect.tapError(() => stop));
      }
    });
  });

/** Each attempt keeps its report; a later resume never overwrites evidence. */
const writeReport = (home: string, id: string, generation: string, report: string) => Effect.tryPromise({
  try: async () => {
    const directory = join(home, "reports", id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, `${generation}.md`), report, { encoding: "utf8", flag: "wx", mode: 0o600 });
  },
  catch: appError,
});

/**
 * Runs one attempt. A direct-PR ship that ends ready is then published as a
 * PR once the attempt has let go of the task; a failed publish leaves it
 * ready with `pr.failed` recorded, for `publish` to retry.
 */
export const runTask = Effect.fn("firstmate.runTask")(function*(id: string, options: RunOptions = {}) {
  const store = yield* TaskStore;
  const task = yield* attemptTask(id, options);
  if (task.intake.kind === "ship" && task.policy.delivery === "no-mistakes" && task.run.state === "ready") {
    options.onText?.(`\nReady at ${task.run.commit}; firstmate validate ${id} runs the no-mistakes pipeline, as a live supervisor does on its own\n`);
  }
  if (task.intake.kind !== "ship" || task.policy.delivery !== "direct-PR" || task.run.state !== "ready") return task;
  return yield* publishTask(id).pipe(
    Effect.tap(({ pr }) => Effect.sync(() => options.onText?.(`\nPublished ${pr.url} at ${pr.head}\n`))),
    Effect.map(published => published.task),
    Effect.catch(error => Effect.sync(() => options.onText?.(`\nPublishing failed; the task stays ready for firstmate publish: ${error.message}\n`))
      .pipe(Effect.andThen(store.get(id)))));
});

const attemptTask = Effect.fn("firstmate.attemptTask")(function*(id: string, options: RunOptions) {
  const store = yield* TaskStore;
  const runtimes = yield* Runtimes;
  const worktrees = yield* Worktrees;
  return yield* Effect.scoped(Effect.gen(function*() {
    const attempt = yield* store.acquire(id, options.resume ?? false, options.supervisor);
    const { task } = attempt;
    const { intake } = task;
    const abort = yield* abortScope(options.signal);
    const pollMs = options.pollMs ?? 300;
    const scope = yield* Effect.scope;
    let control: Control | undefined;

    const work = Effect.gen(function*() {
      // An unverified runtime is refused here too, and the account pin as it is now is checked before anything is prepared.
      const runtime = yield* runtimes.require(intake.dispatch?.runtime ?? staticRuntime);
      const pin = yield* store.accountPin(runtime.name);
      if (pin) {
        const check = yield* runtime.account(pin.root);
        if (check.signedIn === false) {
          return yield* Effect.fail(new RunFailed({ message: `The pinned ${runtime.name} account (${pin.root}) is not signed in (${check.detail}); sign in with \`${check.login}\`, or change the pin with firstmate account pin ${runtime.name} <root|ordinary>, then resume` }));
        }
      }
      const { start } = yield* worktrees.prepare(intake, task.policy.target);
      if (abort.signal.aborted) return yield* Effect.fail(new RunInterrupted({ message: "Run interrupted" }));
      yield* attempt.update({ state: "running" }, "worktree.ready", { path: intake.worktree, ...(start ? { start } : {}) });
      const changes = yield* store.changes(id, pollMs);
      yield* Effect.forkScoped(watchRevocation(attempt, changes, abort, applied => { control = applied; }));

      const unanswered = yield* attempt.reconcileSteers(sessionId => runtime.transcript(sessionId, intake.worktree));
      const promptId = randomUUID();
      const prompt = promptFor(task, options, unanswered);
      yield* attempt.record("prompt.submitted", { id: promptId, prompt, answers: unanswered.map(s => s.id) });
      const input = new InputStream(attempt);
      input.push(promptId, prompt);
      const canUseTool = permissions(attempt, changes, abort, options.onText);
      // The home's memory as it is when the session opens; the generations loaded are recorded with the attempt.
      const memory = yield* composeMemory();
      if (memory.manifest.length) yield* attempt.record("memory.loaded", { files: memory.manifest });
      const session = yield* Effect.acquireRelease(runtime.open({ task, input, abortController: abort, canUseTool, account: pin?.root ?? null, memory: memory.text }),
        session => Effect.sync(() => { abort.abort(); input.close(); session.close(); }));
      yield* Effect.forkScoped(pumpSteers(input, changes, abort));
      // Runtime messages are liveness evidence; writes are spaced so a busy stream does not write on every message.
      const activityMs = options.activityMs ?? 1_000;
      let touched = Date.now();
      const active = Effect.suspend(() => {
        if (Date.now() - touched < activityMs) return Effect.void;
        touched = Date.now();
        return Effect.asVoid(attempt.touch());
      });

      const apply = (effect: StreamEffect): Effect.Effect<void, FirstmateError> => {
        switch (effect.type) {
          case "deliver": return Effect.asVoid(attempt.markDelivered(effect.steerId));
          case "acknowledge-through": return Effect.asVoid(attempt.acknowledgeThrough(effect.steerId));
          case "acknowledge-named": return Effect.asVoid(attempt.acknowledgeNamed(effect.steerIds, effect.promptId));
          case "record-session": return Effect.asVoid(attempt.update({ sessionId: effect.sessionId }, "session.recorded", { sessionId: effect.sessionId }));
          case "fail": return Effect.fail(new AppError({ message: effect.message }));
          case "text": return attempt.record("agent.text", { text: effect.text }).pipe(Effect.andThen(Effect.sync(() => options.onText?.(effect.text))));
          case "tool": return attempt.record("agent.tool", { name: effect.name, id: effect.id });
          // Current SDK results include restored spend for a resumed session.
          // Adding the old total would count that spend twice.
          case "result": return Effect.asVoid(attempt.update({ costUsd: effect.result.costUsd }, "agent.result", {
            subtype: effect.result.subtype, isError: effect.result.isError, costUsd: effect.result.costUsd,
          }));
          case "close-input": return input.end();
          case "settle-input": return input.closeIfSettled().pipe(Effect.andThen(boundSettle(attempt, input, abort, options.steerSettleMs ?? 120_000, scope)));
        }
      };
      const verdict = conclude(yield* consume(session, startStream({ promptId, named: unanswered.map(s => s.id), sessionId: task.run.sessionId }), input, active, apply));
      if (!verdict.ok) return yield* Effect.fail(new RunFailed({ message: verdict.message }));
      if (abort.signal.aborted || (yield* attempt.current()).run.cancelRequested) return yield* Effect.fail(new RunInterrupted({ message: "Run interrupted" }));
      if (yield* attempt.hasPendingDecisions()) return yield* Effect.fail(new InvalidTransition({ message: "Result arrived with unanswered decisions" }));
      if (intake.kind === "scout") {
        yield* writeReport(store.home, id, attempt.generation, verdict.result.text);
        return yield* attempt.update({ state: "completed", output: verdict.result.text }, "task.result", { state: "completed" });
      }
      // A local-only or direct-PR ship stops on a clean branch, so the commit it reports is all of its work.
      // A no-mistakes ship may stop dirty; validation refuses to submit it until it is clean.
      const { commit, clean } = yield* worktrees.head(intake);
      const { delivery } = task.policy;
      if ((delivery === "local-only" || delivery === "direct-PR") && !clean) {
        return yield* Effect.fail(new RunFailed({ message: `A ${delivery} ship must stop on a clean branch; resume to commit or discard the uncommitted changes` }));
      }
      const state = delivery === "local-only" ? "local-ready" : "ready";
      return yield* attempt.update({ state, output: verdict.result.text, commit }, "task.result", { state, commit });
    });

    const exit = yield* Effect.exit(work);
    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.pretty(exit.cause);
    const current = yield* attempt.current();
    const state = current.run.cancelRequested ? "cancelled" : abort.signal.aborted ? "interrupted" : "failed";
    yield* attempt.stop(state, error, state === "interrupted" ? control?.id : undefined);
    return yield* Effect.fail(state === "cancelled" ? new TaskCancelled({ message: error })
      : state === "interrupted" ? new RunInterrupted({ message: error }) : new RunFailed({ message: error }));
  }));
});

export const runQueued = Effect.fn("firstmate.runQueued")(function*(concurrency: number, options: RunOptions = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) return yield* Effect.fail(new InvalidInput({ message: "Concurrency must be between 1 and 32" }));
  const store = yield* TaskStore;
  const { record, owner } = yield* store.supervisor();
  if (record && owner === "live") return yield* Effect.fail(new LiveOwner({ message: `A live supervisor (PID ${record.pid}) owns queued execution for this home` }));
  const queued = (yield* store.list()).filter(task => task.run.state === "queued");
  // A capped project's tasks wait for one of its places; attempts other processes run are refused by acquisition.
  const places = new Map<string, Semaphore.Semaphore>();
  for (const name of new Set(queued.flatMap(task => task.intake.projectName ?? []))) {
    const project = yield* store.project(name);
    if (project?.capacity) places.set(name, Semaphore.makeUnsafe(project.capacity));
  }
  const run = (task: Task) => {
    const place = task.intake.projectName === undefined ? undefined : places.get(task.intake.projectName);
    const attempt = runTask(task.id, options);
    return place ? place.withPermits(1)(attempt) : attempt;
  };
  return yield* Effect.forEach(queued, task => run(task).pipe(Effect.exit, Effect.map(exit => ({ id: task.id, exit }))), { concurrency });
});
