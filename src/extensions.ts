import { spawn, type ChildProcess } from "node:child_process";
import { hostname } from "node:os";
import { Context, Effect, FiberSet, Layer, type Scope } from "effect";
import { appError, InvalidInput, InvalidTransition, NotFound, type FirstmateError, type Wake } from "./domain.js";
import { TaskStore } from "./store.js";
import { Forge, parseIssueUrl } from "./forge.js";
import { Relay } from "./relay.js";
import type { ObservedSignal, OutboxAction, Receipt, RunOutcome, Source, SignalTriage, UpstreamLink } from "./ledger.js";

/** What an extension's effects may use: the home's store, the forge, the relay, and the registry itself. */
export type ExtensionServices = TaskStore | Forge | Relay | Extensions;
type Run<A> = Effect.Effect<A, FirstmateError, ExtensionServices>;

/** What the supervisor gives an extension it opens. */
export interface ReviewContext {
  /** The supervisor generation that holds the home; every durable write is fenced by it. */
  readonly generation: string;
  /** Hands wakes the extension recorded to the supervisor, which reports them as the home's posture says. */
  readonly deliver: (wakes: readonly Wake[]) => Effect.Effect<void, FirstmateError, ExtensionServices>;
  /** Reports a failure that the next review retries. */
  readonly error: (error: FirstmateError) => void;
  readonly note: (text: string) => void;
  /** Time between forge observations. */
  readonly forgeMs: number;
  /** How long an acknowledged but unhandled source result waits before it is announced again. */
  readonly reannounceMs: number;
}

/** An extension the supervisor opened: one review per supervisor tick, and what to stop when it stops. */
export interface OpenExtension {
  readonly review: Run<void>;
  readonly close: Effect.Effect<void, never, ExtensionServices>;
}

/**
 * One registered extension: an event source or a connector. An extension
 * delivers into the wake queue only through the records its review commits
 * with their wakes, and sends outbound actions only for its channel, only
 * through the outbox, which requires the captain's recorded consent. Mail
 * and voice connectors register here the same way when they exist.
 */
export interface Extension {
  readonly name: string;
  readonly kind: "event-source" | "connector";
  readonly description: string;
  /** Whether this home has it on, and why. */
  readonly status: Run<{ readonly on: boolean; readonly detail: string }>;
  readonly open?: (context: ReviewContext) => Effect.Effect<OpenExtension, FirstmateError, ExtensionServices | Scope.Scope>;
  /** The outbound channel it delivers. */
  readonly channel?: string;
  readonly deliver?: (action: OutboxAction) => Run<Receipt>;
}

export class Extensions extends Context.Service<Extensions, { readonly entries: readonly Extension[] }>()("firstmate/Extensions") {
  /** The built-in extensions, then `extra`; a repeated name or channel is refused. */
  static layer(extra: readonly Extension[] = []) {
    const entries = [...builtins, ...extra];
    const names = new Set<string>(), channels = new Set<string>();
    for (const entry of entries) {
      if (names.has(entry.name)) throw new InvalidInput({ message: `Extension ${entry.name} is registered twice` });
      names.add(entry.name);
      if (entry.channel) {
        if (channels.has(entry.channel)) throw new InvalidInput({ message: `Outbound channel ${entry.channel} is registered twice` });
        channels.add(entry.channel);
      }
    }
    return Layer.succeed(Extensions, { entries });
  }
}

// ---- process sources ----

const stdoutLimit = 64 * 1024;
const stderrLimit = 8 * 1024;
/** How many times an unhandled result is announced in all. */
const announcements = 3;

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/** Starts the source's argument array directly, without a shell: the child once it spawned, or why it could not. */
const launch = (source: Source) => new Promise<{ child: ChildProcess } | { error: string }>(resolve => {
  const [command, ...args] = source.argv;
  let child: ChildProcess;
  try { child = spawn(command!, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false }); }
  catch (error) { resolve({ error: appError(error).message }); return; }
  child.once("spawn", () => resolve({ child }));
  child.once("error", error => resolve({ error: error.message }));
});

