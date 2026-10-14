import test from "node:test";
import assert from "node:assert/strict";
import { conclude, interpret as interpretFrame, startStream } from "../dist/interpreter.js";
import { normalize } from "../dist/agent.js";
import { result } from "./helpers.mjs";

const session = result().session_id;
const fresh = () => startStream({ promptId: "prompt", named: [], sessionId: null });
const resumed = named => startStream({ promptId: "prompt", named, sessionId: session });
// The Claude runtime normalizes each SDK message into one frame.
const interpret = (state, message) => interpretFrame(state, normalize(message));
const normalized = message => normalize(message).find(event => event.type === "result").result;
const feed = (state, messages) => messages.reduce(({ state, effects }, message) => {
  const step = interpret(state, message);
  return { state: step.state, effects: [...effects, ...step.effects] };
}, { state, effects: [] });
const echo = uuid => ({ type: "user", isReplay: true, uuid, session_id: session, message: { role: "user", content: "x" }, parent_tool_use_id: null });
const reply = (stamp, content = []) => ({ type: "assistant", session_id: session, ...(stamp ? { user_message_uuid: stamp } : {}), message: { content } });
const without = (effects, ...types) => effects.filter(effect => !types.includes(effect.type));

test("an echoed steer is delivered", () => {
  const { effects } = feed(resumed([]), [echo("steer-1")]);
  assert.deepEqual(effects, [{ type: "deliver", steerId: "steer-1" }]);
});

test("a reply stamped with a steer acknowledges through it, then records its blocks", () => {
  const { effects } = feed(resumed([]), [reply("steer-2", [{ type: "text", text: "done" }, { type: "tool_use", name: "Read", id: "tool-1", input: {} }])]);
  assert.deepEqual(effects, [
    { type: "acknowledge-through", steerId: "steer-2" },
    { type: "text", text: "done" },
    { type: "tool", name: "Read", id: "tool-1" },
  ]);
});

test("a reply stamped with the resume prompt acknowledges the steers it named", () => {
  const { effects } = feed(resumed(["steer-1", "steer-3"]), [reply("prompt")]);
  assert.deepEqual(effects, [{ type: "acknowledge-named", steerIds: ["steer-1", "steer-3"], promptId: "prompt" }]);
});

test("the first session is recorded once and a different session on resume fails before later effects", () => {
  const first = feed(fresh(), [{ type: "system", subtype: "init", session_id: session }, reply(undefined, [{ type: "text", text: "hi" }])]);
  assert.deepEqual(first.effects, [{ type: "record-session", sessionId: session }, { type: "text", text: "hi" }]);
  assert.equal(first.state.sessionId, session);
  assert.deepEqual(feed(resumed([]), [{ type: "system", subtype: "init", session_id: session }]).effects, []);

  const other = { ...reply("steer-1", [{ type: "text", text: "elsewhere" }]), session_id: "00000000-0000-4000-8000-000000000002" };
  const mismatch = interpret(resumed([]), other);
  assert.deepEqual(mismatch.effects, [
    { type: "acknowledge-through", steerId: "steer-1" },
    { type: "fail", message: "SDK returned a different session during resume" },
  ]);
  assert.equal(mismatch.state.sessionId, session);
});

test("a successful result settles the input and concludes with its output", () => {
  const success = result({ result: "Implemented." });
  const { state, effects } = feed(fresh(), [success]);
  assert.deepEqual(without(effects, "record-session"), [{ type: "result", result: normalized(success) }, { type: "settle-input" }]);
  assert.deepEqual(conclude(state), { ok: true, result: normalized(success) });
});

test("a failed result closes the input and concludes as a failure", () => {
  const failure = result({ subtype: "error_max_turns", is_error: true, errors: ["limit"] });
  const { state, effects } = feed(fresh(), [failure]);
  assert.deepEqual(without(effects, "record-session"), [{ type: "result", result: normalized(failure) }, { type: "close-input" }]);
  assert.deepEqual(conclude(state), { ok: false, message: "Worker run failed: error_max_turns: limit" });
  assert.equal(conclude(feed(fresh(), [result({ is_error: true })]).state).ok, false);
});

test("a stream with no result concludes as unverified", () => {
  const { state, effects } = feed(resumed([]), [echo("steer-1"), reply("steer-1")]);
  assert.deepEqual(effects.map(effect => effect.type), ["deliver", "acknowledge-through"]);
  assert.deepEqual(conclude(state), { ok: false, message: "SDK stream ended without a result; completion is unverified" });
  assert.deepEqual(conclude(fresh()), { ok: false, message: "SDK stream ended without a result; completion is unverified" });
});
