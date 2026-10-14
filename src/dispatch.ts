import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Context, Effect, Layer } from "effect";
import {
  appError, InvalidInput, type DispatchCandidate, type DispatchDecision, type Effort, type QuotaEvidence, type ReasoningClass,
} from "./domain.js";
import { TaskStore } from "./store.js";
import { Runtimes, staticRuntime, unverified, type AccountCheck, type WorkerRuntime } from "./runtime.js";

// ---- configuration ----

/** One concrete dispatch profile. */
export interface Profile {
  runtime: string;
  model?: string;
  effort?: Effort;
  reasoning?: ReasoningClass;
  /** The quota-axi provider family whose quota applies; defaults to the runtime's own. */
  provider?: string;
  /** The captain's floor: below this known percentage remaining the candidate is tight. */
  floor?: { minPercent: number };
}
export interface Rule {
  name: string;
  when: { kind?: "ship" | "scout"; project?: string; match?: string };
  use: Profile | Profile[];
  /** The weakest reasoning class the rule's work may run on. */
  minReasoning?: ReasoningClass;
  why?: string;
}
export type QuotaSource = { kind: "quota-axi" } | { kind: "file"; path: string } | { kind: "none" };
/** A home's dispatch configuration: `<home>/dispatch.json`, documented in docs/architecture.md "Dispatch". */
export interface DispatchConfig {
  /** The static runtime, used when no override, rule, or default applies. */
  runtime: string;
  rules: Rule[];
  default: Profile | Profile[] | null;
  quota: QuotaSource;
  /** How long a dispatched task is expected to run; known runway shorter than this is tight. */
  horizonMinutes: number;
  /** Null when the home has no dispatch.json. */
  path: string | null;
}

const efforts: readonly string[] = ["low", "medium", "high", "xhigh", "max"];
const classes: readonly string[] = ["high", "medium", "low"];
const strength = (reasoning: ReasoningClass | null | undefined) => reasoning ? 3 - classes.indexOf(reasoning) : 0;
const providerPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validates a parsed dispatch.json, collecting every problem with its path
 * rather than stopping at the first, so one report names everything to fix.
 */
