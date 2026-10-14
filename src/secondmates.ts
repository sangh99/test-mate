import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Effect, Layer } from "effect";
import {
  AppError, appError, InvalidInput, InvalidTransition, NotFound,
  type FirstmateError, type Handoff, type Item, type Project, type PublishedStatus, type Request, type RoutedWork, type Secondmate,
  type SecondmateIdentity, type SharedPreferences, type Surface, type Task,
} from "./domain.js";
import { generationOf, Store, TaskStore, type Owner } from "./store.js";
import { dispatchItem } from "./backlog.js";
import { contains } from "./worktrees.js";

type Op<A> = Effect.Effect<A, FirstmateError>;

/** What the parent observes of a secondmate's own supervisor: its lease owner and process. */
export interface Liveness {
  readonly owner: Owner;
  readonly pid: number | null;
}

/**
 * How the main home reaches a secondmate's home. Every cross-home write and
 * read goes through it: seeding, enqueueing a correlated request (with a
 * handoff's items), reading the status the secondmate published for a
 * correlation, pushing shared preferences, observing liveness, and
 * launching. The local implementation opens the other home's store on this
 * host; a remote transport implements the same operations with host-bound
 * identity, and every enqueue is idempotent by correlation.
 */
export interface TransportShape {
  seed(home: string, identity: SecondmateIdentity, projects: readonly Project[], preferences: SharedPreferences | null): Op<void>;
  /** Enqueues routed work once per correlation; `received` is false when the home already had it. */
  enqueue(home: string, from: string, correlation: string, work: RoutedWork, items?: readonly Item[], handoff?: string): Op<{ received: boolean }>;
  /** Whether the home holds the correlation; null when the home is gone. */
  received(home: string, correlation: string): Op<boolean | null>;
  /** The status lines the home published for a correlation; null before it has the request. */
  published(home: string, correlation: string): Op<readonly PublishedStatus[] | null>;
  preferences(home: string, from: string, preferences: SharedPreferences | null): Op<void>;
  /** The home's copy of the shared preferences as it holds them now. */
  copy(home: string): Op<SharedPreferences | null>;
  liveness(home: string): Op<Liveness>;
  /** What in the home is not landed yet. */
  unlanded(home: string): Op<readonly string[]>;
  /** Asks a live supervisor of the home to stop; false when none was live. */
  stop(home: string): Op<boolean>;
  /** Starts the home's supervisor as a separate process and returns its PID. */
  launch(home: string, args: readonly string[]): Op<number>;
}

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
const databaseOf = (home: string) => join(home, "firstmate.sqlite");

/** Opens an existing home's store for one operation; a missing home is refused rather than created. */
const withHome = <A>(home: string, f: (store: Store) => A): Op<A> => Effect.try({
  try: () => {
    if (!existsSync(databaseOf(home))) throw new NotFound({ message: `No firstmate home at ${home}` });
    const store = new Store(home);
    try { return f(store); } finally { store.close(); }
  },
  catch: appError,
});

/** True while a process with this PID exists on this host. */
export const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/** The transport for secondmate homes on this host. */
export const localTransport: TransportShape = {
  seed: (home, identity, projects, preferences) => Effect.try({
    try: () => { const store = new Store(home); try { store.seedSecondmate(identity, projects, preferences); } finally { store.close(); } },
    catch: appError,
  }),
  enqueue: (home, from, correlation, work, items = [], handoff) => withHome(home, store => ({ received: store.receive(from, correlation, work, items, handoff).received })),
  received: (home, correlation) => existsSync(databaseOf(home)) ? withHome(home, store => store.inboxEntry(correlation) !== null) : Effect.succeed(null),
  published: (home, correlation) => withHome(home, store => store.inboxEntry(correlation)?.published ?? null),
  preferences: (home, from, preferences) => withHome(home, store => { store.receivePreferences(from, preferences); }),
  copy: home => withHome(home, store => store.preferences()),
  liveness: home => withHome(home, store => {
    const { record, owner } = store.supervisor();
    return { owner, pid: record?.pid ?? null };
  }),
  unlanded: home => withHome(home, store => store.unlandedWork()),
  stop: home => withHome(home, store => {
    if (store.supervisor().owner !== "live") return false;
    store.requestStop();
    return true;
  }),
  launch: (home, args) => Effect.try({
    try: () => {
      const log = openSync(join(home, "supervisor.log"), "a");
      try {
        const child = spawn(process.execPath, [cli, "supervisor", "start", "--home", home, ...args], { detached: true, stdio: ["ignore", log, log], env: process.env });
        if (child.pid === undefined) throw new AppError({ message: `The secondmate supervisor for ${home} did not start` });
        child.unref();
        return child.pid;
      } finally { closeSync(log); }
    },
    catch: appError,
  }),
};

