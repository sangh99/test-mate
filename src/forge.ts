import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Context, Effect, Layer } from "effect";
import { appError, type FirstmateError } from "./domain.js";
import type { RequiredCheck } from "./authority.js";
import { git } from "./worktrees.js";

type Op<A> = Effect.Effect<A, FirstmateError>;

/** A repository on a forge, identified from a project clone's remote. */
export interface ForgeRepository {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

/** A pull request as the forge reports it; nothing here is assembled locally. */
export interface PullRequest {
  readonly url: string;
  readonly number: number;
  /** The PR's current head commit. */
  readonly head: string;
  /** The branch it merges into. */
  readonly target: string;
  readonly state: "open" | "closed" | "merged";
  readonly mergeCommit: string | null;
}

/** What the forge shows of an upstream issue or PR after a baseline: its state and the comments and reviews newer than it. */
export interface Observation {
  readonly state: "open" | "closed" | "merged";
  /** When the forge last changed the state, or null when it reports none. */
  readonly stateAt: string | null;
  readonly comments: readonly { id: number; author: string | null; url: string | null; at: string | null; body: string }[];
  readonly reviews: readonly { id: number; author: string | null; state: string; url: string | null; at: string | null; body: string }[];
}

export interface OpenRequest {
  readonly branch: string;
  readonly target: string;
  readonly title: string;
  readonly body: string;
}

/**
 * The forge adapter: every forge read and write delivery performs. GitHub is
 * the first implementation; tests and other forges provide their own layer.
 */
export interface ForgeShape {
  /** The forge repository behind `remote` in the project clone; refused when this forge does not host it. */
  locate(project: string, remote: string): Op<ForgeRepository>;
  /** Opens a PR from `branch` into `target`, or returns the one already open between them. */
  openPr(repository: ForgeRepository, request: OpenRequest): Op<PullRequest>;
  readPr(repository: ForgeRepository, number: number): Op<PullRequest>;
  /** The PR open from `branch` into `target`, as one the validation pipeline opened, or null when there is none. */
  findPr(repository: ForgeRepository, branch: string, target: string): Op<PullRequest | null>;
  /**
   * The checks a merge of `head` into `target` must pass: every check the
   * target's protection requires, `unreported` when it has no result for
   * `head`, and every other check reported for `head`. Results for other
   * commits are never read.
   */
  requiredChecks(repository: ForgeRepository, target: string, head: string): Op<readonly RequiredCheck[]>;
  /** Merges the PR only while its head is still `head`, returning the merge commit. */
  merge(repository: ForgeRepository, number: number, head: string): Op<string>;
  /** The target's head when it contains `mergeCommit`, or null when the forge does not show it there. */
  landingProof(repository: ForgeRepository, mergeCommit: string, target: string): Op<string | null>;
  /** The issue or PR's state, and its comments and reviews with ids above the baseline's. */
  observe(repository: ForgeRepository, number: number, after: { comment: number; review: number }): Op<Observation>;
  /**
   * Posts a comment carrying the idempotency key, or returns the comment that
   * already carries it, so a retried send never posts twice.
   */
  comment(repository: ForgeRepository, number: number, body: string, key: string): Op<{ id: string; url: string | null }>;
}

export class Forge extends Context.Service<Forge, ForgeShape>()("firstmate/Forge") {
  static readonly github = Layer.succeed(Forge, gitHub());
  static layer(forge?: ForgeShape) { return forge ? Layer.succeed(Forge, forge) : Forge.github; }
}

const execute = promisify(execFile);

/** Runs `gh` with an argument array, non-interactively, failing with its own error output. */
async function gh(args: readonly string[]): Promise<string> {
  try {
    const result = await execute("gh", [...args], {
      windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
    });
    return result.stdout;
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string };
    throw new Error(`gh ${args.slice(0, 4).join(" ")} failed: ${(stderr || message).trim()}`);
  }
}

const repoPath = (repository: ForgeRepository) => `repos/${repository.owner}/${repository.name}`;
const segment = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

/** Reads a REST resource as JSON; `fields` are `-f key=value` request fields. */
async function api(repository: ForgeRepository, method: string, path: string, fields: Record<string, string> = {}): Promise<any> {
  const args = ["api", "--hostname", repository.host, "--method", method, path, ...Object.entries(fields).flatMap(([key, value]) => ["-f", `${key}=${value}`])];
  return JSON.parse(await gh(args));
}

