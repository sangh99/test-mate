import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { addTask, runTask, applicationLayer } from "../dist/index.js";
import { readTranscript } from "../dist/agent.js";
import { fixture } from "./helpers.mjs";

test("live Claude session can complete and resume through the application", {
  timeout: 120_000,
}, async t => {
  const f = await fixture(t);
  const task = await Effect.runPromise(addTask({
    project: f.project, kind: "scout", prompt: "Reply with exactly FIRSTMATE_SDK_OK. Do not call any tools.",
    maxBudgetUsd: 0.5, maxTurns: 2,
  }).pipe(Effect.provide(applicationLayer(f.home))));
  const signal = AbortSignal.timeout(50_000);
  const initial = await Effect.runPromise(runTask(task.id, { signal }).pipe(Effect.provide(applicationLayer(f.home))));
  assert.equal(initial.run.state, "completed");
  assert.ok(initial.run.sessionId);
  assert.match(initial.run.output, /FIRSTMATE_SDK_OK/);
  const resumed = await Effect.runPromise(runTask(task.id, {
    resume: true, prompt: "Repeat your previous exact response without calling tools.", signal: AbortSignal.timeout(50_000),
  }).pipe(Effect.provide(applicationLayer(f.home))));
  assert.equal(resumed.run.sessionId, initial.run.sessionId);
  assert.match(resumed.run.output, /FIRSTMATE_SDK_OK/);
});

test("live steering is echoed, stamped by its reply, and present in the transcript", {
  timeout: 120_000,
}, async t => {
  const f = await fixture(t);
  const task = await Effect.runPromise(addTask({
    project: f.project, kind: "scout", prompt: "Reply with exactly FIRSTMATE_SDK_OK. Do not call any tools.",
    maxBudgetUsd: 0.5, maxTurns: 4,
  }).pipe(Effect.provide(applicationLayer(f.home))));
  const s = f.store();
  const steer = (() => { try { return s.steer(task.id, "Now reply with exactly FIRSTMATE_STEER_OK. Do not call any tools."); } finally { s.close(); } })();
  const done = await Effect.runPromise(runTask(task.id, { signal: AbortSignal.timeout(90_000), steerSettleMs: 30_000 })
    .pipe(Effect.provide(applicationLayer(f.home))));
  assert.equal(done.state, "completed");
  assert.match(done.output, /FIRSTMATE_STEER_OK/);
  const after = f.store();
  try {
    const trail = after.events(task.id).filter(e => e.data?.id === steer.id).map(e => [e.type, e.data.evidence?.via ?? null]);
    assert.deepEqual(trail.slice(1), [["steer.submitted", "input-stream"], ["steer.delivered", "cli-replay"], ["steer.acknowledged", "reply-stamp"]]);
  } finally { after.close(); }
  const transcript = await readTranscript(done.sessionId, done.worktree);
  assert.ok(transcript?.has(steer.id), "transcript must hold the steer under its own identity");
});
