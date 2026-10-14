import type { MergeApproval } from "./domain.js";

/** A recorded approval or flag, with the event sequence that orders it against the other. */
export type Sequenced<A> = A & { readonly sequence: number };

/**
 * A required check's latest result as a forge reports it, for the head it ran
 * on; `unreported` is a required check with no result for that head.
 * Local-only delivery has no forge, so its merges have no required checks.
 */
export interface RequiredCheck {
  readonly name: string;
  readonly head: string;
  readonly conclusion: "success" | "failure" | "pending" | "unreported";
}

/** Everything merge authority weighs, gathered from durable records and the forge. */
export interface MergeRequest {
  readonly yolo: boolean;
  /** The exact commit the merge would put on the target. */
  readonly head: string;
  readonly approvals: readonly Sequenced<MergeApproval>[];
  /** Destructive, irreversible, or security-sensitive flags. */
  readonly flags: readonly Sequenced<{ readonly reason: string }>[];
  readonly checks: readonly RequiredCheck[];
}

export type MergeVerdict =
  | { readonly authorized: true; readonly basis: "captain" | "yolo"; readonly approval: number | null; readonly waived: readonly string[] }
  | { readonly authorized: false; readonly reasons: readonly string[] };

const short = (commit: string) => commit.slice(0, 12);

/**
 * The one merge-authority evaluation: every merge path asks this before it
 * merges and records the basis it returns. Authority is the captain's explicit
 * approval of this exact head, or yolo; a flag requires an approval recorded
 * after it, even under yolo; every required check must be green on this head
 * unless that approval names it as a waiver.
 */
export function authorize(request: MergeRequest): MergeVerdict {
  const reasons: string[] = [];
  const lastFlag = request.flags.at(-1);
  const approval = request.approvals.filter(a => a.commit === request.head && (!lastFlag || a.sequence > lastFlag.sequence)).at(-1);
  if (lastFlag && !approval) {
    reasons.push(`Escalated (${request.flags.map(f => f.reason).join("; ")}): needs the captain's approval of ${short(request.head)} recorded after the flag; yolo cannot authorize it`);
  } else if (!approval && !request.yolo) {
    const stale = request.approvals.some(a => a.commit !== request.head);
    reasons.push(`Needs the captain's approval of ${short(request.head)} (yolo is off)${stale ? "; earlier approvals name a different commit" : ""}`);
  }
  const waived: string[] = [];
  for (const check of request.checks) {
    const state = check.head !== request.head ? "not reported for this head" : check.conclusion === "success" ? undefined : check.conclusion;
    if (!state) continue;
    if (approval?.waivers.includes(check.name)) waived.push(check.name);
    else reasons.push(`Required check ${check.name} is ${state}; only the captain's approval naming it can waive it`);
  }
  if (reasons.length) return { authorized: false, reasons };
  return approval ? { authorized: true, basis: "captain", approval: approval.sequence, waived } : { authorized: true, basis: "yolo", approval: null, waived };
}
