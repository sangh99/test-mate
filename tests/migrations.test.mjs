import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture, exec } from "./helpers.mjs";
import { Store } from "../dist/index.js";
import { migrations } from "../dist/migrations.js";

/** The inline schema the store created before migrations existed. */
const legacy = `
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS leases (task_id TEXT PRIMARY KEY REFERENCES tasks(id), token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), generation TEXT, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS events_task ON events(task_id, sequence);
  CREATE INDEX IF NOT EXISTS decisions_task ON decisions(task_id);
  CREATE TABLE IF NOT EXISTS steers (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), sequence INTEGER NOT NULL, json TEXT NOT NULL, UNIQUE(task_id, sequence));
  PRAGMA user_version = 2;
`;

const raw = (home, f) => {
  const db = new DatabaseSync(join(home, "firstmate.sqlite"));
  try { return f(db); } finally { db.close(); }
};
const schema = home => raw(home, db => ({
  version: db.prepare("PRAGMA user_version").get().user_version,
  objects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").all().map(row => ({ ...row })),
}));
const scratch = async t => {
  const root = await mkdtemp(join(tmpdir(), "firstmate-app-migrations-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
};
const legacyHome = async t => {
  const home = await scratch(t);
  raw(home, db => db.exec(legacy));
  return home;
};
const unreachable = migrations.map(({ version }) => ({ version, sql: "SELECT * FROM step_must_not_run" }));
const upgraded = async t => {
  const home = await legacyHome(t);
  new Store(home).close();
  return home;
};

test("a fresh home opened by two processes at once matches an upgraded pre-migration home", async t => {
  const home = join(await scratch(t), "home");
  const script = `import { Store } from ${JSON.stringify(new URL("../dist/store.js", import.meta.url).href)};
    new Store(process.argv[1]).close();`;
  await Promise.all([1, 2].map(() => exec(process.execPath, ["--input-type=module", "-e", script, home])));
  assert.deepEqual(schema(home), schema(await upgraded(t)));
  assert.equal(schema(home).version, 14);
});

test("an up-to-date home with data opens without running any step", async t => {
  const f = await fixture(t);
  const before = schema(f.home);
  const s = new Store(f.home, unreachable);
  try { assert.equal(s.get(f.task.id).run.state, "queued"); } finally { s.close(); }
  assert.deepEqual(schema(f.home), before);
  assert.deepEqual(before, schema(await upgraded(t)));
});

test("a version-1 home gains only the missing step and keeps its rows", async t => {
  const home = await scratch(t);
  new Store(home, migrations.slice(0, 1)).close();
  raw(home, db => db.exec(`INSERT INTO tasks VALUES ('kept', '{}')`));
  new Store(home, [unreachable[0], migrations[1]]).close();
  assert.deepEqual(schema(home), schema(await legacyHome(t)));
  assert.equal(raw(home, db => db.prepare("SELECT id FROM tasks").get().id), "kept");
});

test("a database newer than the code refuses to open and stays unchanged", async t => {
  const f = await fixture(t);
  raw(f.home, db => db.exec("PRAGMA user_version = 15"));
  assert.throws(() => f.store(), error => error._tag === "AppError" && /version 15 is newer than this firstmate supports \(14\); upgrade firstmate/.test(error.message));
  assert.equal(schema(f.home).version, 15);
});

test("a failing step rolls back and leaves the version unchanged", async t => {
  const f = await fixture(t);
  const before = schema(f.home);
  const failing = [...migrations, { version: 15, sql: "CREATE TABLE partial (x); SELECT * FROM missing_table;" }];
  assert.throws(() => new Store(f.home, failing), /Migration to database version 15 failed: no such table: missing_table/);
  assert.deepEqual(schema(f.home), before);
  const s = f.store();
  try { assert.equal(s.get(f.task.id).run.state, "queued"); } finally { s.close(); }
});
