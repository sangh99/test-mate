import { Effect } from "effect";
import {
  appError, decodeProject, InvalidInput, projectNamePattern, projectProblems,
  type DeliveryMode, type IntakeResolution, type Project, type ProjectPosture, type Surface, type TaskPolicy,
} from "./domain.js";
import { TaskStore } from "./store.js";
import { contains, git, holds, inspectProject, projectRoot, resolveTarget } from "./worktrees.js";

/** The branch prefix of an unregistered task, and of a project that registers none. */
export const defaultBranchPrefix = "firstmate/";

/** The settings a registration chooses; each one left out is defaulted at add and kept at update. */
export interface ProjectSettings {
  defaultBranch?: string;
  delivery?: ProjectPosture;
  yolo?: boolean;
  branchPrefix?: string;
  /** Null is uncapped. */
  capacity?: number | null;
  /** Null for a local-only project; GitHub is the only forge so far. */
  forge?: "github" | null;
}

const hasOrigin = async (clone: string) => (await git(clone, ["remote"])).split("\n").includes("origin");

/** The clone facts a setting must agree with, read with argument-array Git. */
async function checkClone(project: Project, changed: ReadonlySet<keyof ProjectSettings>) {
  const { clone } = project;
  if (changed.has("defaultBranch") && !(await holds(clone, ["show-ref", "--verify", "--quiet", `refs/heads/${project.defaultBranch}`]))) {
    throw new InvalidInput({ message: `${clone} has no local branch ${project.defaultBranch}; pass --default-branch <local-branch>` });
  }
  if (changed.has("branchPrefix") && !(await holds(clone, ["check-ref-format", "--branch", `${project.branchPrefix}probe`]))) {
    throw new InvalidInput({ message: `--branch-prefix ${JSON.stringify(project.branchPrefix)} does not make a valid Git branch name` });
  }
  if (changed.has("delivery") && project.delivery !== "local-only" && !(await hasOrigin(clone))) {
    throw new InvalidInput({ message: `A ${project.delivery} project publishes through its origin remote, and ${clone} has none; add origin or register it --delivery local-only` });
  }
}

const refuse = (problems: readonly string[]) => new InvalidInput({ message: `Invalid project: ${problems.join("; ")}` });

/**
 * Registers a clone under a name. Defaults, each reported in `defaulted`:
 * the checked-out branch as the default branch; `no-mistakes-prod-only` when
 * the clone has an origin remote, else `local-only`; yolo off; the
 * `firstmate/` branch prefix; uncapped; and the GitHub forge unless local-only.
 */