/** Each element a paginated array endpoint yields through `jq`, one JSON value per line. */
async function each(repository: ForgeRepository, path: string, jq: string): Promise<any[]> {
  const out = await gh(["api", "--hostname", repository.host, "--paginate", path, "--jq", jq]);
  return out.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
}

/** The raw open PR from `branch` into `target`, if any. */
async function openBetween(repository: ForgeRepository, branch: string, target: string): Promise<any> {
  const query = new URLSearchParams({ state: "open", head: `${repository.owner}:${branch}`, base: target });
  const [existing] = await api(repository, "GET", `${repoPath(repository)}/pulls?${query}`);
  return existing;
}

const pullRequest = (body: any): PullRequest => {
  const pr = {
    url: body?.html_url, number: body?.number, head: body?.head?.sha, target: body?.base?.ref,
    state: body?.merged ? "merged" as const : body?.state === "open" ? "open" as const : "closed" as const,
    mergeCommit: body?.merged ? body?.merge_commit_sha ?? null : null,
  };
  if (typeof pr.url !== "string" || !/^https:\/\//.test(pr.url) || !Number.isInteger(pr.number) || typeof pr.head !== "string" || typeof pr.target !== "string") {
    throw new Error("The forge returned an unreadable pull request");
  }
  return pr;
};

/** The repository and number of an https issue or pull request URL. */
export function parseIssueUrl(url: string): (ForgeRepository & { number: number }) | undefined {
  const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/(?:issues|pull)\/([1-9][0-9]*)\/?$/.exec(url.trim());
  return match ? { host: match[1]!, owner: match[2]!, name: match[3]!, number: Number(match[4]) } : undefined;
}

/** The marker a firstmate comment carries for its idempotency key. */
const marker = (key: string) => `<!-- firstmate:${key} -->`;

/** `owner/name` and host from an HTTPS, SSH, or scp-style GitHub remote URL. */
export function parseRemote(url: string): ForgeRepository | undefined {
  const match = /^(?:https:\/\/(?:[^@/]+@)?([^/:]+)\/|ssh:\/\/git@([^/:]+)(?::\d+)?\/|git@([^:]+):)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!match) return undefined;
  return { host: (match[1] ?? match[2] ?? match[3])!, owner: match[4]!, name: match[5]! };
}

/** Rank of a check conclusion: a name reported more than once keeps its worst result. */
const rank = { success: 0, pending: 1, failure: 2, unreported: 3 } as const;

