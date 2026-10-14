import { createHash, randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { appError, InvalidInput, InvalidTransition, NotFound, type FirstmateError, type Task, type TaskState, type Wake } from "./domain.js";
import type { Store, WakeSpec } from "./store.js";

/**
 * The durable records of the integrations and events slice: process sources
 * and their captured results, captain inbox notes and replies, Relay
 * mentions and promised final replies, upstream links and their signals, and
 * the outbox of public actions. Every mutation and the wakes it delivers
 * commit in one transaction of the home's store, and every supervisor-side
 * write is fenced by the supervisor generation that holds the home.
 */

/** A source id, inbox request id, or link id: one path-safe word. */
export const ledgerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * When a source's finished run is a result: exit-zero or exit-nonzero on its
 * exit status, any on every run, changed when its output differs from the
 * last run's. A condition is evaluated here, never by a model.
 */
export const SourceCondition = Schema.Literals(["exit-zero", "exit-nonzero", "any", "changed"]);
export type SourceCondition = typeof SourceCondition.Type;
/**
 * A registered process-to-event source: an argument array the supervisor runs
 * directly (never through a shell), once when `every` is null, else every
 * `every` seconds. `registration` is the generation each register makes; a
 * run of an earlier registration is never captured.
 */
export const SourceSchema = Schema.Struct({
  id: Schema.String,
  argv: Schema.Array(Schema.String),
  every: Schema.NullOr(Schema.Number),
  when: SourceCondition,
  timeout: Schema.NullOr(Schema.Number),
  registration: Schema.String,
  /** active runs; stranded and failed wait for source start; finished is a once source that ran; retired is gone. */
  status: Schema.Literals(["active", "stranded", "failed", "finished", "retired"]),
  /** The run in progress: its process, and the supervisor generation that started it. */
  run: Schema.NullOr(Schema.Struct({ pid: Schema.Number, host: Schema.String, supervisor: Schema.String, startedAt: Schema.String })),
  runs: Schema.Number,
  lastRunAt: Schema.NullOr(Schema.String),
  /** A digest of the last run's output, for the changed condition. */
  lastOutput: Schema.NullOr(Schema.String),
  problem: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Source = typeof SourceSchema.Type;
/** A captured result: stored before its wake, and re-announced until `source handled` acknowledges it. */
export const SourceResultSchema = Schema.Struct({
  source: Schema.String,
  sequence: Schema.Number,
  registration: Schema.String,
  argv: Schema.Array(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  stdout: Schema.String,
  stderr: Schema.String,
  truncated: Schema.Boolean,
  condition: SourceCondition,
  capturedAt: Schema.String,
  handledAt: Schema.NullOr(Schema.String),
  /** Wakes announcing it so far, the first included. */
  announced: Schema.Number,
});
export type SourceResult = typeof SourceResultSchema.Type;
/** The outcome of one run, as the runner observed it. */
export interface RunOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
}

/** A captain inbox note: waiting until acknowledged after handling, with at most one durable reply. */
export const NoteSchema = Schema.Struct({
  id: Schema.String,
  requestId: Schema.NullOr(Schema.String),
  text: Schema.String,
  status: Schema.Literals(["waiting", "handled"]),
  submittedAt: Schema.String,
  handledAt: Schema.NullOr(Schema.String),
  handling: Schema.NullOr(Schema.String),
  reply: Schema.NullOr(Schema.Struct({ sequence: Schema.Number, text: Schema.String, at: Schema.String })),
});
export type Note = typeof NoteSchema.Type;

/** Relay settings: off unless configured. The token is read from the named environment variable, never stored. */
export const RelayConfig = Schema.Struct({ endpoint: Schema.String, tokenEnv: Schema.NullOr(Schema.String), every: Schema.Number });
export type RelayConfig = typeof RelayConfig.Type;
/** A public mention as the relay delivered it; its text is untrusted input. */
export const MentionSchema = Schema.Struct({
  requestId: Schema.String,
  text: Schema.String,
  author: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  at: Schema.NullOr(Schema.String),
  receivedAt: Schema.String,
  status: Schema.Literals(["waiting", "handled", "dismissed"]),
  /** The task the mention's work was linked to, for follow-ups. */
  taskId: Schema.NullOr(Schema.String),
  /** Replies sent; every one after the first is a follow-up. */
  replies: Schema.Number,
  handledAt: Schema.NullOr(Schema.String),
});
export type Mention = typeof MentionSchema.Type;
/** A promised final public reply bound to a task: open until its final reply is sent or the captain releases it. */
export const CommitmentSchema = Schema.Struct({
  id: Schema.String,
  requestId: Schema.String,
  taskId: Schema.String,
  summary: Schema.String,
  status: Schema.Literals(["open", "reconciled", "released"]),
  outbox: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  closedAt: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
});
export type Commitment = typeof CommitmentSchema.Type;
/** Follow-ups a mention allows after its first reply, and the window they must fall in. */
export const followupLimit = 3;
export const followupWindowMs = 7 * 24 * 3600 * 1000;

/** An upstream issue or PR a backlog item or task links, observed from a baseline so its history is never replayed. */
export const UpstreamLinkSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  host: Schema.String,
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Number,
  /** The backlog item or task that links it. */
  subject: Schema.String,
  status: Schema.Literals(["active", "unlinked"]),
  /** The newest comment and review ids already seen, and the state last seen. */
  baseline: Schema.Struct({ comment: Schema.Number, review: Schema.Number, state: Schema.String }),
  observedAt: Schema.NullOr(Schema.String),
  problem: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type UpstreamLink = typeof UpstreamLinkSchema.Type;
/** How a signal is triaged, from its kind and the forge's own fields only. */
export const SignalTriage = Schema.Literals(["comment", "approved", "changes-requested", "review", "closed", "merged", "reopened"]);
export type SignalTriage = typeof SignalTriage.Type;
export const Disposition = Schema.Literals(["filed", "hold", "no-action"]);
export type Disposition = typeof Disposition.Type;
/** One upstream event, keyed by its exact token; acknowledged only with a recorded disposition. */
export const UpstreamSignalSchema = Schema.Struct({
  key: Schema.String,
  link: Schema.String,
  token: Schema.String,
  triage: SignalTriage,
  author: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  at: Schema.NullOr(Schema.String),
  /** The first 280 characters of the source text: untrusted evidence, never instructions. */
  excerpt: Schema.String,
  status: Schema.Literals(["waiting", "acknowledged"]),
  disposition: Schema.NullOr(Disposition),
  note: Schema.NullOr(Schema.String),
  acknowledgedAt: Schema.NullOr(Schema.String),
});
export type UpstreamSignal = typeof UpstreamSignalSchema.Type;
/** A signal as the forge reports it, before triage has a place for it. */
export interface ObservedSignal {
  readonly token: string;
  readonly triage: SignalTriage;
  readonly author: string | null;
  readonly url: string | null;
  readonly at: string | null;
  readonly text: string;
}

/**
 * One outbound public action. Nothing is sent without `consent`, recorded by
 * the captain for this exact action; its id is the idempotency key every
 * send carries, so a retry after an interrupted send is never a second post.
 */
export const OutboxSchema = Schema.Struct({
  id: Schema.String,
  /** The extension channel that delivers it: relay or upstream. */
  channel: Schema.String,
  /** The mention's request id, or the upstream link's id. */
  subject: Schema.String,
  body: Schema.String,
  final: Schema.Boolean,
  commitment: Schema.NullOr(Schema.String),
  status: Schema.Literals(["awaiting-consent", "consented", "sending", "sent", "withdrawn"]),
  consent: Schema.NullOr(Schema.Struct({ at: Schema.String, note: Schema.NullOr(Schema.String) })),
  attempts: Schema.Array(Schema.Struct({ at: Schema.String, outcome: Schema.Literals(["sent", "error", "refused"]), error: Schema.NullOr(Schema.String) })),
  receipt: Schema.NullOr(Schema.Struct({ id: Schema.String, url: Schema.NullOr(Schema.String), at: Schema.String })),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type OutboxAction = typeof OutboxSchema.Type;
/** What a channel returns for a delivered action. */
export interface Receipt { readonly id: string; readonly url: string | null }

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const json = (row: Row | undefined) => row ? JSON.parse(String(row.json)) : undefined;
const shortId = (prefix: string) => `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const firstLine = (text: string, max = 120) => {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};
const checkedId = (value: string, name: string) => {
  if (!ledgerIdPattern.test(value)) throw new InvalidInput({ message: `${name} must be letters, digits, dot, underscore, or dash, starting with a letter or digit (at most 64)` });
  return value;
};
const decodeSource = Schema.decodeUnknownSync(SourceSchema);
const decodeResult = Schema.decodeUnknownSync(SourceResultSchema);
const decodeNote = Schema.decodeUnknownSync(NoteSchema);
const decodeMention = Schema.decodeUnknownSync(MentionSchema);
const decodeCommitment = Schema.decodeUnknownSync(CommitmentSchema);
const decodeLink = Schema.decodeUnknownSync(UpstreamLinkSchema);
const decodeSignal = Schema.decodeUnknownSync(UpstreamSignalSchema);
const decodeAction = Schema.decodeUnknownSync(OutboxSchema);
const decodeRelay = Schema.decodeUnknownSync(RelayConfig);

/** Task states that end a task's work, after which a promised final reply is due. */
export const terminalStates: ReadonlySet<TaskState> = new Set(["landed", "completed", "failed", "cancelled", "cleaned"]);

export class Ledger {
  constructor(private readonly store: Store) {}

  private get db() { return this.store.db; }
  private tx<A>(f: () => A): A { return this.store.transaction(f); }

  /** Appends one entry to the home's history. */
  private event(type: string, data: unknown) {
    this.db.prepare("INSERT INTO home_events(type, data, created_at) VALUES (?, ?, ?)").run(type, JSON.stringify(data), now());
  }

  /** Retires every open wake about a subject; returns their sequences. */
  private retire(subject: string): number[] {
    const open = this.db.prepare("SELECT sequence FROM wakes WHERE status != 'acknowledged' AND json_extract(json, '$.subject') = ?").all(subject).map(r => Number(r.sequence));
    const at = now();
    const acknowledge = this.db.prepare("UPDATE wakes SET status = 'acknowledged', updated_at = ? WHERE sequence = ?");
    for (const sequence of open) acknowledge.run(at, sequence);
    return open;
  }

  /** The wakes about a subject, oldest first. */
  wakesAbout(subject: string): Wake[] {
    const sequences = this.db.prepare("SELECT sequence FROM wakes WHERE json_extract(json, '$.subject') = ? ORDER BY sequence").all(subject).map(r => Number(r.sequence));
    const all = this.store.wakes();
    return sequences.flatMap(sequence => all.filter(wake => wake.sequence === sequence));
  }

  private captainWake(spec: Omit<WakeSpec, "consumer" | "generation" | "ref" | "cause"> & { ref?: string | null }): WakeSpec {
    return { consumer: "captain", generation: null, cause: null, ref: null, ...spec };
  }

  // ---- process sources ----

  private saveSource(source: Source) {
    this.db.prepare("INSERT INTO sources VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json")
      .run(source.id, source.status, JSON.stringify({ ...source, updatedAt: now() }));
  }

  sources(): Source[] {
    return this.db.prepare("SELECT json FROM sources ORDER BY rowid").all().map(row => decodeSource(json(row)));
  }

  source(id: string): Source {
    const row = this.db.prepare("SELECT json FROM sources WHERE id = ?").get(id);
    if (!row) throw new NotFound({ message: `No source "${id}"; firstmate source list shows the registered ones` });
    return decodeSource(json(row));
  }

  /**
   * Registers a source, or replaces an existing one with a new registration
   * generation; the same argv, interval, condition, and timeout of an active
   * source is unchanged. A replaced source's running process is stopped by
   * the supervisor and its output never captured, and its open stranded or
   * failed-to-start wakes are retired.
   */
  registerSource(spec: { id: string; argv: readonly string[]; every: number | null; when: SourceCondition; timeout: number | null }) {
    checkedId(spec.id, "A source id");
    if (!spec.argv.length || !spec.argv[0]) throw new InvalidInput({ message: "A source needs a command: firstmate source register <id> [options] -- <command> [args...]" });
    if (spec.every !== null && !(Number.isFinite(spec.every) && spec.every >= 1)) throw new InvalidInput({ message: "--every must be at least 1 second" });
    if (spec.timeout !== null && !(Number.isFinite(spec.timeout) && spec.timeout >= 1)) throw new InvalidInput({ message: "--timeout must be at least 1 second" });
    return this.tx(() => {
      const row = this.db.prepare("SELECT json FROM sources WHERE id = ?").get(spec.id);
      const prior = row ? decodeSource(json(row)) : null;
      const same = prior && prior.status === "active" && JSON.stringify(prior.argv) === JSON.stringify(spec.argv) && prior.every === spec.every && prior.when === spec.when && prior.timeout === spec.timeout;
      if (same) return { source: prior, change: "unchanged" as const };
      const at = now();
      const source: Source = {
        id: spec.id, argv: [...spec.argv], every: spec.every, when: spec.when, timeout: spec.timeout, registration: randomUUID(), status: "active",
        run: null, runs: 0, lastRunAt: null, lastOutput: null, problem: null, createdAt: prior?.createdAt ?? at, updatedAt: at,
      };
      this.saveSource(source);
      // A replaced registration's open down wakes are about the command that was replaced.
      if (prior) this.retire(`source:${spec.id}`);
      this.event("source.registered", { source: source.id, registration: source.registration, argv: source.argv, every: source.every, when: source.when, replaced: prior?.registration ?? null });
      return { source, change: prior ? "replaced" as const : "registered" as const };
    });
  }

  /** Records that the supervisor started a run of this registration. */
  startSource(generation: string, id: string, registration: string, pid: number, host: string): Source | null {
    return this.tx(() => {
      this.store.ownedHome(generation);
      const source = this.source(id);
      if (source.status !== "active" || source.registration !== registration) return null;
      const next: Source = { ...source, run: { pid, host, supervisor: generation, startedAt: now() } };
      this.saveSource(next);
      this.event("source.started", { source: id, registration, pid });
      return next;
    });
  }

  /**
   * A launch that never started: the source is failed until source start,
   * and the captain is woken once per registration and launch.
   */
  sourceFailed(generation: string, id: string, registration: string, error: string): Wake[] {
    return this.tx(() => {
      this.store.ownedHome(generation);
      const source = this.source(id);
      if (source.registration !== registration || source.status === "retired") return [];
      this.saveSource({ ...source, status: "failed", run: null, problem: `failed to start: ${error}`, runs: source.runs + 1 });
      this.event("source.failed", { source: id, registration, error });
      return this.store.insertWakes([this.captainWake({
        key: `source:${id}:launch-failed:${registration}:${source.runs + 1}`, kind: "source-down", taskId: null, subject: `source:${id}`,
        detail: `Process source ${id} failed to start: ${error}; nothing was captured. Fix its command and run firstmate source start ${id}, or retire it`,
      })]);
    });
  }

  /**
   * A run a dead supervisor generation left behind. When its process is gone
   * the source is relaunched; when it may still be running, the source is
   * held stranded until source start, so nothing polls it twice.
   */
  strandSource(generation: string, id: string, alive: boolean): Wake[] {
    return this.tx(() => {
      this.store.ownedHome(generation);
      const source = this.source(id);
      if (!source.run || source.run.supervisor === generation) return [];
      const { pid, supervisor } = source.run;
      this.saveSource({ ...source, run: null, ...(alive ? { status: "stranded" as const, problem: `process ${pid} of a stopped supervisor may still be running` } : {}) });
      this.event("source.stranded", { source: id, registration: source.registration, pid, alive });
      return this.store.insertWakes([this.captainWake({
        key: `source:${id}:stranded:${supervisor}:${pid}`, kind: "source-down", taskId: null, subject: `source:${id}`,
        detail: alive
          ? `Process source ${id} is stranded: process ${pid} from a stopped supervisor is still alive and nothing captures its output; check it, then firstmate source start ${id}`
          : `Process source ${id} was stranded by a supervisor that stopped without capturing its run; it was relaunched and that run's output is lost`,
      })]);
    });
  }

  /**
   * Captures a finished run of a registration: the result is stored before
   * its wake, in one transaction, only when the source's condition holds. A
   * run of an earlier registration, or of a retired source, is discarded.
   */
  captureSource(generation: string, id: string, registration: string, outcome: RunOutcome): { result: SourceResult | null; wakes: Wake[]; discarded: boolean } {
    return this.tx(() => {
      this.store.ownedHome(generation);
      const source = this.source(id);
      if (source.registration !== registration || source.status !== "active") {
        this.event("source.discarded", { source: id, registration, current: source.registration, status: source.status });
        return { result: null, wakes: [], discarded: true };
      }
      const output = digest(outcome.stdout);
      const holds = source.when === "any" || (source.when === "exit-zero" && outcome.exitCode === 0)
        || (source.when === "exit-nonzero" && outcome.exitCode !== 0) || (source.when === "changed" && output !== source.lastOutput);
      const at = now();
      this.saveSource({ ...source, run: null, runs: source.runs + 1, lastRunAt: at, lastOutput: output, problem: null, status: source.every === null ? "finished" : "active" });
      if (!holds) {
        this.event("source.ran", { source: id, registration, exitCode: outcome.exitCode, captured: false });
        return { result: null, wakes: [], discarded: false };
      }
      const sequence = Number(this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM source_results WHERE source = ?").get(id)?.next);
      const result: SourceResult = { source: id, sequence, registration, argv: source.argv, ...outcome, condition: source.when, capturedAt: at, handledAt: null, announced: 1 };
      this.db.prepare("INSERT INTO source_results VALUES (?, ?, ?, NULL, ?)").run(id, sequence, registration, JSON.stringify(result));
      this.event("source.captured", { source: id, registration, sequence, exitCode: outcome.exitCode });
      const wakes = this.store.insertWakes([this.captainWake({
        key: `source:${id}:${registration}:${sequence}`, kind: "source-result", taskId: null, subject: `source:${id}#${sequence}`, ref: String(sequence),
        detail: `Process source ${id} captured result ${sequence} (${outcome.exitCode === null ? `signal ${outcome.signal}` : `exit ${outcome.exitCode}`}): ${firstLine(outcome.stdout) || "(no output)"}; read it with firstmate source result ${id} ${sequence}, then firstmate source handled ${id} ${sequence}`,
      })]);
      return { result, wakes, discarded: false };
    });
  }

  /** Clears the run a stopping supervisor ended, so the next supervisor relaunches it without a strand. */
  releaseSource(generation: string, id: string) {
    this.tx(() => {
      this.store.ownedHome(generation);
      const source = this.source(id);
      if (source.run?.supervisor === generation) this.saveSource({ ...source, run: null });
    });
  }

  /**
   * Announces again each unhandled result whose every wake was acknowledged
   * at least `afterMs` ago, at most `limit` announcements in all.
   */
  reannounce(generation: string, afterMs: number, limit: number): Wake[] {
    return this.tx(() => {
      this.store.ownedHome(generation);
      const pending = this.db.prepare("SELECT json FROM source_results WHERE handled_at IS NULL ORDER BY source, sequence").all().map(row => decodeResult(json(row)));
      return pending.flatMap(result => {
        if (result.announced >= limit) return [];
        const subject = `source:${result.source}#${result.sequence}`;
        const wakes = this.wakesAbout(subject);
        if (!wakes.length || wakes.some(wake => wake.status !== "acknowledged")) return [];
        if (Date.now() - Date.parse(wakes.at(-1)!.updatedAt) < afterMs) return [];
        const next = { ...result, announced: result.announced + 1 };
        this.db.prepare("UPDATE source_results SET json = ? WHERE source = ? AND sequence = ?").run(JSON.stringify(next), result.source, result.sequence);
        return this.store.insertWakes([this.captainWake({
          key: `source:${result.source}:${result.registration}:${result.sequence}:again:${next.announced}`, kind: "source-result", taskId: null, subject, ref: String(result.sequence),
          detail: `Process source ${result.source} result ${result.sequence} is still not handled (announcement ${next.announced} of ${limit}); firstmate source result ${result.source} ${result.sequence}, then firstmate source handled ${result.source} ${result.sequence}`,
        })]);
      });
    });
  }

  results(id: string): SourceResult[] {
    this.source(id);
    return this.db.prepare("SELECT json FROM source_results WHERE source = ? ORDER BY sequence").all(id).map(row => decodeResult(json(row)));
  }

  result(id: string, sequence: number): SourceResult {
    const row = this.db.prepare("SELECT json FROM source_results WHERE source = ? AND sequence = ?").get(id, sequence);
    if (!row) throw new NotFound({ message: `Source ${id} has no result ${sequence}` });
    return decodeResult(json(row));
  }

  /**
   * The handled acknowledgement of one exact result: `handled` the first
   * time and `already-handled` on every repeat, retiring its wakes either way.
   */
  handleResult(id: string, sequence: number) {
    return this.tx(() => {
      const result = this.result(id, sequence);
      const wakes = this.retire(`source:${id}#${sequence}`);
      if (result.handledAt) return { outcome: "already-handled" as const, source: id, sequence, handledAt: result.handledAt, acknowledgedWakes: wakes };
      const at = now();
      this.db.prepare("UPDATE source_results SET handled_at = ?, json = ? WHERE source = ? AND sequence = ?").run(at, JSON.stringify({ ...result, handledAt: at }), id, sequence);
      this.event("source.handled", { source: id, sequence });
      return { outcome: "handled" as const, source: id, sequence, handledAt: at, acknowledgedWakes: wakes };
    });
  }

  /** Stops future runs; captured results stay until handled. */
  retireSource(id: string) {
    return this.tx(() => {
      const source = this.source(id);
      if (source.status === "retired") return { source, change: "already-retired" as const };
      const next: Source = { ...source, status: "retired" };
      this.saveSource(next);
      this.retire(`source:${id}`);
      this.event("source.retired", { source: id, registration: source.registration });
      return { source: next, change: "retired" as const };
    });
  }

  /** Returns a stranded or failed source to active, clearing what a stopped run left; the down wakes are retired. */
  restartSource(id: string) {
    return this.tx(() => {
      const source = this.source(id);
      if (source.status !== "stranded" && source.status !== "failed" && source.status !== "finished") {
        throw new InvalidTransition({ message: `Source ${id} is ${source.status}; only a stranded, failed, or finished source is started again` });
      }
      const next: Source = { ...source, status: "active", run: null, problem: null };
      this.saveSource(next);
      this.retire(`source:${id}`);
      this.event("source.restarted", { source: id, registration: source.registration, from: source.status });
      return next;
    });
  }

  // ---- the captain inbox ----

  private saveNote(note: Note) {
    this.db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json")
      .run(note.id, note.requestId, note.status, JSON.stringify(note));
  }

  note(id: string): Note {
    const row = this.db.prepare("SELECT json FROM notes WHERE id = ?").get(id);
    if (!row) throw new NotFound({ message: `No inbox note "${id}"` });
    return decodeNote(json(row));
  }

  notes(status?: Note["status"]): Note[] {
    const rows = status ? this.db.prepare("SELECT json FROM notes WHERE status = ? ORDER BY rowid").all(status) : this.db.prepare("SELECT json FROM notes ORDER BY rowid").all();
    return rows.map(row => decodeNote(json(row)));
  }

  /**
   * Saves a note and its wake in one transaction. A repeated request id
   * returns the original note as a replay and wakes nobody again.
   */
  addNote(text: string, requestId: string | null) {
    if (!text.trim()) throw new InvalidInput({ message: "A note needs text" });
    if (requestId !== null) checkedId(requestId, "--request-id");
    return this.tx(() => {
      if (requestId !== null) {
        const row = this.db.prepare("SELECT json FROM notes WHERE request_id = ?").get(requestId);
        if (row) return { outcome: "replay" as const, note: decodeNote(json(row)), wakes: [] as Wake[] };
      }
      const note: Note = { id: shortId("note"), requestId, text, status: "waiting", submittedAt: now(), handledAt: null, handling: null, reply: null };
      this.saveNote(note);
      this.event("note.saved", { note: note.id, requestId });
      const wakes = this.store.insertWakes([this.captainWake({
        key: `note:${note.id}`, kind: "note", taskId: null, subject: `note:${note.id}`,
        detail: `Inbox note ${note.id}: ${firstLine(text)}; handle it, then firstmate inbox ack ${note.id}`,
      })]);
      return { outcome: "saved" as const, note, wakes };
    });
  }

  /** Acknowledges a note after handling; it stops counting as waiting and its wake is retired. */
  ackNote(id: string, handling: string | null) {
    return this.tx(() => {
      const note = this.note(id);
      const wakes = this.retire(`note:${id}`);
      if (note.status === "handled") return { outcome: "already-handled" as const, note, acknowledgedWakes: wakes };
      const next: Note = { ...note, status: "handled", handledAt: now(), handling };
      this.saveNote(next);
      this.event("note.acknowledged", { note: id });
      return { outcome: "handled" as const, note: next, acknowledgedWakes: wakes };
    });
  }

  /** Publishes the one durable reply to a note, stamped with the home's reply sequence. */
  replyNote(id: string, text: string) {
    if (!text.trim()) throw new InvalidInput({ message: "A reply needs text" });
    return this.tx(() => {
      const note = this.note(id);
      if (note.reply) throw new InvalidTransition({ message: `Note ${id} already has its reply (sequence ${note.reply.sequence}); a note takes one reply` });
      const at = now();
      const sequence = Number(this.db.prepare("INSERT INTO note_replies(note, json) VALUES (?, ?)").run(id, JSON.stringify({ text, at })).lastInsertRowid);
      const next: Note = { ...note, reply: { sequence, text, at } };
      this.saveNote(next);
      this.event("note.replied", { note: id, sequence });
      return next;
    });
  }

  /** What a submitter reads: waiting and handled counts, notes, and the replies after a cursor, in reply order. */
  receipts(after: number) {
    const notes = this.notes();
    const replies = this.db.prepare("SELECT sequence, note FROM note_replies WHERE sequence > ? ORDER BY sequence").all(after)
      .map(r => { const note = this.note(String(r.note)); return { sequence: Number(r.sequence), note: note.id, requestId: note.requestId, text: note.reply!.text, at: note.reply!.at }; });
    return {
      waiting: notes.filter(n => n.status === "waiting").length, handled: notes.filter(n => n.status === "handled").length,
      notes: notes.map(n => ({ id: n.id, requestId: n.requestId, status: n.status, submittedAt: n.submittedAt, handledAt: n.handledAt, replied: n.reply !== null })),
      replies, cursor: replies.at(-1)?.sequence ?? after,
    };
  }

  // ---- Relay ----

  relay(): RelayConfig | null {
    const row = this.db.prepare("SELECT json FROM settings WHERE name = 'relay'").get();
    return row ? decodeRelay(json(row)) : null;
  }

  configureRelay(config: RelayConfig | null) {
    if (config) {
      let url: URL;
      try { url = new URL(config.endpoint); } catch { throw new InvalidInput({ message: "--endpoint must be an http(s) URL" }); }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new InvalidInput({ message: "--endpoint must be an http(s) URL" });
      if (config.tokenEnv !== null && !/^[A-Z_][A-Z0-9_]*$/.test(config.tokenEnv)) throw new InvalidInput({ message: "--token-env must name an environment variable" });
      if (!(config.every >= 1)) throw new InvalidInput({ message: "--every must be at least 1 second" });
    }
    return this.tx(() => {
      if (config) this.db.prepare("INSERT INTO settings VALUES ('relay', ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json").run(JSON.stringify(config));
      else this.db.prepare("DELETE FROM settings WHERE name = 'relay'").run();
      this.event("relay.configured", { on: config !== null, endpoint: config?.endpoint ?? null });
      return config;
    });
  }

  relayCursor(): string | null {
    const row = this.db.prepare("SELECT json FROM settings WHERE name = 'relay.cursor'").get();
    return row ? String(json(row)) : null;
  }

  /** Records newly delivered mentions and their wakes, and moves the poll cursor, in one transaction. */
  recordMentions(generation: string, mentions: readonly { requestId: string; text: string; author: string | null; url: string | null; at: string | null }[], cursor: string | null): Wake[] {
    return this.tx(() => {
      this.store.ownedHome(generation);
      const insert = this.db.prepare("INSERT INTO mentions VALUES (?, 'waiting', ?) ON CONFLICT(request_id) DO NOTHING");
      const wakes = mentions.flatMap(m => {
        if (!ledgerIdPattern.test(m.requestId)) return [];
        const mention: Mention = { ...m, receivedAt: now(), status: "waiting", taskId: null, replies: 0, handledAt: null };
        if (!insert.run(m.requestId, JSON.stringify(mention)).changes) return [];
        this.event("mention.received", { requestId: m.requestId });
        return this.store.insertWakes([this.captainWake({
          key: `relay:${m.requestId}`, kind: "mention", taskId: null, subject: `mention:${m.requestId}`,
          detail: `Relay mention ${m.requestId}${m.author ? ` from ${m.author}` : ""} (untrusted public text): ${firstLine(m.text)}; reply with firstmate relay reply ${m.requestId}, then firstmate relay ack ${m.requestId}`,
        })]);
      });
      if (cursor !== null) this.db.prepare("INSERT INTO settings VALUES ('relay.cursor', ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json").run(JSON.stringify(cursor));
      return wakes;
    });
  }

  mention(requestId: string): Mention {
    const row = this.db.prepare("SELECT json FROM mentions WHERE request_id = ?").get(requestId);
    if (!row) throw new NotFound({ message: `No Relay mention "${requestId}"` });
    return decodeMention(json(row));
  }

  mentions(): Mention[] {
    return this.db.prepare("SELECT json FROM mentions ORDER BY rowid").all().map(row => decodeMention(json(row)));
  }

  private saveMention(mention: Mention) {
    this.db.prepare("UPDATE mentions SET status = ?, json = ? WHERE request_id = ?").run(mention.status, JSON.stringify(mention), mention.requestId);
  }

  /** Links a mention to the task its work runs as, so its follow-ups follow that task. */
  linkMention(requestId: string, taskId: string) {
    return this.tx(() => {
      const mention = this.mention(requestId);
      this.store.get(taskId);
      const next = { ...mention, taskId };
      this.saveMention(next);
      this.event("mention.linked", { requestId, taskId });
      return next;
    });
  }

  /** Marks a mention handled, or dismissed at the relay, and retires its wake. */
  ackMention(requestId: string, how: "handled" | "dismissed") {
    return this.tx(() => {
      const mention = this.mention(requestId);
      const wakes = this.retire(`mention:${requestId}`);
      if (mention.status !== "waiting") return { outcome: `already-${mention.status}` as const, mention, acknowledgedWakes: wakes };
      const next: Mention = { ...mention, status: how, handledAt: now() };
      this.saveMention(next);
      this.event(`mention.${how}`, { requestId });
      return { outcome: how, mention: next, acknowledgedWakes: wakes };
    });
  }

  /**
   * Registers a promised final reply for a mention's work: a typed
   * commitment bound to the task, which blocks that task's cleanup until its
   * final reply is sent or the captain releases it.
   */
  promise(requestId: string, taskId: string, summary: string) {
    if (!summary.trim()) throw new InvalidInput({ message: "--summary must say, in public-safe words, what the final reply will report" });
    return this.tx(() => {
      const mention = this.mention(requestId);
      const task = this.store.get(taskId);
      if (task.run.state === "cleaned") throw new InvalidTransition({ message: `Task ${taskId} is already cleaned` });
      const open = this.commitments(taskId).find(c => c.requestId === requestId && c.status === "open");
      if (open) return { commitment: open, change: "existing" as const };
      const commitment: Commitment = { id: shortId("promise"), requestId, taskId, summary, status: "open", outbox: null, createdAt: now(), closedAt: null, reason: null };
      this.db.prepare("INSERT INTO commitments VALUES (?, ?, ?, 'open', ?)").run(commitment.id, requestId, taskId, JSON.stringify(commitment));
      if (!mention.taskId) this.saveMention({ ...mention, taskId });
      this.event("commitment.registered", { commitment: commitment.id, requestId, taskId });
      return { commitment, change: "registered" as const };
    });
  }

  commitment(id: string): Commitment {
    const row = this.db.prepare("SELECT json FROM commitments WHERE id = ?").get(id);
    if (!row) throw new NotFound({ message: `No promised final reply "${id}"` });
    return decodeCommitment(json(row));
  }

  commitments(taskId?: string): Commitment[] {
    const rows = taskId ? this.db.prepare("SELECT json FROM commitments WHERE task_id = ? ORDER BY rowid").all(taskId) : this.db.prepare("SELECT json FROM commitments ORDER BY rowid").all();
    return rows.map(row => decodeCommitment(json(row)));
  }

  private saveCommitment(commitment: Commitment) {
    this.db.prepare("UPDATE commitments SET status = ?, json = ? WHERE id = ?").run(commitment.status, JSON.stringify(commitment), commitment.id);
  }

  /** The captain's release of a promise without a final reply, with the reason recorded. */
  releaseCommitment(id: string, reason: string) {
    if (!reason.trim()) throw new InvalidInput({ message: "--reason is required to release a promised final reply" });
    return this.tx(() => {
      const commitment = this.commitment(id);
      if (commitment.status !== "open") throw new InvalidTransition({ message: `Promised final reply ${id} is already ${commitment.status}` });
      const next: Commitment = { ...commitment, status: "released", closedAt: now(), reason };
      this.saveCommitment(next);
      this.retire(`promise:${id}`);
      this.event("commitment.released", { commitment: id, reason });
      return next;
    });
  }

  /** Wakes for each open promise whose task reached a state that ends its work, once per state. */
  dueFollowups(generation: string): Wake[] {
    return this.tx(() => {
      this.store.ownedHome(generation);
      return this.commitments().filter(c => c.status === "open").flatMap(c => {
        const task: Task = this.store.get(c.taskId);
        if (!terminalStates.has(task.run.state)) return [];
        return this.store.insertWakes([this.captainWake({
          key: `followup:${c.id}:${task.run.state}`, kind: "followup", taskId: c.taskId, subject: `promise:${c.id}`, ref: c.requestId,
          detail: `Task ${c.taskId} is ${task.run.state}; the final reply promised on Relay mention ${c.requestId} is due (${c.summary}): firstmate relay reply ${c.requestId} --final --text <reply>, then consent and send it`,
        })]);
      });
    });
  }

  // ---- upstream links and signals ----

  link(id: string): UpstreamLink {
    const row = this.db.prepare("SELECT json FROM upstream_links WHERE id = ?").get(id);
    if (!row) throw new NotFound({ message: `No upstream link "${id}"` });
    return decodeLink(json(row));
  }

  links(): UpstreamLink[] {
    return this.db.prepare("SELECT json FROM upstream_links ORDER BY rowid").all().map(row => decodeLink(json(row)));
  }

  private saveLink(link: UpstreamLink) {
    this.db.prepare("INSERT INTO upstream_links VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json").run(link.id, link.status, JSON.stringify(link));
  }

  /** Links an upstream issue or PR to a backlog item or task, from the baseline observed now; one active link per URL and subject. */
  linkUpstream(subject: string, url: string, repository: { host: string; owner: string; repo: string; number: number }, baseline: UpstreamLink["baseline"]) {
    return this.tx(() => {
      const known = this.db.prepare("SELECT 1 FROM items WHERE id = ? UNION SELECT 1 FROM tasks WHERE id = ?").get(subject, subject);
      if (!known) throw new NotFound({ message: `No backlog item or task "${subject}"` });
      const existing = this.links().find(l => l.status === "active" && l.url === url && l.subject === subject);
      if (existing) return { link: existing, change: "existing" as const };
      const link: UpstreamLink = { id: shortId("up"), url, ...repository, subject, status: "active", baseline, observedAt: now(), problem: null, createdAt: now() };
      this.saveLink(link);
      this.event("upstream.linked", { link: link.id, url, subject });
      return { link, change: "linked" as const };
    });
  }

  unlink(id: string) {
    return this.tx(() => {
      const link = this.link(id);
      const next: UpstreamLink = { ...link, status: "unlinked" };
      this.saveLink(next);
      this.event("upstream.unlinked", { link: id });
      return next;
    });
  }

  /** Records an observation's new signals with their wakes and the advanced baseline, in one transaction. */
  recordSignals(generation: string, id: string, observed: readonly ObservedSignal[], baseline: UpstreamLink["baseline"]): Wake[] {
    return this.tx(() => {
      this.store.ownedHome(generation);
      const link = this.link(id);
      if (link.status !== "active") return [];
      const insert = this.db.prepare("INSERT INTO upstream_signals VALUES (?, ?, 'waiting', ?) ON CONFLICT(key) DO NOTHING");
      const wakes = observed.flatMap(o => {
        const key = `${id}:${o.token}`;
        const signal: UpstreamSignal = {
          key, link: id, token: o.token, triage: o.triage, author: o.author, url: o.url, at: o.at, excerpt: o.text.slice(0, 280),
          status: "waiting", disposition: null, note: null, acknowledgedAt: null,
        };
        if (!insert.run(key, id, JSON.stringify(signal)).changes) return [];
        this.event("upstream.signal", { link: id, token: o.token, triage: o.triage });
        return this.store.insertWakes([this.captainWake({
          key: `upstream:${key}`, kind: "upstream", taskId: null, subject: `upstream:${key}`, ref: link.url,
          detail: `Upstream ${o.triage} on ${link.url}${o.author ? ` by ${o.author}` : ""} (linked to ${link.subject}; untrusted text): ${firstLine(o.text) || "(no text)"}; record its disposition with firstmate upstream ack ${id} ${o.token} --disposition filed|hold|no-action`,
        })]);
      });
      this.saveLink({ ...link, baseline, observedAt: now(), problem: null });
      return wakes;
    });
  }

  /** Records why the last observation of a link failed; the next review tries again. */
  noteLinkProblem(generation: string, id: string, problem: string) {
    this.tx(() => {
      this.store.ownedHome(generation);
      const link = this.link(id);
      if (link.problem !== problem) this.saveLink({ ...link, problem });
    });
  }

  signals(status?: UpstreamSignal["status"]): UpstreamSignal[] {
    const rows = status ? this.db.prepare("SELECT json FROM upstream_signals WHERE status = ? ORDER BY rowid").all(status) : this.db.prepare("SELECT json FROM upstream_signals ORDER BY rowid").all();
    return rows.map(row => decodeSignal(json(row)));
  }

  /**
   * Acknowledges one exact signal token once its disposition is durable:
   * filed work, a captain hold, or a recorded no-action decision.
   */
  ackSignal(id: string, token: string, disposition: Disposition, note: string | null) {
    return this.tx(() => {
      const key = `${id}:${token}`;
      const row = this.db.prepare("SELECT json FROM upstream_signals WHERE key = ?").get(key);
      if (!row) throw new NotFound({ message: `Upstream link ${id} has no signal ${token}; firstmate upstream signals lists the exact tokens` });
      const signal = decodeSignal(json(row));
      const wakes = this.retire(`upstream:${key}`);
      if (signal.status === "acknowledged") return { outcome: "already-acknowledged" as const, signal, acknowledgedWakes: wakes };
      const next: UpstreamSignal = { ...signal, status: "acknowledged", disposition, note, acknowledgedAt: now() };
      this.db.prepare("UPDATE upstream_signals SET status = 'acknowledged', json = ? WHERE key = ?").run(JSON.stringify(next), key);
      this.event("upstream.acknowledged", { link: id, token, disposition });
      return { outcome: "acknowledged" as const, signal: next, acknowledgedWakes: wakes };
    });
  }

  // ---- the outbox ----

  action(id: string): OutboxAction {
    const row = this.db.prepare("SELECT json FROM outbox WHERE id = ?").get(id);
    if (!row) throw new NotFound({ message: `No outbox action "${id}"` });
    return decodeAction(json(row));
  }

  actions(status?: OutboxAction["status"]): OutboxAction[] {
    const rows = status ? this.db.prepare("SELECT json FROM outbox WHERE status = ? ORDER BY rowid").all(status) : this.db.prepare("SELECT json FROM outbox ORDER BY rowid").all();
    return rows.map(row => decodeAction(json(row)));
  }

  private saveAction(action: OutboxAction) {
    const next = { ...action, updatedAt: now() };
    this.db.prepare("INSERT INTO outbox VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json").run(next.id, next.status, JSON.stringify(next));
    return next;
  }

  /**
   * Queues a public action awaiting the captain's consent. The same body to
   * the same subject on the same channel, while unsent, is the same action.
   * A Relay reply checks the mention's follow-up budget; a final one carries
   * the mention's open promise for its task.
   */
  queue(channel: string, subject: string, body: string, final: boolean) {
    if (!body.trim()) throw new InvalidInput({ message: "An outbound action needs text" });
    return this.tx(() => {
      const existing = this.actions().find(a => a.channel === channel && a.subject === subject && a.body === body && a.status !== "withdrawn" && a.status !== "sent");
      if (existing) return { action: existing, change: "existing" as const };
      let commitment: string | null = null;
      if (channel === "relay") {
        const mention = this.mention(subject);
        const planned = mention.replies + this.actions().filter(a => a.channel === "relay" && a.subject === subject && a.status !== "withdrawn" && a.status !== "sent").length;
        if (planned >= 1 + followupLimit) throw new InvalidTransition({ message: `Mention ${subject} has used its reply and ${followupLimit} follow-ups` });
        if (planned >= 1 && Date.now() - Date.parse(mention.receivedAt) > followupWindowMs) throw new InvalidTransition({ message: `Mention ${subject}'s follow-up window of 7 days has closed` });
        if (final) commitment = this.commitments().find(c => c.requestId === subject && c.status === "open")?.id ?? null;
      } else if (channel === "upstream") {
        if (this.link(subject).status !== "active") throw new InvalidTransition({ message: `Upstream link ${subject} is unlinked` });
      }
      const at = now();
      const action = this.saveAction({
        id: shortId("out"), channel, subject, body, final, commitment, status: "awaiting-consent", consent: null, attempts: [], receipt: null, createdAt: at, updatedAt: at,
      });
      if (commitment) this.saveCommitment({ ...this.commitment(commitment), outbox: action.id });
      this.event("outbox.queued", { action: action.id, channel, subject, final, commitment });
      return { action, change: "queued" as const };
    });
  }

  /** Records the captain's consent to send this exact action. */
  consent(id: string, note: string | null) {
    return this.tx(() => {
      const action = this.action(id);
      if (action.status === "withdrawn") throw new InvalidTransition({ message: `Outbox action ${id} was withdrawn` });
      if (action.consent) return { action, change: "already-consented" as const };
      const next = this.saveAction({ ...action, status: "consented", consent: { at: now(), note } });
      this.event("outbox.consented", { action: id });
      return { action: next, change: "consented" as const };
    });
  }

  withdraw(id: string) {
    return this.tx(() => {
      const action = this.action(id);
      if (action.status === "sent" || action.status === "sending") throw new InvalidTransition({ message: `Outbox action ${id} is ${action.status}; it can no longer be withdrawn` });
      const next = this.saveAction({ ...action, status: "withdrawn" });
      if (action.commitment) {
        const commitment = this.commitment(action.commitment);
        if (commitment.outbox === id) this.saveCommitment({ ...commitment, outbox: null });
      }
      this.event("outbox.withdrawn", { action: id });
      return next;
    });
  }

  /**
   * Claims an action for sending. Without consent the send is refused and the
   * refusal recorded; a sent action is returned as already sent. A claim of
   * an action left `sending` is a retry under the same idempotency key.
   */
  claimSend(id: string): { action: OutboxAction; claim: "send" | "already-sent" | "refused" } {
    return this.tx(() => {
      const action = this.action(id);
      if (action.status === "sent") return { action, claim: "already-sent" };
      if (action.status === "withdrawn") throw new InvalidTransition({ message: `Outbox action ${id} was withdrawn` });
      if (!action.consent) {
        const refused = this.saveAction({ ...action, attempts: [...action.attempts, { at: now(), outcome: "refused", error: "no recorded consent" }] });
        this.event("outbox.refused", { action: id, reason: "no recorded consent" });
        return { action: refused, claim: "refused" };
      }
      return { action: this.saveAction({ ...action, status: "sending" }), claim: "send" };
    });
  }

  /** Records a delivered action; a final Relay reply reconciles its promise in the same transaction. */
  finishSend(id: string, receipt: Receipt) {
    return this.tx(() => {
      const action = this.action(id);
      if (action.status === "sent") return action;
      const at = now();
      const next = this.saveAction({ ...action, status: "sent", receipt: { ...receipt, at }, attempts: [...action.attempts, { at, outcome: "sent", error: null }] });
      if (action.channel === "relay") {
        const mention = this.mention(action.subject);
        this.saveMention({ ...mention, replies: mention.replies + 1 });
      }
      if (action.commitment) {
        const commitment = this.commitment(action.commitment);
        if (commitment.status === "open") {
          this.saveCommitment({ ...commitment, status: "reconciled", outbox: id, closedAt: at });
          this.retire(`promise:${commitment.id}`);
          this.event("commitment.reconciled", { commitment: commitment.id, action: id });
        }
      }
      this.event("outbox.sent", { action: id, receipt: receipt.id });
      return next;
    });
  }

  /** Records a failed send; the action stays consented for a retry under the same key, and a supervisor send wakes the captain. */
  failSend(id: string, error: string, generation: string | null) {
    return this.tx(() => {
      if (generation) this.store.ownedHome(generation);
      const action = this.action(id);
      const attempts = [...action.attempts, { at: now(), outcome: "error" as const, error }];
      const next = this.saveAction({ ...action, status: "consented", attempts });
      this.event("outbox.failed", { action: id, error });
      const wakes = generation ? this.store.insertWakes([this.captainWake({
        key: `outbox:${id}:failed:${attempts.length}`, kind: "outbox", taskId: null, subject: `outbox:${id}`,
        detail: `Sending outbox action ${id} (${action.channel} ${action.subject}) failed: ${error}; firstmate outbox send ${id} retries it under the same key, or withdraw it`,
      })]) : [];
      return { action: next, wakes };
    });
  }
}

type Op<A> = Effect.Effect<A, FirstmateError>;
/** The ledger's operations as Effects, each a synchronous store call whose thrown errors are typed. */
export type LedgerOps = { readonly [K in keyof Ledger]: Ledger[K] extends (...args: infer P) => infer R ? (...args: P) => Op<R> : never };

export function ledgerOps(ledger: Ledger): LedgerOps {
  const ops: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(Ledger.prototype)) {
    if (name === "constructor") continue;
    const method = (ledger as unknown as Record<string, unknown>)[name];
    if (typeof method !== "function") continue;
    ops[name] = (...args: unknown[]) => Effect.try({ try: () => (method as (...a: unknown[]) => unknown).apply(ledger, args), catch: appError });
  }
  return ops as LedgerOps;
}