export class Transport extends Context.Service<Transport, TransportShape>()("firstmate/SecondmateTransport") {
  static layer(transport?: TransportShape) { return Layer.succeed(Transport, transport ?? localTransport); }
}

const mainOnly = Effect.gen(function*() {
  const store = yield* TaskStore;
  const identity = yield* store.identity();
  if (identity) return yield* Effect.fail(new InvalidTransition({ message: `This home is secondmate "${identity.id}"'s; secondmates are managed from the main home (${identity.parent})` }));
  return store;
});

export interface NewSecondmate {
  readonly id: string;
  readonly charter: string;
  readonly scope: string;
  /** Registered projects of the main home it may run; none of them local-only. */
  readonly projects: readonly string[];
  /** Its home; default `<main home>/secondmates/<id>`. */
  readonly home?: string;
  /** Automatic relaunches before exits escalate (default 3). */
  readonly relaunches?: number;
}

/**
 * Creates a persistent secondmate: seeds a fresh home with its identity, its
 * projects' registrations, and the shared preferences, then registers it.
 * A failed registration removes the home it created. It is not launched.
 */
export const createSecondmate = Effect.fn("firstmate.createSecondmate")(function*(input: NewSecondmate) {
  const store = yield* mainOnly;
  const transport = yield* Transport;
  if (!input.charter.trim() || !input.scope.trim()) return yield* Effect.fail(new InvalidInput({ message: "A secondmate needs a charter and a routing scope" }));
  const relaunches = input.relaunches ?? 3;
  if (!Number.isSafeInteger(relaunches) || relaunches < 0) return yield* Effect.fail(new InvalidInput({ message: "--relaunches must be a nonnegative integer" }));
  if ((yield* store.secondmates()).some(s => s.id === input.id)) return yield* Effect.fail(new InvalidInput({ message: `Secondmate id "${input.id}" is already used` }));
  const projects: Project[] = [];
  for (const name of [...new Set(input.projects)]) {
    const project = yield* store.project(name);
    if (!project) return yield* Effect.fail(new NotFound({ message: `No project is registered as "${name}"` }));
    if (project.delivery === "local-only") return yield* Effect.fail(new InvalidInput({ message: `Project "${name}" is local-only, and local-only projects stay with the main home` }));
    projects.push(project);
  }
  const home = resolve(input.home ?? join(store.home, "secondmates", input.id));
  if (home === store.home || contains(home, store.home)) return yield* Effect.fail(new InvalidInput({ message: "A secondmate's home must not be the main home or contain it" }));
  for (const project of projects) {
    if (contains(project.clone, home)) return yield* Effect.fail(new InvalidInput({ message: `A secondmate's home must be outside project clone ${project.clone}` }));
  }
  const existed = existsSync(home);
  const timestamp = new Date().toISOString();
  yield* transport.seed(home, { id: input.id, parent: store.home, charter: input.charter, scope: input.scope, createdAt: timestamp }, projects, yield* store.preferences());
  const preferences = yield* store.preferences();
  return yield* store.addSecondmate({
    id: input.id, charter: input.charter, scope: input.scope, projects: projects.map(p => p.name), home, status: "active",
    launch: { desired: "stopped", pid: null, host: null, launchedAt: null, attempts: 0, limit: relaunches, exits: 0, lastExitAt: null, exhausted: null, args: [] },
    preferences: preferences?.generation ?? null, createdAt: timestamp, updatedAt: timestamp, retiredAt: null,
  }).pipe(Effect.tapError(() => Effect.sync(() => { if (!existed) rmSync(home, { recursive: true, force: true }); })));
});

/** How long a launch waits to see the new supervisor take its home's lease. */
const confirmMs = 10_000;

