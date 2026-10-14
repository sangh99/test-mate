import test from "node:test";
import assert from "node:assert/strict";
import { fixture, exec } from "./helpers.mjs";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Fiber, Scope, Stream } from "effect";
import { encodeTask, TaskStore } from "../dist/index.js";

const withTaskStore = (f, use) => Effect.runPromise(Effect.gen(function*() { return yield* use(yield* TaskStore); })
  .pipe(Effect.provide(TaskStore.layer(f.home))));

test("task creation and events survive closing the database", async t => {
  const f = await fixture(t);
  const first = f.store();
  assert.equal(first.get(f.task.id).run.state, "queued");
  first.close();
  const second = f.store();
  try { assert.equal(second.events(f.task.id)[0].type, "task.created"); } finally { second.close(); }
});

test("live ownership excludes a second connection and a second process", async t => {
  const f = await fixture(t);
  const first = f.store(); const second = f.store();
  try {
    const token = first.acquire(f.task.id, false);
    assert.throws(() => second.acquire(f.task.id, true), /live owner/);
    const script = `import { Store } from ${JSON.stringify(new URL("../dist/store.js", import.meta.url).href)};
      const s = new Store(process.argv[1]);
      try { s.acquire(process.argv[2], true); process.exitCode = 3; }
      catch(e) { console.log(e.message); } finally { s.close(); }`;
    const child = await exec(process.execPath, ["--input-type=module", "-e", script, f.home, f.task.id]);
    assert.match(child.stdout, /live owner/);
    first.release(f.task.id, token);
  } finally { first.close(); second.close(); }
});

test("invalid transitions roll back the projection and event together", async t => {
  const f = await fixture(t); const s = f.store();
  try {
    const token = s.acquire(f.task.id, false);
    const before = s.events(f.task.id).length;
    assert.throws(() => s.update(f.task.id, token, { state: "completed" }, "bad.event"), /Invalid transition/);
    assert.equal(s.get(f.task.id).run.state, "provisioning");
    assert.equal(s.events(f.task.id).length, before);
    s.release(f.task.id, token);
  } finally { s.close(); }
});

test("unrelated progress never hides open decisions; answers close only their own key", async t => {
  const f = await fixture(t); const s = f.store();
  try {
    const token = s.acquire(f.task.id, false);
    s.update(f.task.id, token, { state: "running" }, "running");
    const one = s.requestDecision(f.task.id, token, "Bash", { command: "npm test" });
    const two = s.requestDecision(f.task.id, token, "Write", { file_path: "a.ts" });
    s.record(f.task.id, token, "progress", { text: "working" });
    s.answer(one.id, "allow", "");
    assert.equal(s.get(f.task.id).run.state, "waiting");
    assert.equal(s.decisions(f.task.id).filter(d => d.status === "pending").length, 1);
    s.answer(two.id, "deny", "Do not create this file");
    assert.equal(s.get(f.task.id).run.state, "running");
    assert.throws(() => s.answer(two.id, "allow", ""), /no longer pending/);
    s.release(f.task.id, token);
  } finally { s.close(); }
});

test("new generation expires old approvals and rejects old writes", async t => {
  const f = await fixture(t); const s = f.store();
  try {
    const old = s.acquire(f.task.id, false);
    s.update(f.task.id, old, { state: "running" }, "running");
    const decision = s.requestDecision(f.task.id, old, "Bash", { command: "echo hello" });
    s.release(f.task.id, old);
    const current = s.acquire(f.task.id, true);
    assert.throws(() => s.record(f.task.id, old, "late", {}), /Stale/);
    assert.throws(() => s.answer(decision.id, "allow", ""), /Stale/);
    assert.equal(s.decisions(f.task.id)[0].status, "expired");
    s.release(f.task.id, old);
    assert.equal(s.inspect(f.task.id).owner, "live");
    s.release(f.task.id, current);
  } finally { s.close(); }
});

test("crashed owner is unknown until explicit recovery, without losing its session", async t => {
  const f = await fixture(t);
  const modulePath = fileURLToPath(new URL("../dist/store.js", import.meta.url));
  const script = `import { pathToFileURL } from 'node:url';
    const { Store } = await import(pathToFileURL(process.argv[1]).href);
    const s = new Store(process.argv[2]); const token = s.acquire(process.argv[3], false);
    s.update(process.argv[3], token, {state:'running', sessionId:'persisted-session'}, 'session');
    s.close();`;
  await exec(process.execPath, ["--input-type=module", "-e", script, modulePath, f.home, f.task.id]);
  const s = f.store();
  try {
    assert.equal(s.inspect(f.task.id).observedState, "unknown");
    assert.throws(() => s.acquire(f.task.id, false), /use resume/);
    const token = s.acquire(f.task.id, true);
    assert.equal(s.get(f.task.id).run.sessionId, "persisted-session");
    assert.ok(s.events(f.task.id).some(e => e.type === "run.interrupted"));
    s.release(f.task.id, token);
  } finally { s.close(); }
});

test("queued cancellation is terminal and event pagination is monotonic", async t => {
  const f = await fixture(t); const s = f.store();
  try {
    const created = s.events(f.task.id).at(-1);
    s.cancel(f.task.id);
    assert.equal(s.get(f.task.id).run.state, "cancelled");
    assert.deepEqual(s.events(f.task.id, created.sequence).map(e => e.type), ["cancel.requested"]);
    assert.throws(() => s.acquire(f.task.id, false), /use resume/);
  } finally { s.close(); }
});

