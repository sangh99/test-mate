import { execFile } from "node:child_process";
import { Context, Effect, Layer } from "effect";
import {
  appError, AppError, InvalidTransition, RunInterrupted,
  type FirstmateError, type GateAction, type Hold, type PipelineFinding, type PipelineGate, type Task, type Validation,
} from "./domain.js";
import { Forge } from "./forge.js";
import { TaskStore, type Validating } from "./store.js";
import { Worktrees } from "./worktrees.js";

type Op<A> = Effect.Effect<A, FirstmateError>;

export interface ProcessResult {
  /** The exit code, or null when the process was ended by a signal. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export interface ProcessOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Runs external processes with argument arrays, never through a shell. A
 * nonzero exit is a result, not a failure; failing to start the process is.
 */
export interface ProcessRunnerShape {
  run(command: string, args: readonly string[], options: ProcessOptions): Op<ProcessResult>;
}

export class ProcessRunner extends Context.Service<ProcessRunner, ProcessRunnerShape>()("firstmate/ProcessRunner") {
  static readonly node = Layer.succeed(ProcessRunner, nodeRunner());
  static layer(runner?: ProcessRunnerShape) { return runner ? Layer.succeed(ProcessRunner, runner) : ProcessRunner.node; }
}

function nodeRunner(): ProcessRunnerShape {
  return {
    run: (command, args, { cwd, timeoutMs, signal }) => Effect.tryPromise({
      try: interrupt => new Promise<ProcessResult>((resolve, reject) => {
        execFile(command, [...args], {
          cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal: signal ? AbortSignal.any([signal, interrupt]) : interrupt,
          env: { ...process.env, NO_COLOR: "1" },
        }, (error, stdout, stderr) => {
          const code = (error as { code?: unknown } | null)?.code;
          if (error && typeof code !== "number" && (error as { signal?: unknown }).signal == null) reject(error);
          else resolve({ code: error ? typeof code === "number" ? code : null : 0, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
      catch: error => (error as Error).name === "AbortError"
        ? new RunInterrupted({ message: `${command} was interrupted` })
        : new AppError({ message: `${command} could not be run: ${(error as Error).message}` }),
    }),
  };
}

/** A TOON value: a scalar string, a list, or an object. */
export type Toon = string | readonly Toon[] | { readonly [key: string]: Toon };

/** One comma-separated TOON row; quoted fields use JSON string escapes. */
function row(text: string): string[] {
  const fields: string[] = [];
  let index = 0;
  while (true) {
    if (text[index] === "\"") {
      let end = index + 1;
      while (end < text.length && text[end] !== "\"") end += text[end] === "\\" ? 2 : 1;
      const quoted = text.slice(index, end + 1);
      try { fields.push(JSON.parse(quoted)); } catch { fields.push(quoted.slice(1, -1)); }
      index = text.indexOf(",", end + 1);
    } else {
      const end = text.indexOf(",", index);
      fields.push(text.slice(index, end < 0 ? undefined : end).trim());
      index = end;
    }
    if (index < 0) return fields;
    index++;
  }
}
const scalar = (text: string): string => text.startsWith("\"") ? row(text)[0] ?? "" : text;
const indentOf = (line: string) => line.length - line.trimStart().length;

/**
 * Reads the TOON a no-mistakes axi command prints: indented `key: value`
 * objects, `name[N]{columns}:` tables, and `name[N]:` lists. Every scalar
 * stays a string; nothing is coerced.
 */
export function parseToon(text: string): { readonly [key: string]: Toon } {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== "");
  let at = 0;
  const block = (indent: number): Record<string, Toon> => {
    const out: Record<string, Toon> = {};
    while (at < lines.length) {
      const line = lines[at]!;
      const indentation = indentOf(line);
      if (indentation < indent) break;
      at++;
      if (indentation > indent) continue;
      const header = /^("(?:[^"\\]|\\.)*"|[^:[{]+)(?:\[(\d+)\](?:\{([^}]*)\})?)?:(?: (.*))?$/.exec(line.trim());
      if (!header) continue;
      const [, name, count, columns, rest = ""] = header;
      const key = scalar(name!.trim());
      const nested = () => {
        const items: string[] = [];
        while (at < lines.length && indentOf(lines[at]!) > indent) items.push(lines[at++]!.trim());
        return items;
      };
      if (columns !== undefined) {
        const fields = row(columns);
        out[key] = nested().map(line => { const values = row(line); return Object.fromEntries(fields.map((field, i) => [field, values[i] ?? ""])); });
      } else if (count !== undefined) {
        out[key] = rest ? row(rest) : nested().map(item => scalar(item.replace(/^- /, "")));
      } else if (rest === "") {
        const next = lines[at];
        out[key] = next !== undefined && indentOf(next) > indent ? block(indentOf(next)) : "";
      } else out[key] = scalar(rest);
    }
    return out;
  };
  return block(0);
}

/** A gate as the pipeline reported it, before it is placed among the run's gates. */
export interface ReportedGate {
  readonly step: string;
  readonly summary: string;
  readonly findings: readonly PipelineFinding[];
}

/** What one axi command reported, normalized. Every field is the pipeline's own; null when it did not say. */
export interface PipelineReport {
  readonly runId: string | null;
  readonly branch: string | null;
  readonly status: string | null;
  /** The run's head as the pipeline reported it. */
  readonly head: string | null;
  /** The PR URL the pipeline reported; the forge's report is what gets recorded. */
  readonly pr: string | null;
  readonly gate: ReportedGate | null;
  /** The final or CI-ready outcome, such as checks-passed, passed, failed, or cancelled. */
  readonly outcome: string | null;
  readonly error: string | null;
}

export interface GateResponse {
  readonly step: string;
  readonly action: GateAction;
  readonly findings: readonly string[];
  readonly instructions: string | null;
  /** The reason recorded with an approval of the Test step. */
  readonly reason: string | null;
}

/**
 * The validation adapter: every pipeline command validation performs, run
 * in the task's worktree with the task branch checked out. no-mistakes is the
 * implementation; tests and other pipelines provide their own layer.
 */
export interface PipelineShape {
  /** Starts (or reuses) a run for the worktree's head and drives it to the first gate or outcome. */
  start(worktree: string, intent: string, signal?: AbortSignal): Op<PipelineReport>;
  /** Reattaches to the branch's active run and drives it to its next gate or outcome. */
  attach(worktree: string, signal?: AbortSignal): Op<PipelineReport>;
  /** Reads the named run, or the branch's latest when `runId` is null, without driving it. */
  status(worktree: string, runId: string | null): Op<PipelineReport>;
  /** Answers the gate of `step` and drives the run to its next gate or outcome. */
  respond(worktree: string, response: GateResponse, signal?: AbortSignal): Op<PipelineReport>;
}

export class Pipeline extends Context.Service<Pipeline, PipelineShape>()("firstmate/Pipeline") {
  /** The no-mistakes adapter, running `no-mistakes` through the process runner. */
  static readonly noMistakes = Layer.effect(Pipeline, Effect.gen(function*() { return noMistakes(yield* ProcessRunner); }));
  static layer(pipeline?: PipelineShape) { return pipeline ? Layer.succeed(Pipeline, pipeline) : Pipeline.noMistakes; }
}

/** How long one axi call drives a run before returning, so a stopping host is never stuck behind it. */
const waitBound = "5m";
const processTimeoutMs = 7 * 60_000;

const objectOf = (value: Toon | undefined) => value && typeof value === "object" && !Array.isArray(value) ? value as { readonly [key: string]: Toon } : undefined;
const textOf = (value: Toon | undefined) => typeof value === "string" && value !== "" ? value : null;

/** Normalizes an axi document; a run under `other_branch_run` is reported with its branch, which the caller checks. */
export function reportOf(document: { readonly [key: string]: Toon }): PipelineReport {
  const run = objectOf(document.run) ?? objectOf(document.other_branch_run);
  let gate: ReportedGate | null = null;
  if (document.gate !== undefined) {
    const value = objectOf(document.gate);
    const step = value ? textOf(value.step) : textOf(document.gate);
    const rows = value?.findings ?? document.findings;
    const findings = (Array.isArray(rows) ? rows : []).map(objectOf).filter(row => row !== undefined).map(row => ({
      id: textOf(row.id) ?? "", severity: textOf(row.severity) ?? "", file: textOf(row.file) ?? "", action: textOf(row.action) ?? "", description: textOf(row.description) ?? "",
    }));
    if (step) gate = { step, summary: textOf(value?.summary) ?? textOf(document.summary) ?? textOf(value?.note) ?? textOf(document.note) ?? "", findings };
  }
  const error = objectOf(document.error);
  return {
    runId: textOf(run?.id), branch: textOf(run?.branch), status: textOf(run?.status), head: textOf(run?.head_sha), pr: textOf(run?.pr), gate,
    outcome: textOf(document.outcome),
    error: textOf(document.error) ?? (error ? textOf(error.message) ?? textOf(error.code) ?? JSON.stringify(error) : null),
  };
}

function noMistakes(runner: ProcessRunnerShape): PipelineShape {
  const axi = (worktree: string, args: readonly string[], signal?: AbortSignal) =>
    runner.run("no-mistakes", ["axi", ...args], { cwd: worktree, timeoutMs: processTimeoutMs, ...(signal ? { signal } : {}) }).pipe(Effect.flatMap(result => {
      // Exit 2 is bad usage, which no state of the run explains.
      if (result.code === 2 || !result.stdout.trim()) {
        return Effect.fail(new AppError({ message: `no-mistakes axi ${args[0]} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim() || "no output"}` }));
      }
      return Effect.try({ try: () => reportOf(parseToon(result.stdout)), catch: appError });
    }));
  return {
    start: (worktree, intent, signal) => axi(worktree, ["run", "--intent", intent, "--wait", waitBound], signal),
    attach: (worktree, signal) => axi(worktree, ["run", "--wait", waitBound], signal),
    status: (worktree, runId) => axi(worktree, ["status", ...(runId ? ["--run", runId] : [])]),
    respond: (worktree, { step, action, findings, instructions, reason }, signal) => axi(worktree, [
      "respond", "--step", step, "--action", action,
      ...(findings.length ? ["--findings", findings.join(",")] : []),
      ...(instructions ? ["--instructions", instructions] : []),
      ...(reason ? ["--reason", reason] : []),
      "--wait", waitBound,
    ], signal),
  };
}

/** Outcomes that end validation with a PR to find on the forge. */
const passing = new Set(["checks-passed", "passed", "passed-with-override", "passed-with-skips"]);
/** Gates the policy fixes on its own before the same step is held for the captain. */
const policyFixRounds = 2;

export type GateDecision =
  | { readonly hold: true; readonly reason: string }
  | { readonly hold: false; readonly action: GateAction; readonly findings: readonly string[]; readonly reason: string };

/**
 * The host's finding policy, the only judgment the host applies on its own.
 * A gate is held for the captain when any finding is classified anything
 * other than `auto-fix` or `no-op` (an `ask-user` finding, a protected-path
 * or unvalidated-work refusal, or a classification this host does not know),
 * or when the policy has already fixed this step `policyFixRounds` times in
 * the run. Otherwise `auto-fix` findings are fixed, and a gate with only
 * `no-op` findings, or none, is approved. The worker is never asked.
 */
export function decideGate(gate: PipelineGate, policyFixes: number): GateDecision {
  const judgment = gate.findings.filter(f => f.action !== "auto-fix" && f.action !== "no-op");
  if (judgment.length) return { hold: true, reason: `${judgment.map(f => `${f.id || "(unnamed)"} is ${f.action || "unclassified"}`).join("; ")}, which needs the captain's judgment` };
  const fixes = gate.findings.filter(f => f.action === "auto-fix").map(f => f.id);
  if (fixes.length && fixes.some(id => !id)) return { hold: true, reason: "An auto-fix finding has no id to name in a fix" };
  if (fixes.length && policyFixes >= policyFixRounds) return { hold: true, reason: `The policy already fixed step ${gate.step} ${policyFixes} times in this run` };
  if (fixes.length) return { hold: false, action: "fix", findings: fixes, reason: `Policy: fix the auto-fix finding(s) ${fixes.join(", ")}` };
  return { hold: false, action: "approve", findings: [], reason: gate.findings.length ? "Policy: approve a gate with only no-op findings" : "Policy: approve a gate with no findings" };
}

/** The hold's question: why it is held, then every finding exactly as the pipeline wrote it. */
const questionOf = (gate: PipelineGate, reason: string) => [
  `The no-mistakes ${gate.step} step (run ${gate.runId}) is waiting for the captain: ${reason}.`,
  ...(gate.summary ? [`Summary: ${gate.summary}`] : []),
  ...gate.findings.map(f => `- ${f.id} [${f.action || "unclassified"}, ${f.severity || "no severity"}${f.file ? `, ${f.file}` : ""}]: ${f.description}`),
  "Answer with approve, fix (optionally naming findings), or skip, in your own words.",
].join("\n");

export interface ValidateOptions {
  /** Aborting stops driving; the pipeline keeps the run, and the next validate reattaches. */
  signal?: AbortSignal;
  onText?: (text: string) => void;
}

/** Where validation stopped: a PR, a hold the captain must answer, or a recorded failure. */
export interface ValidateResult {
  readonly task: Task;
  readonly validation: Validation;
  readonly outcome: "pr-open" | "held" | "failed";
  readonly hold: Hold | null;
  readonly detail: string;
}

/** How long the forge's PR is re-read after a passing outcome before validation fails without one. */
const prAttempts = 10;
const prDelayMs = 2_000;
/** Consecutive quick pipeline errors before driving stops and is left to a later validate. */
const errorLimit = 3;
/** An error returned after this long is the axi call's own wait bound ending, not a fault. */
const boundedHoldMs = 60_000;

/**
 * Validates a no-mistakes ship under its task's lease. A ready ship's commit
 * is submitted to the pipeline with the task prompt as its intent, or, when
 * its worktree has moved from it or is dirty, recorded as failed; a
 * validating ship's run is reattached. Each gate is recorded, then decided
 * by `decideGate`, carried out from the captain's answered hold, or held
 * with a new hold, which stops driving until the captain answers it. A
 * passing outcome moves the task to pr-open with the PR the forge reports;
 * a failing one, or a branch the pipeline no longer follows, records the
 * failure and returns the task to ready.
 */
export const validateTask = Effect.fn("firstmate.validateTask")(function*(id: string, options: ValidateOptions = {}) {
  const store = yield* TaskStore;
  const pipeline = yield* Pipeline;
  const forge = yield* Forge;
  const worktrees = yield* Worktrees;
  const task: Task = yield* store.get(id);
  const { delivery, target } = task.policy;
  if (task.intake.kind !== "ship" || delivery !== "no-mistakes" || !target) {
    return yield* Effect.fail(new InvalidTransition({ message: "Only a ship delivered through no-mistakes is validated by the pipeline" }));
  }
  const state = task.run.state;
  const commit = task.run.commit;
  if ((state !== "ready" && state !== "validating") || !commit) {
    return yield* Effect.fail(new InvalidTransition({ message: `Task is ${state}; only a ready or validating no-mistakes ship is validated` }));
  }
  const { worktree, branch, project, prompt } = task.intake;
  const say = (text: string) => options.onText?.(`${text}\n`);
  return yield* Effect.scoped(Effect.gen(function*() {
    const lease: Validating = yield* store.validation(id, state, commit);
    let calledAt = Date.now();
    const timed = <A>(call: Op<A>) => Effect.suspend(() => { calledAt = Date.now(); return call; });
    let validation: Validation;
    let report: PipelineReport;
    let unready: string | null = null;
    if (state === "ready") {
      const head = yield* worktrees.head(task.intake);
      // The pipeline validates committed history only, so anything else is a recorded failure rather than a submission.
      if (head.commit !== commit || !head.clean) unready = `The task worktree is not clean at the ready commit ${commit}; resume the task to commit or discard its changes`;
      validation = yield* lease.start();
      say(`Validating ${commit} through no-mistakes`);
      report = unready ? { runId: null, branch: null, status: null, head: null, pr: null, gate: null, outcome: null, error: unready } : yield* timed(pipeline.start(worktree, prompt, options.signal));
    } else {
      const running = (yield* store.validations(id)).findLast(v => v.status === "running");
      if (!running) return yield* Effect.fail(new InvalidTransition({ message: "The task is validating, but no running validation is recorded" }));
      validation = running;
      say(`Reattaching to the no-mistakes run of ${commit}`);
      report = yield* pipeline.status(worktree, validation.runId);
    }

    const fail = (outcome: string | null, error: string) => Effect.gen(function*() {
      const failed = yield* lease.fail(validation.id, { runId: report.runId ?? validation.runId, outcome, error });
      say(`Validation failed: ${error}`);
      const record = (yield* store.validations(id)).find(v => v.id === validation.id)!;
      return { task: failed, validation: record, outcome: "failed", hold: null, detail: error } satisfies ValidateResult;
    });

    if (unready) return yield* fail(null, unready);
    let errors = 0;
    while (true) {
      if (options.signal?.aborted) return yield* Effect.fail(new RunInterrupted({ message: "Validation driving was interrupted; the pipeline keeps its run, and validate reattaches to it" }));
      const owned = report.branch === null || report.branch === branch;
      if (report.runId && owned && report.runId !== validation.runId) validation = yield* lease.run(validation.id, report.runId);

      if (report.outcome && owned) {
        const outcome = report.outcome;
        if (!passing.has(outcome)) return yield* fail(outcome, report.error ?? `The pipeline ended ${outcome}`);
        const repository = yield* forge.locate(project, "origin");
        let pr = yield* forge.findPr(repository, branch, target);
        for (let attempt = 1; (!pr || (report.pr !== null && pr.url !== report.pr)) && attempt < prAttempts; attempt++) {
          yield* Effect.sleep(prDelayMs);
          pr = yield* forge.findPr(repository, branch, target);
        }
        if (!pr) return yield* fail(outcome, `The pipeline ended ${outcome}, but the forge shows no open PR from ${branch} into ${target}`);
        if (report.pr !== null && pr.url !== report.pr) return yield* fail(outcome, `The pipeline reported ${report.pr}, but the forge's open PR from ${branch} is ${pr.url}`);
        const ref = { url: pr.url, number: pr.number, head: pr.head, target: pr.target };
        const passed = yield* lease.pass(validation.id, { runId: validation.runId ?? "unknown", outcome, pr: ref, pipelineHead: report.head });
        say(`Validated: ${outcome}; ${pr.url} at ${pr.head}`);
        return {
          task: passed, validation: (yield* store.validations(id)).find(v => v.id === validation.id)!, outcome: "pr-open", hold: null, detail: `${outcome}: ${pr.url}`,
        } satisfies ValidateResult;
      }

      if (report.gate && owned) {
        errors = 0;
        const runId = validation.runId;
        if (!runId) return yield* Effect.fail(new AppError({ message: "The pipeline raised a gate without naming its run" }));
        const { step, summary, findings } = report.gate;
        const responses = yield* lease.responses(validation.id, runId, step);
        const gate: PipelineGate = { runId, step, occurrence: responses.length + 1, summary, findings: [...findings] };
        yield* lease.gate(validation.id, gate);
        const held = (yield* store.holds(id)).find(h => h.subject?.validation === validation.id && h.subject.gate.runId === runId
          && h.subject.gate.step === step && h.subject.gate.occurrence === gate.occurrence);
        let response: GateResponse;
        let by: "policy" | "captain";
        let reason: string;
        if (held?.status === "open") {
          say(`Held for the captain: hold ${held.id} (${step})`);
          return { task: yield* store.get(id), validation, outcome: "held", hold: held, detail: held.question } satisfies ValidateResult;
        }
        if (held?.answer && held.subject) {
          const ids = (list: readonly PipelineFinding[]) => list.map(f => f.id).join(",");
          if (ids(held.subject.gate.findings) !== ids(findings)) {
            return yield* Effect.fail(new AppError({ message: `The ${step} gate's findings changed since hold ${held.id} was opened; its answer is not carried out` }));
          }
          const { action, text } = held.answer;
          if (!action) return yield* Effect.fail(new AppError({ message: `Hold ${held.id}'s answer names no gate action to carry out` }));
          const answered = held.answer.findings ?? [];
          by = "captain";
          reason = `Carries out the captain's answer to hold ${held.id}`;
          response = {
            step, action, findings: action === "fix" ? answered.length ? [...answered] : findings.map(f => f.id) : [],
            instructions: action === "fix" ? text : null, reason: action === "approve" && step === "test" ? text : null,
          };
        } else {
          const decision = decideGate(gate, responses.filter(r => r.by === "policy" && r.action === "fix").length);
          if (decision.hold) {
            const hold = yield* lease.hold(validation.id, gate, questionOf(gate, decision.reason));
            say(`Held for the captain: hold ${hold.id} (${step}): ${decision.reason}`);
            return { task: yield* store.get(id), validation, outcome: "held", hold, detail: hold.question } satisfies ValidateResult;
          }
          by = "policy";
          reason = decision.reason;
          response = { step, action: decision.action, findings: decision.findings, instructions: null, reason: null };
        }
        yield* lease.respond({ id: validation.id, runId, step, occurrence: gate.occurrence, action: response.action, findings: [...response.findings], by, hold: held?.id ?? null, reason });
        say(`${by === "captain" ? "Captain" : "Policy"}: ${response.action} ${step}${response.findings.length ? ` (${response.findings.join(", ")})` : ""}`);
        report = yield* timed(pipeline.respond(worktree, response, options.signal));
        continue;
      }

      if (report.error || !owned) {
        if (Date.now() - calledAt < boundedHoldMs && ++errors > errorLimit) return yield* Effect.fail(new AppError({ message: `The pipeline could not be driven: ${report.error ?? `it reports branch ${report.branch}`}; validate retries` }));
        const status = yield* pipeline.status(worktree, validation.runId);
        if (status.error) {
          // Without a recorded run the pipeline never took the submission, so nothing is left to wait for.
          if (!validation.runId) return yield* fail(null, `The pipeline did not start a run: ${report.error ?? status.error}`);
          return yield* Effect.fail(new AppError({ message: `The pipeline's run cannot be read: ${status.error}; validate retries` }));
        }
        if (!status.runId || (status.branch !== null && status.branch !== branch)) {
          return yield* fail(null, `The pipeline has no run for ${branch}${report.error ? `: ${report.error}` : ""}`);
        }
        if (status.runId !== validation.runId) validation = yield* lease.run(validation.id, status.runId);
        if (status.outcome || status.gate) { report = status; continue; }
      } else errors = 0;
      // Running without a gate or outcome: drive it to its next one.
      report = yield* timed(pipeline.attach(worktree, options.signal));
    }
  }));
});
