import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { addTask, applicationLayer, runTask, runQueued } from "../dist/index.js";
import { fixture, fake, result, exec, firstText } from "./helpers.mjs";

const run = (f, factory, options) => Effect.runPromise(runTask(f.task.id, options).pipe(Effect.provide(applicationLayer(f.home, factory))));

test("ship runs in its worktree, preserves dirty source, and stops ready for review", async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, "local.txt"), "keep local work");
  let closed = false;
  const task = await run(f, fake(async function*({ options }) {
    assert.equal(options.cwd, f.task.intake.worktree);
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.permissionMode, "default");
    assert.equal(options.maxBudgetUsd, 5);
    await writeFile(join(options.cwd, "feature.txt"), "new feature");
    yield result();
  }, () => { closed = true; }));
  assert.equal(task.run.state, "ready");
  assert.equal(task.run.costUsd, 0.01);
  assert.equal(closed, true);
  await assert.rejects(access(join(f.project, "feature.txt")));
  assert.equal(await readFile(join(f.project, "local.txt"), "utf8"), "keep local work");
  assert.equal((await exec("git", ["-C", f.project, "branch", "--show-current"])).stdout.trim(), "main");
});

test("resume uses exact session and existing dirty worktree", async t => {
  const f = await fixture(t);
  await run(f, fake(async function*({ options }) {
    await writeFile(join(options.cwd, "uncommitted.txt"), "preserve"); yield result();
  }));
  const task = await run(f, fake(async function*({ options, prompt }) {
    assert.equal(options.resume, result().session_id);
    assert.equal(await firstText(prompt), "Add another check");
    assert.equal(await readFile(join(options.cwd, "uncommitted.txt"), "utf8"), "preserve");
    yield result({ result: "Follow-up complete", total_cost_usd: 0.02 });
  }), { resume: true, prompt: "Add another check" });
  assert.equal(task.run.output, "Follow-up complete");
  assert.equal(task.run.costUsd, 0.02);
});

test("SDK failure after an error result retains cost and never reports ready", async t => {
  const f = await fixture(t);
  await assert.rejects(run(f, fake(async function*() {
    yield result({ subtype: "error_max_turns", is_error: true, errors: ["limit"] });
    throw new Error("Turn limit reached");
  })), /Turn limit/);
  const s = f.store();
  try { assert.equal(s.get(f.task.id).run.state, "failed"); assert.equal(s.get(f.task.id).run.costUsd, 0.01); } finally { s.close(); }
});

test("a stream without a result fails and closes resources", async t => {
  const f = await fixture(t); let closed = false;
  await assert.rejects(run(f, fake(async function*() {}, () => { closed = true; })), /without a result/);
  assert.equal(closed, true);
  const s = f.store();
  try { assert.equal(s.get(f.task.id).run.state, "failed"); assert.equal(s.inspect(f.task.id).owner, "absent"); } finally { s.close(); }
});

test("durable permission answer gates execution across connections", async t => {
  const f = await fixture(t);
  const task = await run(f, fake(async function*({ options }) {
    const permission = options.canUseTool("Bash", { command: "npm test" }, { signal: options.abortController.signal });
    const s = f.store();
    try {
      assert.equal(s.get(f.task.id).run.state, "waiting");
      const decision = s.decisions(f.task.id)[0];
      s.answer(decision.id, "allow", "Run the checks");
    } finally { s.close(); }
    assert.equal((await permission).behavior, "allow");
    yield result();
  }), { pollMs: 5 });
  assert.equal(task.run.state, "ready");
});

test("cancellation interrupts a waiting permission without granting it", async t => {
  const f = await fixture(t); let closed = false;
  await assert.rejects(run(f, fake(async function*({ options }) {
    const permission = options.canUseTool("Bash", { command: "npm test" }, { signal: options.abortController.signal });
    const s = f.store(); try { s.cancel(f.task.id); } finally { s.close(); }
    await permission;
    yield result();
  }, () => { closed = true; }), { pollMs: 5 }));
  const s = f.store();
  try {
    assert.equal(s.get(f.task.id).run.state, "cancelled");
    assert.equal(s.decisions(f.task.id)[0].status, "expired");
  } finally { s.close(); }
  assert.equal(closed, true);
});