export function validateConfig(input: unknown, verified: ReadonlyMap<string, WorkerRuntime>, path: string | null): DispatchConfig | { problems: string[] } {
  const problems: string[] = [];
  const unknownKeys = (value: Record<string, unknown>, allowed: readonly string[], at: string) => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(`${at}: unknown field "${key}" (allowed: ${allowed.join(", ")})`);
  };
  const runtimeOf = (value: unknown, at: string): string | undefined => {
    if (typeof value !== "string" || !value) { problems.push(`${at}: must name a runtime`); return undefined; }
    const problem = unverified(value, verified);
    if (problem) { problems.push(`${at}: ${problem}`); return undefined; }
    return value;
  };
  const profile = (value: unknown, at: string): Profile | undefined => {
    if (!isObject(value)) { problems.push(`${at}: a profile must be an object with at least "runtime"`); return undefined; }
    unknownKeys(value, ["runtime", "model", "effort", "reasoning", "provider", "floor"], at);
    const runtime = runtimeOf(value.runtime, `${at}.runtime`);
    const result: Profile = { runtime: runtime ?? "" };
    if (value.model !== undefined) {
      if (typeof value.model !== "string" || !value.model.trim()) problems.push(`${at}.model: must be a non-empty string`);
      else result.model = value.model;
    }
    if (value.effort !== undefined) {
      if (typeof value.effort !== "string" || !efforts.includes(value.effort)) problems.push(`${at}.effort: must be one of ${efforts.join(", ")}`);
      else if (runtime && !verified.get(runtime)!.efforts.includes(value.effort as Effort)) problems.push(`${at}.effort: runtime "${runtime}" does not accept "${value.effort}"`);
      else result.effort = value.effort as Effort;
    }
    if (value.reasoning !== undefined) {
      if (typeof value.reasoning !== "string" || !classes.includes(value.reasoning)) problems.push(`${at}.reasoning: must be one of ${classes.join(", ")}`);
      else result.reasoning = value.reasoning as ReasoningClass;
    }
    if (value.provider !== undefined) {
      if (typeof value.provider !== "string" || !providerPattern.test(value.provider)) problems.push(`${at}.provider: must be a quota-axi provider id such as "claude"`);
      else result.provider = value.provider;
    }
    if (value.floor !== undefined) {
      if (!isObject(value.floor) || typeof value.floor.minPercent !== "number" || value.floor.minPercent < 0 || value.floor.minPercent > 100) {
        problems.push(`${at}.floor: must be { "minPercent": <0-100> }`);
      } else {
        unknownKeys(value.floor, ["minPercent"], `${at}.floor`);
        result.floor = { minPercent: value.floor.minPercent };
      }
    }
    return runtime ? result : undefined;
  };
  /** One profile, or a non-empty array of distinct profiles that each declare a reasoning class. */
  const profiles = (value: unknown, at: string): Profile | Profile[] | undefined => {
    if (!Array.isArray(value)) return profile(value, at);
    if (!value.length) { problems.push(`${at}: a profile array must not be empty`); return undefined; }
    const list = value.map((entry, index) => profile(entry, `${at}[${index}]`));
    const seen = new Map<string, number>();
    list.forEach((entry, index) => {
      if (!entry) return;
      if (value.length > 1 && !entry.reasoning) problems.push(`${at}[${index}].reasoning: every profile in an array declares its reasoning class (high, medium, or low), so a tight quota never silently downgrades it`);
      const key = JSON.stringify([entry.runtime, entry.model ?? null, entry.effort ?? null, entry.provider ?? null]);
      if (seen.has(key)) problems.push(`${at}[${index}]: duplicates ${at}[${seen.get(key)}]`);
      else seen.set(key, index);
    });
    return list.every(entry => entry) ? list as Profile[] : undefined;
  };

  if (!isObject(input)) return { problems: ["the file must hold a JSON object"] };
  unknownKeys(input, ["runtime", "rules", "default", "quota", "horizonMinutes"], "dispatch.json");
  const runtime = input.runtime === undefined ? staticRuntime : runtimeOf(input.runtime, "runtime");
  const rules: Rule[] = [];
  if (input.rules !== undefined && !Array.isArray(input.rules)) problems.push("rules: must be an array");
  const names = new Set<string>();
  (Array.isArray(input.rules) ? input.rules : []).forEach((value: unknown, index) => {
    const at = `rules[${index}]`;
    if (!isObject(value)) { problems.push(`${at}: a rule must be an object with "name", "when", and "use"`); return; }
    unknownKeys(value, ["name", "when", "use", "minReasoning", "why"], at);
    if (typeof value.name !== "string" || !value.name.trim()) problems.push(`${at}.name: must be a non-empty string`);
    else if (names.has(value.name)) problems.push(`${at}.name: "${value.name}" names another rule too`);
    else names.add(value.name);
    const when = value.when;
    if (!isObject(when) || !["kind", "project", "match"].some(key => when[key] !== undefined)) {
      problems.push(`${at}.when: must name at least one of kind, project, or match`);
    } else {
      unknownKeys(when, ["kind", "project", "match"], `${at}.when`);
      if (when.kind !== undefined && when.kind !== "ship" && when.kind !== "scout") problems.push(`${at}.when.kind: must be ship or scout`);
      if (when.project !== undefined && (typeof when.project !== "string" || !when.project)) problems.push(`${at}.when.project: must be a registered project's name`);
      if (when.match !== undefined) {
        if (typeof when.match !== "string" || !when.match) problems.push(`${at}.when.match: must be a regular expression matched against the task prompt`);
        else try { new RegExp(when.match, "i"); } catch (error) { problems.push(`${at}.when.match: ${appError(error).message}`); }
      }
    }
    if (value.use === undefined) problems.push(`${at}.use: required, one profile or an array of profiles`);
    const use = value.use === undefined ? undefined : profiles(value.use, `${at}.use`);
    if (value.minReasoning !== undefined && (typeof value.minReasoning !== "string" || !classes.includes(value.minReasoning))) {
      problems.push(`${at}.minReasoning: must be one of ${classes.join(", ")}`);
    }
    if (value.why !== undefined && typeof value.why !== "string") problems.push(`${at}.why: must be a string`);
    if (use && typeof value.name === "string" && isObject(when)) {
      rules.push({
        name: value.name, when: when as Rule["when"], use,
        ...(value.minReasoning !== undefined ? { minReasoning: value.minReasoning as ReasoningClass } : {}),
        ...(typeof value.why === "string" ? { why: value.why } : {}),
      });
    }
  });
  const fallback = input.default === undefined ? null : profiles(input.default, "default") ?? null;
  let quota: QuotaSource = { kind: "quota-axi" };
  if (input.quota !== undefined) {
    const value = input.quota;
    if (!isObject(value) || !["quota-axi", "file", "none"].includes(String(value.source))) problems.push(`quota: must be { "source": "quota-axi" | "file" | "none" }`);
    else {
      unknownKeys(value, ["source", "path"], "quota");
      if (value.source === "file") {
        if (typeof value.path !== "string" || !isAbsolute(value.path)) problems.push(`quota.path: the file source needs the absolute path of a saved quota-axi --json document`);
        else quota = { kind: "file", path: value.path };
      } else quota = { kind: value.source as "quota-axi" | "none" };
    }
  }
  const horizon = input.horizonMinutes ?? 120;
  if (typeof horizon !== "number" || !Number.isFinite(horizon) || horizon <= 0) problems.push("horizonMinutes: must be a positive number of minutes");
  if (problems.length || !runtime) return { problems };
  return { runtime, rules, default: fallback, quota, horizonMinutes: horizon as number, path };
}