function gitHub(): ForgeShape {
  const lift = <A>(f: () => Promise<A>): Op<A> => Effect.tryPromise({ try: f, catch: appError });
  return {
    locate: (project, remote) => lift(async () => {
      const url = await git(project, ["remote", "get-url", "--end-of-options", remote]);
      const repository = parseRemote(url);
      if (!repository) throw new Error(`Remote ${remote} (${url}) is not a GitHub repository URL`);
      // The authenticated host must serve this repository; this read also proves the login.
      await api(repository, "GET", repoPath(repository));
      return repository;
    }),
    openPr: (repository, { branch, target, title, body }) => lift(async () => {
      // A publish interrupted after the forge opened its PR finds that PR rather than failing on a duplicate.
      const existing = await openBetween(repository, branch, target);
      return pullRequest(existing ?? await api(repository, "POST", `${repoPath(repository)}/pulls`, { title, head: branch, base: target, body }));
    }),
    findPr: (repository, branch, target) => lift(async () => {
      const existing = await openBetween(repository, branch, target);
      return existing ? pullRequest(existing) : null;
    }),
    readPr: (repository, number) => lift(async () => pullRequest(await api(repository, "GET", `${repoPath(repository)}/pulls/${number}`))),
    requiredChecks: (repository, target, head) => lift(async () => {
      const path = repoPath(repository);
      const required = new Set<string>();
      const branch = await api(repository, "GET", `${path}/branches/${segment(target)}`);
      if (branch?.protected === true) {
        const classic = branch?.protection?.required_status_checks;
        if (classic && typeof classic === "object") {
          for (const context of classic.contexts ?? []) required.add(String(context));
          for (const check of classic.checks ?? []) required.add(String(check.context));
        }
      }
      for (const rule of await each(repository, `${path}/rules/branches/${segment(target)}`, ".[]")) {
        if (rule?.type !== "required_status_checks") continue;
        for (const check of rule?.parameters?.required_status_checks ?? []) required.add(String(check.context));
      }
      const results = new Map<string, RequiredCheck["conclusion"]>();
      const report = (name: string, conclusion: RequiredCheck["conclusion"]) => {
        const prior = results.get(name);
        if (!prior || rank[conclusion] > rank[prior]) results.set(name, conclusion);
      };
      // Only the latest run of each check counts, so a rerun that passed supersedes the failure before it.
      const runs = await each(repository, `${path}/commits/${head}/check-runs?per_page=100`, ".check_runs[] | {id, name, status, conclusion, head_sha}");
      const latest = new Map<string, any>();
      for (const run of runs) if (run.head_sha === head && (!latest.has(run.name) || run.id > latest.get(run.name).id)) latest.set(run.name, run);
      for (const run of latest.values()) {
        report(run.name, run.status !== "completed" ? "pending" : ["success", "neutral", "skipped"].includes(run.conclusion) ? "success" : "failure");
      }
      // The combined status already keeps only the latest status of each context.
      const combined = await api(repository, "GET", `${path}/commits/${head}/status?per_page=100`);
      if (combined?.sha !== head) throw new Error(`The forge returned statuses for ${combined?.sha}, not ${head}`);
      for (const status of combined.statuses ?? []) {
        report(status.context, status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure");
      }
      for (const name of required) if (!results.has(name)) results.set(name, "unreported");
      return [...results].sort(([a], [b]) => a.localeCompare(b)).map(([name, conclusion]) => ({ name, head, conclusion }));
    }),
    merge: (repository, number, head) => lift(async () => {
      // `sha` makes the forge refuse the merge if the head moved after it was evaluated.
      const result = await api(repository, "PUT", `${repoPath(repository)}/pulls/${number}/merge`, { sha: head, merge_method: "merge" });
      if (result?.merged !== true || typeof result?.sha !== "string") throw new Error(`The forge did not merge the pull request: ${result?.message ?? "no reason given"}`);
      return result.sha as string;
    }),
    landingProof: (repository, mergeCommit, target) => lift(async () => {
      // `behind` or `identical`: the merge commit is the target's head or one of its ancestors.
      const compare = await api(repository, "GET", `${repoPath(repository)}/compare/${segment(target)}...${mergeCommit}`);
      return compare?.status === "identical" || compare?.status === "behind" ? String(compare.base_commit?.sha) : null;
    }),
    observe: (repository, number, after) => lift(async () => {
      const path = repoPath(repository);
      const issue = await api(repository, "GET", `${path}/issues/${number}`);
      if (!Number.isInteger(issue?.number)) throw new Error(`The forge returned no issue or pull request ${number}`);
      const pull = issue.pull_request ? await api(repository, "GET", `${path}/pulls/${number}`) : null;
      const state = pull?.merged ? "merged" as const : issue.state === "closed" ? "closed" as const : "open" as const;
      const stateAt = state === "merged" ? pull.merged_at ?? null : state === "closed" ? issue.closed_at ?? null : null;
      const comments = (await each(repository, `${path}/issues/${number}/comments?per_page=100`, ".[] | {id, user: .user.login, url: .html_url, at: .created_at, body}"))
        .filter(c => Number(c.id) > after.comment).map(c => ({ id: Number(c.id), author: c.user ?? null, url: c.url ?? null, at: c.at ?? null, body: String(c.body ?? "") }));
      const reviews = pull ? (await each(repository, `${path}/pulls/${number}/reviews?per_page=100`, ".[] | {id, user: .user.login, state, url: .html_url, at: .submitted_at, body}"))
        .filter(r => Number(r.id) > after.review).map(r => ({ id: Number(r.id), author: r.user ?? null, state: String(r.state), url: r.url ?? null, at: r.at ?? null, body: String(r.body ?? "") })) : [];
      return { state, stateAt, comments, reviews };
    }),
    comment: (repository, number, body, key) => lift(async () => {
      const path = repoPath(repository);
      const [existing] = await each(repository, `${path}/issues/${number}/comments?per_page=100`, `.[] | select(.body | contains(${JSON.stringify(marker(key))})) | {id, url: .html_url}`);
      const posted = existing ?? await api(repository, "POST", `${path}/issues/${number}/comments`, { body: `${body}\n\n${marker(key)}` });
      return { id: String(posted.id), url: (existing ? posted.url : posted.html_url) ?? null };
    }),
  };
}