export const addProject = Effect.fn("firstmate.addProject")(function*(name: string, clonePath: string, settings: ProjectSettings) {
  const store = yield* TaskStore;
  if (!projectNamePattern.test(name)) return yield* Effect.fail(refuse(["the name must be 1-64 letters, digits, dots, underscores, dashes, or inner spaces"]));
  const facts = yield* Effect.tryPromise({
    try: async () => {
      const clone = await projectRoot(clonePath);
      const branch = await git(clone, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
      return { clone, branch, origin: await hasOrigin(clone) };
    },
    catch: appError,
  });
  if (contains(facts.clone, store.home)) return yield* Effect.fail(new InvalidInput({ message: "Firstmate home must be outside the project clone" }));
  const defaultBranch = settings.defaultBranch ?? facts.branch;
  if (!defaultBranch) return yield* Effect.fail(new InvalidInput({ message: `${facts.clone} has a detached HEAD; pass --default-branch <local-branch>` }));
  const delivery = settings.delivery ?? (facts.origin ? "no-mistakes-prod-only" : "local-only");
  const timestamp = new Date().toISOString();
  const project: Project = {
    name, clone: facts.clone, defaultBranch, delivery, yolo: settings.yolo ?? false, branchPrefix: settings.branchPrefix ?? defaultBranchPrefix,
    capacity: settings.capacity === undefined ? null : settings.capacity,
    forge: settings.forge !== undefined ? settings.forge : delivery === "local-only" ? null : "github", createdAt: timestamp, updatedAt: timestamp,
  };
  const problems = projectProblems(project);
  if (problems.length) return yield* Effect.fail(refuse(problems));
  yield* Effect.tryPromise({ try: () => checkClone(project, new Set(["defaultBranch", "branchPrefix", "delivery"])), catch: appError });
  const added = yield* store.addProject(project);
  const keys = ["defaultBranch", "delivery", "yolo", "branchPrefix", "capacity", "forge"] as const;
  return { project: added, defaulted: keys.filter(key => settings[key] === undefined) };
});

/**
 * Changes a project's settings for tasks created afterwards; existing tasks
 * keep what they resolved at intake. A record that is malformed can be
 * repaired this way, since only the result must be valid. Moving to or from
 * local-only moves the forge with it unless `forge` is given.
 */
export const updateProject = Effect.fn("firstmate.updateProject")(function*(name: string, settings: ProjectSettings) {
  const store = yield* TaskStore;
  const changed = new Set((Object.keys(settings) as (keyof ProjectSettings)[]).filter(key => settings[key] !== undefined));
  if (!changed.size) return yield* Effect.fail(new InvalidInput({ message: "Nothing to update; pass at least one setting (see --help)" }));
  const merge = (stored: Record<string, unknown>): Project => {
    const delivery = settings.delivery ?? stored.delivery;
    const forge = settings.forge !== undefined ? settings.forge
      : settings.delivery === undefined ? stored.forge : settings.delivery === "local-only" ? null : stored.forge ?? "github";
    const defined = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
    return decodeProject(name, { ...stored, ...defined, delivery, forge });
  };
  // Checked against the clone before writing; the write refuses if the record changed meanwhile.
  const before = yield* store.storedProject(name);
  const next = yield* Effect.try({ try: () => merge(before), catch: appError });
  yield* Effect.tryPromise({ try: () => checkClone(next, changed), catch: appError });
  return yield* store.updateProject(name, current => {
    if (JSON.stringify(current) !== JSON.stringify(before)) throw new InvalidInput({ message: `Project "${name}" changed during the update; run it again` });
    return merge(current);
  });
});

/** What a ship asked for at intake; anything left out is resolved from the registry. */
export interface PostureChoice {
  delivery?: DeliveryMode;
  yolo?: boolean;
  surface?: Surface;
}

/**
 * Resolves a ship's delivery mode and yolo: an explicit value wins; otherwise
 * the registered posture applies, and a `no-mistakes-prod-only` project needs
 * the ship's declared surface (internal-only ships direct-PR, anything else
 * no-mistakes); an unregistered project defaults to no-mistakes with yolo off.
 */
export function resolvePosture(project: Project | null, choice: PostureChoice) {
  const conditional = project?.delivery === "no-mistakes-prod-only";
  if (choice.surface !== undefined && (!conditional || choice.delivery !== undefined)) {
    return new InvalidInput({ message: "--surface chooses the delivery mode only for a ship on a no-mistakes-prod-only project without an explicit --delivery; remove it" });
  }
  let delivery: { mode: DeliveryMode; from: "explicit" | "registry" | "surface" | "unregistered-default" };
  if (choice.delivery !== undefined) delivery = { mode: choice.delivery, from: "explicit" };
  else if (!project) delivery = { mode: "no-mistakes", from: "unregistered-default" };
  else if (project.delivery !== "no-mistakes-prod-only") delivery = { mode: project.delivery, from: "registry" };
  else if (choice.surface === undefined) {
    return new InvalidInput({
      message: `Project "${project.name}" is no-mistakes-prod-only, so a ship declares its surface: --surface internal-only ships direct-PR, and product-facing, mixed, or uncertain ships no-mistakes. `
        + "The surface is never inferred from file paths or names; alternatively pass --delivery explicitly",
    });
  } else delivery = { mode: choice.surface === "internal-only" ? "direct-PR" : "no-mistakes", from: "surface" };
  const yolo = choice.yolo !== undefined ? { on: choice.yolo, from: "explicit" as const }
    : project ? { on: project.yolo, from: "registry" as const } : { on: false, from: "unregistered-default" as const };
  return { delivery, yolo, surface: delivery.from === "surface" ? choice.surface! : null };
}

/** A task as intake names it: a registered project's name, or a clone path. */
export interface IntakeRequest extends PostureChoice {
  project: string;
  kind: "ship" | "scout";
  /** A local ref; for a registered project, a branch here overrides its default branch as base and target. */
  base?: string;
  target?: string;
}

/**
 * Resolves a task's project, base commit, branch prefix, and, for a ship, its
 * delivery policy. `project` names a registered project, or else is a clone
 * path, which uses that clone's registration if it has one. A registered
 * project's default branch is the base and target unless the task names its
 * own; a path-only task is accepted as unregistered, and the gap is reported.
 */
export const resolveIntake = Effect.fn("firstmate.resolveIntake")(function*(request: IntakeRequest) {
  const store = yield* TaskStore;
  const named = projectNamePattern.test(request.project) ? yield* store.project(request.project) : null;
  const registered = named ?? (yield* store.projectByClone(yield* Effect.tryPromise({
    try: () => projectRoot(request.project),
    catch: error => new InvalidInput({ message: `${request.project} is neither a registered project nor a Git repository root: ${appError(error).message}` }),
  })));
  const clone = registered?.clone ?? request.project;
  const base = request.base ?? registered?.defaultBranch;
  const inspected = yield* Effect.tryPromise({ try: () => inspectProject(clone, base ?? "HEAD"), catch: appError });
  if (registered && inspected.project !== registered.clone) {
    return yield* Effect.fail(new InvalidInput({ message: `Project "${registered.name}" is registered at ${registered.clone}, which now resolves to ${inspected.project}; update or re-register it` }));
  }
  const unregistered = `${inspected.project} is not a registered project; register it with firstmate project add <name> --clone ${JSON.stringify(inspected.project)}`;
  const resolved = { project: registered?.name ?? null, matchedBy: named ? "name" as const : registered ? "clone" as const : null, posture: registered?.delivery ?? null };
  let policy: TaskPolicy = {};
  let resolution: IntakeResolution = { ...resolved, surface: null, gap: registered ? null : unregistered };
  if (request.kind === "ship") {
    const posture = resolvePosture(registered, request);
    if (posture instanceof InvalidInput) return yield* Effect.fail(posture);
    const target = yield* Effect.tryPromise({ try: () => resolveTarget(inspected.project, base, request.target), catch: appError });
    policy = { delivery: posture.delivery.mode, yolo: posture.yolo.on, target, ...(posture.surface ? { surface: posture.surface } : {}) };
    const gap = registered ? null : `${unregistered}. Unregistered, the ship ${posture.delivery.from === "explicit" ? "uses its explicit" : "defaulted to"} ${posture.delivery.mode} delivery `
      + `and ${posture.yolo.from === "explicit" ? "explicit" : "defaulted"} yolo ${posture.yolo.on ? "on" : "off"}`;
    resolution = { ...resolved, delivery: posture.delivery, yolo: posture.yolo, surface: posture.surface, gap };
  }
  return {
    project: inspected.project, base: inspected.base, ...(registered ? { projectName: registered.name } : {}),
    branchPrefix: registered?.branchPrefix ?? defaultBranchPrefix, policy, resolution,
  };
});