/**
 * Launches a secondmate's supervisor as a separate process, after
 * converging its shared preferences. The captain's launch resets the
 * relaunch count and any escalation; one already running is left alone.
 */
export const launchSecondmate = Effect.fn("firstmate.launchSecondmate")(function*(id: string, args?: readonly string[]) {
  const store = yield* mainOnly;
  const transport = yield* Transport;
  const secondmate = yield* store.secondmate(id);
  if (secondmate.status !== "active") return yield* Effect.fail(new InvalidTransition({ message: `Secondmate "${id}" is retired` }));
  const before = yield* transport.liveness(secondmate.home);
  if (before.owner === "unknown") return yield* Effect.fail(new InvalidTransition({ message: `Secondmate "${id}"'s supervisor liveness is unknown; it is not launched again` }));
  if (before.owner === "live") return { secondmate, pid: before.pid, launched: false, confirmed: true };
  yield* pushPreferences(id);
  const pid = yield* transport.launch(secondmate.home, args ?? secondmate.launch.args);
  const launched = yield* store.launched(id, pid, "captain", args ?? null);
  const confirmed = yield* confirm(secondmate.home, pid);
  return { secondmate: launched, pid, launched: true, confirmed };
});

/** Waits a bounded time for the launched process to hold its home's supervisor lease. */
const confirm = (home: string, pid: number) => Effect.gen(function*() {
  const transport = yield* Transport;
  const deadline = Date.now() + confirmMs;
  while (Date.now() < deadline) {
    const { owner, pid: holder } = yield* transport.liveness(home).pipe(Effect.catch(() => Effect.succeed({ owner: "unknown" as const, pid: null })));
    if (owner === "live" && holder === pid) return true;
    if (!alive(pid)) return false;
    yield* Effect.sleep(200);
  }
  return false;
});

/** The captain stops a secondmate: its supervisor is asked to stop, and nothing relaunches it. */
export const stopSecondmate = Effect.fn("firstmate.stopSecondmate")(function*(id: string, reason: string) {
  const store = yield* mainOnly;
  const transport = yield* Transport;
  const secondmate = yield* store.stopped(id, reason);
  const requested = yield* transport.stop(secondmate.home);
  return { secondmate, stopRequested: requested };
});

/**
 * Retires a secondmate, refused while its supervisor runs, while its home
 * holds unlanded work, and while a handoff or request to it is unfinished.
 * Every refusal is recorded. The home itself is kept.
 */
export const retireSecondmate = Effect.fn("firstmate.retireSecondmate")(function*(id: string) {
  const store = yield* mainOnly;
  const transport = yield* Transport;
  const secondmate = yield* store.secondmate(id);
  if (secondmate.status !== "active") return yield* Effect.fail(new InvalidTransition({ message: `Secondmate "${id}" is already retired` }));
  const { owner } = yield* transport.liveness(secondmate.home);
  const reasons = owner === "absent" ? [] : [`its supervisor is ${owner === "live" ? "running; stop it first with firstmate secondmate stop" : "of unknown liveness"}`];
  reasons.push(...(yield* transport.unlanded(secondmate.home)).map(what => `its home holds unlanded ${what}`));
  if (reasons.length) {
    yield* store.refuseRetire(id, reasons);
    return yield* Effect.fail(new InvalidTransition({ message: `Secondmate "${id}" is not retired: ${reasons.join("; ")}` }));
  }
  return yield* store.retire(id);
});

/** Pushes the main home's shared preferences to each active secondmate whose copy is not current; null clears its copy. */
export const pushPreferences = Effect.fn("firstmate.pushPreferences")(function*(only?: string) {
  const store = yield* mainOnly;
  const transport = yield* Transport;
  const preferences = yield* store.preferences();
  const generation = preferences?.generation ?? null;
  const results: { id: string; generation: string | null; outcome: "pushed" | "unchanged" | "error"; error?: string }[] = [];
  for (const secondmate of yield* store.secondmates()) {
    if (secondmate.status !== "active" || (only !== undefined && secondmate.id !== only)) continue;
    // The copy is current only when it holds exactly the main text, so an edit made in the secondmate's home is replaced too.
    const copy = yield* transport.copy(secondmate.home).pipe(Effect.result);
    const current = copy._tag === "Success" && (copy.success === null ? generation === null : copy.success.generation === generation && generationOf(copy.success.text) === generation);
    if (current) {
      if (secondmate.preferences !== generation) yield* store.pushedPreferences(secondmate.id, generation);
      results.push({ id: secondmate.id, generation, outcome: "unchanged" });
      continue;
    }
    const pushed = yield* transport.preferences(secondmate.home, store.home, preferences).pipe(Effect.andThen(store.pushedPreferences(secondmate.id, generation)), Effect.result);
    results.push(pushed._tag === "Success" ? { id: secondmate.id, generation, outcome: "pushed" } : { id: secondmate.id, generation, outcome: "error", error: pushed.failure.message });
  }
  return results;
});

