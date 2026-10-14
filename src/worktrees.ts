import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, mkdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Context, Effect, Layer } from "effect";
import { appError, type FirstmateError, type TaskIntake } from "./domain.js";

const execute = promisify(execFile);
export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execute("git", ["-C", cwd, ...args], {
    windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.stdout.trim();
}

/** Runs a Git predicate such as `merge-base --is-ancestor`: exit 0 is true, exit 1 false, anything else an error. */
export async function holds(cwd: string, args: string[]): Promise<boolean> {
  try { await git(cwd, args); return true; }
  catch (error) { if ((error as { code?: unknown }).code === 1) return false; throw error; }
}

export const contains = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
};

/** The repository root at `path`, refused when `path` is not that root. */
export async function projectRoot(path: string): Promise<string> {
  const project = await realpath(resolve(path));
  const root = await realpath(await git(project, ["rev-parse", "--show-toplevel"]));
  if (root !== project) throw new Error(`${path} is not a Git repository root; use the repository root`);
  return project;
}

export async function inspectProject(path: string, base: string) {
  const project = await projectRoot(path);
  const commit = await git(project, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Could not resolve base to a commit");
  return { project, base: commit };
}

/**
 * The local branch a ship's landing advances: `target` when given, else the
 * base when it names a local branch (a registered project's default branch
 * is passed as the base), else the branch checked out in the project when
 * the base is its HEAD. Anything else is refused, never guessed.
 */
export async function resolveTarget(project: string, base: string | undefined, target: string | undefined): Promise<string> {
  const branch = target ?? (base === undefined ? await git(project, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "") : base);
  const named = target !== undefined ? "--target" : base === undefined ? "the checked-out branch" : "--base";
  if (!branch || !(await holds(project, ["check-ref-format", "--branch", branch]))
    || !(await holds(project, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]))) {
    throw new Error(`Cannot determine the ship's target branch from ${named}; pass --target <local-branch>`);
  }
  return branch;
}

/** A ship's branch head when its attempt ends, and whether its worktree has uncommitted or untracked changes. */
export async function branchHead(intake: TaskIntake): Promise<{ commit: string; clean: boolean }> {
  const branch = await git(intake.worktree, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== intake.branch) throw new Error("Worktree branch differs from the recorded task branch");
  const commit = await git(intake.worktree, ["rev-parse", "--verify", "HEAD^{commit}"]);
  return { commit, clean: (await git(intake.worktree, ["status", "--porcelain"])) === "" };
}

/** Whether `path` exists; any error other than its absence is thrown. */
export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/**
 * The commit a new isolated copy starts from: the target branch's current
 * head when it contains the recorded base, so a ship queued before a landing
 * starts from current code; otherwise the recorded base.
 */
async function startOf(intake: TaskIntake, target: string | undefined): Promise<string> {
  if (!target) return intake.base;
  const head = await git(intake.project, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${target}^{commit}`]).catch(() => "");
  return head && await holds(intake.project, ["merge-base", "--is-ancestor", intake.base, head]) ? head : intake.base;
}

/**
 * Creates the task's isolated copy when it is absent and proves its
 * isolation. `start` is the commit a copy created now started from; see
 * `startOf`.
 */
export async function prepareWorktree(intake: TaskIntake, target?: string): Promise<{ root: string; start?: string }> {
  if (contains(intake.project, resolve(intake.worktree))) throw new Error("Worktree must be outside the source checkout");
  let start: string | undefined;
  if (!(await exists(intake.worktree))) {
    await mkdir(resolve(intake.worktree, ".."), { recursive: true, mode: 0o700 });
    start = await startOf(intake, target);
    // Never reset or remove a branch left by an interrupted Git operation.
    await git(intake.project, ["worktree", "add", "-b", intake.branch, intake.worktree, start]);
  }
  const root = await provenCopy(intake);
  await git(root, ["merge-base", "--is-ancestor", intake.base, "HEAD"]);
  return { root, ...(start ? { start } : {}) };
}

/** The task's existing isolated copy, only once it is proven to be the task branch's worktree of the project and outside it. */
export async function provenCopy(intake: TaskIntake): Promise<string> {
  const root = await realpath(await git(intake.worktree, ["rev-parse", "--show-toplevel"]));
  const expected = await realpath(intake.worktree);
  if (root !== expected || contains(await realpath(intake.project), root)) throw new Error("Worktree isolation could not be proven");
  const branch = await git(root, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== intake.branch) throw new Error("Worktree branch differs from the recorded task branch");
  const common = await realpath(resolve(root, await git(root, ["rev-parse", "--git-common-dir"])));
  const sourceCommon = await realpath(resolve(intake.project, await git(intake.project, ["rev-parse", "--git-common-dir"])));
  if (common !== sourceCommon) throw new Error("Worktree belongs to a different repository");
  return root;
}

export class Worktrees extends Context.Service<Worktrees, {
  prepare(intake: TaskIntake, target?: string): Effect.Effect<{ root: string; start?: string }, FirstmateError>;
  head(intake: TaskIntake): Effect.Effect<{ commit: string; clean: boolean }, FirstmateError>;
}>()("firstmate/Worktrees") {
  static readonly layer = Layer.succeed(Worktrees, {
    prepare: (intake, target) => Effect.tryPromise({ try: () => prepareWorktree(intake, target), catch: appError }),
    head: intake => Effect.tryPromise({ try: () => branchHead(intake), catch: appError }),
  });
}
