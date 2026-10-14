import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Store, TaskStore } from "./store.js";
import { alive } from "./secondmates.js";
import { AppError, appError, InvalidInput, InvalidTransition, type Supervisor } from "./domain.js";
import type { Update, UpdateHome } from "./maintenance.js";

/** The package this CLI runs from, and how npm installed it. */
export interface Installation {
  readonly root: string;
  readonly version: string;
  readonly mode: "global" | "local";
  /** What `npm install --prefix` names to replace this installation in place. */
  readonly prefix: string;
}

const packageRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), "..");
const versionAt = (root: string) => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string; version?: string };
  if (manifest.name !== "firstmate-ai" || typeof manifest.version !== "string") throw new AppError({ message: `${root} is not the firstmate-ai package` });
  return manifest.version;
};

/**
 * Where npm installed this firstmate: globally under `<prefix>/lib/node_modules`
 * (POSIX) or `<prefix>/node_modules` beside its command shims (Windows), or
 * locally in a project's `node_modules`. A source checkout is not an npm
 * installation and is refused; it updates through Git.
 */
export function locateInstallation(root = packageRoot()): Installation {
  const version = versionAt(root);
  const modules = dirname(root);
  if (basename(root) !== "firstmate-ai" || basename(modules) !== "node_modules") {
    throw new InvalidTransition({ message: `This firstmate runs from ${root}, which npm did not install; update a source checkout with Git and npm run build` });
  }
  const above = dirname(modules);
  if (process.platform !== "win32" && basename(above) === "lib") return { root, version, mode: "global", prefix: dirname(above) };
  if (process.platform === "win32" && existsSync(join(above, "firstmate.cmd"))) return { root, version, mode: "global", prefix: above };
  return { root, version, mode: "local", prefix: above };
}

/** npm's arguments to install `spec` over this installation. */
const npmArgs = (installation: Installation, spec: string) =>
  ["install", ...(installation.mode === "global" ? ["--global"] : []), "--prefix", installation.prefix, "--no-audit", "--no-fund", spec];

/**
 * Runs npm with an argument array. Windows starts npm's `.cmd` shim only
 * through a shell, so there each argument is quoted for cmd.exe.
 */