/** One candidate in a routing decision: whether its home can take the item, and why. */
export interface Candidate {
  readonly id: string;
  readonly scope: string;
  readonly fits: boolean;
  readonly reason: string;
}

/**
 * The routing decision for an item, read-only: a local-only item stays in
 * the main home; otherwise each active secondmate is a candidate that fits
 * when one of its projects is the item's. The scope is shown for the
 * captain's judgment; the host never matches it as text.
 */
export const matchItem = Effect.fn("firstmate.matchItem")(function*(itemId: string) {
  const store = yield* mainOnly;
  const item = yield* store.item(itemId);
  const local = yield* store.localOnly(item.project);
  const project = item.project === null ? null : (yield* store.project(item.project)) ?? (isAbsolute(item.project) ? yield* store.projectByClone(item.project) : null);
  const candidates: Candidate[] = (yield* store.secondmates()).filter(s => s.status === "active").map(s => {
    const fits = project !== null && s.projects.includes(project.name);
    return {
      id: s.id, scope: s.scope, fits,
      reason: item.project === null ? "the item names no project"
        : project === null ? `project ${item.project} is not registered, so no secondmate's home has it`
        : fits ? `its home has project ${project.name}` : `its projects (${s.projects.join(", ") || "none"}) do not include ${project.name}`,
    };
  });
  const fitting = candidates.filter(c => c.fits);
  return {
    item: item.id, project: item.project, localOnly: local, candidates,
    proposal: local ? null : fitting.length === 1 ? fitting[0]!.id : null,
    explanation: local ? `Project ${local} is local-only, so the item stays in the main home`
      : fitting.length === 1 ? `Only ${fitting[0]!.id}'s home has the item's project; route it there, or name another with --to`
      : fitting.length ? `${fitting.length} secondmates' homes have the item's project; choose one by scope with --to`
      : "No secondmate's home has the item's project; it stays in the main home unless one is created for it",
  };
});

/**
 * Routes a queued item to a secondmate through a handoff, recording the
 * decision with its candidates on the item. `to` is the captain's choice
 * by scope; without it the item routes only when exactly one secondmate's
 * home has its project. A local-only item stays in the main home, and the
 * refusal is recorded too.
 */
export const routeItem = Effect.fn("firstmate.routeItem")(function*(itemId: string, to?: string) {
  const store = yield* mainOnly;
  const decision = yield* matchItem(itemId);
  const candidates = decision.candidates.map(c => ({ ...c }));
  if (decision.localOnly) {
    yield* store.noteRouting(itemId, { secondmate: null, basis: "local-only", candidates });
    return yield* Effect.fail(new InvalidTransition({ message: decision.explanation }));
  }
  const chosen = to ?? decision.proposal;
  if (!chosen) return yield* Effect.fail(new InvalidInput({ message: `${decision.explanation}. Candidates: ${decision.candidates.map(c => `${c.id} (${c.reason}; scope: ${c.scope})`).join("; ") || "none"}` }));
  const candidate = decision.candidates.find(c => c.id === chosen);
  if (!candidate) return yield* Effect.fail(new NotFound({ message: `No active secondmate "${chosen}"` }));
  if (!candidate.fits) return yield* Effect.fail(new InvalidTransition({ message: `Secondmate "${chosen}" cannot take the item: ${candidate.reason}` }));
  const routed = { secondmate: chosen, basis: to ? "explicit" as const : "sole-project-match" as const, candidates };
  return { decision: routed, ...(yield* handoffItems(chosen, [itemId], routed)) };
});

