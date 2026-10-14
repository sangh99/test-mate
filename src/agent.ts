import { getSessionMessages, query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { contains } from "./worktrees.js";
import { appError, type Task } from "./domain.js";
import type { AccountCheck, RuntimeEvent, RuntimeFrame, RuntimeInput, RuntimeSession, WorkerRuntime } from "./runtime.js";

export interface AgentSession extends AsyncIterable<SDKMessage> { close(): void }
export type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AgentSession;
/** UUIDs in a session transcript, or null when the transcript cannot be found or read. */
export type TranscriptReader = (sessionId: string, dir: string) => Promise<ReadonlySet<string> | null>;
/** Asks the Claude executable whether the account at a config directory, or the ordinary login, is signed in. */
export type AccountReader = (root: string) => Promise<AccountCheck>;
export interface AgentInput {
  task: Task;
  abortController: AbortController;
  canUseTool: NonNullable<Options["canUseTool"]>;
  account?: string | null;
  /** The home's memory, appended to the worker's context. */
  memory?: string | null;
}

/**
 * Credentials Claude ranks above a stored login, unset for a pinned launch
 * so the pinned account is the one that spends.
 */
const outranking = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

/** The launch environment for an account pin: `ordinary` is Claude's default login, a path its config directory. */
const pinnedEnv = (account: string) => {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of outranking) delete env[name];
  if (account === "ordinary") delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = account;
  return env;
};

export function agentOptions(input: AgentInput): Options {
  const { task: { intake, policy, run }, abortController, canUseTool } = input;
  const effort = intake.dispatch?.effort;
  const tools = intake.kind === "scout"
    ? ["Read", "Glob", "Grep", "AskUserQuestion"]
    : ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "AskUserQuestion"];
  return {
    cwd: intake.worktree,
    tools,
    permissionMode: "default",
    allowedTools: [],
    // Settings can contain auto-approval rules or executable hooks.
    settingSources: [],
    persistSession: true,
    // The CLI echoes each streamed user message, which is receipt evidence for steering.
    extraArgs: { "replay-user-messages": null },
    ...(run.sessionId ? { resume: run.sessionId } : {}),
    ...(intake.model ? { model: intake.model } : {}),
    ...(effort ? { effort } : {}),
    ...(input.account ? { env: pinnedEnv(input.account) } : {}),
    maxTurns: intake.maxTurns,
    maxBudgetUsd: intake.maxBudgetUsd,
    abortController,
    canUseTool,
    systemPrompt: [
      "You are a Firstmate task worker executing the user's task in an isolated Git worktree.",
      `Task kind: ${intake.kind}. Delivery: ${intake.kind === "scout" ? "report only" : policy.delivery === "local-only"
        ? "local-only; commit finished work on the task branch and leave the worktree clean, because the host lands that branch only once its merge is authorized"
        : policy.delivery === "no-mistakes"
        ? "no-mistakes; commit finished work on the task branch and leave the worktree clean, because the host then validates that commit through the no-mistakes pipeline, which owns review, push, PR and CI; never run no-mistakes yourself"
        : policy.delivery === "direct-PR"
        ? "direct-PR; commit finished work on the task branch and leave the worktree clean, because the host pushes that commit and opens its PR"
        : "local review only"}.`,
      "Read applicable project instructions before work. Keep changes within this worktree.",
      "Never merge, push, remove worktrees, or alter the source checkout. Preserve uncommitted work.",
      "Report verification and limitations truthfully. A successful turn does not prove tests or delivery.",
      intake.kind === "scout" ? "Investigate with read tools and return a complete Markdown report; do not change files."
        : "Implement the task, run appropriate checks when approved, and summarize changes and validation for review.",
      ...(input.memory ? ["", input.memory] : []),
    ].join("\n"),
    hooks: {
      PreToolUse: [{ hooks: [async event => {
        if (event.hook_event_name !== "PreToolUse") return {};
        const deny = (reason: string) => ({ hookSpecificOutput: {
          hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason,
        } });
        if (!tools.includes(event.tool_name)) return deny("Tool is not available for this task kind");
        if (["Write", "Edit"].includes(event.tool_name)) {
          const file = (event.tool_input as { file_path?: unknown }).file_path;
          if (typeof file !== "string") return deny("Missing file path");
          const target = resolve(intake.worktree, file);
          if (!contains(intake.worktree, target)) return deny("Writes must stay in the task worktree");
          // Resolve the nearest existing ancestor to reject symlink escapes for new files too.
          let existing = target;
          while (true) {
            try {
              if (!contains(await realpath(intake.worktree), await realpath(existing))) return deny("Path escapes the worktree through a symlink");
              break;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT" || resolve(existing, "..") === existing) return deny("Cannot verify target path");
              existing = resolve(existing, "..");
            }
          }
          if (relativeParts(intake.worktree, target).includes(".git")) return deny("Git metadata is managed by the host");
        }
        // Force mutating calls through the durable approval callback, even when
        // the SDK would otherwise permit edits from session-local rules.
        if (["Bash", "Write", "Edit"].includes(event.tool_name)) return {
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Firstmate requires approval for this operation" },
        };
        return {};
      }] }],
    },
  };
}