const configPath = (home: string) => join(home, "dispatch.json");

/** The home's dispatch configuration; a home without dispatch.json uses the static runtime. A malformed file is refused, never routed around. */
export const loadConfig = Effect.fn("firstmate.loadDispatchConfig")(function*() {
  const store = yield* TaskStore;
  const runtimes = yield* Runtimes;
  const path = configPath(store.home);
  const text = yield* Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: appError }).pipe(
    Effect.catch(error => /ENOENT/.test(error.message) ? Effect.succeed(null) : Effect.fail(error)));
  const refuse = (problems: readonly string[]) => new InvalidInput({
    message: `Invalid dispatch configuration ${path}: ${problems.join("; ")}. Fix the file (its schema is in docs/architecture.md, "Dispatch") or remove it; nothing is dispatched around it`,
  });
  if (text === null) return validateConfig({}, runtimes.verified, null) as DispatchConfig;
  let input: unknown;
  try { input = JSON.parse(text); } catch (error) { return yield* Effect.fail(refuse([`not valid JSON: ${appError(error).message}`])); }
  const config = validateConfig(input, runtimes.verified, path);
  if ("problems" in config) return yield* Effect.fail(refuse(config.problems));
  return config;
});

// ---- quota ----

export interface QuotaRow {
  provider: string;
  scope: string;
  percentRemaining: number | null;
  spendPriority: number | null;
  runway: QuotaEvidence["runway"];
  runwaySeconds: number | null;
}
/** One quota reading; a reading that failed carries its error and no rows, which is uncertainty, not a blocker. */
export interface QuotaSnapshot {
  source: string;
  takenAt: string | null;
  error: string | null;
  rows: QuotaRow[];
  attention: { provider: string; scope: string; detail: string }[];
}
export interface QuotaProviderShape {
  read(source: QuotaSource, providers: readonly string[]): Effect.Effect<QuotaSnapshot>;
}

const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const runways: readonly string[] = ["through_reset", "projected_exhaustion", "exhausted_now"];

