import type { DatabaseSync } from "node:sqlite";
import { AppError } from "./domain.js";

/** One forward schema step; `version` is the `user_version` the database holds once it commits. */
export interface Migration {
  readonly version: number;
  readonly sql: string;
  /**
   * The step rebuilds a table other tables reference, so it runs with
   * foreign-key enforcement off, as SQLite's table-rebuild procedure
   * requires, and commits only when a foreign-key check then finds nothing.
   */
  readonly rebuild?: boolean;
}

/**
 * The schema's whole history, oldest first. Append a step to change the
 * schema; never edit one that has shipped, because homes already record it.
 */
export const migrations: readonly Migration[] = [
  { version: 1, sql: `
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leases (task_id TEXT PRIMARY KEY REFERENCES tasks(id), token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), generation TEXT, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_task ON events(task_id, sequence);
    CREATE INDEX IF NOT EXISTS decisions_task ON decisions(task_id);
  ` },
  { version: 2, sql: `
    CREATE TABLE IF NOT EXISTS steers (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE(task_id, sequence));
  ` },
  // The classifier starts after the history that existed before supervision,
  // so upgrading a home never replays its past as new wakes.
  { version: 3, sql: `
    ALTER TABLE leases ADD COLUMN active_at TEXT;
    CREATE TABLE IF NOT EXISTS supervisor (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
    INSERT INTO cursors SELECT 'classifier', COALESCE(MAX(sequence), 0) FROM events;
    CREATE TABLE IF NOT EXISTS consumers (name TEXT PRIMARY KEY, generation TEXT NOT NULL, claimed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wakes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, consumer TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, claim TEXT, updated_at TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS wakes_open ON wakes(consumer, status, sequence);
    CREATE TABLE IF NOT EXISTS controls (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS controls_task ON controls(task_id);
  ` },
  // Delivery adds task states (local-ready, landed) and record fields that an
  // older firstmate cannot decode, so the version bump makes it refuse the
  // home. Merge authority reads a task's approval and flag events by type.
  { version: 4, sql: `
    CREATE INDEX IF NOT EXISTS events_task_type ON events(task_id, type, sequence);
  ` },
  // Forge delivery adds the pr-open state, the task record's pr field, PR
  // events, and forge landing proof. Existing rows need no rewrite, so the
  // step only bumps the version that makes an older firstmate refuse the home.
  { version: 5, sql: "" },
  // Validation adds the validating state, pipeline validation records, and
  // holds: open questions only the captain's recorded answer closes.
  { version: 6, sql: `
    CREATE TABLE IF NOT EXISTS validations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS validations_task ON validations(task_id);
    CREATE TABLE IF NOT EXISTS holds (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS holds_open ON holds(status, task_id);
  ` },
  // Cleanup adds the cleaned state, the refresh wake, and cleanup, discard,
  // and clone-refresh events. Discard authorizations are events read by type
  // through events_task_type, so existing rows need no rewrite; the step only
  // bumps the version that makes an older firstmate refuse the home.
  { version: 7, sql: "" },
  // The project registry: one row per registered project and the registry's
  // own event history. Tasks gain an optional project name and intake and
  // deferral events; existing tasks stay unregistered and keep working.
  { version: 8, sql: `
    CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS project_events_project ON project_events(project, sequence);
  ` },
  // The backlog: items, their history, archived done items, and home
  // settings. Holds generalize to hold any item, so the holds table gains
  // item_id and a nullable task_id. Each validation hold recorded before the
  // backlog becomes a captain item of its own (held while open, done once
  // answered), keeping its id, question, gate, and verbatim answer.
  { version: 9, sql: `
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, status TEXT NOT NULL, task_id TEXT, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS items_task ON items(task_id);
    CREATE TABLE IF NOT EXISTS item_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS item_events_item ON item_events(item_id, sequence);
    CREATE TABLE IF NOT EXISTS archived_items (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE holds_v9 (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), status TEXT NOT NULL, json TEXT NOT NULL);
    INSERT INTO items SELECT 'gate-' || substr(id, 1, 12), CASE status WHEN 'open' THEN 'held' ELSE 'done' END, NULL, json_object(
      'id', 'gate-' || substr(id, 1, 12),
      'title', 'Validation gate ' || json_extract(json, '$.subject.gate.step') || ' of task ' || task_id,
      'kind', 'captain', 'project', NULL, 'prompt', NULL,
      'status', CASE status WHEN 'open' THEN 'held' ELSE 'done' END,
      'dependsOn', json('[]'), 'deferUntil', NULL,
      'notes', json_array(json_object('at', json_extract(json, '$.createdAt'), 'by', 'host', 'text', 'Held for the captain before the backlog existed; migrated as its own captain item')),
      'taskId', NULL,
      'hold', CASE status WHEN 'open' THEN id ELSE NULL END,
      'outcome', CASE status WHEN 'open' THEN NULL ELSE json_object('basis', 'answered', 'taskId', NULL, 'detail', 'Answered by the captain before the backlog existed', 'at', json_extract(json, '$.updatedAt')) END,
      'doneAt', CASE status WHEN 'open' THEN NULL ELSE json_extract(json, '$.updatedAt') END,
      'createdAt', json_extract(json, '$.createdAt'), 'updatedAt', json_extract(json, '$.updatedAt')
    ) FROM holds;
    INSERT INTO holds_v9 SELECT id, 'gate-' || substr(id, 1, 12), task_id, status,
      json_set(json, '$.itemId', 'gate-' || substr(id, 1, 12), '$.until', NULL, '$.origin', NULL) FROM holds;
    INSERT INTO item_events(item_id, type, data, created_at)
      SELECT 'gate-' || substr(id, 1, 12), 'item.migrated', json_object('hold', id), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM holds;
    DROP TABLE holds;
    ALTER TABLE holds_v9 RENAME TO holds;
    CREATE INDEX IF NOT EXISTS holds_open ON holds(status, task_id);
    CREATE INDEX IF NOT EXISTS holds_item ON holds(item_id);
  ` },
  // Secondmates: the main home's registry, its history, its correlated
  // requests and backlog handoffs, and a secondmate home's inbox of routed
  // requests with the status it publishes. A home's secondmate identity and
  // shared captain preferences are settings rows, so existing homes need no
  // rewrite and stay main homes.
  { version: 10, sql: `
    CREATE TABLE IF NOT EXISTS secondmates (id TEXT PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS secondmate_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, secondmate TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS secondmate_events_secondmate ON secondmate_events(secondmate, sequence);
    CREATE TABLE IF NOT EXISTS requests (correlation TEXT PRIMARY KEY, secondmate TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS requests_secondmate ON requests(secondmate, status);
    CREATE TABLE IF NOT EXISTS handoffs (id TEXT PRIMARY KEY, secondmate TEXT NOT NULL, phase TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS handoffs_phase ON handoffs(phase, secondmate);
    CREATE TABLE IF NOT EXISTS inbox (correlation TEXT PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL);
  ` },
  // Dispatch adds the task record's dispatch decision, the dispatch.resolved
  // event, and account pins as settings rows. Existing tasks carry no
  // decision and keep running on Claude, so the step only bumps the version
  // that makes an older firstmate refuse the home.
  { version: 11, sql: "" },
  // Posture and memory: away and quiet sessions (at most one active), how
  // each captain wake a session saw was triaged, and the home's own history
  // of posture, memory, and stow changes. Existing homes start present with
  // no history; memory files live beside the database.
  { version: 12, sql: `
    CREATE TABLE IF NOT EXISTS postures (id TEXT PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS postures_active ON postures(status) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS triaged (wake INTEGER PRIMARY KEY REFERENCES wakes(sequence), posture TEXT NOT NULL REFERENCES postures(id), verdict TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS triaged_posture ON triaged(posture, verdict);
    CREATE TABLE IF NOT EXISTS home_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
  ` },
  // Integrations and events: the wake queue gains wakes about no task (an
  // extension's record is their subject), so its table is rebuilt with a
  // nullable task_id, keeping every row and sequence, by SQLite's rebuild
  // procedure; triage rows keep pointing at the same sequences. Process sources and their captured
  // results, captain inbox notes and replies, Relay mentions and promised
  // final replies, upstream links and signals, and the outbox start empty.
  { version: 13, rebuild: true, sql: `
    CREATE TABLE wakes_v13 (sequence INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, consumer TEXT NOT NULL, task_id TEXT REFERENCES tasks(id), status TEXT NOT NULL, claim TEXT, updated_at TEXT NOT NULL, json TEXT NOT NULL);
    INSERT INTO wakes_v13 SELECT sequence, key, consumer, task_id, status, claim, updated_at, json FROM wakes;
    DROP TABLE wakes;
    ALTER TABLE wakes_v13 RENAME TO wakes;
    CREATE INDEX IF NOT EXISTS wakes_open ON wakes(consumer, status, sequence);
    CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_results (source TEXT NOT NULL REFERENCES sources(id), sequence INTEGER NOT NULL, registration TEXT NOT NULL, handled_at TEXT, json TEXT NOT NULL, PRIMARY KEY (source, sequence));
    CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, request_id TEXT UNIQUE, status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS note_replies (sequence INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL UNIQUE REFERENCES notes(id), json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mentions (request_id TEXT PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commitments (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES mentions(request_id), task_id TEXT REFERENCES tasks(id), status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS commitments_task ON commitments(task_id, status);
    CREATE TABLE IF NOT EXISTS upstream_links (id TEXT PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS upstream_signals (key TEXT PRIMARY KEY, link TEXT NOT NULL REFERENCES upstream_links(id), status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS upstream_signals_link ON upstream_signals(link, status);
    CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL);
  ` },
  // Fleet maintenance: self-update runs (at most one active), each recording
  // its plan before it drains a supervisor, and the Bash Firstmate records an
  // explicit import brought in, keyed by source so a repeat imports nothing
  // twice. A supervisor record's drain request is an optional field, so the
  // lease row needs no rewrite.
  { version: 14, sql: `
    CREATE TABLE IF NOT EXISTS updates (id TEXT PRIMARY KEY, status TEXT NOT NULL, json TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS updates_active ON updates(status) WHERE status = 'active';
    CREATE TABLE IF NOT EXISTS imports (key TEXT PRIMARY KEY, kind TEXT NOT NULL, json TEXT NOT NULL);
  ` },
];