/**
 * Hands queued items off to a secondmate: the handoff is prepared in the
 * main home, the secondmate's home receives the items under the request's
 * correlation, and the handoff is then placed. An interruption between the
 * two leaves the handoff in transit for `recoverSecondmates`.
 */
export const handoffItems = Effect.fn("firstmate.handoffItems")(function*(secondmateId: string, itemIds: readonly string[], routed?: { secondmate: string; basis: "explicit" | "sole-project-match"; candidates: Candidate[] }) {
  const store = yield* mainOnly;
  const secondmate = yield* store.secondmate(secondmateId);
  for (const id of itemIds) {
    const item = yield* store.item(id);
    const project = item.project === null ? null : (yield* store.project(item.project)) ?? (isAbsolute(item.project) ? yield* store.projectByClone(item.project) : null);
    if (!project || !secondmate.projects.includes(project.name)) {
      return yield* Effect.fail(new InvalidTransition({ message: `Backlog item "${id}" is for ${item.project ?? "no project"}, which secondmate "${secondmateId}"'s home does not have` }));
    }
  }
  const { handoff, request } = yield* store.prepareHandoff(secondmateId, itemIds, routed);
  const placed = yield* place(secondmate, handoff, request, false).pipe(Effect.mapError(error => new AppError({
    message: `Handoff ${handoff.id} is prepared and its items are in transit, but secondmate "${secondmateId}"'s home did not receive it: ${error.message}. firstmate secondmate recover completes it`,
  })));
  return { handoff: placed, request: yield* store.request(request.correlation) };
});

/** The secondmate's home receives the handoff once per correlation, then the main home records it placed. */
const place = (secondmate: Secondmate, handoff: Handoff, request: Request, recovered: boolean) => Effect.gen(function*() {
  const store = yield* TaskStore;
  const transport = yield* Transport;
  yield* transport.enqueue(secondmate.home, store.home, request.correlation, request.work, handoff.items, handoff.id);
  return yield* store.placeHandoff(handoff.id, recovered);
});

/**
 * Requests new work of a secondmate. The request is durable before it is
 * delivered; an undelivered one stays pending for `recoverSecondmates`.
 */
export const requestWork = Effect.fn("firstmate.requestWork")(function*(secondmateId: string, work: { title: string; prompt: string; kind: "ship" | "scout"; project: string; surface?: Surface }) {
  const store = yield* mainOnly;
  const transport = yield* Transport;
  const secondmate = yield* store.secondmate(secondmateId);
  if (!work.prompt.trim()) return yield* Effect.fail(new InvalidInput({ message: "A request needs a prompt" }));
  const local = yield* store.localOnly(work.project);
  if (local) return yield* Effect.fail(new InvalidTransition({ message: `Project ${local} is local-only, so its work stays in the main home` }));
  if (!secondmate.projects.includes(work.project)) return yield* Effect.fail(new InvalidTransition({ message: `Secondmate "${secondmateId}"'s home does not have project ${work.project}; its projects are ${secondmate.projects.join(", ") || "none"}` }));
  const request = yield* store.createRequest(secondmateId, {
    kind: "work", title: work.title, taskKind: work.kind, project: work.project, prompt: work.prompt, surface: work.surface ?? null, items: [],
  });
  const delivered = yield* transport.enqueue(secondmate.home, store.home, request.correlation, request.work).pipe(Effect.andThen(store.deliverRequest(request.correlation)), Effect.result);
  return delivered._tag === "Success" ? delivered.success : { ...request, undelivered: delivered.failure.message };
});

/**
 * Finishes what an interruption left: each handoff in transit is placed
 * when its secondmate's home has the correlation or can still receive it,
 * and restored to the main backlog when that home is retired or gone; each
 * undelivered request is delivered again under its correlation.
 */