/** Reads a `quota-axi --json` document; only the default account's rows apply, since dispatch never picks an account. */
export function parseQuotaAxi(document: unknown, source: string): QuotaSnapshot {
  const snapshot: QuotaSnapshot = { source, takenAt: null, error: null, rows: [], attention: [] };
  if (!isObject(document) || !Array.isArray(document.providers)) return { ...snapshot, error: "not a quota-axi --json document" };
  snapshot.takenAt = typeof document.generatedAt === "string" ? document.generatedAt : null;
  for (const entry of document.providers) {
    if (!isObject(entry) || typeof entry.provider !== "string") continue;
    const provider = entry.provider;
    if (entry.notSetUp === true) { snapshot.attention.push({ provider, scope: "all", detail: "not set up" }); continue; }
    const state = isObject(entry.state) ? entry.state : {};
    if (state.status !== undefined && state.status !== "fresh") {
      const remedy = typeof state.remedyCommand === "string" ? `; remedy: ${state.remedyCommand}` : "";
      snapshot.attention.push({ provider, scope: "all", detail: `${String(state.status)}${state.error ? ` (${String(state.error)})` : ""}${remedy}` });
    }
    if (state.stale === true) snapshot.attention.push({ provider, scope: "all", detail: "stale reading" });
    const semantics = isObject(entry.quotaSemantics) ? entry.quotaSemantics : {};
    for (const row of Array.isArray(semantics.effectiveAvailability) ? semantics.effectiveAvailability : []) {
      if (!isObject(row) || typeof row.scope !== "string") continue;
      if (typeof row.accountKey === "string" && row.accountKey !== "default") continue;
      const runway = isObject(row.runway) ? row.runway : {};
      const selection = isObject(row.selection) ? row.selection : {};
      if (row.status !== "known") snapshot.attention.push({ provider, scope: row.scope, detail: `scope ${String(row.status ?? "unmeasured")}` });
      snapshot.rows.push({
        provider, scope: row.scope,
        percentRemaining: row.status === "known" ? number(row.effectivePercentRemaining) : null,
        spendPriority: selection.status === "known" ? number(selection.spendPriority) : null,
        runway: runways.includes(String(runway.status)) ? runway.status as QuotaRow["runway"] : "unknown",
        runwaySeconds: number(runway.usableRunwaySeconds),
      });
    }
  }
  return snapshot;
}

/** Runs quota-axi with an argument array; any failure is reported in the snapshot rather than raised. */
const readQuotaAxi = (providers: readonly string[]) => new Promise<QuotaSnapshot>(done => {
  const args = ["--json", ...(providers.length ? ["--provider", providers.join(",")] : [])];
  execFile("quota-axi", args, { timeout: 90_000, maxBuffer: 8 << 20 }, (error, stdout) => {
    const source = `quota-axi ${args.join(" ")}`;
    try { done(parseQuotaAxi(JSON.parse(stdout), source)); }
    catch { done({ source, takenAt: null, error: error ? error.message : "quota-axi printed no JSON", rows: [], attention: [] }); }
  });
});

export const defaultQuota: QuotaProviderShape = {
  read: (source, providers) => {
    switch (source.kind) {
      case "none": return Effect.succeed({ source: "none", takenAt: null, error: "quota reading is turned off in dispatch.json", rows: [], attention: [] });
      case "file": return Effect.promise(() => readFile(source.path, "utf8")
        .then(text => parseQuotaAxi(JSON.parse(text), `file ${source.path}`))
        .catch(error => ({ source: `file ${source.path}`, takenAt: null, error: appError(error).message, rows: [], attention: [] })));
      case "quota-axi": return Effect.promise(() => readQuotaAxi(providers));
    }
  },
};

/** Quota evidence for profile arrays; tests and fixtures inject their own. */
export class QuotaProvider extends Context.Service<QuotaProvider, QuotaProviderShape>()("firstmate/QuotaProvider") {
  static layer(shape: QuotaProviderShape = defaultQuota) { return Layer.succeed(QuotaProvider, shape); }
}

// ---- resolution ----

/** What a task asks dispatch for; overrides are the task's own explicit choices. */
export interface DispatchRequest {
  kind: "ship" | "scout";
  /** The registered project, or null for an unregistered task. */
  projectName: string | null;
  prompt: string;
  runtime?: string;
  model?: string;
  effort?: Effort;
}

const broadScopes = new Set(["all", "all_models", "all_products"]);

/** The quota facts for one candidate: its provider's provider-wide scopes plus any scope named for its model. */
function evidence(snapshot: QuotaSnapshot, provider: string, model: string | null): QuotaEvidence {
  const rows = snapshot.rows.filter(row => row.provider === provider && (broadScopes.has(row.scope) || row.scope === model));
  const known = <K extends "percentRemaining" | "spendPriority">(key: K) => rows.map(row => row[key]).filter((value): value is number => value !== null);
  const min = (values: number[]) => values.length ? Math.min(...values) : null;
  const projected = rows.filter(row => row.runway === "projected_exhaustion").map(row => row.runwaySeconds).filter((value): value is number => value !== null);
  const runway = rows.some(row => row.runway === "exhausted_now") ? "exhausted_now"
    : projected.length ? "projected_exhaustion"
    : rows.length && rows.every(row => row.runway === "through_reset") ? "through_reset" : "unknown";
  return {
    provider, scopes: rows.map(row => row.scope),
    percentRemaining: min(known("percentRemaining")), spendPriority: min(known("spendPriority")),
    runway, runwaySeconds: runway === "exhausted_now" ? 0 : runway === "projected_exhaustion" ? min(projected) : null,
    attention: snapshot.attention.filter(entry => entry.provider === provider).map(entry => `${entry.scope}: ${entry.detail}`),
  };
}