const versionOf = (db: DatabaseSync) => Number(db.prepare("PRAGMA user_version").get()?.user_version);

/**
 * Brings the database up to the last step, each missing step in its own
 * write transaction. The version is re-read under the write lock, so a
 * concurrent opener that already applied a step makes it a no-op here, and a
 * failed step rolls back with the version unchanged. An up-to-date database
 * is only read.
 */
export function migrate(db: DatabaseSync, steps: readonly Migration[] = migrations) {
  steps.forEach((step, index) => {
    if (step.version !== index + 1) throw new AppError({ message: `Migration ${index + 1} is numbered ${step.version}` });
  });
  const latest = steps.length;
  const refuseNewer = (version: number) => {
    if (version > latest) throw new AppError({ message: `Database version ${version} is newer than this firstmate supports (${latest}); upgrade firstmate to open this home` });
  };
  const start = versionOf(db);
  refuseNewer(start);
  for (const step of steps.slice(start)) {
    // Enforcement can only change outside a transaction; it is restored after the step either way.
    const enforced = Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys) === 1;
    if (step.rebuild) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      const version = versionOf(db);
      refuseNewer(version);
      if (version < step.version) {
        db.exec(`${step.sql}\nPRAGMA user_version = ${step.version};`);
        const violation = step.rebuild ? db.prepare("PRAGMA foreign_key_check").get() : undefined;
        if (violation) throw new Error(`foreign key check failed in table ${String(violation.table)}`);
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      if (error instanceof AppError) throw error;
      throw new AppError({ message: `Migration to database version ${step.version} failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      if (step.rebuild && enforced) db.exec("PRAGMA foreign_keys = ON");
    }
  }
}