/** Collects bounded output until the process exits, stopping it at the timeout. */
const finish = (child: ChildProcess, timeoutSeconds: number | null) => new Promise<RunOutcome>(resolve => {
  let stdout = "", stderr = "", truncated = false;
  const take = (into: "out" | "err", limit: number) => (chunk: Buffer) => {
    const current = into === "out" ? stdout : stderr;
    const room = limit - current.length;
    if (chunk.length > room) truncated = true;
    const text = room > 0 ? chunk.toString("utf8", 0, Math.min(room, chunk.length)) : "";
    if (into === "out") stdout += text; else stderr += text;
  };
  child.stdout?.on("data", take("out", stdoutLimit));
  child.stderr?.on("data", take("err", stderrLimit));
  const timer = timeoutSeconds === null ? null : setTimeout(() => {
    stderr += `\n[firstmate: stopped after the ${timeoutSeconds} s timeout]`;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, timeoutSeconds * 1000);
  child.once("close", (code, signal) => {
    if (timer) clearTimeout(timer);
    resolve({ exitCode: code, signal: signal ?? null, stdout, stderr, truncated });
  });
});

/**
 * Runs registered sources for the supervisor that holds the home. A run's
 * result is captured durably with its wake only when the source's condition
 * holds; a launch that fails, or a run a stopped supervisor left behind, is
 * a wake of its own. Runs are child processes of the supervisor, stopped
 * when it stops, and never a model call.
 */
const processSources: Extension = {
  name: "process-sources", kind: "event-source",
  description: "Registered argument-array processes, run once or on an interval; a result whose condition holds becomes a wake until handled",
  status: Effect.gen(function*() {
    const sources = yield* (yield* TaskStore).ledger.sources();
    const active = sources.filter(s => s.status === "active").length;
    return { on: true, detail: `${active} active of ${sources.length} registered` };
  }),
  open: context => Effect.gen(function*() {
    const store = yield* TaskStore;
    const { ledger } = store;
    const host = hostname();
    const fibers = yield* FiberSet.make();
    const running = new Map<string, { child: ChildProcess; registration: string }>();
    let stopping = false;

    const runOnce = (source: Source) => Effect.gen(function*() {
      const started = yield* Effect.promise(() => launch(source));
      if ("error" in started) {
        yield* context.deliver(yield* ledger.sourceFailed(context.generation, source.id, source.registration, started.error));
        return;
      }
      const { child } = started;
      const outcome = Effect.promise(() => finish(child, source.timeout));
      const claimed = yield* ledger.startSource(context.generation, source.id, source.registration, child.pid!, host).pipe(Effect.tapError(() => Effect.sync(() => child.kill("SIGTERM"))));
      if (!claimed) { child.kill("SIGTERM"); yield* outcome; return; }
      running.set(source.id, { child, registration: source.registration });
      const result = yield* outcome.pipe(Effect.ensuring(Effect.sync(() => running.delete(source.id))));
      if (stopping) return;
      const captured = yield* ledger.captureSource(context.generation, source.id, source.registration, result);
      yield* context.deliver(captured.wakes);
    }).pipe(Effect.catch(error => Effect.sync(() => context.error(error))));

    const review = Effect.gen(function*() {
      const sources = yield* ledger.sources();
      for (const source of sources) {
        const mine = running.get(source.id);
        // A run of a replaced or retired registration is stopped; its output is discarded on capture.
        if (mine && (source.status !== "active" || source.registration !== mine.registration)) { mine.child?.kill("SIGTERM"); continue; }
        if (source.status !== "active" || mine) continue;
        if (source.run && source.run.supervisor !== context.generation) {
          const live = source.run.host !== host || alive(source.run.pid);
          yield* context.deliver(yield* ledger.strandSource(context.generation, source.id, live));
          if (live) continue;
        } else if (source.run) continue;
        const due = source.every === null ? source.status === "active" : !source.lastRunAt || Date.now() - Date.parse(source.lastRunAt) >= source.every * 1000;
        if (!due) continue;
        running.set(source.id, { child: null as unknown as ChildProcess, registration: source.registration });
        yield* FiberSet.run(fibers, runOnce(source).pipe(Effect.ensuring(Effect.sync(() => { if (running.get(source.id)?.child === null) running.delete(source.id); }))));
      }
      yield* context.deliver(yield* ledger.reannounce(context.generation, context.reannounceMs, announcements));
    });

    const close = Effect.gen(function*() {
      stopping = true;
      for (const [id, { child }] of running) {
        child?.kill("SIGTERM");
        yield* ledger.releaseSource(context.generation, id).pipe(Effect.ignore);
      }
    });
    return { review, close };
  }),
};

// ---- the captain inbox ----

/** Notes become wakes as they are saved; the inbox needs no review. */
const captainInbox: Extension = {
  name: "captain-inbox", kind: "connector",
  description: "Notes submitted to the home become wakes, count as waiting until acknowledged after handling, and take one durable reply",
  status: Effect.gen(function*() {
    const notes = yield* (yield* TaskStore).ledger.notes("waiting");
    return { on: true, detail: `${notes.length} waiting` };
  }),
};

// ---- Relay ----

/**
 * Off unless configured. Polls the relay for mentions, each a wake; wakes for
 * each promised final reply whose task's work ended; and delivers consented
 * replies under their outbox key.
 */
const relay: Extension = {
  name: "relay", kind: "connector", channel: "relay",
  description: "Public mentions become wakes; promised final replies are typed commitments that block their task's cleanup until reconciled",
  status: Effect.gen(function*() {
    const config = yield* (yield* TaskStore).ledger.relay();
    return config ? { on: true, detail: `polling ${config.endpoint} every ${config.every} s` } : { on: false, detail: "off: firstmate relay configure --endpoint <url> turns it on" };
  }),
  open: context => Effect.gen(function*() {
    const { ledger } = yield* TaskStore;
    const adapter = yield* Relay;
    let polledAt = 0;
    let failure: string | null = null;
    const review = Effect.gen(function*() {
      yield* context.deliver(yield* ledger.dueFollowups(context.generation));
      const config = yield* ledger.relay();
      if (!config || Date.now() - polledAt < config.every * 1000) return;
      polledAt = Date.now();
      const polled = yield* adapter.mentions(config, yield* ledger.relayCursor()).pipe(Effect.tapError(error => Effect.sync(() => {
        if (failure !== error.message) context.error(error);
        failure = error.message;
      })));
      failure = null;
      yield* context.deliver(yield* ledger.recordMentions(context.generation, polled.mentions, polled.cursor));
    });
    return { review, close: Effect.void };
  }),
  deliver: action => Effect.gen(function*() {
    const config = yield* (yield* TaskStore).ledger.relay();
    if (!config) return yield* Effect.fail(new InvalidTransition({ message: "Relay is off; firstmate relay configure turns it on" }));
    return yield* (yield* Relay).reply(config, { requestId: action.subject, text: action.body, final: action.final, key: action.id });
  }),
};

// ---- upstream contribution signals ----

/** Triage from the forge's own fields: a review's state and the issue's state, never its prose. */
const reviewTriage = (state: string): SignalTriage => state === "APPROVED" ? "approved" : state === "CHANGES_REQUESTED" ? "changes-requested" : "review";

/** The signals newer than a link's baseline, and the baseline after them. */
export function triageObservation(link: UpstreamLink, observation: { state: string; stateAt: string | null; comments: readonly { id: number; author: string | null; url: string | null; at: string | null; body: string }[]; reviews: readonly { id: number; author: string | null; state: string; url: string | null; at: string | null; body: string }[] }, observedAt: string) {
  const signals: ObservedSignal[] = [
    // A comment the outbox posted carries its key's marker and is this home's own action, not a signal.
    ...observation.comments.filter(c => !c.body.includes("<!-- firstmate:")).map(c => ({ token: `comment-${c.id}`, triage: "comment" as const, author: c.author, url: c.url, at: c.at, text: c.body })),
    ...observation.reviews.map(r => ({ token: `review-${r.id}`, triage: reviewTriage(r.state), author: r.author, url: r.url, at: r.at, text: r.body })),
  ];
  if (observation.state !== link.baseline.state) {
    const at = observation.stateAt ?? observedAt;
    signals.push({
      token: `state-${observation.state}-${at.replace(/[^0-9A-Za-z]/g, "")}`, triage: observation.state === "open" ? "reopened" : observation.state as SignalTriage,
      author: null, url: link.url, at, text: `The ${link.url} is now ${observation.state}`,
    });
  }
  const baseline = {
    comment: Math.max(link.baseline.comment, ...observation.comments.map(c => c.id)),
    review: Math.max(link.baseline.review, ...observation.reviews.map(r => r.id)),
    state: observation.state,
  };
  return { signals, baseline };
}

const repositoryOf = (link: UpstreamLink) => ({ host: link.host, owner: link.owner, name: link.repo });

/**
 * Observes every active upstream link through the forge adapter: new
 * comments, reviews, and state changes become signals, each a wake until its
 * exact token is acknowledged with a disposition. Comments go out through the
 * outbox.
 */
const upstream: Extension = {
  name: "upstream", kind: "connector", channel: "upstream",
  description: "Comments, reviews, and state changes on linked upstream issues and PRs become triaged signals acknowledged by exact token",
  status: Effect.gen(function*() {
    const links = (yield* (yield* TaskStore).ledger.links()).filter(l => l.status === "active");
    return { on: true, detail: `${links.length} active link(s)${links.some(l => l.problem) ? `; ${links.filter(l => l.problem).length} with an observation problem` : ""}` };
  }),
  open: context => Effect.gen(function*() {
    const { ledger } = yield* TaskStore;
    const forge = yield* Forge;
    let observedAt = 0;
    const review = Effect.gen(function*() {
      if (Date.now() - observedAt < context.forgeMs) return;
      observedAt = Date.now();
      for (const link of yield* ledger.links()) {
        if (link.status !== "active") continue;
        const observed = yield* Effect.result(forge.observe(repositoryOf(link), link.number, link.baseline));
        if (observed._tag === "Failure") {
          if (link.problem !== observed.failure.message) context.error(observed.failure);
          yield* ledger.noteLinkProblem(context.generation, link.id, observed.failure.message);
          continue;
        }
        const { signals, baseline } = triageObservation(link, observed.success, new Date().toISOString());
        yield* context.deliver(yield* ledger.recordSignals(context.generation, link.id, signals, baseline));
      }
    });
    return { review, close: Effect.void };
  }),
  deliver: action => Effect.gen(function*() {
    const link = yield* (yield* TaskStore).ledger.link(action.subject);
    return yield* (yield* Forge).comment(repositoryOf(link), link.number, action.body, action.id);
  }),
};

// ---- the outbox ----

/** Sends what the captain consented to that is not sent yet; a failure is a wake, retried at the next forge interval. */
const outbox: Extension = {
  name: "outbox", kind: "connector",
  description: "Outbound public actions wait for the captain's recorded consent; consented ones are sent once under their idempotency key",
  status: Effect.gen(function*() {
    const actions = yield* (yield* TaskStore).ledger.actions();
    const count = (status: OutboxAction["status"]) => actions.filter(a => a.status === status).length;
    return { on: true, detail: `${count("awaiting-consent")} awaiting consent, ${count("consented")} consented, ${count("sending")} sending, ${count("sent")} sent` };
  }),
  open: context => Effect.gen(function*() {
    const { ledger } = yield* TaskStore;
    const review = Effect.gen(function*() {
      for (const action of yield* ledger.actions("consented")) {
        const failedAt = action.attempts.findLast(a => a.outcome === "error")?.at;
        if (failedAt && Date.now() - Date.parse(failedAt) < context.forgeMs) continue;
        const sent = yield* Effect.result(sendAction(action.id, context.generation));
        if (sent._tag === "Success") context.note(`Sent outbox action ${action.id} (${action.channel} ${action.subject})${sent.success.action.receipt?.url ? `: ${sent.success.action.receipt.url}` : ""}`);
      }
    });
    return { review, close: Effect.void };
  }),
};

const builtins: readonly Extension[] = [processSources, captainInbox, relay, upstream, outbox];

/**
 * Sends one outbox action through the extension that owns its channel. No
 * recorded consent, no send: the refusal is recorded and returned as an
 * error. A sent action is returned as already sent; a failed send stays
 * consented for a retry under the same key.
 */
export const sendAction = Effect.fn("firstmate.sendAction")(function*(id: string, generation: string | null = null) {
  const { ledger } = yield* TaskStore;
  const registry = yield* Extensions;
  const { action, claim } = yield* ledger.claimSend(id);
  if (claim === "refused") {
    return yield* Effect.fail(new InvalidTransition({ message: `Refused: outbox action ${id} has no recorded consent, so nothing was sent; firstmate outbox consent ${id} records the captain's consent` }));
  }
  if (claim === "already-sent") return { outcome: "already-sent" as const, action };
  const channel = registry.entries.find(entry => entry.channel === action.channel && entry.deliver);
  if (!channel?.deliver) {
    const message = `No registered extension delivers channel ${action.channel}`;
    yield* ledger.failSend(id, message, generation);
    return yield* Effect.fail(new NotFound({ message }));
  }
  const receipt = yield* channel.deliver(action).pipe(Effect.tapError(error => ledger.failSend(id, error.message, generation).pipe(Effect.ignore)));
  return { outcome: "sent" as const, action: yield* ledger.finishSend(id, receipt) };
});

/** Links an upstream issue or PR to a backlog item or task, from the forge's state now, so its history is never replayed. */
export const linkUpstream = Effect.fn("firstmate.linkUpstream")(function*(subject: string, url: string) {
  const parsed = parseIssueUrl(url);
  if (!parsed) return yield* Effect.fail(new InvalidInput({ message: "--url must be an https issue or pull request URL such as https://github.com/<owner>/<repo>/issues/<n>" }));
  const { ledger } = yield* TaskStore;
  const observed = yield* (yield* Forge).observe(parsed, parsed.number, { comment: 0, review: 0 });
  const baseline = {
    comment: Math.max(0, ...observed.comments.map(c => c.id)), review: Math.max(0, ...observed.reviews.map(r => r.id)), state: observed.state,
  };
  return yield* ledger.linkUpstream(subject, url.trim().replace(/\/+$/, ""), { host: parsed.host, owner: parsed.owner, repo: parsed.name, number: parsed.number }, baseline);
});

/** Each registered extension with what it does and whether this home has it on. */
export const listExtensions = Effect.fn("firstmate.listExtensions")(function*() {
  const registry = yield* Extensions;
  return yield* Effect.forEach(registry.entries, entry => entry.status.pipe(
    Effect.map(status => ({ name: entry.name, kind: entry.kind, channel: entry.channel ?? null, ...status, description: entry.description }))));
});

/** Dismisses a mention at the relay, then records it dismissed. */
export const dismissMention = Effect.fn("firstmate.dismissMention")(function*(requestId: string) {
  const { ledger } = yield* TaskStore;
  const mention = yield* ledger.mention(requestId);
  const config = yield* ledger.relay();
  if (!config) return yield* Effect.fail(new InvalidTransition({ message: "Relay is off; record the mention handled with firstmate relay ack instead" }));
  if (mention.status === "waiting") yield* (yield* Relay).dismiss(config, requestId);
  return yield* ledger.ackMention(requestId, "dismissed");
});
