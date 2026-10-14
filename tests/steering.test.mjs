import test from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { applicationLayer, runTask } from "../dist/index.js";
import { fixture, fake, result, cli, textOf, until } from "./helpers.mjs";

const run = (f, factory, options, reader) => Effect.runPromise(runTask(f.task.id, { pollMs: 5, ...options })
  .pipe(Effect.provide(applicationLayer(f.home, factory, reader))));
const withStore = (f, use) => { const s = f.store(); try { return use(s); } finally { s.close(); } };
const evidence = (f, id) => withStore(f, s => s.events(f.task.id).filter(e => e.data?.id === id).map(e => [e.type, e.data.evidence?.via ?? null]));

test("a steer sent during a live run is delivered, answered, and then the run completes", async t => {
  const f = await fixture(t);
  let steerId;
  const task = await run(f, cli({ turn: async ({ index }) => {
    if (index === 0) steerId = withStore(f, s => s.steer(f.task.id, "Also update the changelog")).id;
  } }));
  assert.equal(task.run.state, "ready");
  assert.equal(task.run.output, "answered Also update the changelog");
  assert.deepEqual(evidence(f, steerId), [
    ["steer.enqueued", null], ["steer.submitted", "input-stream"], ["steer.delivered", "cli-replay"], ["steer.acknowledged", "reply-stamp"],
  ]);
  assert.ok(withStore(f, s => s.events(f.task.id).some(e => e.type === "input.closed")));
});

test("steers queued before a run follow the initial prompt in sequence order with stable identity", async t => {
  const f = await fixture(t);
  const [one, two] = withStore(f, s => [s.steer(f.task.id, "first"), s.steer(f.task.id, "second")]);
  assert.deepEqual([one.sequence, two.sequence], [1, 2]);
  const seen = [];
  await run(f, cli({ turn: async ({ message }) => { seen.push([message.uuid, textOf(message)]); } }));
  assert.deepEqual(seen.slice(1), [[one.id, "first"], [two.id, "second"]]);
  assert.deepEqual(withStore(f, s => s.steers(f.task.id).map(x => x.status)), ["acknowledged", "acknowledged"]);
});

test("a reply stamped with a later steer acknowledges earlier steers the CLI coalesced", async t => {
  const f = await fixture(t);
  const [one, two] = withStore(f, s => [s.steer(f.task.id, "first"), s.steer(f.task.id, "second")]);
  const task = await run(f, cli({ stamp: message => message.uuid === one.id ? undefined : message.uuid }));
  assert.equal(task.run.state, "ready");
  assert.deepEqual(evidence(f, one.id).at(-1), ["steer.acknowledged", "later-reply-stamp"]);
  assert.deepEqual(evidence(f, two.id).at(-1), ["steer.acknowledged", "reply-stamp"]);
});

test("an unanswered steer blocks completion, times out, and is answered after transcript reconciliation", async t => {
  const f = await fixture(t);
  const steer = withStore(f, s => s.steer(f.task.id, "Use the new API"));
  await assert.rejects(run(f, fake(async function*({ prompt, options }) {
    const input = prompt[Symbol.asyncIterator]();
    await input.next();
    yield result();
    const next = (await input.next()).value;
    yield { type: "user", isReplay: true, uuid: next.uuid, session_id: result().session_id, message: next.message, parent_tool_use_id: null };
    // A turn that ends without stamping its reply leaves the steer unproven.
    yield result();
    await new Promise((_, reject) => options.abortController.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  }), { steerSettleMs: 30 }));
  withStore(f, s => {
    assert.equal(s.get(f.task.id).run.state, "interrupted");
    assert.equal(s.steers(f.task.id)[0].status, "delivered");
  });
  const task = await run(f, cli({ turn: async ({ message, index }) => {
    if (index === 0) assert.match(textOf(message), /Steering messages #1 are in your conversation history/);
    assert.notEqual(message.uuid, steer.id);
  } }), { resume: true }, async () => new Set([steer.id]));
  assert.equal(task.run.state, "ready");
  assert.deepEqual(evidence(f, steer.id).slice(-2), [["steer.delivered", "transcript"], ["steer.acknowledged", "resume-prompt-stamp"]]);
});

test("transcript absence resends with the same identity; unreadable transcripts need explicit requeue", async t => {
  const f = await fixture(t);
  // Leave one steer submitted by a generation that died before any reply.
  const steer = withStore(f, s => {
    const created = s.steer(f.task.id, "Rename the flag");
    const token = s.acquire(f.task.id, false);
    s.update(f.task.id, token, { state: "running", sessionId: result().session_id }, "test.running");
    s.claimSteers(f.task.id, token);
    s.release(f.task.id, token);
    return created;
  });
  const seen = [];
  await run(f, cli({ turn: async ({ message }) => { seen.push(message.uuid); } }), { resume: true }, async () => null);
  assert.ok(!seen.includes(steer.id), "uncertain steer must not be resent automatically");
  assert.equal(withStore(f, s => s.steers(f.task.id)[0].status), "uncertain");

  assert.equal(withStore(f, s => s.requeueSteer(steer.id)).status, "pending");
  seen.length = 0;
  const task = await run(f, cli({ turn: async ({ message }) => { seen.push(message.uuid); } }), { resume: true }, async () => new Set(["other"]));
  assert.equal(task.run.state, "ready");
  assert.deepEqual(seen.slice(1), [steer.id]);
  assert.equal(withStore(f, s => s.steers(f.task.id)[0].status), "acknowledged");
});

test("store fences steering by generation and keeps late steers for the next run", async t => {
  const f = await fixture(t); const s = f.store();
  try {
    assert.throws(() => s.steer(f.task.id, "  "), /empty/);
    const token = s.acquire(f.task.id, false);
    s.update(f.task.id, token, { state: "running" }, "test.running");
    const early = s.steer(f.task.id, "early");
    assert.throws(() => s.claimSteers(f.task.id, "stale"), /Stale/);
    assert.equal(s.closeInput(f.task.id, token), false);
    s.claimSteers(f.task.id, token);
    assert.throws(() => s.update(f.task.id, token, { state: "ready" }, "test.ready"), /Unacknowledged steering/);
    s.markSteerDelivered(f.task.id, token, early.id);
    s.acknowledgeThrough(f.task.id, token, early.id);
    assert.equal(s.closeInput(f.task.id, token), true);
    const late = s.steer(f.task.id, "late");
    assert.equal(s.update(f.task.id, token, { state: "ready" }, "test.ready").run.state, "ready");
    assert.equal(late.sequence, 2);
    assert.equal(s.steers(f.task.id)[1].status, "pending");
    assert.throws(() => s.requeueSteer(late.id), /Only uncertain/);
    s.release(f.task.id, token);
  } finally { s.close(); }
});