export const recoverSecondmates = Effect.fn("firstmate.recoverSecondmates")(function*() {
  const store = yield* mainOnly;
  const transport = yield* Transport;
  const outcomes: { kind: "handoff" | "request"; id: string; secondmate: string; outcome: string }[] = [];
  for (const handoff of (yield* store.handoffs()).filter(h => h.phase === "prepared")) {
    const secondmate = yield* store.secondmate(handoff.secondmate);
    const request = yield* store.request(handoff.correlation);
    const has = yield* transport.received(secondmate.home, handoff.correlation).pipe(Effect.result);
    if (has._tag === "Failure") { outcomes.push({ kind: "handoff", id: handoff.id, secondmate: secondmate.id, outcome: `still in transit: ${has.failure.message}` }); continue; }
    if (has.success === true) {
      yield* store.placeHandoff(handoff.id, true);
      outcomes.push({ kind: "handoff", id: handoff.id, secondmate: secondmate.id, outcome: "placed: the secondmate's home already held it" });
    } else if (has.success === null || secondmate.status !== "active") {
      const reason = has.success === null ? "the secondmate's home is gone" : "the secondmate is retired";
      yield* store.restoreHandoff(handoff.id, reason);
      outcomes.push({ kind: "handoff", id: handoff.id, secondmate: secondmate.id, outcome: `restored to the main backlog: ${reason}` });
    } else {
      const placed = yield* place(secondmate, handoff, request, true).pipe(Effect.result);
      if (placed._tag === "Success") outcomes.push({ kind: "handoff", id: handoff.id, secondmate: secondmate.id, outcome: "placed: delivered again under its correlation" });
      else if (placed.failure._tag === "InvalidTransition") {
        yield* store.restoreHandoff(handoff.id, placed.failure.message);
        outcomes.push({ kind: "handoff", id: handoff.id, secondmate: secondmate.id, outcome: `restored to the main backlog: ${placed.failure.message}` });
      } else outcomes.push({ kind: "handoff", id: handoff.id, secondmate: secondmate.id, outcome: `still in transit: ${placed.failure.message}` });
    }
  }
  for (const request of (yield* store.requests()).filter(r => r.status === "pending" && r.work.kind === "work")) {
    const secondmate = yield* store.secondmate(request.secondmate);
    if (secondmate.status !== "active") continue;
    const delivered = yield* transport.enqueue(secondmate.home, store.home, request.correlation, request.work).pipe(Effect.andThen(store.deliverRequest(request.correlation)), Effect.result);
    outcomes.push({ kind: "request", id: request.correlation, secondmate: secondmate.id, outcome: delivered._tag === "Success" ? "delivered" : `still pending: ${delivered.failure.message}` });
  }
  return outcomes;
});

/**
 * Reads each delivered request's replies from its secondmate's published
 * status, never from its transcript, and records the new lines.
 */
export const readReplies = Effect.fn("firstmate.readReplies")(function*(only?: string) {
  const store = yield* mainOnly;
  const transport = yield* Transport;
  const added: { correlation: string; secondmate: string; status: PublishedStatus }[] = [];
  for (const request of yield* store.requests(only)) {
    if (request.status === "pending") continue;
    const secondmate = yield* store.secondmate(request.secondmate);
    const published = yield* transport.published(secondmate.home, request.correlation).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!published) continue;
    const mirrored = yield* store.mirror(request.correlation, published);
    added.push(...mirrored.added.map(status => ({ correlation: request.correlation, secondmate: request.secondmate, status })));
  }
  return added;
});

/**
 * One review of the secondmates' processes under the bounded relaunch
 * policy: a secondmate the captain wants running whose supervisor has
 * exited is relaunched while its count allows, and otherwise escalated
 * once to the captain as a hold. Unknown liveness is never relaunched.
 */
export const reviewSecondmates = Effect.fn("firstmate.reviewSecondmates")(function*() {
  const store = yield* mainOnly;
  const transport = yield* Transport;
  const notes: string[] = [];
  for (const secondmate of yield* store.secondmates()) {
    const { launch } = secondmate;
    if (secondmate.status !== "active" || launch.desired !== "running" || launch.exhausted) continue;
    const { owner } = yield* transport.liveness(secondmate.home);
    if (owner !== "absent") continue;
    // A process launched on this host that has not taken its lease yet is still starting.
    if (launch.pid !== null && launch.host === hostname() && alive(launch.pid)) continue;
    const exited = launch.pid === null ? secondmate : yield* store.exited(secondmate.id, launch.pid, `Its supervisor holds no live lease and process ${launch.pid} is gone`);
    if (!exited) continue;
    if (exited.launch.attempts < exited.launch.limit) {
      const pid = yield* transport.launch(exited.home, exited.launch.args);
      yield* store.launched(exited.id, pid, "supervisor", null);
      notes.push(`Secondmate ${exited.id} exited (${exited.launch.exits} exit(s)); relaunched as PID ${pid}, attempt ${exited.launch.attempts + 1} of ${exited.launch.limit}`);
    } else {
      const { hold } = yield* store.exhaust(exited.id);
      notes.push(`Secondmate ${exited.id} exited ${exited.launch.exits} time(s) and its ${exited.launch.limit} relaunch(es) are spent; held for the captain as ${hold.id}`);
    }
  }
  return notes;
});