interface Judged extends DispatchCandidate { readonly profile: Profile }

const describe = (candidate: DispatchCandidate) =>
  `${candidate.runtime}/${candidate.model ?? "default model"}${candidate.reasoning ? ` (reasoning ${candidate.reasoning})` : ""}: ${candidate.verdict}, ${candidate.reason}`
  + (candidate.uncertainty.length ? `; uncertain: ${candidate.uncertainty.join("; ")}` : "");

/** The effort used when neither the task nor its profile names one; never `max`. */
export function effortFallback(kind: "ship" | "scout", runtime: WorkerRuntime): { effort: Effort; note: string } {
  const wanted: Effort = kind === "scout" ? "xhigh" : "high";
  const allowed = runtime.efforts.filter(effort => effort !== "max");
  const effort = allowed.includes(wanted) ? wanted : allowed[allowed.length - 1] ?? "high";
  return {
    effort,
    note: `Effort fell back to ${effort}: ${kind === "scout" ? "a scout is open-ended investigation" : "a ship is bounded implementation"}${effort !== wanted ? `, capped at ${runtime.name}'s highest level below max` : ""}; the fallback never chooses max`,
  };
}

/**
 * Chooses a task's runtime, model, and effort. Precedence: the task's
 * explicit override, then the best-fit rule, then the default, then the
 * static runtime. A profile array is resolved from one quota snapshot with
 * every candidate accounted for; missing quota is disclosed uncertainty.
 * When every candidate is tight, the strongest reasoning is kept and the
 * tightness reported. Ties are refused for the captain to choose, never
 * broken by array order.
 */
