import { DatabaseSync } from "node:sqlite";
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { hostname } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Context, Effect, Layer, Schedule, Schema, Stream, type Scope } from "effect";
import {
  activeStates, appError, decodeControl, decodeProject, parseProject, ProjectEventData, AtCapacity, decodeDecision, decodeEvent, decodeEventData, decodeHold, decodeSteer, decodeSupervisor, decodeTask, decodeValidation, decodeWake,
  encodeCreatedTask, encodeTask, transitions,
  InvalidInput, InvalidTransition, LiveOwner, NotFound, OwnerUnknown, StaleGeneration,
  type Control, type ControlVerb, type Decision, type EventDataOf, type EventType, type FirstmateError, type Steer, type SteerEvidence, type SteerStatus,
  type GateAction, type Hold, type PipelineGate, type Validation,
  decodeItem, defaultDoneKeep, itemIdPattern, ItemEventData, BacklogSettings,
  decodeSecondmate, decodeRequest, decodeHandoff, decodeInbox, secondmateIdPattern, SecondmateEventData, SecondmateIdentity, SharedPreferences, AccountPin,
  decodePosture, HomeEventData, TriagedSchema, type HomeEvent, type HomeEventType, type MemoryFile, type Posture, type PostureMode, type Triaged,
  type Secondmate, type SecondmateEvent, type SecondmateEventType, type Request, type Handoff, type Inbox, type RoutedWork, type PublishedStatus,
  type Divergence, type Item, type ItemEvent, type ItemEventType, type ItemKind, type ItemOutcome,
  type Deferred, type IntakeResolution, type Project, type ProjectEvent, type ProjectEventType,
  type Cleaned, type DiscardAuthorization, type LandingProof, type MergeApproval, type PullRequestMerged, type PullRequestRef, type Supervisor, type SupervisorSettings, type Task, type TaskEvent, type TaskRun, type Wake, type WakeConsumer, type WakeKind,
} from "./domain.js";
import type { Sequenced } from "./authority.js";
import { migrate, migrations, type Migration } from "./migrations.js";
import { Ledger, ledgerOps, type LedgerOps } from "./ledger.js";
import { Maintenance, maintenanceOps, type MaintenanceOps } from "./maintenance.js";

type Row = Record<string, unknown>;
const parse = (row: Row | undefined): unknown => {
  if (!row) throw new NotFound({ message: "Record not found" });
  return JSON.parse(String(row.json));
};
const now = () => new Date().toISOString();
const awaitingProof = (steer: Steer) => steer.status === "submitted" || steer.status === "delivered";