test("cancellation committed before completion prevents a success transition", async t => {
  const f = await fixture(t); const s = f.store();
  try {
    const token = s.acquire(f.task.id, false);
    s.update(f.task.id, token, { state: "running" }, "running");
    s.cancel(f.task.id);
    assert.throws(() => s.update(f.task.id, token, { state: "ready" }, "task.result"), /Cancellation/);
    assert.equal(s.get(f.task.id).run.state, "running");
    s.release(f.task.id, token);
  } finally { s.close(); }
});

test("a task stored before the intake and run split decodes and round-trips unchanged", async t => {
  const f = await fixture(t); const s = f.store();
  try {
    const raw = id => s.db.prepare("SELECT json FROM tasks WHERE id = ?").get(id).json;
    assert.deepEqual(Object.keys(JSON.parse(raw(f.task.id))), ["project", "base", "id", "kind", "prompt", "branch", "worktree", "delivery", "yolo", "target", "state",
      "generation", "sessionId", "model", "maxTurns", "maxBudgetUsd", "costUsd", "output", "error", "cancelRequested", "dispatch", "createdAt", "updatedAt"]);
    const id = "00000000-0000-4000-8000-0000000000aa";
    const intake = { kind: "scout", prompt: "Survey the code", project: f.project, base: f.task.intake.base, branch: `firstmate/${id}`,
      worktree: `${f.home}/worktrees/${id}`, model: "claude-test", maxTurns: 7, maxBudgetUsd: 1.5 };
    const run = { state: "interrupted", generation: "old-generation", sessionId: "old-session", costUsd: 0.25, output: "partial",
      error: "boom", cancelRequested: false, updatedAt: "2026-10-12T01:00:00.000Z" };
    const legacy = JSON.stringify({ id, kind: intake.kind, prompt: intake.prompt, project: intake.project, base: intake.base,
      branch: intake.branch, worktree: intake.worktree, state: run.state, generation: run.generation, sessionId: run.sessionId,
      model: intake.model, maxTurns: intake.maxTurns, maxBudgetUsd: intake.maxBudgetUsd, costUsd: run.costUsd, output: run.output,
      error: run.error, cancelRequested: run.cancelRequested, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: run.updatedAt });
    s.db.prepare("INSERT INTO tasks VALUES (?, ?)").run(id, legacy);

    const task = s.get(id);
    assert.deepEqual(task, { id, createdAt: "2026-10-12T00:00:00.000Z", intake, policy: {}, run });
    assert.equal(JSON.stringify(encodeTask(task)), legacy);
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const { stdout } = await exec(process.execPath, [cli, "show", id, "--home", f.home, "--json"]);
    assert.equal(JSON.stringify(JSON.parse(stdout).task), legacy);

    const token = s.acquire(id, true);
    const written = raw(id);
    assert.equal(written, JSON.stringify({ ...JSON.parse(legacy), state: "provisioning", generation: token, error: null, updatedAt: JSON.parse(written).updatedAt }));
    s.release(id, token);
  } finally { s.close(); }
});

test("an attempt update cannot change an intake field", async t => {
  const f = await fixture(t); const s = f.store();
  try {
    const before = s.get(f.task.id);
    const token = s.acquire(f.task.id, false);
    const events = s.events(f.task.id).length;
    for (const changes of [{ prompt: "Do something else" }, { state: "running", worktree: "/elsewhere" }, { intake: { ...before.intake, base: "0".repeat(40) } }, { generation: "forged" }]) {
      assert.throws(() => s.update(f.task.id, token, changes, "test.write"), /cannot write task fields/);
    }
    assert.deepEqual(s.get(f.task.id).intake, before.intake);
    assert.equal(s.get(f.task.id).run.state, "provisioning");
    assert.equal(s.events(f.task.id).length, events);
    assert.deepEqual(s.update(f.task.id, token, { state: "running", output: "progress" }, "test.running").intake, before.intake);
    s.release(f.task.id, token);
  } finally { s.close(); }
});

test("the change feed starts from the current task and reports a change committed by another connection", async t => {
  const f = await fixture(t);
  const changes = await withTaskStore(f, store => Effect.scoped(Effect.gen(function*() {
    const feed = yield* store.changes(f.task.id, 5);
    return yield* feed.pipe(Stream.tap(change => Effect.sync(() => {
      if (change.task.run.state !== "queued") return;
      const other = f.store(); try { other.cancel(f.task.id); } finally { other.close(); }
    })), Stream.take(2), Stream.runCollect);
  })));
  assert.deepEqual(changes.map(change => change.task.run.state), ["queued", "cancelled"]);
  assert.ok(changes[1].sequence > changes[0].sequence);
});

test("the change feed shares one view and stops its subscribers when its scope closes", async t => {
  const f = await fixture(t);
  const seen = [];
  const exit = await withTaskStore(f, store => Effect.gen(function*() {
    const scope = yield* Scope.make();
    const feed = yield* store.changes(f.task.id, 5).pipe(Scope.provide(scope));
    const subscribe = () => Effect.forkDetach(Stream.runForEach(feed, change => Effect.sync(() => seen.push(change.sequence))));
    const subscribers = [yield* subscribe(), yield* subscribe()];
    yield* Effect.sleep(30);
    yield* Scope.close(scope, Exit.void);
    return yield* Fiber.awaitAll(subscribers).pipe(Effect.timeout(1_000));
  }));
  assert.ok(exit.every(Exit.hasInterrupts));
  assert.equal(new Set(seen).size, 1, "an unchanged task is reported once to each subscriber");
  assert.equal(seen.length, 2);
  const after = seen.length;
  const other = f.store(); try { other.cancel(f.task.id); } finally { other.close(); }
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(seen.length, after);
});