/** States at which a routed item's task has stopped and its outcome is published. */
const stopStates = new Set(["ready", "local-ready", "pr-open", "completed", "landed", "failed", "cancelled", "cleaned"]);

/** The report a completed scout saved, if any. */
const reportOf = (home: string, task: Task) => {
  const directory = join(home, "reports", task.id);
  try { const report = readdirSync(directory).filter(name => name.endsWith(".md")).sort().at(-1); return report ? join(directory, report) : null; }
  catch { return null; }
};

/**
 * A secondmate home's service of its inbox, once per review: received
 * requests are accepted, routed items are dispatched once ready, and each
 * routed item's outcome is published as a status line for its
 * correlation, once per state, with a final line once every item stopped.
 * Nothing that was not routed is ever dispatched, so an empty inbox does nothing.
 */
export const serveInbox = Effect.fn("firstmate.serveInbox")(function*() {
  const store = yield* TaskStore;
  if (!(yield* store.identity())) return [];
  const published: PublishedStatus[] = [];
  for (const received of yield* store.inbox()) {
    if (received.status === "refused" || received.published.some(line => line.final)) continue;
    const entry = received.status === "received" ? yield* store.accept(received.correlation) : received;
    if (entry.status !== "accepted") continue;
    const lines: PublishedStatus[] = [];
    const line = (state: string, item: string, detail: string, task: Task | null = null, document: string | null = null): PublishedStatus => ({
      at: new Date().toISOString(), state, item, task: task?.id ?? null, commit: task?.run.commit ?? null, pr: task?.run.pr?.url ?? null, document, detail, final: false,
    });
    const last = (item: string) => [...entry.published, ...lines].findLast(l => l.item === item);
    let stopped = 0;
    for (const id of entry.items) {
      const item = yield* store.item(id).pipe(Effect.catch(() => Effect.succeed(null)));
      if (!item || item.status === "done") { stopped++; continue; }
      if (item.status === "held") {
        const hold = (yield* store.itemHolds(id)).find(h => h.id === item.hold);
        const detail = `Held for the captain: ${hold?.question ?? "an open question"}`;
        if (last(id)?.detail !== detail) lines.push(line("held", id, detail));
      }
      if (item.status === "queued" && item.taskId === null && !(yield* store.waiting(item)).length) {
        const dispatched = yield* dispatchItem(id, entry.work.surface ? { surface: entry.work.surface } : {}).pipe(Effect.result);
        if (dispatched._tag === "Success") lines.push(line("dispatched", id, `Dispatched as ${dispatched.success.task.intake.kind} task ${dispatched.success.task.id}`, dispatched.success.task));
        else if (last(id)?.state !== "blocked") lines.push(line("blocked", id, `Could not dispatch: ${dispatched.failure.message}`));
        continue;
      }
      if (!item.taskId) continue;
      const task = yield* store.get(item.taskId);
      if (!stopStates.has(task.run.state)) continue;
      stopped++;
      const previous = last(id);
      if (previous?.state === task.run.state && previous.task === task.id && previous.commit === (task.run.commit ?? null)) continue;
      const document = task.intake.kind === "scout" && task.run.state === "completed" ? reportOf(store.home, task) : null;
      lines.push(line(task.run.state, id, task.run.error ? `Task ${task.id} is ${task.run.state}: ${task.run.error}` : `Task ${task.id} is ${task.run.state}`, task, document));
    }
    if (stopped === entry.items.length) {
      lines.push({ at: new Date().toISOString(), state: "finished", item: null, task: null, commit: null, pr: null, document: null, detail: `Every routed item has stopped: ${entry.items.join(", ")}`, final: true });
    }
    if (lines.length) {
      yield* store.publishStatus(entry.correlation, lines);
      published.push(...lines);
    }
  }
  return published;
});