export type Owner = "live" | "absent" | "unknown";
/** A lease holder as observed from this host: a foreign host or an unreadable PID is unknown, never absent. */
const ownerOf = (lease: { readonly host?: unknown; readonly pid?: unknown } | undefined): Owner => {
  if (!lease) return "absent";
  if (lease.host !== hostname()) return "unknown";
  try { process.kill(Number(lease.pid), 0); return "live"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown"; }
};

/** A wake as the classifier or a review describes it, before it has a place in the queue. */
export interface WakeSpec {
  readonly key: string;
  readonly consumer: WakeConsumer;
  readonly kind: WakeKind;
  readonly taskId: string | null;
  /** The extension record an extension wake is about. */
  readonly subject?: string | null;
  readonly generation: string | null;
  readonly ref: string | null;
  readonly cause: number | null;
  readonly detail: string;
}

/** A backlog item as the captain adds it; the host fills in the rest. */
export interface NewItem {
  readonly id?: string;
  readonly title: string;
  readonly kind: ItemKind;
  readonly project?: string | null;
  readonly prompt?: string | null;
  readonly dependsOn?: readonly string[];
  readonly deferUntil?: string | null;
  readonly note?: string;
}
/** The captain's answer to a hold: verbatim text, and for a pipeline gate how to carry it out. */
export interface AnswerRequest {
  readonly text: string;
  /** Returns a work item to proceed instead of closing it. */
  readonly release?: boolean;
  readonly action?: GateAction;
  readonly findings?: readonly string[];
}
/** The fields an item update may change; a note is appended. */
export interface ItemChange {
  readonly title?: string;
  readonly kind?: ItemKind;
  readonly project?: string | null;
  readonly prompt?: string | null;
  readonly dependsOn?: readonly string[];
  readonly deferUntil?: string | null;
  readonly note?: string;
}

/** One attempt's lease with what this host can observe about it. */
export interface AttemptLease {
  readonly task: Task;
  readonly generation: string;
  readonly pid: number;
  readonly owner: Owner;
  /** The latest SDK activity the attempt recorded, or null before any. */
  readonly activeAt: string | null;
}

/** A recovery step the supervisor records, with the control that carries it out. */
export type RecoveryStep =
  | { readonly type: "recovery.attempted"; readonly data: EventDataOf<"recovery.attempted"> }
  | { readonly type: "recovery.exhausted"; readonly data: EventDataOf<"recovery.exhausted"> };
export interface ControlRequest {
  readonly verb: ControlVerb;
  readonly reason: string;
  readonly prompt: string | null;
}

/** The run fields an attempt may write; intake, policy, and identity are never among them. */
const attemptWritable = ["state", "sessionId", "output", "error", "costUsd", "commit"] as const;
export type TaskChanges = Partial<Pick<TaskRun, typeof attemptWritable[number]>>;

/** A committed change to a task: its latest event sequence and the projection at that point. */
export interface TaskChange {
  readonly sequence: number;
  readonly task: Task;
  /** The earliest lifecycle control still requested of the task's current generation. */
  readonly control: Control | null;
}

/** One database owns task projections, decision answers, and their event log. */
export class Store {
  readonly db: DatabaseSync;
  readonly home: string;

  /** `steps` is a test seam; production homes always open with the shipped migrations. */
  constructor(home: string, steps: readonly Migration[] = migrations) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.home = realpathSync(home);
    this.db = new DatabaseSync(join(this.home, "firstmate.sqlite"));
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    try {
      // Turning a new database to WAL takes an exclusive lock that the busy timeout does not always wait for, so a
      // second process opening the same new home retries it for a bounded time.
      for (let tries = 0; ; tries++) {
        try { this.db.exec("PRAGMA journal_mode = WAL;"); break; }
        catch (error) {
          if (tries >= 100 || !/database is locked/.test((error as Error).message)) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
      }
      this.db.exec("PRAGMA synchronous = FULL;");
      migrate(this.db, steps);
    } catch (error) { this.db.close(); throw error; }
  }

  close() { this.db.close(); }

  transaction<A>(f: () => A): A {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = f(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  get(id: string): Task {
    return decodeTask(parse(this.db.prepare("SELECT json FROM tasks WHERE id = ?").get(id)));
  }

  list(): Task[] {
    return this.db.prepare("SELECT json FROM tasks ORDER BY rowid").all().map(row => decodeTask(parse(row)));
  }

  inspect(id: string) {
    const task = this.get(id);
    const lease = this.db.prepare("SELECT * FROM leases WHERE task_id = ?").get(id);
    const owner = ownerOf(lease);
    const lastActivityAt = lease?.active_at == null ? null : String(lease.active_at);
    return { task, owner, observedState: activeStates.has(task.run.state) && owner !== "live" ? "unknown" : task.run.state, lastActivityAt };
  }

  /** The only task write after creation: it changes run fields and keeps everything else as stored. */
  private advance(task: Task, changes: Partial<Omit<TaskRun, "updatedAt">>): Task {
    const next = { ...task, run: { ...task.run, ...changes, updatedAt: now() } };
    this.db.prepare("UPDATE tasks SET json = ? WHERE id = ?").run(JSON.stringify(encodeTask(next)), task.id);
    return next;
  }

  /** Appends one event and returns its sequence. */
  private append(task: Task, type: string, data: unknown): number {
    return Number(this.db.prepare("INSERT INTO events(task_id, generation, type, data, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(task.id, task.run.generation, type, JSON.stringify(decodeEventData(type, data)), now()).lastInsertRowid);
  }

  /**
   * Records a new task, with how intake resolved its project and policy when
   * given. A task naming a registered project is refused once that project is
   * gone or no longer at the clone intake read.
   */
  create(task: Task, resolution?: IntakeResolution, itemId?: string): Task {
    return this.transaction(() => {
      const { projectName } = task.intake;
      if (projectName !== undefined && this.project(projectName)?.clone !== task.intake.project) {
        throw new InvalidTransition({ message: `Project "${projectName}" changed while the task was being created; add the task again` });
      }
      const item = itemId === undefined ? null : this.checkDispatch(itemId);
      if (item && item.kind !== task.intake.kind) throw new InvalidInput({ message: `Backlog item "${item.id}" is a ${item.kind} item, not a ${task.intake.kind}` });
      this.db.prepare("INSERT INTO tasks VALUES (?, ?)").run(task.id, JSON.stringify(encodeCreatedTask(task)));
      this.append(task, "task.created", { kind: task.intake.kind, project: task.intake.project, base: task.intake.base });
      if (resolution) this.append(task, "intake.resolved", resolution);
      if (task.intake.dispatch) this.append(task, "dispatch.resolved", task.intake.dispatch);
      if (item) {
        this.saveItem({ ...item, status: "in-flight", taskId: task.id, outcome: null, notes: [...item.notes, hostNote(`Dispatched as ${task.intake.kind} task ${task.id}`)] });
        this.appendItem(item.id, "item.dispatched", { taskId: task.id, kind: task.intake.kind });
        this.append(task, "item.linked", { item: item.id });
      }
      return task;
    });
  }

  /** The registry's entries in name order, each decoded or reported as malformed; nothing is skipped. */
  projectEntries(): ProjectEntry[] {
    return this.db.prepare("SELECT name, json FROM projects ORDER BY name").all().map(row => {
      const name = String(row.name);
      try { return { name, project: parseProject(name, String(row.json)) }; }
      catch (error) { return { name, malformed: appError(error).message }; }
    });
  }

  /** The registered project, null when none has the name, refused when its record is malformed. */
  project(name: string): Project | null {
    const row = this.db.prepare("SELECT json FROM projects WHERE name = ?").get(name);
    return row ? parseProject(name, String(row.json)) : null;
  }

  /**
   * The project registered for a clone root, or null. A malformed entry that
   * may be that clone's is refused rather than skipped.
   */
  projectByClone(clone: string): Project | null {
    for (const entry of this.projectEntries()) {
      if ("project" in entry) { if (entry.project.clone === clone) return entry.project; continue; }
      let raw: { clone?: unknown } | undefined;
      try { raw = JSON.parse(String(this.db.prepare("SELECT json FROM projects WHERE name = ?").get(entry.name)?.json)); } catch { raw = undefined; }
      if (typeof raw?.clone !== "string" || raw.clone === clone) throw new InvalidInput({ message: entry.malformed });
    }
    return null;
  }

  private appendProject(name: string, type: ProjectEventType, data: unknown): number {
    const checked = Schema.decodeUnknownSync(ProjectEventData[type] as Schema.Codec<unknown>)(data);
    return Number(this.db.prepare("INSERT INTO project_events(project, type, data, created_at) VALUES (?, ?, ?, ?)")
      .run(name, type, JSON.stringify(checked), now()).lastInsertRowid);
  }

  /** Registers a project; a name or a clone registers once. */
  addProject(project: Project): Project {
    return this.transaction(() => {
      const checked = decodeProject(project.name, project);
      if (this.db.prepare("SELECT 1 FROM projects WHERE name = ?").get(checked.name)) throw new InvalidInput({ message: `Project "${checked.name}" is already registered; use firstmate project update` });
      const other = this.projectByClone(checked.clone);
      if (other) throw new InvalidInput({ message: `${checked.clone} is already registered as project "${other.name}"` });
      this.db.prepare("INSERT INTO projects VALUES (?, ?)").run(checked.name, JSON.stringify(checked));
      this.appendProject(checked.name, "project.added", checked);
      return checked;
    });
  }

  /**
   * Rewrites a project from its stored fields, read even when malformed, so
   * an update can repair a record; the result must be a valid project.
   * Existing tasks keep what they resolved at intake.
   */
  updateProject(name: string, change: (stored: Record<string, unknown>) => Project): Project {
    return this.transaction(() => {
      const next = decodeProject(name, { ...change(this.storedProject(name)), name, updatedAt: now() });
      this.db.prepare("UPDATE projects SET json = ? WHERE name = ?").run(JSON.stringify(next), name);
      this.appendProject(name, "project.updated", next);
      return next;
    });
  }

  /** A project's tasks that hold work not yet landed: anything but a landed ship, a completed scout, or a cleaned task. */
  unlanded(name: string): Task[] {
    return this.list().filter(task => task.intake.projectName === name && task.run.state !== "cleaned" && task.run.state !== "landed"
      && !(task.intake.kind === "scout" && task.run.state === "completed"));
  }

  /** A project's stored fields as recorded, even when malformed; an unreadable record reads as no fields. */
  storedProject(name: string): Record<string, unknown> {
    const row = this.db.prepare("SELECT json FROM projects WHERE name = ?").get(name);
    if (!row) throw new NotFound({ message: `No project is registered as "${name}"` });
    try {
      const raw: unknown = JSON.parse(String(row.json));
      return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw, name } : { name };
    } catch { return { name }; }
  }

  /** Unregisters a project, refused while any of its tasks holds unlanded work; the clone itself is never touched. */
  removeProject(name: string): { name: string; sequence: number } {
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM projects WHERE name = ?").get(name)) throw new NotFound({ message: `No project is registered as "${name}"` });
      const held = this.unlanded(name);
      if (held.length) {
        throw new InvalidTransition({
          message: `Project "${name}" has unlanded work, so it stays registered: ${held.map(t => `${t.id} (${t.intake.kind}, ${t.run.state})`).join(", ")}. `
            + "Land each task, or cancel it if it has not run, record the captain's discard with firstmate discard, and remove it with firstmate cleanup; then remove the project",
        });
      }
      this.db.prepare("DELETE FROM projects WHERE name = ?").run(name);
      return { name, sequence: this.appendProject(name, "project.removed", { name }) };
    });
  }

  projectEvents(name: string): ProjectEvent[] {
    return this.db.prepare("SELECT * FROM project_events WHERE project = ? ORDER BY sequence").all(name).map(r => ({
      sequence: Number(r.sequence), project: String(r.project), type: String(r.type), data: JSON.parse(String(r.data)), createdAt: String(r.created_at),
    }));
  }

  /** The tasks of a project holding a place: every task with an attempt in an active state, whether or not its owner still lives. */
  holders(name: string): Task[] {
    return this.list().filter(task => task.intake.projectName === name && activeStates.has(task.run.state));
  }

  /**
   * The capacity the task's project imposes and the other tasks holding its
   * places; null when the task is unregistered, its project is no longer
   * registered, or the project is uncapped. A malformed project is refused.
   */
  room(id: string): Room | null {
    const task = this.get(id);
    const name = task.intake.projectName;
    const project = name === undefined ? null : this.project(name);
    if (!project || project.capacity === null) return null;
    return { project: project.name, capacity: project.capacity, holders: this.holders(project.name).filter(t => t.id !== id).map(t => t.id) };
  }

  /** Records that a queued task stays queued because its project is at capacity. */
  defer(id: string, deferred: Deferred): number {
    return this.transaction(() => {
      const task = this.get(id);
      if (task.run.state !== "queued") throw new InvalidTransition({ message: `Task is ${task.run.state}; only a queued task is deferred` });
      return this.append(task, "task.deferred", deferred);
    });
  }

  /** The generation fence: every write on behalf of an attempt passes through here. */
  private owned(id: string, token: string): Task {
    const lease = this.db.prepare("SELECT token FROM leases WHERE task_id = ?").get(id);
    const task = this.get(id);
    if (lease?.token !== token || task.run.generation !== token) throw new StaleGeneration({ message: "Stale task generation: operation refused" });
    return task;
  }

  /**
   * Takes ownership as a new generation. A first run is refused while a live
   * supervisor other than `supervisor` owns the home's queued execution.
   */
  acquire(id: string, resume: boolean, supervisor?: string): string {
    return this.transaction(() => {
      const task = this.get(id);
      if (!resume && task.run.state !== "queued") throw new InvalidTransition({ message: `Task is ${task.run.state}; use resume explicitly` });
      if (!activeStates.has(task.run.state) && !transitions[task.run.state].includes("provisioning")) {
        throw new InvalidTransition({ message: `Task is ${task.run.state}; it cannot run again` });
      }
      if (!resume) this.refuseForeignSupervisor(supervisor);
      // Checked under the write lock, so two openers never both take a project's last place.
      const room = this.room(id);
      if (room && room.holders.length >= room.capacity) {
        throw new AtCapacity({
          message: `Project "${room.project}" is at its capacity of ${room.capacity} (running: ${room.holders.join(", ")}); the task is unchanged, and a supervisor starts it once a place frees`,
        });
      }
      const lease = this.db.prepare("SELECT * FROM leases WHERE task_id = ?").get(id);
      if (lease) {
        if (lease.host !== hostname()) throw new OwnerUnknown({ message: "Task belongs to another host; shared homes are unsupported" });
        const owner = ownerOf(lease);
        if (owner === "unknown") throw new OwnerUnknown({ message: "Task owner liveness is unknown" });
        if (owner === "live") throw new LiveOwner({ message: `Task already has a live owner (PID ${lease.pid})` });
        if (!resume) throw new InvalidTransition({ message: "Previous run needs explicit resume" });
        this.db.prepare("DELETE FROM leases WHERE task_id = ?").run(id);
      }
      if (activeStates.has(task.run.state)) {
        this.append(task, "run.interrupted", { reason: "Previous owner exited; explicit recovery requested" });
      }
      this.expireOpen(task);
      const token = randomUUID();
      this.db.prepare("INSERT INTO leases(task_id, token, pid, host, active_at) VALUES (?, ?, ?, ?, ?)").run(id, token, process.pid, hostname(), now());
      this.append(this.advance(task, { generation: token, state: "provisioning", cancelRequested: false, error: null }), "run.started", { resume });
      return token;
    });
  }

  /** Pending decisions and lifecycle requests never outlive the generation they were made for. */
  private expireOpen(task: Task) {
    for (const decision of this.decisions(task.id).filter(d => d.status === "pending")) {
      this.saveDecision({ ...decision, status: "expired" });
      this.append(task, "decision.expired", { id: decision.id });
    }
    for (const control of this.controls(task.id).filter(c => c.status === "requested")) {
      this.saveControl({ ...control, status: "expired", updatedAt: now() });
      this.append(task, "control.expired", { id: control.id });
    }
  }

  release(id: string, token: string) {
    this.transaction(() => {
      const lease = this.db.prepare("SELECT token FROM leases WHERE task_id = ?").get(id);
      if (lease?.token !== token) return;
      const task = this.get(id);
      if (activeStates.has(task.run.state)) {
        this.advance(task, { state: "interrupted" });
        this.append(task, "run.interrupted", { reason: "Execution scope closed" });
      }
      this.expireOpen(task);
      this.db.prepare("DELETE FROM leases WHERE task_id = ? AND token = ?").run(id, token);
    });
  }

  /** Records SDK activity as liveness evidence; it is not history, so no event is appended. */
  touch(id: string, token: string): boolean {
    return this.db.prepare("UPDATE leases SET active_at = ? WHERE task_id = ? AND token = ?").run(now(), id, token).changes > 0;
  }

  /** Ends an attempt and, in the same transaction, applies the lifecycle control that stopped it. */
  stop(id: string, token: string, state: "failed" | "interrupted" | "cancelled", error: string, controlId?: string) {
    return this.transaction(() => {
      const task = this.owned(id, token);
      if (state !== task.run.state && !transitions[task.run.state].includes(state)) throw new InvalidTransition({ message: `Invalid transition ${task.run.state} -> ${state}` });
      const next = this.advance(task, { state, error });
      this.append(next, "run.stopped", { error, state });
      const control = this.controls(id).find(c => c.id === controlId && c.generation === token && c.status === "requested");
      if (control) {
        this.saveControl({ ...control, status: "applied", updatedAt: now() });
        this.append(next, "control.applied", { id: control.id, verb: control.verb });
      }
      return next;
    });
  }

  update(id: string, token: string, changes: TaskChanges, type: string, data: unknown = {}) {
    const refused = Object.keys(changes).filter(key => !(attemptWritable as readonly string[]).includes(key));
    if (refused.length) throw new InvalidInput({ message: `An attempt cannot write task fields: ${refused.join(", ")}` });
    return this.transaction(() => {
      const task = this.owned(id, token);
      if (changes.state && changes.state !== task.run.state && !transitions[task.run.state].includes(changes.state)) {
        throw new InvalidTransition({ message: `Invalid transition ${task.run.state} -> ${changes.state}` });
      }
      if (changes.state === "ready" || changes.state === "local-ready" || changes.state === "completed") {
        if (task.run.cancelRequested) throw new InvalidTransition({ message: "Cancellation was requested before completion" });
        if (this.decisions(id).some(decision => decision.status === "pending")) throw new InvalidTransition({ message: "Unanswered decisions prevent completion" });
        if (this.unacknowledged(id, token).length) throw new InvalidTransition({ message: "Unacknowledged steering prevents completion" });
      }
      const next = this.advance(task, changes);
      this.append(next, type, data);
      return next;
    });
  }

  record(id: string, token: string, type: string, data: unknown) {
    this.transaction(() => this.append(this.owned(id, token), type, data));
  }

  events(id: string, after = 0): TaskEvent[] {
    this.get(id);
    return this.db.prepare("SELECT * FROM events WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT 1000").all(id, after).map(eventOf);
  }

  /** Every projection, decision, steering, and control write appends an event, so the latest sequence marks any change. */
  latest(id: string): TaskChange {
    const sequence = Number(this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE task_id = ?").get(id)?.sequence);
    const task = this.get(id);
    const control = this.controls(id).find(c => c.status === "requested" && c.generation === task.run.generation) ?? null;
    return { sequence, task, control };
  }

  decisions(id?: string): Decision[] {
    const rows = id ? this.db.prepare("SELECT json FROM decisions WHERE task_id = ? ORDER BY rowid").all(id)
      : this.db.prepare("SELECT json FROM decisions ORDER BY rowid").all();
    return rows.map(row => decodeDecision(parse(row)));
  }

  private saveDecision(decision: Decision) {
    this.db.prepare("INSERT INTO decisions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      .run(decision.id, decision.taskId, JSON.stringify(decodeDecision(decision)));
  }

  requestDecision(id: string, token: string, tool: string, input: Record<string, unknown>): Decision {
    return this.transaction(() => {
      const task = this.owned(id, token);
      if (task.run.state !== "running" && task.run.state !== "waiting") throw new InvalidTransition({ message: "Task is not accepting decisions" });
      const decision: Decision = { id: randomUUID(), taskId: id, generation: token, tool, input, status: "pending", answer: "", createdAt: now() };
      this.saveDecision(decision);
      this.advance(task, { state: "waiting" });
      this.append(task, "decision.requested", decision);
      return decision;
    });
  }

  answer(id: string, status: "allow" | "deny", answer: string): Decision {
    return this.transaction(() => {
      const decision = decodeDecision(parse(this.db.prepare("SELECT json FROM decisions WHERE id = ?").get(id)));
      const task = this.owned(decision.taskId, decision.generation);
      if (decision.status !== "pending" || task.run.cancelRequested || task.run.state !== "waiting") throw new InvalidTransition({ message: "Decision is no longer pending" });
      const next = { ...decision, status, answer };
      this.saveDecision(next);
      this.append(task, "decision.answered", { id, status, answer });
      if (!this.decisions(task.id).some(d => d.status === "pending")) this.advance(task, { state: "running" });
      return next;
    });
  }

  steers(id?: string): Steer[] {
    const rows = id ? this.db.prepare("SELECT json FROM steers WHERE task_id = ? ORDER BY sequence").all(id)
      : this.db.prepare("SELECT json FROM steers ORDER BY task_id, sequence").all();
    return rows.map(row => decodeSteer(parse(row)));
  }

  private saveSteer(steer: Steer) {
    this.db.prepare("INSERT INTO steers VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      .run(steer.id, steer.taskId, steer.sequence, JSON.stringify(decodeSteer(steer)));
  }

  private moveSteer(task: Task, steer: Steer, status: SteerStatus, evidence: SteerEvidence, generation = steer.generation) {
    const next = { ...steer, status, generation, updatedAt: now() };
    this.saveSteer(next);
    this.append(task, `steer.${status}`, { id: steer.id, sequence: steer.sequence, evidence });
    return next;
  }

  /** Durably enqueues steering text; delivery is a separate, evidence-backed step. */
  steer(id: string, text: string): Steer {
    if (!text.trim()) throw new InvalidInput({ message: "Steering message must not be empty" });
    if (text.length > 100_000) throw new InvalidInput({ message: "Steering message exceeds 100000 characters" });
    return this.transaction(() => {
      const task = this.get(id);
      // Sequences are never reused because steering records are never deleted.
      const sequence = Number(this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM steers WHERE task_id = ?").get(id)?.next);
      const timestamp = now();
      const steer: Steer = { id: randomUUID(), taskId: id, sequence, text, status: "pending", generation: null, createdAt: timestamp, updatedAt: timestamp };
      this.saveSteer(steer);
      this.append(task, "steer.enqueued", { id: steer.id, sequence });
      return steer;
    });
  }

  /** Moves pending steers, in sequence order, into this generation's input stream. */
  claimSteers(id: string, token: string): Steer[] {
    return this.transaction(() => {
      const task = this.owned(id, token);
      return this.steers(id).filter(s => s.status === "pending")
        .map(s => this.moveSteer(task, s, "submitted", { via: "input-stream" }, token));
    });
  }

  /** Records the CLI's echo of a streamed message; unknown UUIDs are ignored. */
  markSteerDelivered(id: string, token: string, steerId: string): boolean {
    return this.transaction(() => {
      const task = this.owned(id, token);
      const steer = this.steers(id).find(s => s.id === steerId);
      if (!steer || steer.generation !== token || steer.status !== "submitted") return false;
      this.moveSteer(task, steer, "delivered", { via: "cli-replay" });
      return true;
    });
  }

  /**
   * A reply stamped with a steer's UUID proves that steer reached the model.
   * Steers share one priority, so the CLI consumes them in order and earlier
   * unconfirmed steers of the same generation were consumed too.
   */
  acknowledgeThrough(id: string, token: string, steerId: string): Steer[] {
    return this.transaction(() => {
      const task = this.owned(id, token);
      const steers = this.steers(id);
      const stamped = steers.find(s => s.id === steerId);
      if (!stamped || stamped.generation !== token || !awaitingProof(stamped)) return [];
      return steers.filter(s => s.generation === token && s.sequence <= stamped.sequence && awaitingProof(s))
        .map(s => this.moveSteer(task, s, "acknowledged", s.id === steerId ? { via: "reply-stamp" } : { via: "later-reply-stamp", stamp: steerId }));
    });
  }

  /** Acknowledges transcript-delivered steers that an answered resume prompt named. */
  acknowledgeNamed(id: string, token: string, steerIds: readonly string[], promptId: string): Steer[] {
    return this.transaction(() => {
      const task = this.owned(id, token);
      return this.steers(id).filter(s => steerIds.includes(s.id) && s.status === "delivered")
        .map(s => this.moveSteer(task, s, "acknowledged", { via: "resume-prompt-stamp", prompt: promptId }));
    });
  }

  /** Steers this generation submitted that no evidence has acknowledged yet. */
  unacknowledged(id: string, token: string): Steer[] {
    return this.steers(id).filter(s => s.generation === token && awaitingProof(s));
  }

  /** Steers an earlier generation submitted that no evidence has acknowledged yet. */
  unconfirmed(id: string, token: string): Steer[] {
    return this.steers(id).filter(s => s.generation !== token && awaitingProof(s));
  }

  /**
   * Closes the input stream only when nothing is pending or unacknowledged.
   * A steer enqueued afterwards stays pending for the next explicit run.
   */
  closeInput(id: string, token: string): boolean {
    return this.transaction(() => {
      const task = this.owned(id, token);
      if (this.steers(id).some(s => s.status === "pending") || this.unacknowledged(id, token).length) return false;
      this.append(task, "input.closed", {});
      return true;
    });
  }

  /** Reconciles a steer an earlier generation left unconfirmed, using transcript evidence. */
  reconcileSteer(id: string, token: string, steerId: string, status: "delivered" | "pending" | "uncertain", evidence: SteerEvidence): Steer {
    return this.transaction(() => {
      const task = this.owned(id, token);
      const steer = this.steers(id).find(s => s.id === steerId);
      if (!steer || steer.generation === token || !awaitingProof(steer)) throw new InvalidTransition({ message: "Steer is not awaiting reconciliation" });
      return this.moveSteer(task, steer, status, evidence, status === "pending" ? null : steer.generation);
    });
  }

  /** Explicitly accepts a possible duplicate and resends an uncertain steer. */
  requeueSteer(steerId: string): Steer {
    return this.transaction(() => {
      const steer = decodeSteer(parse(this.db.prepare("SELECT json FROM steers WHERE id = ?").get(steerId)));
      if (steer.status !== "uncertain") throw new InvalidTransition({ message: `Only uncertain steers can be requeued; this one is ${steer.status}` });
      return this.moveSteer(this.get(steer.taskId), steer, "pending", { via: "explicit-requeue" }, null);
    });
  }

  cancel(id: string) {
    return this.transaction(() => {
      const task = this.get(id);
      const idle = task.run.state === "queued" || task.run.state === "interrupted";
      if (!activeStates.has(task.run.state) && !idle) throw new InvalidTransition({ message: `Cannot cancel a ${task.run.state} task` });
      const next = this.advance(task, { cancelRequested: true, state: idle ? "cancelled" : task.run.state });
      this.append(next, "cancel.requested", {});
      return next;
    });
  }

  /** A ship whose delivery mode was chosen at intake; earlier ships have none and cannot be delivered. */
  private delivered(id: string): Task {
    const task = this.get(id);
    if (task.intake.kind !== "ship" || !task.policy.delivery) throw new InvalidTransition({ message: "Only a ship with a delivery mode recorded at intake has a merge" });
    return task;
  }

  /** The approvals and flags merge authority weighs, oldest first. */
  mergeRecords(id: string): { approvals: Sequenced<MergeApproval>[]; flags: Sequenced<{ reason: string }>[] } {
    this.delivered(id);
    const events = this.db.prepare("SELECT * FROM events WHERE task_id = ? AND type IN ('merge.approved', 'merge.flagged') ORDER BY sequence").all(id).map(eventOf);
    return {
      approvals: events.filter(e => e.type === "merge.approved").map(e => ({ ...e.data as MergeApproval, sequence: e.sequence })),
      flags: events.filter(e => e.type === "merge.flagged").map(e => ({ ...e.data as { reason: string }, sequence: e.sequence })),
    };
  }

  /** The forge merges recorded for the task's PRs, oldest first. */
  merges(id: string): PullRequestMerged[] {
    return this.db.prepare("SELECT * FROM events WHERE task_id = ? AND type = 'pr.merged' ORDER BY sequence").all(id).map(row => eventOf(row).data as PullRequestMerged);
  }

  /**
   * Records the captain's approval to merge the task's ready commit (for a
   * PR, the head it was published at), which `commit`, when given, must name.
   * A later ready commit needs a new approval.
   */
  approve(id: string, request: { commit?: string; waivers: readonly string[]; note: string }): Sequenced<MergeApproval> {
    const waivers = [...new Set(request.waivers.map(w => w.trim()))];
    if (waivers.some(w => !w)) throw new InvalidInput({ message: "A waiver must name a check" });
    return this.transaction(() => {
      const task = this.delivered(id);
      const head = task.run.commit;
      if ((task.run.state !== "local-ready" && task.run.state !== "pr-open") || !head) {
        throw new InvalidTransition({ message: `Task is ${task.run.state}; approval names a ready commit, so it waits for local-ready or pr-open` });
      }
      const named = request.commit?.toLowerCase();
      if (named !== undefined && (named.length < 7 || !head.startsWith(named))) {
        throw new InvalidInput({ message: `The approval names ${request.commit}, but the ready commit is ${head}` });
      }
      const approval = { commit: head, waivers, note: request.note };
      return { ...approval, sequence: this.append(task, "merge.approved", approval) };
    });
  }

  /** Marks the task's merge destructive, irreversible, or security-sensitive; only a later approval authorizes it. */
  flag(id: string, reason: string): Sequenced<{ reason: string }> {
    if (!reason.trim()) throw new InvalidInput({ message: "A flag needs a reason" });
    return this.transaction(() => {
      const task = this.delivered(id);
      if (task.run.state === "landed") throw new InvalidTransition({ message: "Task has already landed" });
      return { reason, sequence: this.append(task, "merge.flagged", { reason }) };
    });
  }

  /**
   * Takes the task's lease for delivering `commit` (publishing or landing it),
   * so no attempt can move its branch meanwhile. Refused unless the task is a
   * ship still in `state` at that commit with no live or unknown owner.
   */
  beginDelivery(id: string, state: DeliveryState, commit: string): string {
    return this.transaction(() => {
      const task = this.delivered(id);
      if (task.run.state !== state || task.run.commit !== commit) throw new InvalidTransition({ message: `Task is ${task.run.state}, not ${state} at ${commit}` });
      return this.lease(id);
    });
  }

  /** Replaces a dead owner's lease with this process's; a live or unknown owner refuses. Runs inside the caller's transaction. */
  private lease(id: string): string {
    const lease = this.db.prepare("SELECT * FROM leases WHERE task_id = ?").get(id);
    const owner = ownerOf(lease);
    if (owner === "live") throw new LiveOwner({ message: `Task already has a live owner (PID ${lease?.pid})` });
    if (owner === "unknown") throw new OwnerUnknown({ message: "Task owner liveness is unknown" });
    if (lease) this.db.prepare("DELETE FROM leases WHERE task_id = ?").run(id);
    const token = randomUUID();
    this.db.prepare("INSERT INTO leases(task_id, token, pid, host, active_at) VALUES (?, ?, ?, ?, ?)").run(id, token, process.pid, hostname(), now());
    return token;
  }

  /** The delivery fence: the task, only while the delivery that took `token` still holds its lease. */
  private delivering(id: string, token: string): Task {
    if (this.db.prepare("SELECT token FROM leases WHERE task_id = ?").get(id)?.token !== token) throw new StaleGeneration({ message: "The delivery lost its lease: operation refused" });
    return this.get(id);
  }

  /** Appends a delivery event, such as a forge merge or a failed publish, while the delivery holds its lease. */
  recordDelivery<T extends "pr.failed" | "pr.merged">(id: string, token: string, type: T, data: EventDataOf<T>): number {
    return this.transaction(() => this.append(this.delivering(id, token), type, data));
  }

  /** Records the PR a ready direct-PR ship was published as, from the forge's response, and moves it to pr-open. */
  publish(id: string, token: string, pr: PullRequestRef, type: "pr.opened" | "pr.updated"): Task {
    return this.transaction(() => {
      const task = this.delivering(id, token);
      if (task.run.state !== "ready" || task.run.commit !== pr.head) throw new InvalidTransition({ message: `Task is ${task.run.state} at ${task.run.commit}, but the PR head is ${pr.head}` });
      const next = this.advance(task, { state: "pr-open", pr });
      this.append(next, type, pr);
      return next;
    });
  }

  /** Records the landing proof and moves the task to landed, only while the landing still holds its lease. */
  finishLanding(id: string, token: string, proof: LandingProof): Task {
    return this.transaction(() => {
      const task = this.delivering(id, token);
      const from = "via" in proof ? "pr-open" : "local-ready";
      if (task.run.state !== from || task.run.commit !== proof.commit) throw new InvalidTransition({ message: `Task is ${task.run.state}, not ${from} at ${proof.commit}` });
      const next = this.advance(task, { state: "landed" });
      this.append(next, "task.landed", proof);
      const item = this.itemOf(id);
      if (item) {
        this.finishItem(item, { basis: "landed", taskId: id, at: now(),
          detail: "via" in proof ? `Task ${id} merged ${proof.url} into ${proof.target} as ${proof.mergeCommit}` : `Task ${id} landed ${proof.commit} on local ${proof.target}` });
      }
      return next;
    });
  }

  /** The proof the task landed on, or null before it landed. */
  landing(id: string): LandingProof | null {
    const row = this.db.prepare("SELECT * FROM events WHERE task_id = ? AND type = 'task.landed' ORDER BY sequence DESC LIMIT 1").get(id);
    return row ? eventOf(row).data as LandingProof : null;
  }

  /** Records a landed ship's clone refresh or its refusal. */
  recordRefresh<T extends "clone.refreshed" | "clone.refused">(id: string, type: T, data: EventDataOf<T>): number {
    return this.transaction(() => {
      const task = this.get(id);
      if (task.run.state !== "landed") throw new InvalidTransition({ message: `Task is ${task.run.state}; only a landed task refreshes its project clone` });
      return this.append(task, type, data);
    });
  }

  /**
   * Records the captain's word that cleanup may discard the task's unlanded
   * work at branch head `head`. Landed work needs none, and a running or
   * validating task cannot be cleaned up at all.
   */
  authorizeDiscard(id: string, reason: string, head: string | null): Sequenced<DiscardAuthorization> {
    if (!reason.trim()) throw new InvalidInput({ message: "A discard authorization needs a reason" });
    return this.transaction(() => {
      const task = this.get(id);
      if (task.run.state === "landed") throw new InvalidTransition({ message: "Task has landed; cleanup needs no discard authorization" });
      if (task.run.state === "cleaned") throw new InvalidTransition({ message: "Task is already cleaned up" });
      if (!transitions[task.run.state].includes("cleaned")) throw new InvalidTransition({ message: `Task is ${task.run.state}; its work cannot be discarded until it stops` });
      const authorization = { reason, head };
      return { ...authorization, sequence: this.append(task, "discard.authorized", authorization) };
    });
  }

  /** The discard authorization cleanup may rely on: the latest one recorded since the task's last attempt started, if any. */
  discardAuthorization(id: string): Sequenced<DiscardAuthorization> | null {
    const started = Number(this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE task_id = ? AND type = 'run.started'").get(id)?.sequence);
    const row = this.db.prepare("SELECT * FROM events WHERE task_id = ? AND type = 'discard.authorized' AND sequence > ? ORDER BY sequence DESC LIMIT 1").get(id, started);
    if (!row) return null;
    const event = eventOf(row);
    return { ...event.data as DiscardAuthorization, sequence: event.sequence };
  }

  /** Records why cleanup refused, so a refusal is never only a message on a terminal. */
  refuseCleanup(id: string, reason: string): number {
    return this.transaction(() => this.append(this.get(id), "cleanup.refused", { reason }));
  }

  /**
   * Takes the task's lease for cleaning it up, so no attempt or delivery can
   * start meanwhile. Refused unless the task's state may become cleaned and it
   * has no live or unknown owner.
   */
  beginCleanup(id: string): string {
    return this.transaction(() => {
      const task = this.get(id);
      if (task.run.state === "cleaned") throw new InvalidTransition({ message: "Task is already cleaned up" });
      if (!transitions[task.run.state].includes("cleaned")) throw new InvalidTransition({ message: `Task is ${task.run.state}; it cannot be cleaned up` });
      return this.lease(id);
    });
  }

  /** Records what cleanup removed and moves the task to cleaned, only while the cleanup still holds its lease. */
  finishCleanup(id: string, token: string, cleaned: Cleaned): Task {
    return this.transaction(() => {
      const task = this.delivering(id, token);
      if (!transitions[task.run.state].includes("cleaned")) throw new InvalidTransition({ message: `Invalid transition ${task.run.state} -> cleaned` });
      const next = this.advance(task, { state: "cleaned" });
      this.append(next, "task.cleaned", cleaned);
      const item = this.itemOf(id);
      if (item) {
        const basis = cleaned.basis === "discard" ? "discarded" : cleaned.basis;
        this.finishItem(item, { basis, taskId: id, at: now(), detail: `Task ${id} was cleaned up (${basis === "discarded" ? "discarded under the captain's authorization" : basis})` });
      }
      return next;
    });
  }

  validations(id: string): Validation[] {
    return this.db.prepare("SELECT json FROM validations WHERE task_id = ? ORDER BY rowid").all(id).map(row => decodeValidation(parse(row)));
  }

  private saveValidation(validation: Validation) {
    this.db.prepare("INSERT INTO validations VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      .run(validation.id, validation.taskId, JSON.stringify(decodeValidation(validation)));
  }

  /** A validation of the task that the validation holding `token` may still change. */
  private runningValidation(id: string, token: string, validationId: string): { task: Task; validation: Validation } {
    const task = this.delivering(id, token);
    const validation = this.validations(id).find(v => v.id === validationId);
    if (!validation || validation.status !== "running" || task.run.state !== "validating") throw new InvalidTransition({ message: "The validation is no longer running" });
    return { task, validation };
  }

  /** Hands a ready no-mistakes ship's commit to the pipeline: a new validation record, and the task moves to validating. */
  startValidation(id: string, token: string): Validation {
    return this.transaction(() => {
      const task = this.delivering(id, token);
      const commit = task.run.commit;
      if (task.policy.delivery !== "no-mistakes" || task.run.state !== "ready" || !commit) throw new InvalidTransition({ message: `Task is ${task.run.state}; only a ready no-mistakes ship is validated` });
      const timestamp = now();
      const validation: Validation = { id: randomUUID(), taskId: id, commit, runId: null, status: "running", outcome: null, error: null, createdAt: timestamp, updatedAt: timestamp };
      this.saveValidation(validation);
      this.append(this.advance(task, { state: "validating" }), "validation.started", { id: validation.id, commit });
      return validation;
    });
  }

  /** Records the pipeline run a validation follows, whenever the pipeline reports a different one. */
  validationRun(id: string, token: string, validationId: string, runId: string): Validation {
    return this.transaction(() => {
      const { task, validation } = this.runningValidation(id, token, validationId);
      if (validation.runId === runId) return validation;
      const next = { ...validation, runId, updatedAt: now() };
      this.saveValidation(next);
      this.append(task, "validation.run", { id: validationId, runId });
      return next;
    });
  }

  /** The responses recorded for one step of one pipeline run, oldest first. */
  responses(id: string, validationId: string, runId: string, step: string): EventDataOf<"validation.responded">[] {
    return this.db.prepare("SELECT * FROM events WHERE task_id = ? AND type = 'validation.responded' ORDER BY sequence").all(id)
      .map(row => eventOf(row).data as EventDataOf<"validation.responded">)
      .filter(r => r.id === validationId && r.runId === runId && r.step === step);
  }

  /** Records a gate the pipeline raised, once per occurrence. */
  recordGate(id: string, token: string, validationId: string, gate: PipelineGate) {
    this.transaction(() => {
      const { task } = this.runningValidation(id, token, validationId);
      const recorded = this.db.prepare("SELECT * FROM events WHERE task_id = ? AND type = 'validation.gate' ORDER BY sequence").all(id)
        .map(row => eventOf(row).data as EventDataOf<"validation.gate">)
        .some(e => e.id === validationId && sameGate(e.gate, gate));
      if (!recorded) this.append(task, "validation.gate", { id: validationId, gate });
    });
  }

  /** Records a gate response before it is sent; a captain response names the answered hold it carries out. */
  respondGate(id: string, token: string, response: EventDataOf<"validation.responded">) {
    this.transaction(() => {
      const { task } = this.runningValidation(id, token, response.id);
      if (this.responses(id, response.id, response.runId, response.step).some(r => r.occurrence === response.occurrence)) {
        throw new InvalidTransition({ message: `Gate ${response.step} #${response.occurrence} already has a response` });
      }
      if (response.hold && this.holds(id).find(h => h.id === response.hold)?.status !== "answered") throw new InvalidTransition({ message: "Only an answered hold can be carried out" });
      this.append(task, "validation.responded", response);
    });
  }

  /** Holds, oldest first: all of them, or those of the task whose pipeline gate they hold. */
  holds(taskId?: string): Hold[] {
    const rows = taskId ? this.db.prepare("SELECT json FROM holds WHERE task_id = ? ORDER BY rowid").all(taskId)
      : this.db.prepare("SELECT json FROM holds ORDER BY rowid").all();
    return rows.map(row => decodeHold(parse(row)));
  }

  /** Every hold an item has had, oldest first. */
  itemHolds(itemId: string): Hold[] {
    return this.db.prepare("SELECT json FROM holds WHERE item_id = ? ORDER BY rowid").all(itemId).map(row => decodeHold(parse(row)));
  }

  private saveHold(hold: Hold) {
    this.db.prepare("INSERT INTO holds VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json")
      .run(hold.id, hold.itemId, hold.taskId, hold.status, JSON.stringify(decodeHold(hold)));
  }

  /**
   * Opens a hold on a gate that needs the captain's judgment; a gate already
   * held returns its hold. It holds the work item the task was dispatched
   * from, unless that item is already held or done, and otherwise a new
   * captain item that carries the question.
   */
  openHold(id: string, token: string, validationId: string, gate: PipelineGate, question: string): Hold {
    return this.transaction(() => {
      const { task } = this.runningValidation(id, token, validationId);
      const held = this.holds(id).find(h => h.subject?.validation === validationId && sameGate(h.subject.gate, gate));
      if (held) return held;
      const timestamp = now();
      const holdId = randomUUID();
      const work = this.itemOf(id);
      const item = work && work.status === "in-flight" ? work
        : this.insertItem({ id: `gate-${holdId.slice(0, 12)}`, title: `Validation gate ${gate.step} of task ${id}`, kind: "captain" });
      const hold: Hold = {
        id: holdId, itemId: item.id, taskId: id, status: "open", question, until: null, origin: null,
        subject: { kind: "validation-gate", validation: validationId, gate }, answer: null, createdAt: timestamp, updatedAt: timestamp,
      };
      this.placeHold(item, hold);
      this.append(task, "hold.opened", { id: hold.id, question, validation: validationId, gate });
      return hold;
    });
  }

  /** Records a new open hold on an item and moves the item to held. */
  private placeHold(item: Item, hold: Hold) {
    this.saveHold(hold);
    this.saveItem({ ...item, status: "held", hold: hold.id });
    this.appendItem(item.id, "item.held", { hold: hold.id, reason: hold.question, until: hold.until, origin: hold.origin, from: item.status });
  }

  /**
   * Holds a backlog item for the captain, or, without `itemId`, creates a
   * captain item titled `title` and holds it. Holding an item that is already
   * held re-holds it under the new reason and deferral, as when the captain
   * says "later"; a done item is never reopened.
   */
  holdItem(itemId: string | null, request: { reason: string; until?: string | null; origin?: string | null; title?: string; project?: string | null }): { item: Item; hold: Hold } {
    if (!request.reason.trim()) throw new InvalidInput({ message: "A hold needs a reason: the question and its options" });
    const until = request.until == null ? null : checkedDate(request.until, "--until");
    return this.transaction(() => {
      const origin = request.origin ?? null;
      if (origin !== null) this.get(origin);
      let item: Item;
      if (itemId === null) {
        if (!request.title?.trim()) throw new InvalidInput({ message: "Name the item to hold, or give --title to create a captain item for the call" });
        item = this.insertItem({ title: request.title, kind: "captain", project: request.project ?? null });
      } else item = this.item(itemId);
      if (item.status === "done") throw new InvalidTransition({ message: `Backlog item "${item.id}" is done; a closed item is never reopened, so hold a new item for the call` });
      const timestamp = now();
      const open = item.hold ? this.itemHolds(item.id).find(h => h.id === item.hold && h.status === "open") : undefined;
      if (open && item.status === "held") {
        const hold = { ...open, question: request.reason, until, origin: origin ?? open.origin, updatedAt: timestamp };
        this.saveHold(hold);
        this.saveItem(item);
        this.appendItem(item.id, "item.held", { hold: hold.id, reason: hold.question, until, origin: hold.origin, from: item.status });
        return { item: this.item(item.id), hold };
      }
      const hold: Hold = { id: randomUUID(), itemId: item.id, taskId: null, status: "open", question: request.reason, until, origin, subject: null, answer: null, createdAt: timestamp, updatedAt: timestamp };
      this.placeHold(item, hold);
      return { item: this.item(item.id), hold };
    });
  }

  /**
   * The captain's answer, the only way a hold closes; the text is stored
   * exactly as given. A captain item closes. A work item whose task has not
   * finished resumes in flight; any other work item closes, or with
   * `release` returns to the queue to be dispatched again. A pipeline gate's
   * answer also names how the host carries it out.
   */
  answerItem(itemId: string, request: AnswerRequest): { item: Item; hold: Hold } {
    if (!request.text.trim()) throw new InvalidInput({ message: "A hold is answered in the captain's own words; the answer must not be empty" });
    return this.transaction(() => {
      const item = this.item(itemId);
      // The open hold is what the captain owes an answer to, even when the item's records disagree with it.
      const holds = this.itemHolds(item.id);
      const hold = holds.find(h => h.id === item.hold && h.status === "open") ?? holds.findLast(h => h.status === "open");
      if (!hold) {
        throw new InvalidTransition({ message: `Backlog item "${item.id}" has no open hold, so there is nothing to answer${item.status === "held" ? "; its records disagree, see firstmate backlog diverged" : ""}` });
      }
      const findings = request.findings ?? [];
      if (hold.subject) {
        if (!request.action) throw new InvalidInput({ message: "A pipeline gate's answer names its action: approve, fix, or skip" });
        const known = hold.subject.gate.findings.map(f => f.id);
        const unknown = findings.filter(f => !known.includes(f));
        if (unknown.length) throw new InvalidInput({ message: `The gate has no finding ${unknown.join(", ")}; its findings are ${known.join(", ") || "none"}` });
        if (request.action !== "fix" && findings.length) throw new InvalidInput({ message: "Only a fix names findings" });
      } else if (request.action || findings.length) throw new InvalidInput({ message: "Only a pipeline gate's answer names an action or findings" });
      if (item.kind === "captain" && request.release) throw new InvalidInput({ message: `Backlog item "${item.id}" is a captain item, a question; its answer closes it, so it cannot be released` });
      const timestamp = now();
      const unfinished = item.kind !== "captain" && item.taskId !== null && item.outcome === null;
      const close = unfinished || request.release ? "released" as const : "closed" as const;
      const answer = { text: request.text, ...(request.action ? { action: request.action, findings: [...findings] } : {}), answeredAt: timestamp, close };
      const answered: Hold = { ...hold, status: "answered", answer, updatedAt: timestamp };
      this.saveHold(answered);
      const status = close === "closed" ? "done" as const : unfinished ? "in-flight" as const : "queued" as const;
      this.appendItem(item.id, "item.answered", { hold: hold.id, text: request.text, close, status });
      const released = { ...item, hold: null };
      const next = status === "done"
        ? this.closeItem(released, item.outcome ?? { basis: "answered", taskId: null, detail: "Closed by the captain's answer", at: timestamp })
        : this.saveItem(status === "in-flight" ? { ...released, status } : { ...released, status, taskId: null, outcome: null });
      if (hold.subject && hold.taskId && request.action) {
        this.append(this.get(hold.taskId), "hold.answered", { id: hold.id, action: request.action, text: request.text, findings: [...findings] });
      }
      return { item: next, hold: answered };
    });
  }

  /** Answers a hold by its own id; see `answerItem`. */
  answerHold(holdId: string, request: AnswerRequest): Hold {
    const hold = decodeHold(parse(this.db.prepare("SELECT json FROM holds WHERE id = ?").get(holdId)));
    if (hold.status !== "open") throw new InvalidTransition({ message: "The hold is already answered" });
    return this.answerItem(hold.itemId, request).hold;
  }

  // ---- backlog ----

  /** The live backlog, oldest first. */
  items(): Item[] {
    return this.db.prepare("SELECT json FROM items ORDER BY rowid").all().map(row => decodeItem(parse(row)));
  }

  /** Done items moved out of the live backlog by retention, oldest archived first. */
  archivedItems(): Item[] {
    return this.db.prepare("SELECT json FROM archived_items ORDER BY rowid").all().map(row => decodeItem(parse(row)));
  }

  item(id: string): Item {
    const row = this.db.prepare("SELECT json FROM items WHERE id = ?").get(id);
    if (row) return decodeItem(parse(row));
    const handoff = this.handoffOf(id);
    throw new NotFound({ message: this.db.prepare("SELECT 1 FROM archived_items WHERE id = ?").get(id) ? `Backlog item "${id}" is done and archived`
      : handoff ? `Backlog item "${id}" was handed off to secondmate ${handoff.secondmate} (handoff ${handoff.id}, ${handoff.phase === "prepared" ? "in transit" : "placed"}); see firstmate secondmate handoffs`
      : `No backlog item "${id}"` });
  }

  /** A live or archived item, or null. */
  private anyItem(id: string): Item | null {
    const row = this.db.prepare("SELECT json FROM items WHERE id = ?").get(id) ?? this.db.prepare("SELECT json FROM archived_items WHERE id = ?").get(id);
    return row ? decodeItem(parse(row)) : null;
  }

  /** The work item a task was dispatched from, or null. */
  itemOf(taskId: string): Item | null {
    const row = this.db.prepare("SELECT json FROM items WHERE task_id = ?").get(taskId);
    return row ? decodeItem(parse(row)) : null;
  }

  itemEvents(id: string): ItemEvent[] {
    return this.db.prepare("SELECT * FROM item_events WHERE item_id = ? ORDER BY sequence").all(id).map(r => ({
      sequence: Number(r.sequence), itemId: String(r.item_id), type: String(r.type), data: JSON.parse(String(r.data)), createdAt: String(r.created_at),
    }));
  }

  private saveItem(item: Item): Item {
    const next = decodeItem({ ...item, updatedAt: now() });
    this.db.prepare("INSERT INTO items VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, task_id = excluded.task_id, json = excluded.json")
      .run(next.id, next.status, next.taskId, JSON.stringify(next));
    return next;
  }

  private appendItem(id: string, type: ItemEventType, data: unknown): number {
    const checked = Schema.decodeUnknownSync(ItemEventData[type] as Schema.Codec<unknown>)(data);
    return Number(this.db.prepare("INSERT INTO item_events(item_id, type, data, created_at) VALUES (?, ?, ?, ?)")
      .run(id, type, JSON.stringify(checked), now()).lastInsertRowid);
  }

  /** A fresh item id from the title, never one an item has had before. */
  private freshItemId(title: string): string {
    const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "item";
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`;
      if (!this.idUsed(id)) return id;
    }
  }

  private idUsed(id: string): boolean {
    return Boolean(this.anyItem(id) ?? this.db.prepare("SELECT 1 FROM item_events WHERE item_id = ? LIMIT 1").get(id));
  }

  /** Validates and records a new queued item; runs inside the caller's transaction. */
  private insertItem(input: NewItem): Item {
    if (!input.title.trim()) throw new InvalidInput({ message: "A backlog item needs a title" });
    if (input.id !== undefined) {
      if (!itemIdPattern.test(input.id)) throw new InvalidInput({ message: "An item id is 1-64 letters, digits, dots, underscores, or dashes, starting with a letter or digit" });
      if (this.idUsed(input.id)) throw new InvalidInput({ message: `Backlog item id "${input.id}" is already used` });
    }
    const id = input.id ?? this.freshItemId(input.title);
    const dependsOn = this.checkedDependencies(id, input.dependsOn ?? []);
    const timestamp = now();
    const item = this.saveItem({
      id, title: input.title, kind: input.kind, project: input.project ?? null, prompt: input.prompt ?? null, status: "queued", dependsOn,
      deferUntil: input.deferUntil == null ? null : checkedDate(input.deferUntil, "--defer"),
      notes: input.note?.trim() ? [{ at: timestamp, by: "captain", text: input.note }] : [],
      taskId: null, hold: null, outcome: null, doneAt: null, createdAt: timestamp, updatedAt: timestamp,
    });
    this.appendItem(id, "item.added", item);
    return item;
  }

  addItem(input: NewItem): Item {
    return this.transaction(() => this.insertItem(input));
  }

  /** Dependencies that exist and make no cycle through the live backlog. */
  private checkedDependencies(id: string, dependsOn: readonly string[]): string[] {
    const unique = [...new Set(dependsOn.map(d => d.trim()).filter(Boolean))];
    for (const dep of unique) {
      if (dep === id) throw new InvalidInput({ message: "An item cannot depend on itself" });
      if (!this.anyItem(dep)) throw new InvalidInput({ message: `No backlog item "${dep}" to depend on` });
    }
    const reaches = (from: string, seen: Set<string>): boolean => {
      if (from === id) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (this.anyItem(from)?.dependsOn ?? []).some(next => reaches(next, seen));
    };
    const cycle = unique.find(dep => reaches(dep, new Set()));
    if (cycle) throw new InvalidInput({ message: `Depending on "${cycle}" would make a cycle, since it already waits for "${id}"` });
    return unique;
  }

  /**
   * Changes an item's description, dependencies, deferral, or notes; status
   * only ever changes through dispatch, holds, answers, and completion. What
   * its task was created from cannot change once dispatched.
   */
  updateItem(id: string, change: ItemChange): Item {
    return this.transaction(() => {
      const item = this.item(id);
      if (item.status === "done") throw new InvalidTransition({ message: `Backlog item "${id}" is done; add a new item instead` });
      const dispatched = item.taskId !== null && (change.kind !== undefined || change.project !== undefined || change.prompt !== undefined);
      if (dispatched) throw new InvalidTransition({ message: `Backlog item "${id}" was dispatched as task ${item.taskId}; its kind, project, and prompt are fixed` });
      if (change.title !== undefined && !change.title.trim()) throw new InvalidInput({ message: "A backlog item needs a title" });
      if (change.kind !== undefined && (change.kind === "captain") !== (item.kind === "captain")) throw new InvalidInput({ message: "A captain item stays a captain item, and a work item a work item" });
      const timestamp = now();
      const next = this.saveItem({
        ...item,
        ...(change.title !== undefined ? { title: change.title } : {}),
        ...(change.kind !== undefined ? { kind: change.kind } : {}),
        ...(change.project !== undefined ? { project: change.project } : {}),
        ...(change.prompt !== undefined ? { prompt: change.prompt } : {}),
        ...(change.dependsOn !== undefined ? { dependsOn: this.checkedDependencies(id, change.dependsOn) } : {}),
        ...(change.deferUntil !== undefined ? { deferUntil: change.deferUntil === null ? null : checkedDate(change.deferUntil, "--defer") } : {}),
        ...(change.note?.trim() ? { notes: [...item.notes, { at: timestamp, by: "captain" as const, text: change.note }] } : {}),
      });
      this.appendItem(id, "item.updated", next);
      return next;
    });
  }

  /**
   * Removes an item from the backlog; its history stays. Refused while it is
   * in flight, held for the captain, or something not done depends on it.
   */
  removeItem(id: string): { id: string; sequence: number } {
    return this.transaction(() => {
      const item = this.item(id);
      if (item.status === "in-flight") throw new InvalidTransition({ message: `Backlog item "${id}" is in flight as task ${item.taskId}; it closes when that task lands or is cleaned up` });
      if (item.status === "held") throw new InvalidTransition({ message: `Backlog item "${id}" is held for the captain; only the captain's answer closes it` });
      const dependents = this.items().filter(i => i.status !== "done" && i.dependsOn.includes(id));
      if (dependents.length) throw new InvalidTransition({ message: `Backlog item "${id}" is a dependency of ${dependents.map(i => i.id).join(", ")}; update them first` });
      this.db.prepare("DELETE FROM items WHERE id = ?").run(id);
      return { id, sequence: this.appendItem(id, "item.removed", { id }) };
    });
  }

  /** Why an item cannot dispatch now; empty when it can. */
  waiting(item: Item, at = Date.now()): string[] {
    if (item.kind === "captain") return ["a captain item is a question and never dispatches"];
    if (item.status !== "queued") return [`it is ${item.status}`];
    return [
      ...item.dependsOn.flatMap(dep => {
        const status = this.anyItem(dep)?.status ?? "missing";
        return status === "done" ? [] : [`it waits for ${dep} (${status})`];
      }),
      ...(item.deferUntil !== null && Date.parse(item.deferUntil) > at ? [`it is deferred until ${item.deferUntil}`] : []),
    ];
  }

  /** The item, refused unless it can dispatch now; dispatch checks before intake and again as it commits. */
  checkDispatch(id: string): Item {
    const item = this.item(id);
    const waiting = this.waiting(item);
    if (waiting.length) throw new InvalidTransition({ message: `Backlog item "${id}" cannot dispatch: ${waiting.join("; ")}` });
    return item;
  }

  /**
   * Records a proven outcome of an item's task. The item closes, unless it
   * is held for the captain: then it keeps the outcome and stays held, so it
   * still reads as the captain's own call. Runs inside the caller's transaction.
   */
  private finishItem(item: Item, outcome: ItemOutcome) {
    if (item.status === "done" || (item.status === "held" && item.outcome)) return;
    if (item.status === "held") {
      this.saveItem({ ...item, outcome, notes: [...item.notes, hostNote(`${outcome.detail}; the item stays held until the captain answers`)] });
      this.appendItem(item.id, "item.finished", outcome);
      return;
    }
    this.closeItem(item, outcome);
  }

  private closeItem(item: Item, outcome: ItemOutcome): Item {
    const next = this.saveItem({ ...item, status: "done", hold: null, outcome, doneAt: outcome.at, notes: [...item.notes, hostNote(outcome.detail)] });
    this.appendItem(item.id, "item.done", outcome);
    this.prune();
    return next;
  }

  /** Archives done items beyond the configured number of recent ones. */
  private prune() {
    const { doneKeep } = this.backlogSettings();
    const done = this.items().filter(i => i.status === "done").sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
    for (const item of done.slice(doneKeep)) {
      this.db.prepare("INSERT INTO archived_items VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(item.id, JSON.stringify(item));
      this.db.prepare("DELETE FROM items WHERE id = ?").run(item.id);
      this.appendItem(item.id, "item.archived", { doneAt: item.doneAt ?? "" });
    }
  }

  backlogSettings(): BacklogSettings {
    const row = this.db.prepare("SELECT json FROM settings WHERE name = 'backlog'").get();
    return row ? Schema.decodeUnknownSync(BacklogSettings)(parse(row)) : { doneKeep: defaultDoneKeep };
  }

  /** Changes how many done items stay in the live backlog, archiving any beyond it now. */
  setBacklogSettings(settings: BacklogSettings): BacklogSettings {
    if (!Number.isSafeInteger(settings.doneKeep) || settings.doneKeep < 0) throw new InvalidInput({ message: "--done-keep must be a nonnegative integer" });
    return this.transaction(() => {
      this.db.prepare("INSERT INTO settings VALUES ('backlog', ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json").run(JSON.stringify(settings));
      this.prune();
      return settings;
    });
  }

  /** Why an attested item does not durably carry a call of scout `taskId`, or null when it does. */
  private attestedProblem(taskId: string, id: string): string | null {
    const item = this.anyItem(id);
    if (!item) return `no backlog item "${id}"`;
    if (item.taskId === taskId) return `"${id}" is the scout's own item, never its own inventory entry`;
    const hold = this.itemHolds(id).at(-1);
    if (!hold) return `"${id}" was never held for the captain`;
    if (hold.origin !== null && hold.origin !== taskId) return `"${id}" was held for ${hold.origin}, not this scout`;
    return null;
  }

  /**
   * Attests a completed scout's captain calls: every listed item is held for
   * the captain or carries the captain's answer, or `none` states the report
   * left nothing waiting on the captain. The scout's own item, if any, closes
   * on its report. Later attestations add to the inventory.
   */
  attest(taskId: string, items: readonly string[], none: boolean): { items: string[]; none: boolean; sequence: number } {
    if (none && items.length) throw new InvalidInput({ message: "Attest either --none or the captain-held items, not both" });
    if (!none && !items.length) throw new InvalidInput({ message: "Name every item held for the scout's captain calls with --items, or attest --none" });
    return this.transaction(() => {
      const task = this.get(taskId);
      if (task.intake.kind !== "scout") throw new InvalidTransition({ message: "Only a scout's captain calls are attested" });
      if (task.run.state !== "completed") throw new InvalidTransition({ message: `The scout is ${task.run.state}; its captain calls are attested once it completes` });
      if (none) {
        const open = this.holds().filter(h => h.origin === taskId && h.status === "open");
        if (open.length) throw new InvalidTransition({ message: `Holds ${open.map(h => h.itemId).join(", ")} still carry this scout's open captain calls; attest them instead of --none` });
      }
      const problems = [...new Set(items)].map(id => this.attestedProblem(taskId, id)).filter((p): p is string => p !== null);
      if (problems.length) throw new InvalidTransition({ message: `Attestation refused: ${problems.join("; ")}` });
      const sequence = this.append(task, "scout.attested", { items: [...new Set(items)], none });
      const work = this.itemOf(taskId);
      const attestation = this.attestation(taskId)!;
      if (work) {
        this.finishItem(work, { basis: "report", taskId, at: now(),
          detail: `Scout ${taskId} completed with its report saved and ${attestation.items.length ? `captain calls held as ${attestation.items.join(", ")}` : "no captain calls"}` });
      }
      return { ...attestation, sequence };
    });
  }

  /** The scout's attested inventory since its last attempt started, or null when none is recorded. */
  attestation(taskId: string): { items: string[]; none: boolean } | null {
    const started = Number(this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE task_id = ? AND type = 'run.started'").get(taskId)?.sequence);
    const rows = this.db.prepare("SELECT * FROM events WHERE task_id = ? AND type = 'scout.attested' AND sequence > ? ORDER BY sequence").all(taskId, started).map(eventOf);
    if (!rows.length) return null;
    const attested = rows.map(row => row.data as EventDataOf<"scout.attested">);
    const items = [...new Set(attested.flatMap(a => a.items))];
    return { items, none: items.length === 0 };
  }

  /** What no longer holds of a scout's attestation; empty when every attested call is still durable. */
  verifyAttestation(taskId: string): string[] {
    return (this.attestation(taskId)?.items ?? []).map(id => this.attestedProblem(taskId, id)).filter((p): p is string => p !== null);
  }

  /**
   * Reports each pair of records of one captain call that disagree. It is
   * read-only and closes nothing: a divergence is never proof the captain
   * ruled, so reconciling it is left to the captain's own words or a re-hold.
   */
  diverged(): Divergence[] {
    const holds = this.holds();
    const byId = new Map(holds.map(h => [h.id, h]));
    const answered = new Set([
      ...this.db.prepare("SELECT data FROM item_events WHERE type = 'item.answered'").all().map(r => String(JSON.parse(String(r.data)).hold)),
      ...this.db.prepare("SELECT data FROM events WHERE type = 'hold.answered'").all().map(r => String(JSON.parse(String(r.data)).id)),
    ]);
    const reconcile = (item: string) => `It is not proof the captain ruled: record the captain's own words with firstmate backlog answer ${item}, or hold it again with firstmate backlog hold ${item}`;
    const out: Divergence[] = [];
    for (const item of this.items()) {
      const hold = item.hold ? byId.get(item.hold) : undefined;
      if (item.status === "held" && hold?.status !== "open") {
        out.push({ item: item.id, hold: item.hold, kind: "held-without-open-hold", detail: `The item is held, but ${item.hold ? `its hold is ${hold?.status ?? "missing"}` : "it names no hold"}. ${reconcile(item.id)}` });
      }
    }
    for (const hold of holds) {
      if (hold.status === "open") {
        const item = this.anyItem(hold.itemId);
        if (!item || item.status !== "held" || item.hold !== hold.id) {
          out.push({ item: hold.itemId, hold: hold.id, kind: "open-hold-on-unheld-item", detail: `The hold is open, but its item is ${item ? `${item.status}${item.hold && item.hold !== hold.id ? ` under hold ${item.hold}` : ""}` : "gone"}. ${reconcile(hold.itemId)}` });
        }
        if (answered.has(hold.id)) {
          out.push({ item: hold.itemId, hold: hold.id, kind: "answer-recorded-but-hold-open", detail: `An answer to this hold is recorded in the history, but the hold is still open. ${reconcile(hold.itemId)}` });
        }
      } else if (!answered.has(hold.id)) {
        out.push({ item: hold.itemId, hold: hold.id, kind: "closed-without-recorded-answer", detail: `The hold is answered, but no answer to it is recorded in the history. ${reconcile(hold.itemId)}` });
      }
    }
    for (const row of this.db.prepare("SELECT * FROM events WHERE type = 'validation.responded' ORDER BY sequence").all().map(eventOf)) {
      const response = row.data as EventDataOf<"validation.responded">;
      if (response.by !== "captain" || !response.hold) continue;
      const hold = byId.get(response.hold);
      if (hold?.status !== "answered") {
        out.push({ item: hold?.itemId ?? "", hold: response.hold, kind: "captain-response-without-answer", detail: `Task ${row.taskId} sent the pipeline a captain response for this hold, but the hold is ${hold?.status ?? "missing"}. ${reconcile(hold?.itemId ?? "<item>")}` });
      }
    }
    return out;
  }

  /** Ends a validation with the PR the forge reported; the PR head becomes the commit merge authority binds to. */
  passValidation(id: string, token: string, validationId: string, result: { runId: string; outcome: string; pr: PullRequestRef; pipelineHead: string | null }): Task {
    return this.transaction(() => {
      const { task, validation } = this.runningValidation(id, token, validationId);
      this.saveValidation({ ...validation, runId: result.runId, status: "passed", outcome: result.outcome, updatedAt: now() });
      const next = this.advance(task, { state: "pr-open", pr: result.pr, commit: result.pr.head });
      this.append(next, "validation.passed", { id: validationId, runId: result.runId, outcome: result.outcome, url: result.pr.url, head: result.pr.head, pipelineHead: result.pipelineHead });
      this.append(next, "pr.opened", result.pr);
      return next;
    });
  }

  /** Ends a validation without a PR; the task returns to ready at the same commit. */
  failValidation(id: string, token: string, validationId: string, result: { runId: string | null; outcome: string | null; error: string }): Task {
    return this.transaction(() => {
      const { task, validation } = this.runningValidation(id, token, validationId);
      this.saveValidation({ ...validation, runId: result.runId ?? validation.runId, status: "failed", outcome: result.outcome, error: result.error, updatedAt: now() });
      const next = this.advance(task, { state: "ready" });
      this.append(next, "validation.failed", { id: validationId, runId: result.runId ?? validation.runId, outcome: result.outcome, error: result.error });
      return next;
    });
  }

  endDelivery(id: string, token: string) {
    this.db.prepare("DELETE FROM leases WHERE task_id = ? AND token = ?").run(id, token);
  }

  controls(id: string): Control[] {
    return this.db.prepare("SELECT json FROM controls WHERE task_id = ? ORDER BY rowid").all(id).map(row => decodeControl(parse(row)));
  }

  private saveControl(control: Control) {
    this.db.prepare("INSERT INTO controls VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      .run(control.id, control.taskId, JSON.stringify(decodeControl(control)));
  }

  /** The control-request core; a request already open for the generation is returned rather than repeated. */
  private requestControlIn(task: Task, request: ControlRequest): Control {
    if (!activeStates.has(task.run.state) || !task.run.generation) throw new InvalidTransition({ message: `Task is ${task.run.state}; there is no running attempt to ${request.verb}` });
    const owner = ownerOf(this.db.prepare("SELECT * FROM leases WHERE task_id = ?").get(task.id));
    if (owner === "unknown") throw new OwnerUnknown({ message: "Task owner liveness is unknown" });
    if (owner === "absent") throw new InvalidTransition({ message: "Task owner is not running; use resume" });
    const generation = task.run.generation;
    const open = this.controls(task.id).find(c => c.generation === generation && c.verb === request.verb && c.status === "requested");
    if (open) return open;
    const timestamp = now();
    const control: Control = { id: randomUUID(), taskId: task.id, generation, ...request, status: "requested", createdAt: timestamp, updatedAt: timestamp };
    this.saveControl(control);
    this.append(task, "control.requested", { id: control.id, verb: control.verb, reason: control.reason });
    return control;
  }

  /** Durably asks the live owner of a task's current generation to stop; it never signals a process. */
  requestControl(id: string, request: ControlRequest): Control {
    return this.transaction(() => this.requestControlIn(this.get(id), request));
  }

  /** The supervisor record, if any, with its owner as observed from this host. */
  supervisor(): { record: Supervisor | null; owner: Owner } {
    const row = this.db.prepare("SELECT json FROM supervisor WHERE id = 1").get();
    const record = row ? decodeSupervisor(parse(row)) : null;
    return { record, owner: record ? ownerOf(record) : "absent" };
  }

  private saveSupervisor(record: Supervisor) {
    this.db.prepare("INSERT INTO supervisor VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(JSON.stringify(decodeSupervisor(record)));
  }

  private refuseForeignSupervisor(generation: string | undefined) {
    const { record, owner } = this.supervisor();
    if (!record || owner === "absent" || record.generation === generation) return;
    if (owner === "unknown") throw new OwnerUnknown({ message: "The home's supervisor liveness is unknown; shared homes are unsupported" });
    throw new LiveOwner({ message: `A live supervisor (PID ${record.pid}) owns queued execution for this home` });
  }

  /**
   * Takes the home's supervisor lease. A live or unknown owner refuses; one
   * proven dead is replaced and returned. The supervisor consumer's queue
   * generation becomes the new lease's, so the old owner's acknowledgements lapse.
   */
  superviseHome(settings: SupervisorSettings): { record: Supervisor; reclaimed: Supervisor | null } {
    return this.transaction(() => {
      const { record: previous, owner } = this.supervisor();
      if (previous && owner === "live") throw new LiveOwner({ message: `A live supervisor (PID ${previous.pid}) already owns this home` });
      if (previous && owner === "unknown") throw new OwnerUnknown({ message: "The home's supervisor liveness is unknown; shared homes are unsupported" });
      const record: Supervisor = {
        generation: randomUUID(), pid: process.pid, host: hostname(), startedAt: now(), reviewedAt: null, stopRequested: false, lastError: null, settings,
      };
      this.saveSupervisor(record);
      this.setConsumer("supervisor", record.generation);
      return { record, reclaimed: previous };
    });
  }

  releaseHome(generation: string) {
    this.transaction(() => {
      if (this.supervisor().record?.generation === generation) this.db.prepare("DELETE FROM supervisor WHERE id = 1").run();
    });
  }

  /** The supervisor fence: every write on behalf of a supervisor passes through here. */
  ownedHome(generation: string): Supervisor {
    const { record } = this.supervisor();
    if (record?.generation !== generation) throw new StaleGeneration({ message: "Stale supervisor generation: operation refused" });
    return record;
  }

  noteHome(generation: string, changes: Partial<Pick<Supervisor, "reviewedAt" | "lastError">>) {
    this.transaction(() => this.saveSupervisor({ ...this.ownedHome(generation), ...changes }));
  }

  /** Asks the live supervisor to stop at its next review; like cancellation, no signal is sent. */
  requestStop(): Supervisor {
    return this.transaction(() => {
      const { record, owner } = this.supervisor();
      if (!record || owner !== "live") throw new InvalidTransition({ message: "No live supervisor owns this home" });
      const next = { ...record, stopRequested: true };
      this.saveSupervisor(next);
      return next;
    });
  }

  /**
   * Asks the live supervisor to drain, or withdraws the request: draining, it
   * starts no attempt, validation, merge, or secondmate relaunch, and stops
   * once the attempts and validations it runs have ended. Like a stop request,
   * no signal is sent.
   */
  requestDrain(drain: boolean): Supervisor {
    return this.transaction(() => {
      const { record, owner } = this.supervisor();
      if (!record || owner !== "live") throw new InvalidTransition({ message: "No live supervisor owns this home" });
      const next = { ...record, drainRequested: drain };
      this.saveSupervisor(next);
      return next;
    });
  }

  /** The last event sequence the classifier has turned into wakes. */
  cursor(): number {
    return Number(this.db.prepare("SELECT sequence FROM cursors WHERE name = 'classifier'").get()?.sequence ?? 0);
  }

  /** Every task's events after a sequence, oldest first, at most 1,000. */
  history(after: number): TaskEvent[] {
    return this.db.prepare("SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT 1000").all(after).map(eventOf);
  }

  /**
   * Records the wakes classified from the events after `from` through
   * `through` and moves the cursor there, only while the cursor is still at
   * `from`, so a batch is never classified twice or skipped.
   */
  classified(generation: string, from: number, through: number, specs: readonly WakeSpec[]): Wake[] {
    return this.transaction(() => {
      this.ownedHome(generation);
      if (this.cursor() !== from) throw new InvalidTransition({ message: "The classifier cursor moved; batch refused" });
      const recorded = this.insertWakes(specs);
      this.db.prepare("UPDATE cursors SET sequence = ? WHERE name = 'classifier'").run(through);
      return recorded;
    });
  }

  /** Records wakes found by a review; a key already recorded, even acknowledged, is not recorded again. */
  raiseWakes(generation: string, specs: readonly WakeSpec[]): Wake[] {
    return this.transaction(() => { this.ownedHome(generation); return this.insertWakes(specs); });
  }

  /** Inserts wakes inside the caller's transaction; a key already recorded, even acknowledged, is not recorded again. */
  insertWakes(specs: readonly WakeSpec[]): Wake[] {
    const insert = this.db.prepare("INSERT INTO wakes(key, consumer, task_id, status, claim, updated_at, json) VALUES (?, ?, ?, 'pending', NULL, ?, ?) ON CONFLICT(key) DO NOTHING");
    return specs.flatMap(({ key, consumer, taskId, subject, kind, generation, ref, cause, detail }) => {
      const createdAt = now();
      const result = insert.run(key, consumer, taskId, createdAt, JSON.stringify({ kind, ...(subject ? { subject } : {}), generation, ref, cause, detail, createdAt }));
      return result.changes ? [this.wake(Number(result.lastInsertRowid))] : [];
    });
  }

  private wake(sequence: number): Wake {
    const [wake] = this.db.prepare("SELECT * FROM wakes WHERE sequence = ?").all(sequence).map(wakeOf);
    if (!wake) throw new NotFound({ message: "Wake not found" });
    return wake;
  }

  wakes(consumer?: WakeConsumer): Wake[] {
    const rows = consumer ? this.db.prepare("SELECT * FROM wakes WHERE consumer = ? ORDER BY sequence").all(consumer)
      : this.db.prepare("SELECT * FROM wakes ORDER BY sequence").all();
    return rows.map(wakeOf);
  }

  private setConsumer(consumer: WakeConsumer, generation: string) {
    this.db.prepare("INSERT INTO consumers VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET generation = excluded.generation, claimed_at = excluded.claimed_at")
      .run(consumer, generation, now());
  }

  private consumerGeneration(consumer: WakeConsumer) {
    const row = this.db.prepare("SELECT generation FROM consumers WHERE name = ?").get(consumer);
    return row ? String(row.generation) : null;
  }

  /** Gives every unacknowledged wake of a consumer to its current generation, including any an earlier generation left. */
  private claimIn(consumer: WakeConsumer, generation: string): Wake[] {
    this.db.prepare("UPDATE wakes SET status = 'claimed', claim = ?, updated_at = ? WHERE consumer = ? AND status != 'acknowledged' AND (claim IS NULL OR claim != ?)")
      .run(generation, now(), consumer, generation);
    return this.db.prepare("SELECT * FROM wakes WHERE consumer = ? AND status = 'claimed' AND claim = ? ORDER BY sequence").all(consumer, generation).map(wakeOf);
  }

  /** The supervisor's claim, fenced by its lease. */
  claimWakes(generation: string): Wake[] {
    return this.transaction(() => { this.ownedHome(generation); return this.claimIn("supervisor", generation); });
  }

  /** Presents a consumer's open wakes under a new queue generation, which supersedes every earlier one. */
  presentWakes(consumer: WakeConsumer): { generation: string; wakes: Wake[] } {
    if (consumer === "supervisor") throw new InvalidInput({ message: "Supervisor wakes are presented only to the supervisor that holds the home" });
    return this.transaction(() => {
      const generation = randomUUID();
      this.setConsumer(consumer, generation);
      return { generation, wakes: this.claimIn(consumer, generation) };
    });
  }

  /**
   * Acknowledges wakes the generation was given, through a sequence or
   * exactly one. A generation a later presentation superseded acknowledges
   * nothing, so a late consumer can never retire wakes it was not shown.
   */
  acknowledgeWakes(consumer: WakeConsumer, generation: string, through: number, only?: number): Wake[] {
    if (!Number.isSafeInteger(through) || through < 0) throw new InvalidInput({ message: "Acknowledge through a nonnegative wake sequence" });
    return this.transaction(() => {
      if (this.consumerGeneration(consumer) !== generation) {
        throw new StaleGeneration({ message: "A newer presentation superseded this queue generation; present the wakes again and acknowledge with its generation" });
      }
      const handled = this.db.prepare("SELECT * FROM wakes WHERE consumer = ? AND claim = ? AND status = 'claimed' AND sequence <= ? ORDER BY sequence")
        .all(consumer, generation, through).map(wakeOf).filter(wake => only === undefined || wake.sequence === only);
      const timestamp = now();
      const acknowledge = this.db.prepare("UPDATE wakes SET status = 'acknowledged', updated_at = ? WHERE sequence = ?");
      for (const wake of handled) acknowledge.run(timestamp, wake.sequence);
      return handled.map(wake => ({ ...wake, status: "acknowledged" as const, updatedAt: timestamp }));
    });
  }

  /** Each attempt's lease with its owner observation and latest SDK activity. */
  attempts(): AttemptLease[] {
    return this.db.prepare("SELECT * FROM leases ORDER BY rowid").all().map(lease => ({
      task: this.get(String(lease.task_id)), generation: String(lease.token), pid: Number(lease.pid), owner: ownerOf(lease),
      activeAt: lease.active_at == null ? null : String(lease.active_at),
    }));
  }

  /** The recovery steps recorded since the task's last successful result, which resets the ladder. */
  ladder(id: string): { attempts: number; exhausted: boolean } {
    const rows = this.db.prepare(`SELECT type, COUNT(*) AS count FROM events WHERE task_id = ? AND type IN ('recovery.attempted', 'recovery.exhausted')
      AND sequence > (SELECT COALESCE(MAX(sequence), 0) FROM events WHERE task_id = ? AND type = 'task.result') GROUP BY type`).all(id, id);
    const count = (type: string) => Number(rows.find(row => row.type === type)?.count ?? 0);
    return { attempts: count("recovery.attempted"), exhausted: count("recovery.exhausted") > 0 };
  }

  /**
   * Records a recovery step with its control in one transaction. A step
   * whose control is already open for the generation is not recorded again,
   * so handling a repeated wake does not repeat it.
   */
  recover(generation: string, id: string, step: RecoveryStep, request?: ControlRequest): boolean {
    return this.transaction(() => {
      this.ownedHome(generation);
      const task = this.get(id);
      if (request && this.controls(id).some(c => c.generation === task.run.generation && c.verb === request.verb && c.status === "requested")) return false;
      this.append(task, step.type, step.data);
      if (request) this.requestControlIn(task, request);
      return true;
    });
  }

  // ---- secondmates ----

  private setting<A>(name: string, schema: Schema.Codec<A>): A | null {
    const row = this.db.prepare("SELECT json FROM settings WHERE name = ?").get(name);
    return row ? Schema.decodeUnknownSync(schema)(parse(row)) : null;
  }

  private putSetting(name: string, value: unknown | null) {
    if (value === null) this.db.prepare("DELETE FROM settings WHERE name = ?").run(name);
    else this.db.prepare("INSERT INTO settings VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json").run(name, JSON.stringify(value));
  }

  /** This home's secondmate identity, or null for a main home. */
  identity(): SecondmateIdentity | null {
    return this.setting("secondmate", SecondmateIdentity);
  }

  /**
   * Makes a fresh home a secondmate home: its identity, the registered
   * projects it may run, and the main home's shared preferences. Refused for
   * a home that already holds anything.
   */
  seedSecondmate(identity: SecondmateIdentity, projects: readonly Project[], preferences: SharedPreferences | null): SecondmateIdentity {
    return this.transaction(() => {
      const used = ["tasks", "items", "projects", "secondmates", "inbox"].filter(table => this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
      if (this.identity() || used.length) throw new InvalidTransition({ message: `${this.home} is not a fresh home${used.length ? `: it already has ${used.join(", ")}` : ""}; a secondmate gets a home of its own` });
      this.putSetting("secondmate", Schema.decodeUnknownSync(SecondmateIdentity)(identity));
      for (const project of projects) {
        this.db.prepare("INSERT INTO projects VALUES (?, ?)").run(project.name, JSON.stringify(project));
        this.appendProject(project.name, "project.added", project);
      }
      if (preferences) this.putSetting("preferences", { ...preferences, from: identity.parent });
      return identity;
    });
  }

  secondmates(): Secondmate[] {
    return this.db.prepare("SELECT json FROM secondmates ORDER BY rowid").all().map(row => decodeSecondmate(parse(row)));
  }

  secondmate(id: string): Secondmate {
    const row = this.db.prepare("SELECT json FROM secondmates WHERE id = ?").get(id);
    if (!row) throw new NotFound({ message: `No secondmate "${id}" is registered` });
    return decodeSecondmate(parse(row));
  }

  private activeSecondmate(id: string): Secondmate {
    const secondmate = this.secondmate(id);
    if (secondmate.status !== "active") throw new InvalidTransition({ message: `Secondmate "${id}" is retired` });
    return secondmate;
  }

  private saveSecondmate(secondmate: Secondmate): Secondmate {
    const next = decodeSecondmate({ ...secondmate, updatedAt: now() });
    this.db.prepare("INSERT INTO secondmates VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json")
      .run(next.id, next.status, JSON.stringify(next));
    return next;
  }

  private appendSecondmate<T extends SecondmateEventType>(id: string, type: T, data: typeof SecondmateEventData[T]["Type"]): number {
    const checked = Schema.decodeUnknownSync(SecondmateEventData[type] as Schema.Codec<unknown>)(data);
    return Number(this.db.prepare("INSERT INTO secondmate_events(secondmate, type, data, created_at) VALUES (?, ?, ?, ?)")
      .run(id, type, JSON.stringify(checked), now()).lastInsertRowid);
  }

  secondmateEvents(id: string): SecondmateEvent[] {
    return this.db.prepare("SELECT * FROM secondmate_events WHERE secondmate = ? ORDER BY sequence").all(id).map(r => ({
      sequence: Number(r.sequence), secondmate: String(r.secondmate), type: String(r.type), data: JSON.parse(String(r.data)), createdAt: String(r.created_at),
    }));
  }

  /** Registers a seeded secondmate; an id registers once, even after retirement. A secondmate home has no secondmates of its own. */
  addSecondmate(secondmate: Secondmate): Secondmate {
    return this.transaction(() => {
      if (this.identity()) throw new InvalidTransition({ message: "This home is a secondmate's; secondmates are created from the main home" });
      if (!secondmateIdPattern.test(secondmate.id)) throw new InvalidInput({ message: "A secondmate id is 1-64 letters, digits, dots, underscores, or dashes, starting with a letter or digit" });
      if (this.db.prepare("SELECT 1 FROM secondmates WHERE id = ?").get(secondmate.id)) throw new InvalidInput({ message: `Secondmate id "${secondmate.id}" is already used` });
      const saved = this.saveSecondmate(secondmate);
      this.appendSecondmate(saved.id, "secondmate.created", saved);
      return saved;
    });
  }

  /** Records a launch: by the captain, which resets the relaunch count and any exhaustion, or by the supervisor's relaunch policy. */
  launched(id: string, pid: number, by: "captain" | "supervisor", args: readonly string[] | null): Secondmate {
    return this.transaction(() => {
      const secondmate = this.activeSecondmate(id);
      const attempts = by === "captain" ? 0 : secondmate.launch.attempts + 1;
      const next = this.saveSecondmate({ ...secondmate, launch: {
        ...secondmate.launch, desired: "running", pid, host: hostname(), launchedAt: now(), attempts, ...(by === "captain" ? { exhausted: null } : {}), ...(args ? { args: [...args] } : {}),
      } });
      this.appendSecondmate(id, "secondmate.launched", { pid, by, attempt: attempts, limit: secondmate.launch.limit });
      return next;
    });
  }

  /** Records an observed exit of the launched process; returns null when it was already recorded. */
  exited(id: string, pid: number | null, detail: string): Secondmate | null {
    return this.transaction(() => {
      const secondmate = this.activeSecondmate(id);
      if (secondmate.launch.pid !== pid || secondmate.launch.desired !== "running") return null;
      const exits = secondmate.launch.exits + 1;
      const next = this.saveSecondmate({ ...secondmate, launch: { ...secondmate.launch, pid: null, exits, lastExitAt: now() } });
      this.appendSecondmate(id, "secondmate.exited", { pid, exits, detail });
      return next;
    });
  }

  /**
   * The relaunch policy ran out: a captain item is held with the question,
   * and nothing relaunches the secondmate until the captain launches it.
   */
  exhaust(id: string): { secondmate: Secondmate; item: Item; hold: Hold } {
    return this.transaction(() => {
      const secondmate = this.activeSecondmate(id);
      if (secondmate.launch.exhausted) throw new InvalidTransition({ message: `Secondmate "${id}" is already escalated` });
      const { attempts, limit, exits } = secondmate.launch;
      const item = this.insertItem({ title: `Secondmate ${id} keeps exiting`, kind: "captain" });
      const timestamp = now();
      const hold: Hold = {
        id: randomUUID(), itemId: item.id, taskId: null, status: "open", until: null, origin: null, subject: null, answer: null, createdAt: timestamp, updatedAt: timestamp,
        question: `Secondmate "${id}" exited ${exits} time(s) and was relaunched ${attempts} of ${limit} times automatically; it is no longer relaunched. `
          + `Investigate its home (${secondmate.home}, supervisor.log) and then relaunch it with firstmate secondmate launch ${id}, stop it with firstmate secondmate stop ${id}, or retire it.`,
      };
      this.placeHold(item, hold);
      const next = this.saveSecondmate({ ...secondmate, launch: { ...secondmate.launch, exhausted: hold.id } });
      this.appendSecondmate(id, "secondmate.exhausted", { attempts, limit, exits, hold: hold.id, item: item.id });
      return { secondmate: next, item: this.item(item.id), hold };
    });
  }

  /** The captain no longer wants it running: nothing relaunches it. */
  stopped(id: string, reason: string): Secondmate {
    return this.transaction(() => {
      const secondmate = this.activeSecondmate(id);
      const next = this.saveSecondmate({ ...secondmate, launch: { ...secondmate.launch, desired: "stopped" } });
      this.appendSecondmate(id, "secondmate.stopped", { reason });
      return next;
    });
  }

  /** Records a refused retirement with its reasons. */
  refuseRetire(id: string, reasons: readonly string[]): number {
    return this.transaction(() => this.appendSecondmate(this.secondmate(id).id, "secondmate.retire-refused", { reasons: [...reasons] }));
  }

  /**
   * Retires a secondmate whose home holds no unlanded work, as the caller
   * proved; refused here too while a handoff to it is in transit or a
   * request has not reached it. Its home is kept.
   */
  retire(id: string): Secondmate {
    return this.transaction(() => {
      const secondmate = this.activeSecondmate(id);
      const transit = this.handoffs(id).filter(h => h.phase === "prepared");
      const pending = this.requests(id).filter(r => r.status === "pending" && r.work.kind === "work");
      if (transit.length || pending.length) {
        throw new InvalidTransition({ message: `Secondmate "${id}" has ${transit.length} handoff(s) in transit and ${pending.length} undelivered request(s); run firstmate secondmate recover first` });
      }
      const next = this.saveSecondmate({ ...secondmate, status: "retired", retiredAt: now(), launch: { ...secondmate.launch, desired: "stopped" } });
      this.appendSecondmate(id, "secondmate.retired", { home: secondmate.home });
      return next;
    });
  }

  /** Records which shared preferences generation the secondmate's home now holds. */
  pushedPreferences(id: string, generation: string | null): Secondmate {
    return this.transaction(() => {
      const secondmate = this.secondmate(id);
      const next = this.saveSecondmate({ ...secondmate, preferences: generation });
      this.appendSecondmate(id, "preferences.pushed", { generation });
      return next;
    });
  }

  // ---- account pins ----

  /** Every runtime's account pin. Dispatch only reads them; only the developer's pin and unpin change them. */
  accountPins(): AccountPin[] {
    return this.db.prepare("SELECT name, json FROM settings WHERE name LIKE 'account.%' ORDER BY name").all()
      .map(row => Schema.decodeUnknownSync(AccountPin)(parse(row)));
  }

  accountPin(runtime: string): AccountPin | null {
    return this.setting(`account.${runtime}`, AccountPin);
  }

  /** Pins a runtime's account to `ordinary` or an absolute root, or clears the pin with null. */
  setAccountPin(runtime: string, root: string | null): AccountPin | null {
    if (root !== null && root !== "ordinary" && !isAbsolute(root)) throw new InvalidInput({ message: "An account pin is ordinary or an absolute directory" });
    if (root !== null && /[\u0000-\u001f]/.test(root)) throw new InvalidInput({ message: "An account pin must not contain control characters" });
    const pin = root === null ? null : { runtime, root, setAt: now() };
    this.putSetting(`account.${runtime}`, pin);
    return pin;
  }

  /** The shared captain preferences: the main home's own, or a secondmate home's read-only copy. */
  preferences(): SharedPreferences | null {
    return this.setting("preferences", SharedPreferences);
  }

  /** Sets or clears the shared preferences; only the main home's are authoritative. */
  setPreferences(text: string | null): SharedPreferences | null {
    return this.transaction(() => {
      const identity = this.identity();
      if (identity) throw new InvalidTransition({ message: `Shared captain preferences are read-only in secondmate "${identity.id}"'s home; change them in the main home (${identity.parent})` });
      if (text !== null && !text.trim()) throw new InvalidInput({ message: "Preferences must not be empty; use preferences clear" });
      const preferences = text === null ? null : { text, generation: generationOf(text), updatedAt: now(), from: null };
      this.putSetting("preferences", preferences);
      return preferences;
    });
  }

  /** A secondmate home takes its parent's preferences as given, replacing any copy; null clears it. */
  receivePreferences(from: string, preferences: SharedPreferences | null): SharedPreferences | null {
    return this.transaction(() => {
      this.parented(from);
      const copy = preferences && { ...preferences, from };
      this.putSetting("preferences", copy);
      return copy;
    });
  }

  /** Refuses a write from anyone but this secondmate home's own parent. */
  private parented(from: string): SecondmateIdentity {
    const identity = this.identity();
    if (!identity) throw new InvalidTransition({ message: `${this.home} is not a secondmate home` });
    if (identity.parent !== from) throw new InvalidTransition({ message: `Secondmate "${identity.id}" answers to ${identity.parent}, not ${from}` });
    return identity;
  }

  // ---- requests and handoffs (main home) ----

  requests(secondmate?: string): Request[] {
    const rows = secondmate === undefined ? this.db.prepare("SELECT json FROM requests ORDER BY rowid").all()
      : this.db.prepare("SELECT json FROM requests WHERE secondmate = ? ORDER BY rowid").all(secondmate);
    return rows.map(row => decodeRequest(parse(row)));
  }

  request(correlation: string): Request {
    const row = this.db.prepare("SELECT json FROM requests WHERE correlation = ?").get(correlation);
    if (!row) throw new NotFound({ message: `No request "${correlation}"` });
    return decodeRequest(parse(row));
  }

  private saveRequest(request: Request): Request {
    const next = decodeRequest({ ...request, updatedAt: now() });
    this.db.prepare("INSERT INTO requests VALUES (?, ?, ?, ?) ON CONFLICT(correlation) DO UPDATE SET status = excluded.status, json = excluded.json")
      .run(next.correlation, next.secondmate, next.status, JSON.stringify(next));
    return next;
  }

  private insertRequest(secondmate: string, work: RoutedWork): Request {
    const timestamp = now();
    const request = this.saveRequest({ correlation: randomUUID(), secondmate, work, status: "pending", replies: [], createdAt: timestamp, deliveredAt: null, updatedAt: timestamp });
    this.appendSecondmate(secondmate, "request.created", { correlation: request.correlation, work });
    return request;
  }

  /** Records a request for new work before it is delivered, so it is never lost to a failed delivery. */
  createRequest(secondmate: string, work: RoutedWork): Request {
    return this.transaction(() => {
      this.activeSecondmate(secondmate);
      return this.insertRequest(secondmate, work);
    });
  }

  /** The secondmate's home holds the request; delivery is never a reply. */
  deliverRequest(correlation: string): Request {
    return this.transaction(() => {
      const request = this.request(correlation);
      if (request.status !== "pending") return request;
      const next = this.saveRequest({ ...request, status: "delivered", deliveredAt: now() });
      this.appendSecondmate(request.secondmate, "request.delivered", { correlation });
      return next;
    });
  }

  /**
   * Mirrors the secondmate's published status lines for a request, read from
   * its home; each new line is recorded once. A final line makes the
   * request replied.
   */
  mirror(correlation: string, published: readonly PublishedStatus[]): { request: Request; added: PublishedStatus[] } {
    return this.transaction(() => {
      const request = this.request(correlation);
      const added = published.slice(request.replies.length);
      if (!added.length) return { request, added };
      for (const status of added) this.appendSecondmate(request.secondmate, "request.replied", { correlation, status });
      const replies = [...request.replies, ...added];
      const status = replies.some(r => r.final) ? "replied" as const : "accepted" as const;
      return { request: this.saveRequest({ ...request, replies, status, deliveredAt: request.deliveredAt ?? now() }), added };
    });
  }

  handoffs(secondmate?: string): Handoff[] {
    const rows = secondmate === undefined ? this.db.prepare("SELECT json FROM handoffs ORDER BY rowid").all()
      : this.db.prepare("SELECT json FROM handoffs WHERE secondmate = ? ORDER BY rowid").all(secondmate);
    return rows.map(row => decodeHandoff(parse(row)));
  }

  handoff(id: string): Handoff {
    const row = this.db.prepare("SELECT json FROM handoffs WHERE id = ?").get(id);
    if (!row) throw new NotFound({ message: `No handoff "${id}"` });
    return decodeHandoff(parse(row));
  }

  private saveHandoff(handoff: Handoff): Handoff {
    const next = decodeHandoff({ ...handoff, updatedAt: now() });
    this.db.prepare("INSERT INTO handoffs VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET phase = excluded.phase, json = excluded.json")
      .run(next.id, next.secondmate, next.phase, JSON.stringify(next));
    return next;
  }

  /**
   * Prepares a backlog handoff in one transaction: the request and handoff
   * records are written and the items leave the live backlog, in transit
   * under the handoff, so no dispatch can take them. Only queued work items
   * move, and only as a whole connected set: a dependency on an item not
   * done must move with it, and so must every item depending on one that
   * moves. A local-only project's item stays with the main home.
   */
  prepareHandoff(secondmateId: string, itemIds: readonly string[], routed?: typeof ItemEventData["item.routed"]["Type"]): { handoff: Handoff; request: Request } {
    return this.transaction(() => {
      const secondmate = this.activeSecondmate(secondmateId);
      const ids = [...new Set(itemIds)];
      if (!ids.length) throw new InvalidInput({ message: "Name the backlog items to hand off" });
      const items = ids.map(id => this.item(id));
      for (const item of items) {
        if (item.kind === "captain") throw new InvalidTransition({ message: `Backlog item "${item.id}" is a captain call; it stays with the captain in the main home` });
        if (item.status !== "queued") throw new InvalidTransition({ message: `Backlog item "${item.id}" is ${item.status}; only queued items are handed off, and in-flight, held, or done ones stay with their home` });
        const local = this.localOnly(item.project);
        if (local) throw new InvalidTransition({ message: `Backlog item "${item.id}" is for local-only project "${local}", which stays with the main home` });
      }
      const moving = new Set(ids);
      const stranded = items.flatMap(item => item.dependsOn.filter(dep => !moving.has(dep) && this.anyItem(dep)?.status !== "done").map(dep => `${item.id} waits for ${dep}`));
      const dependents = this.items().filter(i => !moving.has(i.id) && i.status !== "done" && i.dependsOn.some(dep => moving.has(dep))).map(i => `${i.id} waits for ${i.dependsOn.filter(d => moving.has(d)).join(", ")}`);
      if (stranded.length || dependents.length) {
        throw new InvalidTransition({ message: `A handoff moves a whole connected set, and this one would strand a dependency: ${[...stranded, ...dependents].join("; ")}. Name those items too` });
      }
      const timestamp = now();
      const request = this.insertRequest(secondmate.id, {
        kind: "handoff", title: items.length === 1 ? items[0]!.title : `${items.length} backlog items`, taskKind: null, project: null, prompt: null, surface: null, items: ids,
      });
      // A dependency on an item already done here is satisfied; the secondmate's backlog has no record of it.
      const carried = items.map(item => ({
        ...item, dependsOn: item.dependsOn.filter(dep => moving.has(dep)),
        notes: [...item.notes, hostNote(`Handed off to secondmate ${secondmate.id} (request ${request.correlation})`)],
      }));
      const handoff = this.saveHandoff({ id: randomUUID(), secondmate: secondmate.id, correlation: request.correlation, items: carried, phase: "prepared", createdAt: timestamp, updatedAt: timestamp });
      for (const item of items) {
        if (routed) this.appendItem(item.id, "item.routed", routed);
        this.db.prepare("DELETE FROM items WHERE id = ?").run(item.id);
        this.appendItem(item.id, "item.handed-off", { secondmate: secondmate.id, handoff: handoff.id, correlation: request.correlation });
      }
      this.appendSecondmate(secondmate.id, "handoff.prepared", { id: handoff.id, correlation: request.correlation, items: ids });
      return { handoff, request };
    });
  }

  /** The secondmate's home holds the handoff's items: the handoff completes and its request is delivered. */
  placeHandoff(id: string, recovered: boolean): Handoff {
    return this.transaction(() => {
      const handoff = this.handoff(id);
      if (handoff.phase !== "prepared") return handoff;
      const next = this.saveHandoff({ ...handoff, phase: "placed" });
      this.appendSecondmate(handoff.secondmate, "handoff.placed", { id, recovered });
      const request = this.request(handoff.correlation);
      if (request.status === "pending") {
        this.saveRequest({ ...request, status: "delivered", deliveredAt: now() });
        this.appendSecondmate(handoff.secondmate, "request.delivered", { correlation: request.correlation });
      }
      return next;
    });
  }

  /**
   * Returns an in-transit handoff's items to the main backlog, as they were
   * when it was prepared; only for a handoff the secondmate's home proved it
   * never received.
   */
  restoreHandoff(id: string, reason: string): Handoff {
    return this.transaction(() => {
      const handoff = this.handoff(id);
      if (handoff.phase !== "prepared") throw new InvalidTransition({ message: `Handoff ${id} is ${handoff.phase}; only one in transit is restored` });
      for (const item of handoff.items) {
        const original = { ...item, notes: [...item.notes, hostNote(`Restored from handoff to secondmate ${handoff.secondmate}: ${reason}`)] };
        this.saveItem(original);
        this.appendItem(item.id, "item.restored", { secondmate: handoff.secondmate, handoff: id, reason });
      }
      const next = this.saveHandoff({ ...handoff, phase: "restored" });
      this.appendSecondmate(handoff.secondmate, "handoff.restored", { id, reason });
      return next;
    });
  }

  /** Where an item that left this backlog went: the handoff that carries or carried it. */
  handoffOf(itemId: string): Handoff | null {
    return this.handoffs().findLast(h => h.phase !== "restored" && h.items.some(i => i.id === itemId)) ?? null;
  }

  /** Records a routing decision on an item that stays in this home. */
  noteRouting(itemId: string, decision: typeof ItemEventData["item.routed"]["Type"]): number {
    return this.transaction(() => this.appendItem(this.item(itemId).id, "item.routed", decision));
  }

  /** The local-only registered project an item's project resolves to, or null. */
  localOnly(project: string | null): string | null {
    if (project === null) return null;
    const registered = this.project(project) ?? (isAbsolute(project) ? this.projectByClone(project) : null);
    return registered?.delivery === "local-only" ? registered.name : null;
  }

  // ---- inbox (secondmate home) ----

  inbox(): Inbox[] {
    return this.db.prepare("SELECT json FROM inbox ORDER BY rowid").all().map(row => decodeInbox(parse(row)));
  }

  inboxEntry(correlation: string): Inbox | null {
    const row = this.db.prepare("SELECT json FROM inbox WHERE correlation = ?").get(correlation);
    return row ? decodeInbox(parse(row)) : null;
  }

  private saveInbox(entry: Inbox): Inbox {
    const next = decodeInbox({ ...entry, updatedAt: now() });
    this.db.prepare("INSERT INTO inbox VALUES (?, ?, ?) ON CONFLICT(correlation) DO UPDATE SET status = excluded.status, json = excluded.json")
      .run(next.correlation, next.status, JSON.stringify(next));
    return next;
  }

  /**
   * Receives a request from this home's parent, once per correlation: a
   * repeated delivery returns the entry already received. A handoff's items
   * enter this backlog queued in the same transaction, so they are here
   * exactly when the correlation is.
   */
  receive(from: string, correlation: string, work: RoutedWork, items: readonly Item[] = [], handoff: string = correlation): { entry: Inbox; received: boolean } {
    return this.transaction(() => {
      this.parented(from);
      const existing = this.inboxEntry(correlation);
      if (existing) return { entry: existing, received: false };
      if (work.kind === "handoff") {
        for (const item of items) {
          if (this.idUsed(item.id)) throw new InvalidTransition({ message: `Backlog item id "${item.id}" is already used in this home; the handoff cannot place it` });
          this.saveItem({ ...item, status: "queued", taskId: null, hold: null, outcome: null, doneAt: null });
          this.appendItem(item.id, "item.received", { from, handoff, correlation });
        }
      }
      const timestamp = now();
      const entry = this.saveInbox({ correlation, from, work, status: "received", items: work.kind === "handoff" ? items.map(i => i.id) : [], published: [], receivedAt: timestamp, updatedAt: timestamp });
      return { entry, received: true };
    });
  }

  /**
   * Accepts a received request: new work becomes a queued item of this
   * backlog; a handoff's items are already here. Publishes the acceptance,
   * or the refusal when the work cannot become an item.
   */
  accept(correlation: string): Inbox {
    return this.transaction(() => {
      const entry = this.inboxEntry(correlation);
      if (!entry) throw new NotFound({ message: `No request "${correlation}" in this home's inbox` });
      if (entry.status !== "received") return entry;
      const line = (state: string, item: string | null, detail: string, final = false): PublishedStatus => ({ at: now(), state, item, task: null, commit: null, pr: null, document: null, detail, final });
      if (entry.work.kind === "handoff") {
        return this.saveInbox({ ...entry, status: "accepted", published: [...entry.published, line("accepted", null, `Received ${entry.items.length} backlog item(s): ${entry.items.join(", ")}`)] });
      }
      const { work } = entry;
      try {
        if (!work.taskKind || !work.prompt) throw new InvalidInput({ message: "Routed work names a task kind and a prompt" });
        const item = this.insertItem({ title: work.title, kind: work.taskKind, prompt: work.prompt, project: work.project, note: `Routed from the main home (request ${correlation})` });
        return this.saveInbox({ ...entry, status: "accepted", items: [item.id], published: [...entry.published, line("accepted", item.id, `Queued as backlog item ${item.id}`)] });
      } catch (error) {
        return this.saveInbox({ ...entry, status: "refused", published: [...entry.published, line("refused", null, appError(error).message, true)] });
      }
    });
  }

  /** Appends status lines this home publishes for a request; `done` once its last line is final. */
  publishStatus(correlation: string, lines: readonly PublishedStatus[]): Inbox {
    return this.transaction(() => {
      const entry = this.inboxEntry(correlation);
      if (!entry) throw new NotFound({ message: `No request "${correlation}" in this home's inbox` });
      if (!lines.length) return entry;
      return this.saveInbox({ ...entry, status: lines.some(l => l.final) ? "done" : entry.status, published: [...entry.published, ...lines] });
    });
  }

  /**
   * What in this home is not yet landed: tasks that are not a landed ship, a
   * completed scout, or cleaned; backlog items not done; and requests it
   * has not finished.
   */
  unlandedWork(): string[] {
    return [
      ...this.list().filter(task => task.run.state !== "cleaned" && task.run.state !== "landed" && !(task.intake.kind === "scout" && task.run.state === "completed"))
        .map(task => `task ${task.id} (${task.intake.kind}, ${task.run.state})`),
      ...this.items().filter(item => item.status !== "done").map(item => `item ${item.id} (${item.status})`),
      ...this.inbox().filter(entry => entry.status === "received" || entry.status === "accepted").map(entry => `request ${entry.correlation} (${entry.status})`),
    ];
  }

  // ---- posture, triage, stow, and the home's history ----

  private appendHome<T extends HomeEventType>(type: T, data: typeof HomeEventData[T]["Type"]): number {
    const checked = Schema.decodeUnknownSync(HomeEventData[type] as Schema.Codec<unknown>)(data);
    return Number(this.db.prepare("INSERT INTO home_events(type, data, created_at) VALUES (?, ?, ?)").run(type, JSON.stringify(checked), now()).lastInsertRowid);
  }

  /** The home's posture, memory, and stow history after a sequence, oldest first. */
  homeEvents(after = 0): HomeEvent[] {
    return this.db.prepare("SELECT * FROM home_events WHERE sequence > ? ORDER BY sequence").all(after).map(r => ({
      sequence: Number(r.sequence), type: String(r.type), data: JSON.parse(String(r.data)), createdAt: String(r.created_at),
    }));
  }

  /** The active away or quiet session, or null while the captain is present. */
  posture(): Posture | null {
    const row = this.db.prepare("SELECT json FROM postures WHERE status = 'active'").get();
    return row ? decodePosture(parse(row)) : null;
  }

  /** Every posture session, oldest first. */
  postures(): Posture[] {
    return this.db.prepare("SELECT json FROM postures ORDER BY rowid").all().map(row => decodePosture(parse(row)));
  }

  postureById(id: string): Posture {
    const row = this.db.prepare("SELECT json FROM postures WHERE id = ?").get(id);
    if (!row) throw new NotFound({ message: `No posture session "${id}"` });
    return decodePosture(parse(row));
  }

  private savePosture(posture: Posture): Posture {
    const next = decodePosture(posture);
    this.db.prepare("INSERT INTO postures VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json")
      .run(next.id, next.endedAt ? "ended" : "active", JSON.stringify(next));
    return next;
  }

  private endIn(posture: Posture, by: "return" | "quiet-off" | "replaced", command: string | null): Posture {
    const ended = this.savePosture({ ...posture, endedAt: now(), endedBy: by });
    this.appendHome("posture.exited", { posture: posture.id, mode: posture.mode, by, command });
    return ended;
  }

  /**
   * Enters away or quiet. The away words are stored exactly as given; blank
   * words record no mandate. Away while away with no words, or the same
   * words, is a refresh that changes nothing; new words replace the mandate
   * at once and keep the session. Away replaces a quiet session. Quiet is
   * refused while away, because only the captain's return ends away.
   */
  enterPosture(mode: PostureMode, words?: string | null): { posture: Posture; change: "entered" | "words-replaced" | "refreshed"; replaced: Posture | null } {
    return this.transaction(() => {
      const given = words === undefined ? undefined : words === null || !words.trim() ? null : words;
      const active = this.posture();
      if (mode === "quiet" && given !== undefined && given !== null) throw new InvalidInput({ message: "Quiet records no away words; the captain stays present" });
      if (active?.mode === "away" && mode === "quiet") throw new InvalidTransition({ message: "The away posture is active; the captain's return ends it before quiet starts" });
      if (active && active.mode === mode) {
        if (mode === "quiet" || given === undefined || given === active.words) return { posture: active, change: "refreshed" as const, replaced: null };
        const at = now();
        const posture = this.savePosture({ ...active, words: given, wordsAt: at, superseded: [...active.superseded, { words: active.words, from: active.wordsAt, to: at }] });
        this.appendHome("posture.words-replaced", { posture: active.id, words: given, previous: active.words });
        return { posture, change: "words-replaced" as const, replaced: null };
      }
      const replaced = active ? this.endIn(active, "replaced", null) : null;
      const at = now();
      const posture = this.savePosture({ id: randomUUID(), mode, words: given ?? null, superseded: [], wordsAt: at, enteredAt: at, endedAt: null, endedBy: null });
      this.appendHome("posture.entered", { posture: posture.id, mode, words: posture.words });
      return { posture, change: "entered" as const, replaced };
    });
  }

  /** Ends the active session: away only by the captain's return, quiet only by quiet-off. */
  endPosture(by: "return" | "quiet-off", command: string | null = null): Posture {
    return this.transaction(() => {
      const active = this.posture();
      const wanted = by === "return" ? "away" : "quiet";
      if (!active) throw new InvalidTransition({ message: `No ${wanted} posture is active; the captain is present` });
      if (active.mode !== wanted) {
        throw new InvalidTransition({ message: active.mode === "quiet" ? "Quiet is active, and only posture quiet-off ends it" : "Away is active, and only the captain's return (posture return) ends it" });
      }
      return this.endIn(active, by, command);
    });
  }

  /**
   * Records how the active session handled captain wakes, fenced by the
   * supervisor lease: a routine wake is acknowledged in the same
   * transaction, a captain one stays open. Returns null, recording nothing,
   * once that session is no longer active.
   */
  triage(generation: string, posture: string, entries: readonly { wake: Wake; verdict: "routine" | "captain"; why: string }[]): Triaged[] | null {
    return this.transaction(() => {
      this.ownedHome(generation);
      if (this.posture()?.id !== posture) return null;
      const insert = this.db.prepare("INSERT INTO triaged VALUES (?, ?, ?, ?) ON CONFLICT(wake) DO NOTHING");
      const acknowledge = this.db.prepare("UPDATE wakes SET status = 'acknowledged', updated_at = ? WHERE sequence = ? AND status != 'acknowledged'");
      return entries.flatMap(({ wake, verdict, why }) => {
        const at = now();
        const triaged: Triaged = { wake: wake.sequence, posture, verdict, kind: wake.kind, taskId: wake.taskId, detail: wake.detail, why, at };
        if (!insert.run(wake.sequence, posture, verdict, JSON.stringify(triaged)).changes) return [];
        if (verdict === "routine") acknowledge.run(at, wake.sequence);
        return [triaged];
      });
    });
  }

  /** The wakes a session triaged, or every session's, oldest first, each with whether its wake is still open. */
  triaged(posture?: string): (Triaged & { open: boolean })[] {
    const rows = posture
      ? this.db.prepare("SELECT t.json, w.status FROM triaged t JOIN wakes w ON w.sequence = t.wake WHERE t.posture = ? ORDER BY t.wake").all(posture)
      : this.db.prepare("SELECT t.json, w.status FROM triaged t JOIN wakes w ON w.sequence = t.wake ORDER BY t.wake").all();
    return rows.map(row => ({ ...Schema.decodeUnknownSync(TriagedSchema)(parse(row)), open: row.status !== "acknowledged" }));
  }

  /** Task events of the given types recorded at or after a time, oldest first. */
  eventsSince(types: readonly EventType[], since: string): TaskEvent[] {
    return this.db.prepare(`SELECT * FROM events WHERE type IN (${types.map(() => "?").join(", ")}) AND created_at >= ? ORDER BY sequence`).all(...types, since).map(eventOf);
  }

  /** Item history of the given types recorded at or after a time, oldest first. */
  itemEventsSince(types: readonly ItemEventType[], since: string): ItemEvent[] {
    return this.db.prepare(`SELECT * FROM item_events WHERE type IN (${types.map(() => "?").join(", ")}) AND created_at >= ? ORDER BY sequence`).all(...types, since).map(r => ({
      sequence: Number(r.sequence), itemId: String(r.item_id), type: String(r.type), data: JSON.parse(String(r.data)), createdAt: String(r.created_at),
    }));
  }

  /** Records a memory file change in the home's history. */
  noteMemory(file: MemoryFile, change: "append" | "replace", generation: string | null, bytes: number): number {
    return this.transaction(() => this.appendHome("memory.changed", { file, change, generation, bytes }));
  }

  /**
   * Files what the home holds before a reset, in one transaction: each open
   * item with no notes gets a host note describing its record as it stands,
   * and the open holds and the batched captain wakes still open are listed
   * in a `stow.filed` event. Nothing is checked against repositories or PRs.
   */
  stow(learnings: number): { noted: Item[]; holds: Hold[]; batched: (Triaged & { open: boolean })[]; posture: Posture | null; sequence: number } {
    return this.transaction(() => {
      const noted = this.items().filter(item => item.status !== "done" && item.notes.length === 0).map(item => {
        const hold = item.hold ? this.db.prepare("SELECT json FROM holds WHERE id = ?").get(item.hold) : undefined;
        const task = item.taskId && this.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(item.taskId) ? this.get(item.taskId) : null;
        const text = [`Stowed while ${item.status}`, task ? `task ${task.id} is ${task.run.state}` : null,
          hold ? `held for the captain: ${decodeHold(parse(hold)).question}` : null, item.dependsOn.length ? `depends on ${item.dependsOn.join(", ")}` : null,
          item.deferUntil ? `deferred until ${item.deferUntil}` : null].filter(Boolean).join("; ");
        const next = this.saveItem({ ...item, notes: [hostNote(text)] });
        this.appendItem(item.id, "item.updated", next);
        return next;
      });
      const holds = this.holds().filter(hold => hold.status === "open");
      const batched = this.triaged().filter(t => t.verdict === "captain" && t.open);
      const posture = this.posture();
      const sequence = this.appendHome("stow.filed", { noted: noted.map(i => i.id), holds: holds.map(h => h.id), batched: batched.map(t => t.wake), learnings, posture: posture?.id ?? null });
      return { noted, holds, batched, posture, sequence };
    });
  }

  /** The supervisor's inspectable state, read in one snapshot. */
  supervision() {
    return this.transaction(() => {
      const { record, owner } = this.supervisor();
      const counts = this.db.prepare("SELECT consumer, status, COUNT(*) AS count FROM wakes WHERE status != 'acknowledged' GROUP BY consumer, status").all();
      const open = (consumer: WakeConsumer) => Object.fromEntries((["pending", "claimed"] as const)
        .map(status => [status, Number(counts.find(row => row.consumer === consumer && row.status === status)?.count ?? 0)]));
      const latest = Number(this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events").get()?.sequence);
      const owned = record && owner === "live" ? this.attempts().filter(a => a.pid === record.pid && a.owner === "live").map(a => a.task.id) : [];
      const recovering = this.db.prepare("SELECT DISTINCT task_id FROM events WHERE type IN ('recovery.attempted', 'recovery.exhausted') ORDER BY task_id").all()
        .map(row => ({ taskId: String(row.task_id), ...this.ladder(String(row.task_id)) })).filter(r => r.attempts > 0 || r.exhausted);
      return {
        supervisor: record, owner, classifier: { cursor: this.cursor(), latestEvent: latest },
        wakes: { captain: open("captain"), supervisor: open("supervisor") }, owned, recovering,
      };
    });
  }
}

/** The generation of a shared preferences text: a hash, so equal generations hold equal text. */
export const generationOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
/** A note the host writes: templated from durable identities only, never a path, PID, session, or generation. */
const hostNote = (text: string) => ({ at: now(), by: "host" as const, text });
/** A date (YYYY-MM-DD) or an ISO date-time, as given. */
const checkedDate = (value: string, name: string) => {
  if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InvalidInput({ message: `${name} must be a date (YYYY-MM-DD) or an ISO date-time` });
  }
  return value;
};

/** The same gate occurrence of the same pipeline run. */
const sameGate = (a: PipelineGate, b: PipelineGate) => a.runId === b.runId && a.step === b.step && a.occurrence === b.occurrence;

const eventOf = (r: Row): TaskEvent => decodeEvent({ sequence: Number(r.sequence), taskId: String(r.task_id), generation: r.generation,
  type: String(r.type), data: JSON.parse(String(r.data)), createdAt: String(r.created_at) });
const wakeOf = (r: Row): Wake => decodeWake({ sequence: Number(r.sequence), key: r.key, consumer: r.consumer, taskId: r.task_id,
  status: r.status, claim: r.claim, updatedAt: r.updated_at, ...JSON.parse(String(r.json)) });

/**
 * Decides an earlier generation's unconfirmed steer from its session transcript:
 * present means delivered, absent means safe to resend with the same identity,
 * unreadable means uncertain.
 */
const reconciliation = (sessionId: string | null, transcript: ReadonlySet<string> | null, steerId: string) =>
  !sessionId ? ["pending", { via: "no-session" }] as const
  : !transcript ? ["uncertain", { via: "transcript-unavailable" }] as const
  : transcript.has(steerId) ? ["delivered", { via: "transcript" }] as const
  : ["pending", { via: "transcript-absent" }] as const;

type Op<A> = Effect.Effect<A, FirstmateError>;
const lift = <A>(f: () => A): Op<A> => Effect.try({ try: f, catch: appError });

/**
 * One generation's authority over a task, released when its scope closes.
 * Every write is fenced by that generation, so a superseded attempt cannot
 * move the task, its decisions, or its steering.
 */
export interface Attempt {
  readonly generation: string;
  /** The task as this generation acquired it. */
  readonly task: Task;
  current(): Op<Task>;
  /** True once this task state shows a cancellation or a newer generation. */
  revokedBy(task: Task): boolean;
  update<T extends EventType>(changes: TaskChanges, type: T, data: EventDataOf<T>): Op<Task>;
  record<T extends EventType>(type: T, data: EventDataOf<T>): Op<void>;
  requestDecision(tool: string, input: Record<string, unknown>): Op<Decision>;
  decision(decisionId: string): Op<Decision | undefined>;
  hasPendingDecisions(): Op<boolean>;
  /**
   * Settles every steer an earlier generation left unconfirmed, reading the
   * transcript only when one exists, and returns the delivered steers that
   * this attempt's prompt must ask to have answered.
   */
  reconcileSteers(transcript: (sessionId: string) => Effect.Effect<ReadonlySet<string> | null>): Op<readonly Steer[]>;
  claimSteers(): Op<readonly Steer[]>;
  markDelivered(steerId: string): Op<boolean>;
  acknowledgeThrough(steerId: string): Op<readonly Steer[]>;
  acknowledgeNamed(steerIds: readonly string[], promptId: string): Op<readonly Steer[]>;
  /** Steers this generation submitted that no evidence has acknowledged yet. */
  unacknowledged(): Op<readonly Steer[]>;
  closeInput(): Op<boolean>;
  /** Records SDK activity as this generation's liveness evidence. */
  touch(): Op<boolean>;
  /** Ends the attempt, applying the lifecycle control that stopped it, if any. */
  stop(state: "failed" | "interrupted" | "cancelled", error: string, controlId?: string): Op<Task>;
}

const attempt = (store: Store, task: Task, token: string): Attempt => {
  const id = task.id;
  return {
    generation: token,
    task,
    current: () => lift(() => store.get(id)),
    revokedBy: ({ run }) => run.cancelRequested || run.generation !== token,
    update: (changes, type, data) => lift(() => store.update(id, token, changes, type, data)),
    record: (type, data) => lift(() => store.record(id, token, type, data)),
    requestDecision: (tool, input) => lift(() => store.requestDecision(id, token, tool, input)),
    decision: decisionId => lift(() => store.decisions(id).find(d => d.id === decisionId)),
    hasPendingDecisions: () => lift(() => store.decisions(id).some(d => d.status === "pending")),
    reconcileSteers: transcript => Effect.gen(function*() {
      const unconfirmed = yield* lift(() => store.unconfirmed(id, token));
      if (unconfirmed.length) {
        const { sessionId } = task.run;
        const found = sessionId ? yield* transcript(sessionId) : null;
        for (const steer of unconfirmed) {
          const [status, evidence] = reconciliation(sessionId, found, steer.id);
          yield* lift(() => store.reconcileSteer(id, token, steer.id, status, evidence));
        }
      }
      return yield* lift(() => store.steers(id).filter(s => s.status === "delivered"));
    }),
    claimSteers: () => lift(() => store.claimSteers(id, token)),
    markDelivered: steerId => lift(() => store.markSteerDelivered(id, token, steerId)),
    acknowledgeThrough: steerId => lift(() => store.acknowledgeThrough(id, token, steerId)),
    acknowledgeNamed: (steerIds, promptId) => lift(() => store.acknowledgeNamed(id, token, steerIds, promptId)),
    unacknowledged: () => lift(() => store.unacknowledged(id, token)),
    closeInput: () => lift(() => store.closeInput(id, token)),
    touch: () => lift(() => store.touch(id, token)),
    stop: (state, error, controlId) => lift(() => store.stop(id, token, state, error, controlId)),
  };
};

/**
 * One supervisor generation's authority over the home, released when its
 * scope closes. Every write is fenced by that generation, so a superseded
 * supervisor can neither classify, raise, claim, nor acknowledge wakes.
 */
export interface Supervision {
  readonly generation: string;
  /** The record of a supervisor proven dead that this lease replaced. */
  readonly reclaimed: Supervisor | null;
  current(): Op<Supervisor>;
  note(changes: Partial<Pick<Supervisor, "reviewedAt" | "lastError">>): Op<void>;
  cursor(): Op<number>;
  history(after: number): Op<readonly TaskEvent[]>;
  classified(from: number, through: number, specs: readonly WakeSpec[]): Op<readonly Wake[]>;
  raise(specs: readonly WakeSpec[]): Op<readonly Wake[]>;
  claim(): Op<readonly Wake[]>;
  acknowledge(sequence: number): Op<readonly Wake[]>;
  attempts(): Op<readonly AttemptLease[]>;
  ladder(id: string): Op<{ attempts: number; exhausted: boolean }>;
  recover(id: string, step: RecoveryStep, request?: ControlRequest): Op<boolean>;
  /** Records how the active posture session handled captain wakes; null once that session has ended. */
  triage(posture: string, entries: readonly { wake: Wake; verdict: "routine" | "captain"; why: string }[]): Op<readonly Triaged[] | null>;
}

const supervision = (store: Store, generation: string, reclaimed: Supervisor | null): Supervision => ({
  generation,
  reclaimed,
  current: () => lift(() => store.ownedHome(generation)),
  note: changes => lift(() => store.noteHome(generation, changes)),
  cursor: () => lift(() => store.cursor()),
  history: after => lift(() => store.history(after)),
  classified: (from, through, specs) => lift(() => store.classified(generation, from, through, specs)),
  raise: specs => lift(() => store.raiseWakes(generation, specs)),
  claim: () => lift(() => store.claimWakes(generation)),
  acknowledge: sequence => lift(() => store.acknowledgeWakes("supervisor", generation, sequence, sequence)),
  attempts: () => lift(() => store.attempts()),
  ladder: id => lift(() => store.ladder(id)),
  recover: (id, step, request) => lift(() => store.recover(generation, id, step, request)),
  triage: (posture, entries) => lift(() => store.triage(generation, posture, entries)),
});

export type Inspection = ReturnType<Store["inspect"]>;
/** A registry entry as loaded: decoded, or reported with what is wrong with it. */
export type ProjectEntry = { readonly name: string; readonly project: Project } | { readonly name: string; readonly malformed: string };
/** A capped project's capacity and the other tasks holding its places. */
export interface Room {
  readonly project: string;
  readonly capacity: number;
  readonly holders: readonly string[];
}

/** A delivery's hold on its task: no attempt can start until its scope closes. */
export interface Delivery {
  record<T extends "pr.failed" | "pr.merged">(type: T, data: EventDataOf<T>): Op<number>;
  publish(pr: PullRequestRef, type: "pr.opened" | "pr.updated"): Op<Task>;
  finish(proof: LandingProof): Op<Task>;
}
export type SupervisionState = ReturnType<Store["supervision"]>;
/** The states a delivery takes its task's lease from. */
export type DeliveryState = "ready" | "validating" | "local-ready" | "pr-open";

/** A cleanup's hold on its task: no attempt or delivery can start until its scope closes. */
export interface Cleanup {
  finish(cleaned: Cleaned): Op<Task>;
}

/** A validation's hold on its task: no attempt can start, and every write is fenced by it. */
export interface Validating {
  /** Starts a validation of the task's ready commit. */
  start(): Op<Validation>;
  run(validationId: string, runId: string): Op<Validation>;
  responses(validationId: string, runId: string, step: string): Op<readonly EventDataOf<"validation.responded">[]>;
  gate(validationId: string, gate: PipelineGate): Op<void>;
  respond(response: EventDataOf<"validation.responded">): Op<void>;
  hold(validationId: string, gate: PipelineGate, question: string): Op<Hold>;
  pass(validationId: string, result: { runId: string; outcome: string; pr: PullRequestRef; pipelineHead: string | null }): Op<Task>;
  fail(validationId: string, result: { runId: string | null; outcome: string | null; error: string }): Op<Task>;
}

/** Task-level operations; every generation-bound write goes through an `Attempt`. */
export interface TaskStoreShape {
  readonly home: string;
  /** Process sources, the captain inbox, Relay, upstream signals, and the outbox. */
  readonly ledger: LedgerOps;
  readonly maintenance: MaintenanceOps;
  create(task: Task, resolution?: IntakeResolution, itemId?: string): Op<Task>;
  get(id: string): Op<Task>;
  list(): Op<readonly Task[]>;
  inspect(id: string): Op<Inspection>;
  events(id: string, after?: number): Op<readonly TaskEvent[]>;
  decisions(taskId?: string): Op<readonly Decision[]>;
  answer(decisionId: string, status: "allow" | "deny", answer: string): Op<Decision>;
  steer(id: string, text: string): Op<Steer>;
  steers(id: string): Op<readonly Steer[]>;
  requeueSteer(steerId: string): Op<Steer>;
  cancel(id: string): Op<Task>;
  mergeRecords(id: string): Op<{ approvals: readonly Sequenced<MergeApproval>[]; flags: readonly Sequenced<{ reason: string }>[] }>;
  merges(id: string): Op<readonly PullRequestMerged[]>;
  approve(id: string, request: { commit?: string; waivers: readonly string[]; note: string }): Op<Sequenced<MergeApproval>>;
  flag(id: string, reason: string): Op<Sequenced<{ reason: string }>>;
  projectEntries(): Op<readonly ProjectEntry[]>;
  project(name: string): Op<Project | null>;
  projectByClone(clone: string): Op<Project | null>;
  addProject(project: Project): Op<Project>;
  storedProject(name: string): Op<Record<string, unknown>>;
  updateProject(name: string, change: (stored: Record<string, unknown>) => Project): Op<Project>;
  removeProject(name: string): Op<{ name: string; sequence: number }>;
  unlanded(name: string): Op<readonly Task[]>;
  holders(name: string): Op<readonly Task[]>;
  projectEvents(name: string): Op<readonly ProjectEvent[]>;
  room(id: string): Op<Room | null>;
  defer(id: string, deferred: Deferred): Op<number>;
  /** Holds the task's lease for delivering `commit` from `state`; the scope's close releases it. */
  delivery(id: string, state: DeliveryState, commit: string): Effect.Effect<Delivery, FirstmateError, Scope.Scope>;
  /** Holds the task's lease for validating `commit` from `state`; the scope's close releases it. */
  validation(id: string, state: "ready" | "validating", commit: string): Effect.Effect<Validating, FirstmateError, Scope.Scope>;
  validations(id: string): Op<readonly Validation[]>;
  landing(id: string): Op<LandingProof | null>;
  recordRefresh<T extends "clone.refreshed" | "clone.refused">(id: string, type: T, data: EventDataOf<T>): Op<number>;
  authorizeDiscard(id: string, reason: string, head: string | null): Op<Sequenced<DiscardAuthorization>>;
  discardAuthorization(id: string): Op<Sequenced<DiscardAuthorization> | null>;
  refuseCleanup(id: string, reason: string): Op<number>;
  /** Holds the task's lease for cleaning it up; the scope's close releases it. */
  cleanup(id: string): Effect.Effect<Cleanup, FirstmateError, Scope.Scope>;
  holds(taskId?: string): Op<readonly Hold[]>;
  itemHolds(itemId: string): Op<readonly Hold[]>;
  answerHold(holdId: string, request: AnswerRequest): Op<Hold>;
  items(): Op<readonly Item[]>;
  archivedItems(): Op<readonly Item[]>;
  item(id: string): Op<Item>;
  itemOf(taskId: string): Op<Item | null>;
  itemEvents(id: string): Op<readonly ItemEvent[]>;
  addItem(input: NewItem): Op<Item>;
  updateItem(id: string, change: ItemChange): Op<Item>;
  removeItem(id: string): Op<{ id: string; sequence: number }>;
  waiting(item: Item): Op<readonly string[]>;
  checkDispatch(id: string): Op<Item>;
  holdItem(itemId: string | null, request: { reason: string; until?: string | null; origin?: string | null; title?: string; project?: string | null }): Op<{ item: Item; hold: Hold }>;
  answerItem(itemId: string, request: AnswerRequest): Op<{ item: Item; hold: Hold }>;
  attest(taskId: string, items: readonly string[], none: boolean): Op<{ items: string[]; none: boolean; sequence: number }>;
  attestation(taskId: string): Op<{ items: string[]; none: boolean } | null>;
  verifyAttestation(taskId: string): Op<readonly string[]>;
  diverged(): Op<readonly Divergence[]>;
  backlogSettings(): Op<BacklogSettings>;
  setBacklogSettings(settings: BacklogSettings): Op<BacklogSettings>;
  controls(id: string): Op<readonly Control[]>;
  requestControl(id: string, request: ControlRequest): Op<Control>;
  supervisor(): Op<{ record: Supervisor | null; owner: Owner }>;
  supervision(): Op<SupervisionState>;
  requestStop(): Op<Supervisor>;
  requestDrain(drain: boolean): Op<Supervisor>;
  wakes(consumer?: WakeConsumer): Op<readonly Wake[]>;
  presentWakes(consumer: WakeConsumer): Op<{ generation: string; wakes: readonly Wake[] }>;
  acknowledgeWakes(consumer: WakeConsumer, generation: string, through: number): Op<readonly Wake[]>;
  identity(): Op<SecondmateIdentity | null>;
  secondmates(): Op<readonly Secondmate[]>;
  secondmate(id: string): Op<Secondmate>;
  secondmateEvents(id: string): Op<readonly SecondmateEvent[]>;
  addSecondmate(secondmate: Secondmate): Op<Secondmate>;
  launched(id: string, pid: number, by: "captain" | "supervisor", args: readonly string[] | null): Op<Secondmate>;
  exited(id: string, pid: number | null, detail: string): Op<Secondmate | null>;
  exhaust(id: string): Op<{ secondmate: Secondmate; item: Item; hold: Hold }>;
  stopped(id: string, reason: string): Op<Secondmate>;
  refuseRetire(id: string, reasons: readonly string[]): Op<number>;
  retire(id: string): Op<Secondmate>;
  pushedPreferences(id: string, generation: string | null): Op<Secondmate>;
  preferences(): Op<SharedPreferences | null>;
  accountPins(): Op<readonly AccountPin[]>;
  accountPin(runtime: string): Op<AccountPin | null>;
  setAccountPin(runtime: string, root: string | null): Op<AccountPin | null>;
  setPreferences(text: string | null): Op<SharedPreferences | null>;
  requests(secondmate?: string): Op<readonly Request[]>;
  request(correlation: string): Op<Request>;
  createRequest(secondmate: string, work: RoutedWork): Op<Request>;
  deliverRequest(correlation: string): Op<Request>;
  mirror(correlation: string, published: readonly PublishedStatus[]): Op<{ request: Request; added: readonly PublishedStatus[] }>;
  handoffs(secondmate?: string): Op<readonly Handoff[]>;
  prepareHandoff(secondmate: string, items: readonly string[], routed?: typeof ItemEventData["item.routed"]["Type"]): Op<{ handoff: Handoff; request: Request }>;
  placeHandoff(id: string, recovered: boolean): Op<Handoff>;
  restoreHandoff(id: string, reason: string): Op<Handoff>;
  handoffOf(itemId: string): Op<Handoff | null>;
  localOnly(project: string | null): Op<string | null>;
  noteRouting(itemId: string, decision: typeof ItemEventData["item.routed"]["Type"]): Op<number>;
  inbox(): Op<readonly Inbox[]>;
  accept(correlation: string): Op<Inbox>;
  publishStatus(correlation: string, lines: readonly PublishedStatus[]): Op<Inbox>;
  unlandedWork(): Op<readonly string[]>;
  homeEvents(after?: number): Op<readonly HomeEvent[]>;
  posture(): Op<Posture | null>;
  postures(): Op<readonly Posture[]>;
  postureById(id: string): Op<Posture>;
  enterPosture(mode: PostureMode, words?: string | null): Op<{ posture: Posture; change: "entered" | "words-replaced" | "refreshed"; replaced: Posture | null }>;
  endPosture(by: "return" | "quiet-off", command?: string | null): Op<Posture>;
  triaged(posture?: string): Op<readonly (Triaged & { open: boolean })[]>;
  eventsSince(types: readonly EventType[], since: string): Op<readonly TaskEvent[]>;
  itemEventsSince(types: readonly ItemEventType[], since: string): Op<readonly ItemEvent[]>;
  noteMemory(file: MemoryFile, change: "append" | "replace", generation: string | null, bytes: number): Op<number>;
  stow(learnings: number): Op<{ noted: readonly Item[]; holds: readonly Hold[]; batched: readonly (Triaged & { open: boolean })[]; posture: Posture | null; sequence: number }>;
  /**
   * The task's change feed, checked every `pollMs` and shared by every
   * subscriber until the scope closes. A subscriber first receives the
   * current state, then each change any connection commits; changes that
   * land between its reads arrive as one, carrying the latest state.
   */
  changes(id: string, pollMs: number): Effect.Effect<Stream.Stream<TaskChange, FirstmateError>, never, Scope.Scope>;
  /** Takes ownership as a new generation on behalf of an optional supervisor; the scope's close releases it. */
  acquire(id: string, resume: boolean, supervisor?: string): Effect.Effect<Attempt, FirstmateError, Scope.Scope>;
  /** Takes the home's supervisor lease; the scope's close releases it. */
  supervise(settings: SupervisorSettings): Effect.Effect<Supervision, FirstmateError, Scope.Scope>;
}

const service = (store: Store): TaskStoreShape => ({
  ledger: ledgerOps(new Ledger(store)),
  maintenance: maintenanceOps(new Maintenance(store)),
  home: store.home,
  create: (task, resolution, itemId) => lift(() => store.create(task, resolution, itemId)),
  projectEntries: () => lift(() => store.projectEntries()),
  project: name => lift(() => store.project(name)),
  projectByClone: clone => lift(() => store.projectByClone(clone)),
  addProject: project => lift(() => store.addProject(project)),
  storedProject: name => lift(() => store.storedProject(name)),
  updateProject: (name, change) => lift(() => store.updateProject(name, change)),
  removeProject: name => lift(() => store.removeProject(name)),
  unlanded: name => lift(() => store.unlanded(name)),
  holders: name => lift(() => store.holders(name)),
  projectEvents: name => lift(() => store.projectEvents(name)),
  room: id => lift(() => store.room(id)),
  defer: (id, deferred) => lift(() => store.defer(id, deferred)),
  get: id => lift(() => store.get(id)),
  list: () => lift(() => store.list()),
  inspect: id => lift(() => store.inspect(id)),
  events: (id, after) => lift(() => store.events(id, after)),
  decisions: taskId => lift(() => store.decisions(taskId)),
  answer: (decisionId, status, answer) => lift(() => store.answer(decisionId, status, answer)),
  steer: (id, text) => lift(() => store.steer(id, text)),
  steers: id => lift(() => store.steers(id)),
  requeueSteer: steerId => lift(() => store.requeueSteer(steerId)),
  cancel: id => lift(() => store.cancel(id)),
  mergeRecords: id => lift(() => store.mergeRecords(id)),
  merges: id => lift(() => store.merges(id)),
  approve: (id, request) => lift(() => store.approve(id, request)),
  flag: (id, reason) => lift(() => store.flag(id, reason)),
  delivery: (id, state, commit) => Effect.acquireRelease(lift(() => store.beginDelivery(id, state, commit)), token => Effect.sync(() => store.endDelivery(id, token)))
    .pipe(Effect.map((token): Delivery => ({
      record: (type, data) => lift(() => store.recordDelivery(id, token, type, data)),
      publish: (pr, type) => lift(() => store.publish(id, token, pr, type)),
      finish: proof => lift(() => store.finishLanding(id, token, proof)),
    }))),
  validation: (id, state, commit) => Effect.acquireRelease(lift(() => store.beginDelivery(id, state, commit)), token => Effect.sync(() => store.endDelivery(id, token)))
    .pipe(Effect.map((token): Validating => ({
      start: () => lift(() => store.startValidation(id, token)),
      run: (validationId, runId) => lift(() => store.validationRun(id, token, validationId, runId)),
      responses: (validationId, runId, step) => lift(() => store.responses(id, validationId, runId, step)),
      gate: (validationId, gate) => lift(() => store.recordGate(id, token, validationId, gate)),
      respond: response => lift(() => store.respondGate(id, token, response)),
      hold: (validationId, gate, question) => lift(() => store.openHold(id, token, validationId, gate, question)),
      pass: (validationId, result) => lift(() => store.passValidation(id, token, validationId, result)),
      fail: (validationId, result) => lift(() => store.failValidation(id, token, validationId, result)),
    }))),
  validations: id => lift(() => store.validations(id)),
  landing: id => lift(() => store.landing(id)),
  recordRefresh: (id, type, data) => lift(() => store.recordRefresh(id, type, data)),
  authorizeDiscard: (id, reason, head) => lift(() => store.authorizeDiscard(id, reason, head)),
  discardAuthorization: id => lift(() => store.discardAuthorization(id)),
  refuseCleanup: (id, reason) => lift(() => store.refuseCleanup(id, reason)),
  cleanup: id => Effect.acquireRelease(lift(() => store.beginCleanup(id)), token => Effect.sync(() => store.endDelivery(id, token)))
    .pipe(Effect.map((token): Cleanup => ({ finish: cleaned => lift(() => store.finishCleanup(id, token, cleaned)) }))),
  holds: taskId => lift(() => store.holds(taskId)),
  answerHold: (holdId, request) => lift(() => store.answerHold(holdId, request)),
  itemHolds: itemId => lift(() => store.itemHolds(itemId)),
  items: () => lift(() => store.items()),
  archivedItems: () => lift(() => store.archivedItems()),
  item: id => lift(() => store.item(id)),
  itemOf: taskId => lift(() => store.itemOf(taskId)),
  itemEvents: id => lift(() => store.itemEvents(id)),
  addItem: input => lift(() => store.addItem(input)),
  updateItem: (id, change) => lift(() => store.updateItem(id, change)),
  removeItem: id => lift(() => store.removeItem(id)),
  waiting: item => lift(() => store.waiting(item)),
  checkDispatch: id => lift(() => store.checkDispatch(id)),
  holdItem: (itemId, request) => lift(() => store.holdItem(itemId, request)),
  answerItem: (itemId, request) => lift(() => store.answerItem(itemId, request)),
  attest: (taskId, items, none) => lift(() => store.attest(taskId, items, none)),
  attestation: taskId => lift(() => store.attestation(taskId)),
  verifyAttestation: taskId => lift(() => store.verifyAttestation(taskId)),
  diverged: () => lift(() => store.diverged()),
  backlogSettings: () => lift(() => store.backlogSettings()),
  setBacklogSettings: settings => lift(() => store.setBacklogSettings(settings)),
  controls: id => lift(() => store.controls(id)),
  requestControl: (id, request) => lift(() => store.requestControl(id, request)),
  supervisor: () => lift(() => store.supervisor()),
  supervision: () => lift(() => store.supervision()),
  requestStop: () => lift(() => store.requestStop()),
  requestDrain: drain => lift(() => store.requestDrain(drain)),
  wakes: consumer => lift(() => store.wakes(consumer)),
  presentWakes: consumer => lift(() => store.presentWakes(consumer)),
  acknowledgeWakes: (consumer, generation, through) => lift(() => store.acknowledgeWakes(consumer, generation, through)),
  identity: () => lift(() => store.identity()),
  secondmates: () => lift(() => store.secondmates()),
  secondmate: id => lift(() => store.secondmate(id)),
  secondmateEvents: id => lift(() => store.secondmateEvents(id)),
  addSecondmate: secondmate => lift(() => store.addSecondmate(secondmate)),
  launched: (id, pid, by, args) => lift(() => store.launched(id, pid, by, args)),
  exited: (id, pid, detail) => lift(() => store.exited(id, pid, detail)),
  exhaust: id => lift(() => store.exhaust(id)),
  stopped: (id, reason) => lift(() => store.stopped(id, reason)),
  refuseRetire: (id, reasons) => lift(() => store.refuseRetire(id, reasons)),
  retire: id => lift(() => store.retire(id)),
  pushedPreferences: (id, generation) => lift(() => store.pushedPreferences(id, generation)),
  preferences: () => lift(() => store.preferences()),
  accountPins: () => lift(() => store.accountPins()),
  accountPin: runtime => lift(() => store.accountPin(runtime)),
  setAccountPin: (runtime, root) => lift(() => store.setAccountPin(runtime, root)),
  setPreferences: text => lift(() => store.setPreferences(text)),
  requests: secondmate => lift(() => store.requests(secondmate)),
  request: correlation => lift(() => store.request(correlation)),
  createRequest: (secondmate, work) => lift(() => store.createRequest(secondmate, work)),
  deliverRequest: correlation => lift(() => store.deliverRequest(correlation)),
  mirror: (correlation, published) => lift(() => store.mirror(correlation, published)),
  handoffs: secondmate => lift(() => store.handoffs(secondmate)),
  prepareHandoff: (secondmate, items, routed) => lift(() => store.prepareHandoff(secondmate, items, routed)),
  placeHandoff: (id, recovered) => lift(() => store.placeHandoff(id, recovered)),
  restoreHandoff: (id, reason) => lift(() => store.restoreHandoff(id, reason)),
  handoffOf: itemId => lift(() => store.handoffOf(itemId)),
  localOnly: project => lift(() => store.localOnly(project)),
  noteRouting: (itemId, decision) => lift(() => store.noteRouting(itemId, decision)),
  inbox: () => lift(() => store.inbox()),
  accept: correlation => lift(() => store.accept(correlation)),
  publishStatus: (correlation, lines) => lift(() => store.publishStatus(correlation, lines)),
  unlandedWork: () => lift(() => store.unlandedWork()),
  homeEvents: after => lift(() => store.homeEvents(after)),
  posture: () => lift(() => store.posture()),
  postures: () => lift(() => store.postures()),
  postureById: id => lift(() => store.postureById(id)),
  enterPosture: (mode, words) => lift(() => store.enterPosture(mode, words)),
  endPosture: (by, command) => lift(() => store.endPosture(by, command ?? null)),
  triaged: posture => lift(() => store.triaged(posture)),
  eventsSince: (types, since) => lift(() => store.eventsSince(types, since)),
  itemEventsSince: (types, since) => lift(() => store.itemEventsSince(types, since)),
  noteMemory: (file, change, generation, bytes) => lift(() => store.noteMemory(file, change, generation, bytes)),
  stow: learnings => lift(() => store.stow(learnings)),
  changes: (id, pollMs) => Stream.fromEffectSchedule(lift(() => store.latest(id)), Schedule.spaced(pollMs)).pipe(
    Stream.changesWith((a, b) => a.sequence === b.sequence),
    Stream.broadcast({ capacity: 1, strategy: "sliding", replay: 1 })),
  acquire: (id, resume, supervisor) => Effect.gen(function*() {
    const token = yield* Effect.acquireRelease(lift(() => store.acquire(id, resume, supervisor)), token => Effect.sync(() => store.release(id, token)));
    return attempt(store, yield* lift(() => store.get(id)), token);
  }),
  supervise: settings => Effect.acquireRelease(lift(() => store.superviseHome(settings)), ({ record }) => Effect.sync(() => store.releaseHome(record.generation)))
    .pipe(Effect.map(({ record, reclaimed }) => supervision(store, record.generation, reclaimed))),
});

export class TaskStore extends Context.Service<TaskStore, TaskStoreShape>()("firstmate/TaskStore") {
  static layer(home: string) {
    return Layer.effect(TaskStore, Effect.acquireRelease(lift(() => new Store(home)), store => Effect.sync(() => store.close()))
      .pipe(Effect.map(service)));
  }
}
