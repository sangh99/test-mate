import type { RuntimeFrame, RuntimeResult } from "./runtime.js";

/** What one attempt knows while reading its runtime stream. */
export interface StreamState {
  /** Identity of the attempt's prompt; a reply stamped with it answers `named`. */
  readonly promptId: string;
  /** Delivered steers the prompt asked to have answered. */
  readonly named: readonly string[];
  /** The session being resumed; the runtime may not substitute another. */
  readonly resumed: string | null;
  /** The session last recorded for the task. */
  readonly sessionId: string | null;
  readonly result: RuntimeResult | undefined;
}

/** A durable or input-stream consequence of one runtime event, applied in order. */
export type StreamEffect =
  | { readonly type: "deliver"; readonly steerId: string }
  | { readonly type: "acknowledge-through"; readonly steerId: string }
  | { readonly type: "acknowledge-named"; readonly steerIds: readonly string[]; readonly promptId: string }
  | { readonly type: "record-session"; readonly sessionId: string }
  /** Stops the run; no later effect of the same frame applies. */
  | { readonly type: "fail"; readonly message: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly id: string }
  | { readonly type: "result"; readonly result: RuntimeResult }
  /** A failed turn ends the run; unconfirmed steering is reconciled on resume. */
  | { readonly type: "close-input" }
  /** Close the input once steering is settled, otherwise start the settle bound. */
  | { readonly type: "settle-input" };

export const startStream = (input: { promptId: string; named: readonly string[]; sessionId: string | null }): StreamState => ({
  promptId: input.promptId, named: input.named, resumed: input.sessionId, sessionId: input.sessionId, result: undefined,
});

const failed = (result: RuntimeResult) => result.subtype !== "success" || result.isError;

/** Interprets one runtime frame without performing any of its effects. */
export function interpret(state: StreamState, frame: RuntimeFrame): { state: StreamState; effects: StreamEffect[] } {
  const effects: StreamEffect[] = [];
  for (const event of frame) {
    switch (event.type) {
      case "input-echo": effects.push({ type: "deliver", steerId: event.id }); break;
      case "reply-stamp": effects.push(event.id === state.promptId
        ? { type: "acknowledge-named", steerIds: state.named, promptId: state.promptId }
        : { type: "acknowledge-through", steerId: event.id }); break;
      case "session":
        if (state.resumed && event.sessionId !== state.resumed) {
          effects.push({ type: "fail", message: "SDK returned a different session during resume" });
          return { state, effects };
        }
        if (state.sessionId !== event.sessionId) {
          effects.push({ type: "record-session", sessionId: event.sessionId });
          state = { ...state, sessionId: event.sessionId };
        }
        break;
      case "text": effects.push({ type: "text", text: event.text }); break;
      case "tool": effects.push({ type: "tool", name: event.name, id: event.id }); break;
      case "result":
        state = { ...state, result: event.result };
        effects.push({ type: "result", result: event.result }, { type: failed(event.result) ? "close-input" : "settle-input" });
        break;
    }
  }
  return { state, effects };
}

/** The verdict once the stream ends: only a successful result completes the attempt. */
export function conclude(state: StreamState): { ok: true; result: RuntimeResult } | { ok: false; message: string } {
  const result = state.result;
  if (!result) return { ok: false, message: "SDK stream ended without a result; completion is unverified" };
  if (failed(result)) return { ok: false, message: `Worker run failed: ${result.subtype}${result.errors.length ? `: ${result.errors.join("; ")}` : ""}` };
  return { ok: true, result };
}
