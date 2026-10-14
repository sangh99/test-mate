import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { appError, InvalidTransition, type Cleaned, type LandingProof, type Task } from "./domain.js";
import { TaskStore } from "./store.js";
import { exists, git, holds, provenCopy } from "./worktrees.js";

/** The task branch's commit in the project clone, or null when the branch is gone. */
export async function branchCommit(project: string, branch: string): Promise<string | null> {
  return git(project, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`]).catch(() => null);
}

/** What cleanup found: the isolated copy, if present and proven the task's, and the branch head. */
interface Found {
  readonly copy: string | null;
  readonly dirty: string;
  readonly head: string | null;
}

/** Why cleanup may remove the task's copy and branch; anything it does not name is refused. */
type Basis = { readonly basis: Cleaned["basis"]; readonly authorization: number | null; readonly discards: boolean };

const refuse = (message: string) => Effect.fail(new InvalidTransition({ message: `Cleanup refused: ${message}` }));
const short = (commit: string) => commit.slice(0, 12);

/**
 * Reads the task's isolated copy and branch. A copy that exists but cannot be
 * proven to be this task's worktree of the project is refused rather than
 * removed, and so is a copy whose checkout is no longer the branch's head.
 */
const inspect = (task: Task) => Effect.tryPromise({
  try: async (): Promise<Found> => {
    const { intake } = task;
    const head = await branchCommit(intake.project, intake.branch);
    if (!(await exists(intake.worktree))) return { copy: null, dirty: "", head };
    const copy = await provenCopy(intake);
    const checkout = await git(copy, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (checkout !== head) throw new Error(`the copy's HEAD ${checkout} is not the branch head ${head}`);
    return { copy, dirty: await git(copy, ["status", "--porcelain", "--untracked-files=all"]), head };
  },
  catch: error => new InvalidTransition({ message: `Cleanup refused: ${intake(task)} could not be proven: ${appError(error).message}` }),
});
const intake = (task: Task) => `the isolated copy ${task.intake.worktree} on ${task.intake.branch}`;

/** Lists at most ten dirty paths for a refusal. */
const listed = (dirty: string) => {
  const lines = dirty.split("\n").filter(Boolean);
  return `${lines.slice(0, 10).join(", ")}${lines.length > 10 ? `, and ${lines.length - 10} more` : ""}`;
};

/** A ship's branch holds only landed work when its head is the landed commit or an ancestor of it. */
const landedHead = (project: string, head: string, proof: LandingProof) =>
  head === proof.commit ? Effect.succeed(true) : Effect.tryPromise({ try: () => holds(project, ["merge-base", "--is-ancestor", head, proof.commit]), catch: appError });

/**
 * Decides on what basis the task's copy and branch may go, or refuses. A
 * landed ship's copy must be clean and its branch hold nothing beyond the
 * landed commit; a completed scout's copy is scratch once its report exists
 * and its captain calls are attested as held items that still hold.
 * Anything else needs the captain's discard authorization, recorded since the
 * task's last attempt and naming the branch head as it is now. An open hold
 * refuses even then: cleanup never retires the captain's question; nor does
 * it retire a promised final public reply that is not reconciled.
 */