export const resolveDispatch = Effect.fn("firstmate.resolveDispatch")(function*(request: DispatchRequest) {
  const store = yield* TaskStore;
  const runtimes = yield* Runtimes;
  const quota = yield* QuotaProvider;
  const config = yield* loadConfig();
  const notes: string[] = [];
  if (request.effort !== undefined && !efforts.includes(request.effort)) {
    return yield* Effect.fail(new InvalidInput({ message: `--effort must be one of ${efforts.join(", ")}` }));
  }

  let source: DispatchDecision["source"];
  let rule: Rule | null = null;
  let use: Profile | Profile[];
  if (request.runtime !== undefined || request.model !== undefined) {
    source = "override";
    const runtime = yield* runtimes.require(request.runtime ?? config.runtime);
    use = { runtime: runtime.name, ...(request.model !== undefined ? { model: request.model } : {}) };
  } else {
    const fits = config.rules.map(candidate => {
      const { kind, project, match } = candidate.when;
      const ok = (kind === undefined || kind === request.kind) && (project === undefined || project === request.projectName)
        && (match === undefined || new RegExp(match, "i").test(request.prompt));
      return { rule: candidate, ok, specificity: [kind, project, match].filter(value => value !== undefined).length };
    }).filter(fit => fit.ok);
    const best = Math.max(0, ...fits.map(fit => fit.specificity));
    const top = fits.filter(fit => fit.specificity === best);
    if (top.length > 1) {
      return yield* Effect.fail(new InvalidInput({
        message: `Dispatch rules ${top.map(fit => `"${fit.rule.name}"`).join(" and ")} fit this task equally (${best} condition${best === 1 ? "" : "s"} each), and rule order never decides; `
          + "make one rule more specific in dispatch.json, or choose with --runtime and --model",
      }));
    }
    if (top[0]) { source = "rule"; rule = top[0].rule; use = rule.use; }
    else if (config.default) { source = "default"; use = config.default; }
    else { source = "static"; use = { runtime: config.runtime }; }
  }

  // Each runtime's pin is read and checked once; dispatch never changes a pin.
  const accounts = new Map<string, { pin: string; check: AccountCheck } | null>();
  for (const profile of Array.isArray(use) ? use : [use]) {
    if (accounts.has(profile.runtime)) continue;
    const pin = yield* store.accountPin(profile.runtime);
    if (!pin) { accounts.set(profile.runtime, null); continue; }
    const readable = pin.root === "ordinary" || (yield* Effect.promise(() => stat(pin.root).then(info => info.isDirectory(), () => false)));
    const runtime = yield* runtimes.require(profile.runtime);
    const check = readable ? yield* runtime.account(pin.root)
      : { signedIn: false, detail: `${pin.root} is not a readable directory`, login: runtime.login(pin.root) };
    accounts.set(profile.runtime, { pin: pin.root, check });
  }
  const accountProblem = (runtime: string) => {
    const account = accounts.get(runtime);
    return account?.check.signedIn === false
      ? `the pinned ${runtime} account (${account.pin}) is not signed in (${account.check.detail}); sign in with \`${account.check.login}\`, or change the pin with firstmate account pin ${runtime} <root|ordinary>, since dispatch never changes it`
      : null;
  };

  const profilesUsed = Array.isArray(use) ? use : [use];
  const required = rule?.minReasoning;
  let snapshot: QuotaSnapshot | null = null;
  if (profilesUsed.length > 1) {
    const providers = [...new Set(profilesUsed.map(profile => profile.provider ?? runtimes.verified.get(profile.runtime)!.provider))];
    snapshot = yield* quota.read(config.quota, providers);
  }
  const horizonSeconds = Math.round(config.horizonMinutes * 60);

  const judged: Judged[] = profilesUsed.map(profile => {
    const runtime = runtimes.verified.get(profile.runtime)!;
    const provider = profile.provider ?? runtime.provider;
    const model = profile.model ?? null;
    const uncertainty: string[] = [];
    if (model !== null) uncertainty.push(`${runtime.name} publishes no offline model catalog, so support for ${model} is confirmed only at launch`);
    const account = accounts.get(profile.runtime);
    if (account?.check.signedIn === null) uncertainty.push(`pinned account ${account.pin} unconfirmed: ${account.check.detail}`);
    const base = { runtime: runtime.name, model, effort: profile.effort ?? null, reasoning: profile.reasoning ?? null, provider, profile };
    const blocked = accountProblem(profile.runtime);
    if (blocked) return { ...base, verdict: "blocked", runway: "unknown", quota: null, uncertainty, reason: blocked };
    if (required && strength(profile.reasoning) < strength(required)) {
      return { ...base, verdict: "blocked", runway: "unknown", quota: null, uncertainty, reason: `reasoning ${profile.reasoning ?? "undeclared"} is below rule "${rule!.name}"'s required ${required}` };
    }
    if (!snapshot) return { ...base, verdict: "eligible", runway: "unknown", quota: null, uncertainty, reason: "the only profile, so no quota was consulted" };
    const facts = evidence(snapshot, provider, model);
    if (snapshot.error) uncertainty.push(`quota reading failed: ${snapshot.error}`);
    else if (!facts.scopes.length) uncertainty.push(`no quota measured for provider ${provider}${facts.attention.length ? ` (${facts.attention.join("; ")})` : ""}`);
    if (facts.scopes.length && facts.spendPriority === null) uncertainty.push("spendPriority unknown");
    const runway = facts.runway === "exhausted_now" ? "fail" : facts.runway === "through_reset" ? "pass"
      : facts.runway === "projected_exhaustion" && facts.runwaySeconds !== null ? (facts.runwaySeconds >= horizonSeconds ? "pass" : "fail") : "unknown";
    if (runway === "unknown") uncertainty.push("runway unknown, so it is not assumed to last");
    const floor = profile.floor;
    const belowFloor = floor !== undefined && facts.percentRemaining !== null && facts.percentRemaining < floor.minPercent;
    if (floor && facts.percentRemaining === null) uncertainty.push(`floor of ${floor.minPercent}% unverifiable`);
    const tight = runway === "fail" || belowFloor;
    const reason = [
      `spendPriority ${facts.spendPriority ?? "unknown"}`, `${facts.percentRemaining ?? "unknown"}% remaining`,
      `runway ${facts.runway}${facts.runwaySeconds !== null ? ` ${facts.runwaySeconds}s` : ""} against a ${horizonSeconds}s horizon`,
      ...(belowFloor ? [`below its floor of ${floor!.minPercent}%`] : []),
    ].join(", ");
    return { ...base, verdict: tight ? "tight" : "eligible", runway, quota: facts, uncertainty, reason };
  });

  // Viable runway first, then unknown runway, and tight only when nothing else remains.
  const open = judged.filter(candidate => candidate.verdict !== "blocked");
  if (!open.length) {
    return yield* Effect.fail(new InvalidInput({ message: `No dispatch candidate can run: ${judged.map(describe).join(" | ")}` }));
  }
  const tier = (["pass", "unknown"] as const).map(runway => open.filter(candidate => candidate.verdict === "eligible" && candidate.runway === runway)).find(group => group.length)
    ?? open.filter(candidate => candidate.verdict === "tight");
  const allTight = tier.every(candidate => candidate.verdict === "tight");
  // Higher known spendPriority wins; with none known, or when every candidate is tight, the stronger reasoning class wins.
  const score = (candidate: Judged): [number, number] => allTight
    ? [strength(candidate.reasoning), candidate.quota?.spendPriority ?? Number.NEGATIVE_INFINITY]
    : [candidate.quota?.spendPriority !== null && candidate.quota?.spendPriority !== undefined ? 1 : 0, candidate.quota?.spendPriority ?? strength(candidate.reasoning)];
  const compare = (a: Judged, b: Judged) => { const [x, y] = [score(a), score(b)]; return y[0] - x[0] || y[1] - x[1]; };
  const ranked = [...tier].sort(compare);
  const tied = ranked.filter(candidate => compare(candidate, ranked[0]!) === 0);
  if (tied.length > 1) {
    const marked = judged.map(candidate => tied.includes(candidate) ? { ...candidate, verdict: "tied" as const } : candidate);
    return yield* Effect.fail(new InvalidInput({
      message: `Dispatch candidates tie and array order never decides; choose one with --runtime and --model: ${marked.map(describe).join(" | ")}`,
    }));
  }
  const chosen = ranked[0]!;
  if (snapshot) {
    notes.push(allTight
      ? `Every candidate is tight on quota; kept the strongest-reasoning choice ${chosen.runtime}/${chosen.model ?? "default model"} (reasoning ${chosen.reasoning}) rather than downgrading`
      : `Chose ${chosen.runtime}/${chosen.model ?? "default model"} from ${judged.length} candidates: ${chosen.runway === "pass" ? "its runway lasts the horizon" : "no candidate's runway is known to last, so its uncertainty is disclosed"} and ${chosen.quota?.spendPriority !== null && chosen.quota?.spendPriority !== undefined ? `it has the highest known spendPriority (${chosen.quota.spendPriority})` : `with no comparable spendPriority, it has the strongest reasoning (${chosen.reasoning})`}`);
  }
  const runtime = runtimes.verified.get(chosen.runtime)!;
  let effort: Effort;
  let effortFrom: DispatchDecision["effortFrom"];
  if (request.effort !== undefined) { effort = request.effort; effortFrom = "override"; }
  else if (chosen.effort) { effort = chosen.effort; effortFrom = "profile"; }
  else { const fallback = effortFallback(request.kind, runtime); effort = fallback.effort; effortFrom = "fallback"; notes.push(fallback.note); }
  if (!runtime.efforts.includes(effort)) return yield* Effect.fail(new InvalidInput({ message: `Runtime "${runtime.name}" does not accept effort "${effort}" (it accepts ${runtime.efforts.join(", ")})` }));
  const account = accounts.get(runtime.name);
  const decision: DispatchDecision = {
    source, rule: rule?.name ?? null, runtime: runtime.name, model: chosen.model, effort, effortFrom,
    account: account ? { pin: account.pin, signedIn: account.check.signedIn, detail: account.check.detail } : null,
    quota: snapshot ? { source: snapshot.source, takenAt: snapshot.takenAt, error: snapshot.error, horizonSeconds } : null,
    candidates: judged.map(({ profile: _profile, ...candidate }) => ({ ...candidate, verdict: candidate === chosen ? "chosen" : candidate.verdict })),
    notes, decidedAt: new Date().toISOString(),
  };
  return decision;
});
