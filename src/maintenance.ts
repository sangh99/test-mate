import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { appError, InvalidTransition, NotFound, type FirstmateError } from "./domain.js";
import type { Store } from "./store.js";

/**
 * The durable records of fleet maintenance: self-update runs and the Bash
 * Firstmate records an explicit import brought in. Each change and its home
 * history entry commit in one transaction of the main home's store.
 */

const now = () => new Date().toISOString();

/** One home an update stops and restarts: what ran before, and what the update did with it. */
export const UpdateHome = Schema.Struct({
  home: Schema.String,
  /** The secondmate the home belongs to; null for the main home. */
  secondmate: Schema.NullOr(Schema.String),
  /** The supervisor that held the home when the update planned it; null when none ran, so nothing is restarted. */
  pid: Schema.NullOr(Schema.Number),
  /** The arguments its replacement starts with, from the stopped supervisor's own settings. */
  args: Schema.Array(Schema.String),
  /** drained once the supervisor stopped on the drain request; restarted, left-running when a refused update withdrew the drain, or failed. */
  outcome: Schema.NullOr(Schema.Literals(["drained", "restarted", "left-running", "failed"])),
  /** The replacement supervisor's PID once it held the home's lease. */
  restartedPid: Schema.NullOr(Schema.Number),
  detail: Schema.NullOr(Schema.String),
});
export type UpdateHome = typeof UpdateHome.Type;

/**
 * A self-update run, recorded before any supervisor is asked to drain so an
 * interrupted run is finished by `update resume`. Phases: draining,
 * installing, restarting, then finished; refused when a home was unsafe or
 * did not drain in time, failed when the install failed (its homes are
 * restarted on the version already installed).
 */
export const UpdateSchema = Schema.Struct({
  id: Schema.String,
  /** The npm package spec installed: a version, tag, tarball, or registry name. */
  spec: Schema.String,
  installation: Schema.Struct({ root: Schema.String, mode: Schema.Literals(["global", "local"]), prefix: Schema.String }),
  from: Schema.String,
  to: Schema.NullOr(Schema.String),
  phase: Schema.Literals(["draining", "installing", "restarting", "finished", "refused", "failed"]),
  homes: Schema.Array(UpdateHome),
  reasons: Schema.Array(Schema.String),
  /** The install's output tail. */
  output: Schema.NullOr(Schema.String),
  startedAt: Schema.String,
  updatedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
});
export type Update = typeof UpdateSchema.Type;
const decodeUpdate = Schema.decodeUnknownSync(UpdateSchema);
const done = (phase: Update["phase"]) => phase === "finished" || phase === "refused" || phase === "failed";

/** One imported record: where it came from, its content hash, and what it became here. */
export const ImportSchema = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["project", "item", "hold", "preferences", "shared", "learnings"]),
  source: Schema.String,
  digest: Schema.String,
  target: Schema.String,
  importedAt: Schema.String,
});
export type Import = typeof ImportSchema.Type;
const decodeImport = Schema.decodeUnknownSync(ImportSchema);

export class Maintenance {
  constructor(private readonly store: Store) {}

  private get db() { return this.store.db; }

  private event(type: string, data: unknown) {
    this.db.prepare("INSERT INTO home_events(type, data, created_at) VALUES (?, ?, ?)").run(type, JSON.stringify(data), now());
  }

  private save(update: Update): Update {
    const checked = decodeUpdate(update);
    this.db.prepare("INSERT INTO updates VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json")
      .run(checked.id, done(checked.phase) ? "finished" : "active", JSON.stringify(checked));
    return checked;
  }