const basisOf = (task: Task, found: Found) => Effect.gen(function*() {
  const store = yield* TaskStore;
  const open = (yield* store.holds(task.id)).filter(hold => hold.status === "open");
  if (open.length) return yield* refuse(`${open.length} open hold(s) await the captain's answer (${open.map(h => h.id).join(", ")}); answer them with firstmate answer-hold first`);
  const promised = (yield* store.ledger.commitments(task.id)).filter(c => c.status === "open");
  if (promised.length) {
    return yield* refuse(`${promised.length} promised final public reply(ies) are not reconciled (${promised.map(c => `${c.id} for mention ${c.requestId}`).join(", ")}); send the final reply with firstmate relay reply <request-id> --final, consent, and send it, or release the promise with firstmate relay release <id> --reason <text>`);
  }
  const { project } = task.intake;
  if (task.intake.kind === "scout" && task.run.state === "completed") {
    const reports = yield* Effect.tryPromise({ try: () => readdir(join(store.home, "reports", task.id)).catch(() => [] as string[]), catch: appError });
    if (reports.some(name => name.endsWith(".md"))) {
      if (!(yield* store.attestation(task.id))) {
        return yield* refuse(`the scout's captain calls are not recorded; hold each with firstmate backlog hold --origin ${task.id}, then run firstmate backlog complete ${task.id} --items <ids> (or --none)`);
      }
      const problems = yield* store.verifyAttestation(task.id);
      if (problems.length) return yield* refuse(`the scout's attested captain calls are no longer durable: ${problems.join("; ")}`);
      return { basis: "report", authorization: null, discards: true } satisfies Basis;
    }
  }
  if (task.intake.kind === "ship" && task.run.state === "landed") {
    const proof = yield* store.landing(task.id);
    if (!proof) return yield* refuse("the task is landed but has no landing proof recorded");
    if (found.dirty) return yield* refuse(`${intake(task)} has uncommitted or untracked changes that never landed: ${listed(found.dirty)}`);
    if (found.head && !(yield* landedHead(project, found.head, proof))) {
      return yield* refuse(`${task.intake.branch} is at ${short(found.head)}, which is not part of the landed commit ${short(proof.commit)}; it holds unlanded work`);
    }
    return { basis: "landed", authorization: null, discards: false } satisfies Basis;
  }
  const authorization = yield* store.discardAuthorization(task.id);
  const unlanded = task.intake.kind === "scout" ? "the scout has no saved report" : `the task is ${task.run.state}, so its work has not landed`;
  if (!authorization) return yield* refuse(`${unlanded}; record the captain's discard authorization with firstmate discard ${task.id} --reason <text> to discard it`);
  if (authorization.head !== found.head) {
    return yield* refuse(`the discard authorization (event ${authorization.sequence}) names branch head ${authorization.head ?? "none"}, but ${task.intake.branch} is now at ${found.head ?? "none"}; authorize again`);
  }
  return { basis: "discard", authorization: authorization.sequence, discards: true } satisfies Basis;
});

/**
 * Removes a task's isolated copy and branch under the task's lease, only on a
 * basis `basisOf` accepts, and moves it to cleaned. Without discard, the
 * copy is removed without force, so Git itself also refuses a dirty one, and
 * the branch is deleted only while it is still at the inspected head. A copy
 * or branch already gone, as after an interrupted cleanup, is not an error.
 * Every refusal is recorded as a `cleanup.refused` event.
 */
export const cleanTask = Effect.fn("firstmate.cleanTask")(function*(id: string) {
  const store = yield* TaskStore;
  const task: Task = yield* store.get(id);
  const clean = Effect.scoped(Effect.gen(function*() {
    const cleanup = yield* store.cleanup(id);
    const current = yield* store.get(id);
    const found = yield* inspect(current);
    const { basis, authorization, discards } = yield* basisOf(current, found);
    const { project, worktree, branch } = current.intake;
    yield* Effect.tryPromise({
      try: async () => {
        if (found.copy) await git(project, ["worktree", "remove", ...(discards ? ["--force"] : []), "--", found.copy]);
        if (found.head) await git(project, ["update-ref", "-d", `refs/heads/${branch}`, found.head]);
      },
      catch: error => new InvalidTransition({ message: `Cleanup refused by Git: ${appError(error).message}` }),
    });
    const cleaned: Cleaned = { basis, authorization, worktree, branch, head: found.head, removedWorktree: found.copy !== null, removedBranch: found.head !== null };
    return { task: yield* cleanup.finish(cleaned), cleaned };
  }));
  return yield* clean.pipe(Effect.tapError(error => store.refuseCleanup(task.id, error.message).pipe(Effect.ignore)));
});

/** Records the captain's discard authorization, bound to the task branch's head as it is now. */
export const authorizeDiscard = Effect.fn("firstmate.authorizeDiscard")(function*(id: string, reason: string) {
  const store = yield* TaskStore;
  const task: Task = yield* store.get(id);
  const head = yield* Effect.tryPromise({ try: () => branchCommit(task.intake.project, task.intake.branch), catch: appError });
  return yield* store.authorizeDiscard(id, reason, head);
});