test("cancellation committed by another connection stops a running stream", async t => {
  const f = await fixture(t); let closed = false;
  await assert.rejects(run(f, fake(async function*({ options }) {
    yield { type: "system", subtype: "init", session_id: result().session_id };
    const s = f.store(); try { s.cancel(f.task.id); } finally { s.close(); }
    await new Promise((_, reject) => {
      options.abortController.signal.addEventListener("abort", () => reject(new Error("stopped by abort")), { once: true });
      setTimeout(() => reject(new Error("cancellation did not stop the stream")), 2_000);
    });
  }, () => { closed = true; }), { pollMs: 5 }), /stopped by abort/);
  const s = f.store();
  try { assert.equal(s.get(f.task.id).run.state, "cancelled"); } finally { s.close(); }
  assert.equal(closed, true);
});

test("an approval wait ends without permission when the task is cancelled", async t => {
  const f = await fixture(t); let outcome;
  await assert.rejects(run(f, fake(async function*({ options }) {
    const permission = options.canUseTool("Bash", { command: "npm test" }, { signal: options.abortController.signal });
    const s = f.store(); try { s.cancel(f.task.id); } finally { s.close(); }
    outcome = await permission.then(result => result.behavior, () => "aborted");
    yield result();
  }), { pollMs: 5 }));
  assert.ok(outcome === "deny" || outcome === "aborted", `unexpected outcome ${outcome}`);
});

test("external interruption preserves session for explicit resume", async t => {
  const f = await fixture(t); const abort = new AbortController();
  await assert.rejects(run(f, fake(async function*({ options }) {
    yield { type: "system", subtype: "init", session_id: result().session_id };
    const permission = options.canUseTool("Write", { file_path: "x" }, { signal: options.abortController.signal });
    abort.abort(); await permission;
  }), { signal: abort.signal, pollMs: 5 }));
  const s = f.store();
  try { assert.equal(s.get(f.task.id).run.state, "interrupted"); assert.equal(s.get(f.task.id).run.sessionId, result().session_id); } finally { s.close(); }
});

test("scout tools are read-only and the complete report is saved", async t => {
  const f = await fixture(t);
  f.task = await Effect.runPromise(addTask({ project: f.project, prompt: "Investigate the design", kind: "scout" }).pipe(Effect.provide(applicationLayer(f.home))));
  const task = await run(f, fake(async function*({ options }) {
    assert.deepEqual(options.tools, ["Read", "Glob", "Grep", "AskUserQuestion"]);
    yield result({ result: "# Findings\nEvidence and limitations." });
  }));
  assert.equal(task.run.state, "completed");
  const reports = join(f.home, "reports", f.task.id);
  const files = await readdir(reports);
  assert.equal(await readFile(join(reports, files[0]), "utf8"), task.run.output);
});

test("queue concurrency is bounded and one failed task does not cancel another", async t => {
  const f = await fixture(t);
  const layer = applicationLayer(f.home);
  for (let i = 0; i < 3; i++) await Effect.runPromise(addTask({ project: f.project, prompt: `task ${i}`, kind: "ship", delivery: "no-mistakes", yolo: false }).pipe(Effect.provide(layer)));
  let active = 0; let peak = 0;
  const factory = fake(async function*({ prompt }) {
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      if (await firstText(prompt) === "task 1") throw new Error("Expected isolated failure");
      yield result();
    } finally { active--; }
  });
  const outcomes = await Effect.runPromise(runQueued(2).pipe(Effect.provide(applicationLayer(f.home, factory))));
  assert.equal(outcomes.length, 4);
  assert.equal(peak, 2);
  const s = f.store();
  try { assert.equal(s.list().filter(t => t.run.state === "ready").length, 3); assert.equal(s.list().filter(t => t.run.state === "failed").length, 1); } finally { s.close(); }
});

test("rejects invalid budgets and an operational home inside the project", async t => {
  const f = await fixture(t);
  await assert.rejects(Effect.runPromise(addTask({ project: f.project, prompt: "x", kind: "ship", delivery: "no-mistakes", yolo: false, maxBudgetUsd: -1 }).pipe(Effect.provide(applicationLayer(f.home)))), /positive/);
  await assert.rejects(Effect.runPromise(addTask({ project: f.project, prompt: "x", kind: "ship", delivery: "no-mistakes", yolo: false }).pipe(Effect.provide(applicationLayer(join(f.project, ".firstmate"))))), /outside/);
});
