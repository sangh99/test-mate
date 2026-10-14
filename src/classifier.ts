import type { EventDataOf, EventType, TaskEvent, WakeConsumer, WakeKind } from "./domain.js";
import type { WakeSpec } from "./store.js";

const is = <T extends EventType>(event: TaskEvent, type: T): event is TaskEvent & { data: EventDataOf<T> } => event.type === type;

const wake = (event: TaskEvent, consumer: WakeConsumer, kind: WakeKind, key: string, detail: string, ref: string | null = null): WakeSpec =>
  ({ key, consumer, kind, taskId: event.taskId, generation: event.generation, ref, cause: event.sequence, detail });

/**
 * Classifies one event into the wake it makes actionable, if any, without
 * performing anything. Progress, text, tool use, and the host's own
 * bookkeeping are not actionable, so an unchanged fleet raises nothing.
 */
export function classify(event: TaskEvent): WakeSpec | undefined {
  const at = `${event.taskId}:${event.generation}`;
  if (is(event, "task.result")) return wake(event, "captain", "finished", `finished:${at}`, `Task is ${event.data.state}; review its output`);
  if (is(event, "run.stopped") && event.data.state === "failed") return wake(event, "captain", "failed", `failed:${at}`, event.data.error);
  if (is(event, "decision.requested")) {
    return wake(event, "captain", "decision", `decision:${event.data.id}`, `${event.data.tool} is waiting for an answer`, event.data.id);
  }
  if (is(event, "steer.uncertain")) {
    return wake(event, "captain", "steer", `steer:${event.sequence}`, `Delivery of steer #${event.data.sequence} cannot be proven; requeue it to resend`, event.data.id);
  }
  if (is(event, "steer.unsettled")) {
    return wake(event, "captain", "steer", `unsettled:${at}`, `${event.data.ids.length} steer(s) went unacknowledged past the settle bound; resume reconciles them`);
  }
  if (is(event, "recovery.exhausted")) {
    return wake(event, "captain", "escalated", `escalated:${at}`,
      `Recovery stopped after ${event.data.attempts} of ${event.data.limit} attempt(s) (${event.data.cause}): ${event.data.detail}`);
  }
  if (is(event, "pr.opened")) return wake(event, "captain", "published", `published:${event.sequence}`, `Opened ${event.data.url} for ${event.data.head}`, event.data.url);
  if (is(event, "hold.opened")) return wake(event, "captain", "hold", `hold:${event.data.id}`, event.data.question, event.data.id);
  if (is(event, "validation.failed")) return wake(event, "captain", "failed", `validation:${event.data.id}`, `Validation failed; the task stays ready for firstmate validate: ${event.data.error}`);
  if (is(event, "pr.failed")) return wake(event, "captain", "failed", `publish:${event.sequence}`, `Publishing failed; the task stays ready for firstmate publish: ${event.data.error}`);
  // The one-line outcome of a merge nobody approved in the moment.
  if (is(event, "task.landed") && event.data.basis === "yolo") {
    const landed = event.data;
    return wake(event, "captain", "landed", `landed:${event.taskId}`, "via" in landed
      ? `Merged ${landed.url} (${landed.commit}) into ${landed.target} as ${landed.mergeCommit} under yolo`
      : `Landed ${landed.commit} on local ${landed.target} under yolo`, "via" in landed ? landed.url : null);
  }
  // A landing the supervisor proved may leave the clone stale with nobody watching.
  if (is(event, "clone.refused")) {
    return wake(event, "captain", "refresh", `refresh:${event.sequence}`, `Landed, but the clone refresh of ${event.data.target} was refused: ${event.data.reason}; firstmate refresh ${event.taskId} retries`);
  }
  if (is(event, "control.applied") && event.data.verb === "relaunch") {
    return wake(event, "supervisor", "relaunch", `relaunch:${event.data.id}`, "Resume the session a relaunch stopped", event.data.id);
  }
  return undefined;
}
