import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Effect } from "effect";
import { Store, addTask, applicationLayer } from "../dist/index.js";

export const exec = promisify(execFile);
export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "firstmate-app-test-"));
  const project = join(root, "project with spaces");
  const home = join(root, "home with spaces");
  await mkdir(project);
  await exec("git", ["init", "-b", "main", project]);
  await exec("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const task = await Effect.runPromise(addTask({ project, prompt: "Implement the test task", kind: "ship", delivery: "no-mistakes", yolo: false }).pipe(Effect.provide(applicationLayer(home))));
  return { root, project, home, task, store: () => new Store(home) };
}

export const result = (overrides = {}) => ({
  type: "result", subtype: "success", is_error: false, session_id: "00000000-0000-4000-8000-000000000001",
  result: "Implemented and verified.", total_cost_usd: 0.01, ...overrides,
});

export const fake = (generate, onClose = () => {}) => params => {
  const iterator = generate(params);
  return { [Symbol.asyncIterator]: () => iterator, close: onClose };
};

export const textOf = message => message.message.content;
export const firstText = async prompt => textOf((await prompt[Symbol.asyncIterator]().next()).value);
export const until = async (condition, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

/**
 * Simulates the CLI's streaming input with --replay-user-messages: each user
 * message is echoed, answered by a reply stamped with its UUID, then a result.
 * `stamp` may redirect or suppress the stamp to model coalesced batches.
 */
export const cli = ({ turn = async () => {}, stamp = message => message.uuid } = {}) => fake(async function*({ prompt, options }) {
  let index = 0;
  for await (const message of prompt) {
    yield { type: "user", isReplay: true, uuid: message.uuid, session_id: result().session_id, message: message.message, parent_tool_use_id: null };
    await turn({ message, index: index++, options });
    const uuid = stamp(message);
    yield { type: "assistant", session_id: result().session_id, ...(uuid ? { user_message_uuid: uuid } : {}),
      message: { content: [{ type: "text", text: `ack ${textOf(message)}` }] } };
    yield result({ result: `answered ${textOf(message)}` });
  }
});