  /** Records a new run; refused while another is unfinished. A run refused before it changed anything is recorded finished. */
  beginUpdate(plan: Omit<Update, "id" | "startedAt" | "updatedAt" | "finishedAt">): Update {
    return this.store.transaction(() => {
      const active = this.activeUpdate();
      if (active) throw new InvalidTransition({ message: `Update ${active.id} is unfinished (${active.phase}); firstmate update resume finishes it` });
      const timestamp = now();
      const update = this.save({ ...plan, id: `update-${randomUUID().slice(0, 8)}`, startedAt: timestamp, updatedAt: timestamp, finishedAt: done(plan.phase) ? timestamp : null });
      this.event(update.phase === "refused" ? "update.refused" : "update.started", { id: update.id, spec: update.spec, from: update.from, homes: update.homes.map(h => h.home), reasons: update.reasons });
      return update;
    });
  }

  /** Moves a run on; a finishing phase closes it. */
  advanceUpdate(id: string, change: Partial<Pick<Update, "phase" | "homes" | "reasons" | "to" | "output">>): Update {
    return this.store.transaction(() => {
      const update = this.update(id);
      if (done(update.phase)) throw new InvalidTransition({ message: `Update ${id} is already ${update.phase}` });
      const timestamp = now();
      const next = this.save({ ...update, ...change, updatedAt: timestamp, finishedAt: change.phase && done(change.phase) ? timestamp : null });
      if (done(next.phase)) this.event(`update.${next.phase}`, { id, from: next.from, to: next.to, homes: next.homes.map(h => ({ home: h.home, outcome: h.outcome })), reasons: next.reasons });
      return next;
    });
  }

  update(id: string): Update {
    const row = this.db.prepare("SELECT json FROM updates WHERE id = ?").get(id);
    if (!row) throw new NotFound({ message: `No update "${id}"` });
    return decodeUpdate(JSON.parse(String(row.json)));
  }

  activeUpdate(): Update | null {
    const row = this.db.prepare("SELECT json FROM updates WHERE status = 'active'").get();
    return row ? decodeUpdate(JSON.parse(String(row.json))) : null;
  }

  /** Every run, oldest first. */
  updates(): Update[] {
    return this.db.prepare("SELECT json FROM updates ORDER BY rowid").all().map(row => decodeUpdate(JSON.parse(String(row.json))));
  }

  imported(key: string): Import | null {
    const row = this.db.prepare("SELECT json FROM imports WHERE key = ?").get(key);
    return row ? decodeImport(JSON.parse(String(row.json))) : null;
  }

  imports(): Import[] {
    return this.db.prepare("SELECT json FROM imports ORDER BY rowid").all().map(row => decodeImport(JSON.parse(String(row.json))));
  }

  /**
   * Remembers one imported record under its source key, after the record's
   * own change committed; refused when the key is already remembered, so a
   * record is imported at most once. Each importer also refuses a target
   * that already exists, which covers an interruption between the two.
   */
  recordImport(entry: Omit<Import, "importedAt">): Import {
    return this.store.transaction(() => {
      if (this.imported(entry.key)) throw new InvalidTransition({ message: `${entry.key} was already imported` });
      const record = decodeImport({ ...entry, importedAt: now() });
      this.db.prepare("INSERT INTO imports VALUES (?, ?, ?)").run(record.key, record.kind, JSON.stringify(record));
      this.event("import.record", { key: record.key, kind: record.kind, target: record.target, source: record.source });
      return record;
    });
  }
}

type Op<A> = Effect.Effect<A, FirstmateError>;
export type MaintenanceOps = { readonly [K in keyof Maintenance]: Maintenance[K] extends (...args: infer P) => infer R ? (...args: P) => Op<R> : never };

export function maintenanceOps(maintenance: Maintenance): MaintenanceOps {
  const ops: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(Maintenance.prototype)) {
    if (name === "constructor") continue;
    const method = (maintenance as unknown as Record<string, unknown>)[name];
    if (typeof method !== "function") continue;
    ops[name] = (...args: unknown[]) => Effect.try({ try: () => (method as (...a: unknown[]) => unknown).apply(maintenance, args), catch: appError });
  }
  return ops as MaintenanceOps;
}
