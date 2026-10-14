import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { appError, InvalidInput, InvalidTransition, type Hold, type Item } from "./domain.js";
import { TaskStore } from "./store.js";
import { addTask, type NewTask } from "./orchestrator.js";

/** Task settings for a dispatch; the kind and prompt come from the item, and the project too unless given. */
export type DispatchOptions = Omit<NewTask, "project" | "prompt" | "kind" | "item"> & { readonly project?: string };

/**
 * Dispatches a backlog item: creates its queued task, resolved by intake
 * like any task, and moves the item to in-flight in the same transaction.
 * Refused for a captain item, a held or not-queued item, an item waiting on
 * a dependency that is not done, and one deferred to a later date.
 */
export const dispatchItem = Effect.fn("firstmate.dispatchItem")(function*(id: string, options: DispatchOptions = {}) {
  const store = yield* TaskStore;
  const item = yield* store.checkDispatch(id);
  const project = options.project ?? item.project;
  if (!project) return yield* Effect.fail(new InvalidInput({ message: `Backlog item "${id}" names no project; dispatch it with --project or set one with firstmate backlog update` }));
  if (item.kind === "captain") return yield* Effect.fail(new InvalidTransition({ message: `Backlog item "${id}" is a captain item and never dispatches` }));
  const task = yield* addTask({ ...options, project, prompt: item.prompt ?? item.title, kind: item.kind, item: id });
  return { task, item: yield* store.item(id) };
});

/**
 * Records that a completed scout's captain calls are held: every item named
 * is held for the captain (or already answered), or `none` attests the
 * report leaves nothing waiting on the captain. Only then is the scout
 * complete: its own item closes, and cleanup may discard its isolated copy.
 */
export const completeScout = Effect.fn("firstmate.completeScout")(function*(taskId: string, items: readonly string[], none: boolean) {
  const store = yield* TaskStore;
  yield* store.get(taskId);
  const reports = yield* Effect.tryPromise({ try: () => readdir(join(store.home, "reports", taskId)).catch(() => [] as string[]), catch: appError });
  if (!reports.some(name => name.endsWith(".md"))) return yield* Effect.fail(new InvalidTransition({ message: "The scout has no saved report; its captain calls are attested once its report exists" }));
  return yield* store.attest(taskId, items, none);
});

/** An item as listed: why it waits to dispatch, and its open captain call, if any. */
export interface ItemView extends Item {
  readonly ready: boolean;
  readonly waiting: readonly string[];
  /** The open hold; `deferred` while the captain's own deferral date is still ahead. */
  readonly call: (Pick<Hold, "id" | "question" | "until" | "origin"> & { readonly deferred: boolean }) | null;
}

export const viewItem = Effect.fn("firstmate.viewItem")(function*(item: Item) {
  const store = yield* TaskStore;
  const waiting = item.status === "queued" ? yield* store.waiting(item) : [];
  const hold = item.hold ? (yield* store.itemHolds(item.id)).find(h => h.id === item.hold && h.status === "open") : undefined;
  return {
    ...item, ready: item.status === "queued" && waiting.length === 0, waiting,
    call: hold ? { id: hold.id, question: hold.question, until: hold.until, origin: hold.origin, deferred: hold.until !== null && Date.parse(hold.until) > Date.now() } : null,
  } satisfies ItemView;
});
