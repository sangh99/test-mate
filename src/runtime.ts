import { Context, Effect, Layer } from "effect";
import { InvalidInput, type Effort, type FirstmateError, type Task } from "./domain.js";

/** One streamed input message: the attempt's prompt or a steer, under the identity a reply stamps. */
export interface RuntimeInput { readonly id: string; readonly text: string }

/** How a finished turn ended, as the runtime reported it. */
export interface RuntimeResult {
  readonly subtype: string;
  readonly isError: boolean;
  readonly errors: readonly string[];
  /** The session's total spend so far, which includes restored spend for a resumed session. */
  readonly costUsd: number;
  readonly text: string;
}

/**
 * The normalized facts of one runtime message, in the order they are
 * applied: an echoed input is receipt evidence, a reply stamp names the
 * input a reply answers, then the session, the reply's blocks, and a result.
 */
export type RuntimeEvent =
  | { readonly type: "input-echo"; readonly id: string }
  | { readonly type: "reply-stamp"; readonly id: string }
  | { readonly type: "session"; readonly sessionId: string }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly id: string }
  | { readonly type: "result"; readonly result: RuntimeResult };

/** One runtime message's events; a failure on one of them stops the rest of the frame. */
export type RuntimeFrame = readonly RuntimeEvent[];

export interface RuntimeSession extends AsyncIterable<RuntimeFrame> { close(): void }

export type ToolVerdict = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };
/** Asks the host whether a tool call may run; it waits for a durable answer. */
export type ToolPermission = (tool: string, input: Record<string, unknown>, context: { signal: AbortSignal }) => Promise<ToolVerdict>;

export interface SessionRequest {
  task: Task;
  input: AsyncIterable<RuntimeInput>;
  abortController: AbortController;
  canUseTool: ToolPermission;
  /** The account pin the launch uses: an absolute root, `ordinary`, or null when unpinned. */
  account: string | null;
  /** The home's memory section for the worker's context, or null when the home holds none. */
  memory?: string | null;
}

/** Whether a pinned account is signed in: null when the runtime could not tell. */
export interface AccountCheck { readonly signedIn: boolean | null; readonly detail: string; readonly login: string }

/**
 * A worker runtime adapter: open a session with streaming input and a
 * normalized event stream, interrupt it through the abort controller, read
 * its transcript, and check a pinned account.
 */
export interface WorkerRuntime {
  readonly name: string;
  /** The quota-axi provider family its quota is read under unless a profile names another. */
  readonly provider: string;
  /** Effort levels it accepts, weakest first. */
  readonly efforts: readonly Effort[];
  open(request: SessionRequest): Effect.Effect<RuntimeSession, FirstmateError>;
  /** Input identities in a session transcript, or null when it cannot be found or read. */
  transcript(sessionId: string, dir: string): Effect.Effect<ReadonlySet<string> | null>;
  /** Asks the runtime itself whether the account at `root` is signed in; never changes it. */
  account(root: string): Effect.Effect<AccountCheck>;
  /** The command a developer runs to sign the account at `root` in. */
  login(root: string): string;
}

/**
 * Runtimes Firstmate knows by name. Only a registered adapter is verified and
 * dispatchable; the rest are refused until one passes adapter verification.
 */
export const knownRuntimes: readonly string[] = ["claude", "codex", "opencode", "pi", "gemini", "grok", "kimi", "cursor"];
/** The runtime a home uses when neither the task nor its dispatch configuration names one. */
export const staticRuntime = "claude";

/** Why a runtime name cannot be dispatched, or null when it is verified. */
export const unverified = (name: string, verified: ReadonlyMap<string, WorkerRuntime>): string | null => {
  if (verified.has(name)) return null;
  const choices = `verified runtimes: ${[...verified.keys()].join(", ")}`;
  return knownRuntimes.includes(name)
    ? `runtime "${name}" is not verified for dispatch, since no adapter for it has passed verification in this firstmate (${choices})`
    : `runtime "${name}" is unknown (${choices})`;
};

/** The verified worker runtimes, by name. */
export class Runtimes extends Context.Service<Runtimes, {
  readonly verified: ReadonlyMap<string, WorkerRuntime>;
  /** The verified runtime, or a refusal naming the verified ones; an unverified runtime is never launched. */
  require(name: string): Effect.Effect<WorkerRuntime, FirstmateError>;
}>()("firstmate/Runtimes") {
  static layer(runtimes: readonly WorkerRuntime[]) {
    const verified = new Map(runtimes.map(runtime => [runtime.name, runtime]));
    return Layer.succeed(Runtimes, {
      verified,
      require: name => {
        const problem = unverified(name, verified);
        return problem ? Effect.fail(new InvalidInput({ message: `Refused: ${problem}. Pass --runtime with a verified runtime, or change the dispatch profile` }))
          : Effect.succeed(verified.get(name)!);
      },
    });
  }
}