const runNpm = (args: readonly string[]) => Effect.callback<{ code: number | null; output: string }, AppError>(resume => {
  const windows = process.platform === "win32";
  const quote = (arg: string) => /^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
  const child = windows
    ? spawn(["npm", ...args.map(quote)].join(" "), { shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    : spawn("npm", [...args], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const keep = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-8_192); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.once("error", error => resume(Effect.fail(new AppError({ message: `npm did not start: ${error.message}` }))));
  child.once("close", code => resume(Effect.succeed({ code, output })));
});

/** The `supervisor start` arguments that reproduce a supervisor's recorded settings. */
export function restartArgs(record: Supervisor): string[] {
  const { settings } = record;
  return [
    "--concurrency", String(settings.concurrency), "--poll-ms", String(settings.pollMs), "--stale-after", String(settings.staleMs / 1000), "--recoveries", String(settings.recoveries),
    ...(settings.forgeMs !== undefined ? ["--forge-every", String(settings.forgeMs / 1000)] : []),
    ...(settings.secondmateMs !== undefined ? ["--secondmate-every", String(settings.secondmateMs / 1000)] : []),
    ...(settings.reannounceMs !== undefined ? ["--reannounce-after", String(settings.reannounceMs / 1000)] : []),
  ];
}

/** Opens a local home's store for one read or write. */
const withHome = <A>(home: string, f: (store: Store) => A) => Effect.try({
  try: () => { const store = new Store(home); try { return f(store); } finally { store.close(); } },
  catch: appError,
});

/** Starts a home's supervisor from the installed CLI as a separate process, logging to `<home>/supervisor.log`. */
const launch = (cli: string, home: string, args: readonly string[]) => Effect.try({
  try: () => {
    const log = openSync(join(home, "supervisor.log"), "a");
    try {
      const child = spawn(process.execPath, [cli, "supervisor", "start", "--home", home, ...args], { detached: true, stdio: ["ignore", log, log], env: process.env, windowsHide: true });
      if (child.pid === undefined) throw new AppError({ message: `The supervisor for ${home} did not start` });
      child.unref();
      return child.pid;
    } finally { closeSync(log); }
  },
  catch: appError,
});

/** How long a restarted supervisor has to take its home's lease. */
const confirmMs = 20_000;

/** Waits a bounded time for `pid` to hold the home's supervisor lease. */
const confirm = (home: string, pid: number) => Effect.gen(function*() {
  const deadline = Date.now() + confirmMs;
  while (Date.now() < deadline) {
    const { record, owner } = yield* withHome(home, store => store.supervisor());
    if (owner === "live" && record?.pid === pid) return true;
    if (!alive(pid)) return false;
    yield* Effect.sleep(250);
  }
  return false;
});

export interface UpdateOptions {
  /** The npm package spec to install: a version, tag, registry name, or tarball path. */
  readonly spec: string;
  /** How long running work may take to drain before the update is refused (default 600 s). */
  readonly waitMs?: number;
  /** Plans and checks without changing anything. */
  readonly dryRun?: boolean;
  readonly onNote?: (note: string) => void;
}

/**
 * The homes an update stops and restarts: the main home and each active
 * secondmate home on this host, each with the reasons it is unsafe now. A
 * supervisor of unknown liveness, a foreground run, or a secondmate home
 * that cannot be read is unsafe; work a supervisor runs is drained instead.
 */
const planHomes = Effect.fn("firstmate.planUpdate")(function*() {
  const store = yield* TaskStore;
  const identity = yield* store.identity();
  if (identity) return yield* Effect.fail(new InvalidTransition({ message: `This home is secondmate "${identity.id}"'s; update from the main home (${identity.parent}), which restarts its secondmates` }));
  const secondmates = (yield* store.secondmates()).filter(s => s.status === "active");
  const homes = [{ home: store.home, secondmate: null as string | null }, ...secondmates.map(s => ({ home: s.home, secondmate: s.id as string | null }))];
  const reasons: string[] = [];
  const planned: UpdateHome[] = [];
  for (const { home, secondmate } of homes) {
    const name = secondmate ? `secondmate ${secondmate}` : "the main home";
    const observed = yield* withHome(home, s => ({ ...s.supervisor(), attempts: s.attempts() })).pipe(Effect.result);
    if (observed._tag === "Failure") { reasons.push(`${name}'s home cannot be read: ${observed.failure.message}`); continue; }
    const { record, owner, attempts } = observed.success;
    if (owner === "unknown") reasons.push(`${name}'s supervisor liveness is unknown from this host`);
    for (const attempt of attempts) {
      if (attempt.owner === "unknown") reasons.push(`${name}'s task ${attempt.task.id} has an attempt of unknown liveness`);
      if (attempt.owner === "live" && attempt.pid !== (owner === "live" ? record?.pid : undefined)) reasons.push(`${name}'s task ${attempt.task.id} runs in the foreground (PID ${attempt.pid}); let it finish or interrupt it`);
    }
    planned.push({ home, secondmate, pid: owner === "live" ? record!.pid : null, args: owner === "live" ? restartArgs(record!) : [], outcome: null, restartedPid: null, detail: null });
  }
  return { homes: planned, reasons };
});

/**
 * Self-update: installs `spec` over this npm installation, then restarts the
 * supervisors that were running. The plan is recorded before anything
 * changes. Each running supervisor is asked to drain (start nothing new, stop
 * once its attempts and validations end); interrupting work is never needed,
 * and a home still running work after the wait withdraws every drain and
 * restarts what already stopped, so the update is refused with nothing
 * installed. A failed install restarts the homes on the version already
 * installed. Secondmates restart before the main home, whose supervisor would
 * otherwise count their stop as an exit.
 */
export const updateFirstmate = Effect.fn("firstmate.updateFirstmate")(function*(options: UpdateOptions) {
  const store = yield* TaskStore;
  const { maintenance } = store;
  const note = options.onNote ?? (() => undefined);
  const waitMs = options.waitMs ?? 600_000;
  if (!options.spec.trim()) return yield* Effect.fail(new InvalidInput({ message: "Name the package to install: a version, tag, or tarball" }));
  if (!(waitMs >= 0)) return yield* Effect.fail(new InvalidInput({ message: "--wait must be a nonnegative number of seconds" }));
  const installation = yield* Effect.try({ try: () => locateInstallation(), catch: appError });
  const active = yield* maintenance.activeUpdate();
  if (active) return yield* Effect.fail(new InvalidTransition({ message: `Update ${active.id} is unfinished (${active.phase}); firstmate update resume finishes it` }));
  const { homes, reasons } = yield* planHomes();
  const plan = { spec: options.spec, installation: { root: installation.root, mode: installation.mode, prefix: installation.prefix }, from: installation.version, to: null, homes, reasons, output: null };
  if (options.dryRun) return { dryRun: true, ...plan, npm: ["npm", ...npmArgs(installation, options.spec)], unsafe: reasons.length > 0 };
  if (reasons.length) {
    const refused = yield* maintenance.beginUpdate({ ...plan, phase: "refused" });
    return yield* Effect.fail(new InvalidTransition({ message: `Update refused (${refused.id}), nothing was changed: ${reasons.join("; ")}` }));
  }
  let update = yield* maintenance.beginUpdate({ ...plan, phase: "draining" });
  note(`Recorded ${update.id}; draining ${homes.filter(h => h.pid !== null).length} running supervisor(s)`);
  update = yield* drain(update, waitMs, note);
  if (update.phase === "refused") {
    return yield* Effect.fail(new InvalidTransition({ message: `Update refused (${update.id}), nothing was installed: ${update.reasons.join("; ")}` }));
  }
  update = yield* maintenance.advanceUpdate(update.id, { phase: "installing" });
  note(`Installing ${options.spec} with npm (${installation.mode}, prefix ${installation.prefix})`);
  const installed = yield* runNpm(npmArgs(installation, options.spec)).pipe(Effect.catch(error => Effect.succeed({ code: null, output: error.message })));
  const to = installed.code === 0 ? yield* Effect.try({ try: () => versionAt(installation.root), catch: appError }).pipe(Effect.catch(() => Effect.succeed(null))) : null;
  if (installed.code !== 0 || to === null) {
    note(`npm failed (exit ${installed.code}); restarting the supervisors on ${installation.version}`);
    update = yield* maintenance.advanceUpdate(update.id, { output: installed.output.slice(-4_096), reasons: [`npm install exited ${installed.code}`] });
    update = yield* restart(update, note);
    update = yield* maintenance.advanceUpdate(update.id, { phase: "failed" });
    return yield* Effect.fail(new AppError({ message: `Update failed (${update.id}): npm install exited ${installed.code}; the supervisors were restarted on ${installation.version}\n${installed.output.slice(-2_000)}` }));
  }
  update = yield* maintenance.advanceUpdate(update.id, { phase: "restarting", to, output: installed.output.slice(-4_096) });
  note(`Installed ${to} (was ${installation.version}); restarting the supervisors`);
  update = yield* restart(update, note);
  return yield* maintenance.advanceUpdate(update.id, { phase: "finished" });
});

/**
 * Asks each running supervisor to drain and waits for all of them to stop.
 * Main first, so it stops relaunching secondmates while they drain. Past the
 * wait, the drains are withdrawn, stopped supervisors restarted, and the run
 * recorded refused.
 */
const drain = (update: Update, waitMs: number, note: (note: string) => void) => Effect.gen(function*() {
  const store = yield* TaskStore;
  const running = update.homes.filter(h => h.pid !== null);
  for (const home of running) {
    const asked = yield* withHome(home.home, s => s.requestDrain(true)).pipe(Effect.result);
    if (asked._tag === "Failure") note(`Drain request for ${home.home}: ${asked.failure.message}`);
  }
  const deadline = Date.now() + waitMs;
  let homes = update.homes;
  while (true) {
    homes = yield* Effect.forEach(homes, home => home.pid === null || home.outcome !== null ? Effect.succeed(home)
      : withHome(home.home, s => s.supervisor()).pipe(Effect.map(({ record, owner }) => owner === "live" && record?.pid === home.pid ? home : { ...home, outcome: "drained" as const })));
    if (homes.every(h => h.pid === null || h.outcome === "drained")) {
      note("Every supervisor drained");
      return yield* store.maintenance.advanceUpdate(update.id, { homes });
    }
    if (Date.now() >= deadline) break;
    yield* Effect.sleep(500);
  }
  const busy = yield* Effect.forEach(homes.filter(h => h.pid !== null && h.outcome === null), home => withHome(home.home, s => {
    s.requestDrain(false);
    const owned = s.attempts().filter(a => a.owner === "live").map(a => a.task.id);
    return `${home.secondmate ? `secondmate ${home.secondmate}` : "the main home"} is still running ${owned.length ? `task(s) ${owned.join(", ")}` : "a validation"}`;
  }).pipe(Effect.catch(error => Effect.succeed(`${home.home}: ${error.message}`))));
  note(`Draining did not finish within ${Math.round(waitMs / 1000)} s; withdrawing the drain`);
  homes = homes.map(h => h.pid !== null && h.outcome === null ? { ...h, outcome: "left-running" as const } : h);
  let next = yield* store.maintenance.advanceUpdate(update.id, { homes, reasons: [`work did not drain within ${Math.round(waitMs / 1000)} s: ${busy.join("; ")}`] });
  next = yield* restart(next, note);
  return yield* store.maintenance.advanceUpdate(update.id, { phase: "refused" });
});

/** Restarts each drained supervisor from the installed CLI, secondmates first, and records what took its lease. */
const restart = (update: Update, note: (note: string) => void) => Effect.gen(function*() {
  const store = yield* TaskStore;
  const cli = join(update.installation.root, "dist", "cli.js");
  const order = [...update.homes.filter(h => h.secondmate !== null), ...update.homes.filter(h => h.secondmate === null)];
  const results = new Map<string, UpdateHome>();
  for (const home of order) {
    if (home.outcome !== "drained") { results.set(home.home, home); continue; }
    const result = yield* Effect.gen(function*() {
      const pid = yield* launch(cli, home.home, home.args);
      if (home.secondmate) yield* store.launched(home.secondmate, pid, "captain", null);
      const confirmed = yield* confirm(home.home, pid);
      return confirmed ? { ...home, outcome: "restarted" as const, restartedPid: pid, detail: null }
        : { ...home, outcome: "failed" as const, restartedPid: pid, detail: `PID ${pid} did not take the home's lease within ${confirmMs / 1000} s; see ${join(home.home, "supervisor.log")}` };
    }).pipe(Effect.catch(error => Effect.succeed({ ...home, outcome: "failed" as const, detail: error.message })));
    note(`${home.secondmate ? `Secondmate ${home.secondmate}` : "Main home"}: ${result.outcome}${result.restartedPid ? ` as PID ${result.restartedPid}` : ""}${result.detail ? ` (${result.detail})` : ""}`);
    results.set(home.home, result);
  }
  return yield* store.maintenance.advanceUpdate(update.id, { homes: update.homes.map(h => results.get(h.home) ?? h) });
});

/**
 * Finishes an update an interruption left unfinished: withdraws any drain
 * still requested, restarts each supervisor it stopped, and closes the run
 * as failed when nothing was installed, else finished.
 */
export const resumeUpdate = Effect.fn("firstmate.resumeUpdate")(function*(onNote?: (note: string) => void) {
  const store = yield* TaskStore;
  const note = onNote ?? (() => undefined);
  const active = yield* store.maintenance.activeUpdate();
  if (!active) return yield* Effect.fail(new InvalidTransition({ message: "No update is unfinished" }));
  const homes = yield* Effect.forEach(active.homes, home => home.pid === null || home.outcome !== null ? Effect.succeed(home) : withHome(home.home, s => {
    const { record, owner } = s.supervisor();
    if (owner === "live" && record?.pid === home.pid) { s.requestDrain(false); return { ...home, outcome: "left-running" as const }; }
    return { ...home, outcome: "drained" as const };
  }).pipe(Effect.catch(error => Effect.succeed({ ...home, outcome: "failed" as const, detail: error.message }))));
  let update = yield* store.maintenance.advanceUpdate(active.id, { homes });
  update = yield* restart(update, note);
  const to = yield* Effect.try({ try: () => versionAt(update.installation.root), catch: appError }).pipe(Effect.catch(() => Effect.succeed(null)));
  return yield* store.maintenance.advanceUpdate(update.id, { phase: to !== null && to !== update.from ? "finished" : "failed", to, reasons: [...update.reasons, "resumed after an interruption"] });
});