function relativeParts(root: string, path: string) {
  return path.slice(root.length).split(/[\\/]/).map(part => part.toLowerCase());
}

export const readTranscript: TranscriptReader = async (sessionId, dir) => {
  const messages = await getSessionMessages(sessionId, { dir });
  // The SDK returns an empty list for a missing session, which proves nothing.
  return messages.length ? new Set(messages.map(message => message.uuid)) : null;
};

/** The Claude executable the SDK bundles for this platform, else `claude` on the PATH. */
const claudeExecutable = () => {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    return join(dirname(manifest), process.platform === "win32" ? "claude.exe" : "claude");
  } catch { return "claude"; }
};

const claudeLogin = (root: string) => root === "ordinary" ? "claude auth login" : `CLAUDE_CONFIG_DIR=${JSON.stringify(root)} claude auth login`;

/**
 * Runs `claude auth status --json` with only the variables a login lookup
 * needs and the pinned root, so a credential in Firstmate's own environment
 * cannot answer for the pin.
 */
export const readAccount: AccountReader = root => new Promise(done => {
  const env: Record<string, string> = {};
  for (const name of ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (root !== "ordinary") env.CLAUDE_CONFIG_DIR = root;
  const login = claudeLogin(root);
  execFile(claudeExecutable(), ["auth", "status", "--json"], { env, timeout: 30_000, maxBuffer: 1 << 20 }, (error, stdout) => {
    let status: { loggedIn?: unknown; authMethod?: unknown } | undefined;
    try { status = JSON.parse(stdout); } catch { status = undefined; }
    if (typeof status?.loggedIn === "boolean") {
      done({ signedIn: status.loggedIn, detail: `claude auth status: loggedIn ${status.loggedIn}, authMethod ${String(status.authMethod)}`, login });
    } else done({ signedIn: null, detail: `claude auth status gave no verdict${error ? `: ${error.message}` : ""}`, login });
  });
});

/** Normalizes one SDK message into runtime events, in the order they apply. */
export function normalize(message: SDKMessage): RuntimeFrame {
  const events: RuntimeEvent[] = [];
  if (message.type === "user" && "isReplay" in message && message.isReplay) events.push({ type: "input-echo", id: message.uuid });
  if (message.type === "assistant" && message.user_message_uuid) events.push({ type: "reply-stamp", id: message.user_message_uuid });
  if ("session_id" in message && typeof message.session_id === "string") events.push({ type: "session", sessionId: message.session_id });
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "text") events.push({ type: "text", text: block.text });
      if (block.type === "tool_use") events.push({ type: "tool", name: block.name, id: block.id });
    }
  }
  if (message.type === "result") {
    events.push({ type: "result", result: {
      subtype: message.subtype, isError: message.is_error, errors: "errors" in message ? message.errors : [],
      costUsd: message.total_cost_usd, text: "result" in message ? message.result : "",
    } });
  }
  return events;
}

async function* sdkInput(input: AsyncIterable<RuntimeInput>): AsyncIterable<SDKUserMessage> {
  for await (const { id, text } of input) {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: id as SDKUserMessage["uuid"] & string };
  }
}

/** Presents an SDK session as a runtime session. */
const normalized = (session: AgentSession): RuntimeSession => ({
  close: () => session.close(),
  [Symbol.asyncIterator]() {
    const iterator = session[Symbol.asyncIterator]();
    return {
      next: async () => {
        const next = await iterator.next();
        return next.done ? { done: true, value: undefined } : { done: false, value: normalize(next.value) };
      },
      return: async () => {
        await iterator.return?.();
        return { done: true, value: undefined };
      },
    };
  },
});

/** The reference runtime: the Claude Agent SDK. */
export const claudeRuntime = (factory: QueryFactory = query, reader: TranscriptReader = readTranscript, accounts: AccountReader = readAccount): WorkerRuntime => ({
  name: "claude",
  provider: "claude",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  open: request => Effect.try({
    try: () => normalized(factory({
      prompt: sdkInput(request.input),
      options: agentOptions({
        task: request.task, abortController: request.abortController,
        canUseTool: request.canUseTool, account: request.account, memory: request.memory ?? null,
      }),
    })),
    catch: appError,
  }),
  transcript: (sessionId, dir) => Effect.promise(() => reader(sessionId, dir).catch(() => null)),
  account: root => Effect.promise(() => accounts(root).catch(error => ({ signedIn: null, detail: appError(error).message, login: claudeLogin(root) }))),
  login: claudeLogin,
});
