import { Effect } from "effect";
import { appError, AppError, InvalidTransition, MergeRefused, type CloneRefresh, type LandingProof, type LocalLanding, type PullRequestMerged, type Task } from "./domain.js";
import { authorize } from "./authority.js";
import { Forge } from "./forge.js";
import { TaskStore } from "./store.js";
import { git, holds } from "./worktrees.js";

/** What a landing found in the project clone and did to its target branch. */
type FastForward = Pick<LocalLanding, "before" | "after" | "fastForward">;

/**
 * Fast-forwards `target`, checked out and clean in the project clone, to
 * `commit`, which the task branch must still point at. Refuses a moved task
 * branch, another checked-out branch, a dirty clone, and a diverged target;
 * it never resets, merges, rebases, or stashes. Proof is that `commit` is an
 * ancestor of the target afterwards, whether or not a fast-forward was needed.
 */
export async function fastForward(project: string, branch: string, target: string, commit: string): Promise<FastForward> {
  const head = await git(project, ["rev-parse", "--verify", "--end-of-options", `refs/heads/${branch}^{commit}`]);
  if (head !== commit) throw new Error(`Task branch ${branch} moved from its ready commit ${commit} to ${head}; resume the task to record a new ready commit`);
  const checkedOut = await git(project, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "a detached HEAD");
  if (checkedOut !== target) throw new Error(`The project clone is on ${checkedOut}, not the target branch ${target}; refusing to land`);
  if (await git(project, ["status", "--porcelain"])) throw new Error(`The project clone ${project} has uncommitted or untracked changes; refusing to land`);
  const ref = `refs/heads/${target}`;
  const before = await git(project, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const contained = await holds(project, ["merge-base", "--is-ancestor", commit, before]);
  if (!contained) {
    if (!(await holds(project, ["merge-base", "--is-ancestor", before, commit]))) {
      throw new Error(`Refused: ${target} (${before}) has diverged from the ready commit ${commit}, so landing is not a fast-forward; resume the task to rebase it onto ${target}`);
    }
    await git(project, ["merge", "--ff-only", "--no-edit", commit]);
  }
  const after = await git(project, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!(await holds(project, ["merge-base", "--is-ancestor", commit, after]))) throw new Error(`Landing unproven: ${commit} is not on ${target} (${after})`);
  return { before, after, fastForward: !contained };
}

/** The remote a direct-PR ship's branch is pushed to; the project registry does not yet name another. */
const remote = "origin";

/**
 * Brings the project clone's local `target` up to the remote's after a forge
 * landing, so tasks created or started afterwards begin from current code.
 * Only a fast-forward: refused when the clone has uncommitted or untracked
 * changes or the local target has commits the remote's lacks; it never
 * resets, merges, rebases, or stashes. A target checked out in the clone is
 * fast-forwarded with `merge --ff-only`; otherwise its ref is moved only if
 * it is still where it was read. Proof is that `landed` is on the local
 * target afterwards.
 */
export async function refreshClone(project: string, target: string, landed: string): Promise<CloneRefresh> {
  const ref = `refs/heads/${target}`;
  const tracking = `refs/remotes/${remote}/${target}`;
  if (await git(project, ["status", "--porcelain"])) throw new Error(`The project clone ${project} has uncommitted or untracked changes; refusing to refresh ${target}`);
  await git(project, ["fetch", "--quiet", "--no-tags", "--end-of-options", remote, `+${ref}:${tracking}`]);
  const before = await git(project, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const latest = await git(project, ["rev-parse", "--verify", "--end-of-options", `${tracking}^{commit}`]);
  const current = await holds(project, ["merge-base", "--is-ancestor", latest, before]);
  if (!current) {
    if (!(await holds(project, ["merge-base", "--is-ancestor", before, latest]))) {
      throw new Error(`Refused: local ${target} (${before}) has commits ${remote}/${target} (${latest}) lacks, so refreshing it is not a fast-forward`);
    }
    const checkedOut = await git(project, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
    if (checkedOut === target) await git(project, ["merge", "--ff-only", "--no-edit", latest]);
    else await git(project, ["update-ref", "-m", `firstmate: refresh ${target} from ${remote}`, ref, latest, before]);
  }
  const after = await git(project, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  if (!(await holds(project, ["merge-base", "--is-ancestor", landed, after]))) throw new Error(`Refresh unproven: ${landed} is not on local ${target} (${after})`);
  return { project, target, before, after, fastForward: !current };
}

/**
 * Refreshes a forge-landed ship's project clone and records the outcome.
 * The landing is already proven, so a refusal is recorded, not raised;
 * `refresh` retries it.
 */
const refreshLanded = (task: Task, target: string, landed: string) => Effect.gen(function*() {
  const store = yield* TaskStore;
  const { project } = task.intake;
  return yield* Effect.tryPromise({ try: () => refreshClone(project, target, landed), catch: appError }).pipe(
    Effect.flatMap(refresh => store.recordRefresh(task.id, "clone.refreshed", refresh).pipe(Effect.as(refresh.fastForward
      ? `local ${target} fast-forwarded to ${refresh.after.slice(0, 12)}` : `local ${target} already current at ${refresh.after.slice(0, 12)}`))),
    Effect.catch(error => store.recordRefresh(task.id, "clone.refused", { project, target, reason: error.message })
      .pipe(Effect.as(`clone refresh refused: ${error.message}; firstmate refresh ${task.id} retries`))));
});

/** Retries the clone refresh of a ship its forge landing proved on its target. */
export const refreshTask = Effect.fn("firstmate.refreshTask")(function*(id: string) {
  const store = yield* TaskStore;
  const task: Task = yield* store.get(id);
  const proof = yield* store.landing(id);
  if (task.run.state !== "landed" || !proof || !("via" in proof)) {
    return yield* Effect.fail(new InvalidTransition({ message: `Task is ${task.run.state}; only a ship landed on the forge refreshes the project clone (a local landing already moved it)` }));
  }
  return { task, outcome: yield* refreshLanded(task, proof.target, proof.mergeCommit) };
});

/** How long a published PR's head is re-read before the forge's report is taken as final. */
const headAttempts = 10;
const headDelayMs = 1_000;

/** A ship with the delivery policy recorded at intake, or a refusal naming what is missing. */
const deliverable = (task: Task) => {
  const { delivery, yolo, target } = task.policy;
  if (task.intake.kind !== "ship" || !delivery || yolo === undefined || !target) {
    return new InvalidTransition({ message: "Only a ship with a delivery mode, merge posture, and target recorded at intake can be delivered" });
  }
  return { delivery, yolo, target };
};

/** A PR title from the task prompt's first line. */
const titleOf = (prompt: string) => {
  const line = prompt.trim().split("\n")[0]!.trim();
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
};
const bodyOf = (task: Task) => {
  const output = task.run.output.length > 8_000 ? `${task.run.output.slice(0, 8_000)}\n\n(truncated)` : task.run.output;
  return `${task.intake.prompt}\n\n---\n\nFirstmate task \`${task.id}\`, commit ${task.run.commit}.\n\n${output}`;
};

/**
 * Publishes a ready direct-PR ship: pushes its exact ready commit to the
 * task branch on the remote and opens a PR into its target, or, when an
 * earlier attempt's PR is still open, updates that PR. The push is leased on
 * the head the PR was last recorded at, so it never overwrites a commit pushed
 * by anyone else. The PR, its URL, and its head are recorded only as the forge
 * reports them; a head that differs from the pushed commit is refused. A
 * failure leaves the task ready, records `pr.failed`, and can be retried.
 */
export const publishTask = Effect.fn("firstmate.publishTask")(function*(id: string) {
  const store = yield* TaskStore;
  const forge = yield* Forge;
  const task: Task = yield* store.get(id);
  const policy = deliverable(task);
  if (policy instanceof InvalidTransition) return yield* Effect.fail(policy);
  if (policy.delivery !== "direct-PR") return yield* Effect.fail(new InvalidTransition({ message: `Task delivers ${policy.delivery}; only direct-PR ships are published as a PR here` }));
  const commit = task.run.commit;
  if (task.run.state !== "ready" || !commit) return yield* Effect.fail(new InvalidTransition({ message: `Task is ${task.run.state}; only a ready ship can be published` }));
  return yield* Effect.scoped(Effect.gen(function*() {
    const delivery = yield* store.delivery(id, "ready", commit);
    const publish = Effect.gen(function*() {
      const { project, branch } = task.intake;
      const repository = yield* forge.locate(project, remote);
      const previous = task.run.pr;
      const open = previous ? yield* forge.readPr(repository, previous.number) : undefined;
      // The remote branch must still be where this task last pushed it (absent before the first push), so a commit pushed by anyone else is never overwritten.
      const lease = previous?.head ?? "";
      yield* Effect.tryPromise({
        try: () => git(project, ["push", "--porcelain", `--force-with-lease=refs/heads/${branch}:${lease}`, "--end-of-options", remote, `${commit}:refs/heads/${branch}`]),
        catch: error => String((error as { stdout?: unknown }).stdout ?? "").includes("stale info")
          ? new AppError({ message: `Refused to push: ${remote} ${branch} is no longer ${lease ? `at ${lease}, where this task last pushed it` : "absent"}; someone else pushed to it` })
          : appError(error),
      });
      let pr = open?.state === "open" ? open : yield* forge.openPr(repository, { branch, target: policy.target, title: titleOf(task.intake.prompt), body: bodyOf(task) });
      // The forge updates a PR's head shortly after a push, so its report is re-read for a bounded time.
      for (let attempt = 1; pr.head !== commit && attempt <= headAttempts; attempt++) {
        yield* Effect.sleep(headDelayMs);
        pr = yield* forge.readPr(repository, pr.number);
      }
      if (pr.head !== commit) return yield* Effect.fail(new AppError({ message: `The forge reports ${pr.url} at ${pr.head}, not the pushed ready commit ${commit}` }));
      if (pr.target !== policy.target) return yield* Effect.fail(new AppError({ message: `The forge reports ${pr.url} into ${pr.target}, not the task's target ${policy.target}` }));
      const ref = { url: pr.url, number: pr.number, head: pr.head, target: pr.target };
      return { task: yield* delivery.publish(ref, open?.state === "open" ? "pr.updated" : "pr.opened"), pr: ref };
    });
    return yield* publish.pipe(Effect.tapError(error => delivery.record("pr.failed", { error: error.message }).pipe(Effect.ignore)));
  }));
});

/** A PR's current head, the checks its merge must pass, and what merge authority says about them now. */
export const evaluateMerge = Effect.fn("firstmate.evaluateMerge")(function*(id: string) {
  const store = yield* TaskStore;
  const forge = yield* Forge;
  const task: Task = yield* store.get(id);
  const policy = deliverable(task);
  if (policy instanceof InvalidTransition) return yield* Effect.fail(policy);
  const recorded = task.run.pr;
  if (task.run.state !== "pr-open" || !recorded) return yield* Effect.fail(new InvalidTransition({ message: `Task is ${task.run.state}; only a ship with an open PR has checks` }));
  const repository = yield* forge.locate(task.intake.project, remote);
  const pr = yield* forge.readPr(repository, recorded.number);
  const checks = pr.state === "open" ? yield* forge.requiredChecks(repository, policy.target, pr.head) : [];
  const verdict = authorize({ yolo: policy.yolo, head: pr.head, ...yield* store.mergeRecords(id), checks });
  return { pr, checks, verdict };
});

/**
 * Lands a ship under the task's lease, so no attempt can move its branch. A
 * local-only ship's target is fast-forwarded in the project clone; the PR of a
 * direct-PR ship, or of a no-mistakes ship the pipeline validated, is merged
 * on the forge bound to its recorded head. Either
 * way merge authority is evaluated first, and the task becomes `landed` only
 * with proof that its commit is on the target.
 */
export const landTask = Effect.fn("firstmate.landTask")(function*(id: string) {
  const store = yield* TaskStore;
  const task: Task = yield* store.get(id);
  const policy = deliverable(task);
  if (policy instanceof InvalidTransition) return yield* Effect.fail(policy);
  if (policy.delivery !== "local-only") return yield* landPr(task, policy.yolo, policy.target);
  const commit = task.run.commit;
  if (task.run.state !== "local-ready" || !commit) return yield* Effect.fail(new InvalidTransition({ message: `Task is ${task.run.state}; only a local-ready ship can land` }));
  const { yolo, target } = policy;
  return yield* Effect.scoped(Effect.gen(function*() {
    const landing = yield* store.delivery(id, "local-ready", commit);
    // Evaluated under the lease, so the approvals and flags it weighs are the latest before the merge.
    const verdict = authorize({ yolo, head: commit, ...yield* store.mergeRecords(id), checks: [] });
    if (!verdict.authorized) return yield* Effect.fail(new MergeRefused({ message: `Merge not authorized: ${verdict.reasons.join("; ")}`, waiting: false }));
    const moved = yield* Effect.tryPromise({ try: () => fastForward(task.intake.project, task.intake.branch, target, commit), catch: appError });
    const { basis, approval, waived } = verdict;
    const proof: LandingProof = { commit, target, ...moved, basis, approval, waived: [...waived] };
    return { task: yield* landing.finish(proof), proof, outcome: `Landed ${commit} on local ${target} (${basis})` };
  }));
});

/** How long a merged PR's landing proof is re-read before the landing is left for a later `land`. */
const proofAttempts = 5;
const proofDelayMs = 2_000;

/**
 * Merges a pr-open ship's PR and proves its landing. The PR head must still
 * be the ready commit, every check its merge requires is read for that head
 * only, and the merge is bound to that head. A PR the forge already reports
 * merged is not merged again: its landing is proven under the authority its
 * recorded merge used, or as `external` when it was merged elsewhere.
 */
const landPr = (task: Task, yolo: boolean, target: string) => Effect.gen(function*() {
  const store = yield* TaskStore;
  const forge = yield* Forge;
  const commit = task.run.commit;
  const recorded = task.run.pr;
  if (task.run.state !== "pr-open" || !commit || !recorded) return yield* Effect.fail(new InvalidTransition({ message: `Task is ${task.run.state}; only a ship with an open PR can merge` }));
  return yield* Effect.scoped(Effect.gen(function*() {
    const delivery = yield* store.delivery(task.id, "pr-open", commit);
    const repository = yield* forge.locate(task.intake.project, remote);
    const pr = yield* forge.readPr(repository, recorded.number);
    let merged: PullRequestMerged | undefined = (yield* store.merges(task.id)).findLast(m => m.number === pr.number);
    if (pr.state === "merged" && !merged && pr.head !== commit) {
      return yield* Effect.fail(new InvalidTransition({ message: `${pr.url} was merged elsewhere at ${pr.head}, not the ready commit ${commit}; its landing is not this task's` }));
    }
    if (pr.state === "closed") return yield* Effect.fail(new InvalidTransition({ message: `${pr.url} was closed without merging; resume the task to publish it again` }));
    if (pr.state === "open") {
      if (pr.head !== commit) {
        return yield* Effect.fail(new MergeRefused({ message: `Refused: ${pr.url} head moved from the ready commit ${commit} to ${pr.head}; resume the task to record a new ready commit`, waiting: false }));
      }
      if (pr.target !== target) return yield* Effect.fail(new MergeRefused({ message: `Refused: ${pr.url} merges into ${pr.target}, not the task's target ${target}`, waiting: false }));
      const checks = yield* forge.requiredChecks(repository, target, pr.head);
      // Evaluated under the lease, so the approvals and flags it weighs are the latest before the merge.
      const verdict = authorize({ yolo, head: pr.head, ...yield* store.mergeRecords(task.id), checks });
      if (!verdict.authorized) {
        // A check still running, or not yet reported because CI has not started, may still turn green.
        const waiting = checks.some(check => check.head === pr.head && (check.conclusion === "pending" || check.conclusion === "unreported"));
        return yield* Effect.fail(new MergeRefused({ message: `Merge of ${pr.url} not authorized: ${verdict.reasons.join("; ")}`, waiting }));
      }
      const mergeCommit = yield* forge.merge(repository, pr.number, pr.head);
      const { basis, approval, waived } = verdict;
      merged = { url: pr.url, number: pr.number, head: pr.head, mergeCommit, basis, approval, waived: [...waived] };
      yield* delivery.record("pr.merged", merged);
    }
    const mergeCommit = merged?.mergeCommit ?? pr.mergeCommit;
    if (!mergeCommit) return yield* Effect.fail(new AppError({ message: `The forge reports ${pr.url} merged without a merge commit; landing unproven` }));
    let targetHead: string | null = null;
    for (let attempt = 1; attempt <= proofAttempts && !targetHead; attempt++) {
      if (attempt > 1) yield* Effect.sleep(proofDelayMs);
      targetHead = yield* forge.landingProof(repository, mergeCommit, target);
    }
    if (!targetHead) return yield* Effect.fail(new AppError({ message: `${pr.url} merged as ${mergeCommit}, but the forge does not yet show it on ${target}; run land again to re-read the proof` }));
    const proof: LandingProof = {
      via: "forge", commit, target, url: pr.url, number: pr.number, mergeCommit, targetHead,
      basis: merged?.basis ?? "external", approval: merged?.approval ?? null, waived: [...merged?.waived ?? []],
    };
    const landed = yield* delivery.finish(proof);
    const refreshed = yield* refreshLanded(landed, target, mergeCommit);
    return { task: landed, proof, outcome: `Merged ${pr.url} (${commit.slice(0, 12)}) into ${target} as ${mergeCommit.slice(0, 12)} (${proof.basis}); ${refreshed}` };
  }));
});
