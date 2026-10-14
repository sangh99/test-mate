import { isAbsolute } from "node:path";
import { Schema } from "effect";

export const TaskKind = Schema.Literals(["ship", "scout"]);
export const TaskState = Schema.Literals([
  "queued", "provisioning", "running", "waiting", "ready", "validating", "local-ready", "pr-open", "landed", "completed",
  "failed", "interrupted", "cancelled", "cleaned",
]);
export type TaskState = typeof TaskState.Type;
/** Reasoning effort a worker runs at. `max` is used only when named explicitly, never by fallback. */
export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;
/** The reasoning class a dispatch profile declares, as quota-axi's --intelligence names them. */
export const ReasoningClass = Schema.Literals(["high", "medium", "low"]);
export type ReasoningClass = typeof ReasoningClass.Type;
/** The quota facts that apply to one candidate, from one snapshot; null fields were not measured. */
export const QuotaEvidence = Schema.Struct({
  provider: Schema.String,
  /** The snapshot scopes the facts came from: provider-wide ones and any named for the candidate's model. */
  scopes: Schema.Array(Schema.String),
  percentRemaining: Schema.NullOr(Schema.Number),
  spendPriority: Schema.NullOr(Schema.Number),
  runway: Schema.Literals(["through_reset", "projected_exhaustion", "exhausted_now", "unknown"]),
  runwaySeconds: Schema.NullOr(Schema.Number),
  /** Auth, staleness, and other facts the snapshot named instead of a number. */
  attention: Schema.Array(Schema.String),
});
export type QuotaEvidence = typeof QuotaEvidence.Type;
/**
 * One profile candidate and how dispatch judged it. chosen: dispatched.
 * eligible: viable but ranked below the choice. tight: its known runway or
 * floor fails. blocked: concrete evidence rules it out. tied: indistinguishable
 * from another, so the captain chooses.
 */
export const DispatchCandidate = Schema.Struct({
  runtime: Schema.String,
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Effort),
  reasoning: Schema.NullOr(ReasoningClass),
  provider: Schema.String,
  verdict: Schema.Literals(["chosen", "eligible", "tight", "blocked", "tied"]),
  /** Whether known runway lasts the completion horizon; unknown is never assumed to pass. */
  runway: Schema.Literals(["pass", "fail", "unknown"]),
  quota: Schema.NullOr(QuotaEvidence),
  uncertainty: Schema.Array(Schema.String),
  reason: Schema.String,
});
export type DispatchCandidate = typeof DispatchCandidate.Type;
/**
 * How dispatch chose a task's runtime, model, and effort: which step of the
 * precedence (explicit override, best-fit rule, default, static runtime)
 * supplied the profile, each candidate with its evidence, and the quota
 * snapshot an array was resolved from. Fixed at creation.
 */
export const DispatchDecision = Schema.Struct({
  source: Schema.Literals(["override", "rule", "default", "static"]),
  rule: Schema.NullOr(Schema.String),
  runtime: Schema.String,
  /** Null runs the runtime's own default model. */
  model: Schema.NullOr(Schema.String),
  effort: Effort,
  effortFrom: Schema.Literals(["override", "profile", "fallback"]),
  /** The account pin at dispatch and whether the runtime confirmed it signed in; null when unpinned. */
  account: Schema.NullOr(Schema.Struct({ pin: Schema.String, signedIn: Schema.NullOr(Schema.Boolean), detail: Schema.String })),
  /** The snapshot a profile array was resolved from; null when no array was resolved. */
  quota: Schema.NullOr(Schema.Struct({ source: Schema.String, takenAt: Schema.NullOr(Schema.String), error: Schema.NullOr(Schema.String), horizonSeconds: Schema.Number })),
  candidates: Schema.Array(DispatchCandidate),
  notes: Schema.Array(Schema.String),
  decidedAt: Schema.String,
});
export type DispatchDecision = typeof DispatchDecision.Type;
/**
 * A runtime's account pin, set and changed only by the developer: `ordinary`
 * (the runtime's default login) or the absolute root of another login.
 */
export const AccountPin = Schema.Struct({ runtime: Schema.String, root: Schema.String, setAt: Schema.String });
export type AccountPin = typeof AccountPin.Type;
/** What the task was asked to do; fixed at creation and never rewritten. */
export const TaskIntakeSchema = Schema.Struct({
  kind: TaskKind,
  prompt: Schema.String,
  project: Schema.String,
  /** The registered project the task names; absent for a path-only (unregistered) task and for tasks created before the registry. */
  projectName: Schema.optionalKey(Schema.String),
  base: Schema.String,
  branch: Schema.String,
  worktree: Schema.String,
  model: Schema.NullOr(Schema.String),
  maxTurns: Schema.Number,
  maxBudgetUsd: Schema.Number,
  /** How dispatch chose the runtime, model, and effort; absent for tasks created before dispatch, which run on Claude. */
  dispatch: Schema.optionalKey(DispatchDecision),
});
export type TaskIntake = typeof TaskIntakeSchema.Type;
/**
 * no-mistakes: the validation pipeline owns review, push, PR, and CI.
 * direct-PR: pushed and opened as a PR without the pipeline.
 * local-only: stops on a clean ready branch that the host fast-forwards locally.
 */
export const DeliveryMode = Schema.Literals(["no-mistakes", "direct-PR", "local-only"]);
export type DeliveryMode = typeof DeliveryMode.Type;
/**
 * What a ship declares it changes, for a `no-mistakes-prod-only` project:
 * internal-only work ships direct-PR, and everything else no-mistakes. It is
 * declared at intake and never inferred from file paths or names.
 */
export const Surface = Schema.Literals(["internal-only", "product-facing", "mixed", "uncertain"]);
export type Surface = typeof Surface.Type;
/**
 * Per-task delivery policy, resolved at ship intake and never
 * rewritten. `yolo` is merge posture only: whether green, unflagged work may
 * merge without the captain's word. `target` is the branch a landing advances.
 * Scouts and ships created before delivery modes carry none of these.
 */
export const TaskPolicySchema = Schema.Struct({
  delivery: Schema.optionalKey(DeliveryMode),
  yolo: Schema.optionalKey(Schema.Boolean),
  target: Schema.optionalKey(Schema.String),
  /** The surface a ship on a `no-mistakes-prod-only` project declared, when it decided the delivery mode. */
  surface: Schema.optionalKey(Surface),
});
export type TaskPolicy = typeof TaskPolicySchema.Type;
/**
 * A direct-PR ship's pull request, every field as the forge returned it:
 * `url` is never assembled, and `head` is the commit the forge reported for
 * the PR when it was opened or last updated.
 */
export const PullRequestRef = Schema.Struct({
  url: Schema.String,
  number: Schema.Number,
  head: Schema.String,
  target: Schema.String,
});
export type PullRequestRef = typeof PullRequestRef.Type;
/** One finding of a pipeline gate, as the pipeline reported it. `action` is the pipeline's classification (auto-fix, no-op, ask-user, or another). */
export const PipelineFinding = Schema.Struct({
  id: Schema.String,
  severity: Schema.String,
  file: Schema.String,
  action: Schema.String,
  description: Schema.String,
});
export type PipelineFinding = typeof PipelineFinding.Type;
/**
 * A pipeline gate: a step of one pipeline run parked for a response.
 * `occurrence` counts this step's gates in the run, so a gate the step raises
 * again after a response is a different gate.
 */
export const PipelineGate = Schema.Struct({
  runId: Schema.String,
  step: Schema.String,
  occurrence: Schema.Number,
  summary: Schema.String,
  findings: Schema.Array(PipelineFinding),
});
export type PipelineGate = typeof PipelineGate.Type;
/**
 * One validation of a no-mistakes ship's ready commit by the pipeline.
 * running: the pipeline owns the branch. passed: it ended with a PR whose
 * URL and head the forge reported. failed: it ended without one, or could
 * not be driven to an outcome.
 */
export const ValidationSchema = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  /** The ready commit submitted to the pipeline. */
  commit: Schema.String,
  /** The pipeline's run identity, once it reported one. */
  runId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["running", "passed", "failed"]),
  /** The pipeline's final outcome, such as checks-passed or failed. */
  outcome: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Validation = typeof ValidationSchema.Type;
export const decodeValidation = Schema.decodeUnknownSync(ValidationSchema);
/** How a gate is answered: the pipeline's own response verbs. */
export const GateAction = Schema.Literals(["approve", "fix", "skip"]);
export type GateAction = typeof GateAction.Type;
/**
 * The captain's answer to a hold, stored exactly as given. A pipeline gate's
 * answer also carries how the host carries it out (`action`, `findings`);
 * `close` says whether the answer closed the held item or released it to
 * proceed. Answers recorded before the backlog carry neither `close` nor
 * anything but a gate answer.
 */
export const HoldAnswer = Schema.Struct({
  text: Schema.String,
  action: Schema.optionalKey(GateAction),
  /** The findings a fix applies to; empty means every finding of the gate. */
  findings: Schema.optionalKey(Schema.Array(Schema.String)),
  answeredAt: Schema.String,
  close: Schema.optionalKey(Schema.Literals(["closed", "released"])),
});
export type HoldAnswer = typeof HoldAnswer.Type;
/** A pipeline gate that needs the captain's judgment, held on the validation that raised it. */
export const GateSubject = Schema.Struct({ kind: Schema.Literal("validation-gate"), validation: Schema.String, gate: PipelineGate });
/**
 * A backlog item held for the captain: an open question only the captain
 * can close, through an answer stored verbatim. Every hold holds one item;
 * `subject` is set when the question is a pipeline gate of task `taskId`.
 * `until` is the captain's own deferral, `origin` the scout or other task
 * whose work discovered the call. A re-held item starts a new hold.
 */
export const HoldSchema = Schema.Struct({
  id: Schema.String,
  itemId: Schema.String,
  /** The task whose pipeline gate is held; null for a hold that is not a gate. */
  taskId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["open", "answered"]),
  /** The reason it is held: the question and its options. */
  question: Schema.String,
  until: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
  subject: Schema.NullOr(GateSubject),
  answer: Schema.NullOr(HoldAnswer),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Hold = typeof HoldSchema.Type;
export const decodeHold = Schema.decodeUnknownSync(HoldSchema);

/** ship and scout items dispatch as tasks of that kind; a captain item is a question and never dispatches. */
export const ItemKind = Schema.Literals(["ship", "scout", "captain"]);
export type ItemKind = typeof ItemKind.Type;
/** queued: waiting for dispatch. in-flight: its task exists. held: waiting on the captain. done: closed on a proven outcome or the captain's answer. */
export const ItemStatus = Schema.Literals(["queued", "in-flight", "held", "done"]);
export type ItemStatus = typeof ItemStatus.Type;
export const ItemNote = Schema.Struct({ at: Schema.String, by: Schema.Literals(["captain", "host"]), text: Schema.String });
export type ItemNote = typeof ItemNote.Type;
/**
 * What closed an item, or what its task proved while the item was held:
 * landed, a scout report attested, discarded under the captain's
 * authorization, or answered by the captain.
 */
export const ItemOutcome = Schema.Struct({
  basis: Schema.Literals(["landed", "report", "discarded", "answered"]),
  taskId: Schema.NullOr(Schema.String),
  detail: Schema.String,
  at: Schema.String,
});
export type ItemOutcome = typeof ItemOutcome.Type;
/**
 * A backlog work item, separate from any task. Only the host changes its
 * status: dispatch creates its task, completion and cleanup close it, and
 * only the captain's answer closes or releases a hold.
 */
export const ItemSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  kind: ItemKind,
  /** A registered project's name or a repository root, as a task's --project. */
  project: Schema.NullOr(Schema.String),
  /** What its task is asked to do; the title when null. */
  prompt: Schema.NullOr(Schema.String),
  status: ItemStatus,
  /** Items that must be done before this one dispatches. */
  dependsOn: Schema.Array(Schema.String),
  /** No dispatch before this date or time. */
  deferUntil: Schema.NullOr(Schema.String),
  notes: Schema.Array(ItemNote),
  /** The task dispatched from it. */
  taskId: Schema.NullOr(Schema.String),
  /** The open hold, while held. */
  hold: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(ItemOutcome),
  doneAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Item = typeof ItemSchema.Type;
export const decodeItem = Schema.decodeUnknownSync(ItemSchema);
/** Letters, digits, dot, underscore, and dash, starting with a letter or digit. */
export const itemIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The backlog's own history, one event per change, committed with the change. */
export const ItemEventData = {
  "item.added": ItemSchema,
  "item.updated": ItemSchema,
  "item.removed": Schema.Struct({ id: Schema.String }),
  "item.dispatched": Schema.Struct({ taskId: Schema.String, kind: TaskKind }),
  "item.held": Schema.Struct({ hold: Schema.String, reason: Schema.String, until: Schema.NullOr(Schema.String), origin: Schema.NullOr(Schema.String), from: ItemStatus }),
  "item.answered": Schema.Struct({ hold: Schema.String, text: Schema.String, close: Schema.Literals(["closed", "released"]), status: ItemStatus }),
  "item.finished": ItemOutcome,
  "item.done": ItemOutcome,
  "item.archived": Schema.Struct({ doneAt: Schema.String }),
  "item.migrated": Schema.Struct({ hold: Schema.String }),
  // Since secondmates: the routing decision, and the item leaving or entering a home through a handoff.
  "item.routed": Schema.Struct({ secondmate: Schema.NullOr(Schema.String), basis: Schema.Literals(["explicit", "sole-project-match", "local-only"]), candidates: Schema.Array(Schema.Struct({ id: Schema.String, scope: Schema.String, fits: Schema.Boolean, reason: Schema.String })) }),
  "item.handed-off": Schema.Struct({ secondmate: Schema.String, handoff: Schema.String, correlation: Schema.String }),
  "item.received": Schema.Struct({ from: Schema.String, handoff: Schema.String, correlation: Schema.String }),
  "item.restored": Schema.Struct({ secondmate: Schema.String, handoff: Schema.String, reason: Schema.String }),
} as const;
export type ItemEventType = keyof typeof ItemEventData;
export const ItemEventSchema = Schema.Struct({
  sequence: Schema.Number,
  itemId: Schema.String,
  type: Schema.String,
  data: Schema.Unknown,
  createdAt: Schema.String,
});
export type ItemEvent = typeof ItemEventSchema.Type;
/**
 * Two records of one captain call that disagree. It is never proof that the
 * captain ruled: reconcile it with the captain's own words or by re-holding.
 */
export const Divergence = Schema.Struct({
  item: Schema.String,
  hold: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["held-without-open-hold", "open-hold-on-unheld-item", "answer-recorded-but-hold-open", "closed-without-recorded-answer", "captain-response-without-answer"]),
  detail: Schema.String,
});
export type Divergence = typeof Divergence.Type;
export const BacklogSettings = Schema.Struct({ doneKeep: Schema.Number });
export type BacklogSettings = typeof BacklogSettings.Type;
/** Done items kept in the live backlog before the oldest are archived. */
export const defaultDoneKeep = 10;
/** The latest attempt's runtime record; the only part of a task that changes after creation. */
export const TaskRunSchema = Schema.Struct({
  state: TaskState,
  generation: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  costUsd: Schema.Number,
  output: Schema.String,
  error: Schema.NullOr(Schema.String),
  cancelRequested: Schema.Boolean,
  /** A ship's branch head when its latest result was recorded: the commit a landing may advance its target to. */
  commit: Schema.optionalKey(Schema.String),
  /** The pull request a direct-PR ship was published as; kept across later attempts so they update it. */
  pr: Schema.optionalKey(PullRequestRef),
  updatedAt: Schema.String,
});
export type TaskRun = typeof TaskRunSchema.Type;
export const TaskSchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  intake: TaskIntakeSchema,
  policy: TaskPolicySchema,
  run: TaskRunSchema,
});
export type Task = typeof TaskSchema.Type;

/**
 * The flat task JSON stored in SQLite and printed by the CLI. Its field order
 * is the stored byte order, so it interleaves intake and run fields.
 */
export const TaskRecordSchema = Schema.Struct({
  id: Schema.String,
  kind: TaskKind,
  prompt: Schema.String,
  project: Schema.String,
  projectName: Schema.optionalKey(Schema.String),
  base: Schema.String,
  branch: Schema.String,
  worktree: Schema.String,
  delivery: Schema.optionalKey(DeliveryMode),
  yolo: Schema.optionalKey(Schema.Boolean),
  target: Schema.optionalKey(Schema.String),
  surface: Schema.optionalKey(Surface),
  state: TaskState,
  generation: Schema.NullOr(Schema.String),
  sessionId: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  maxTurns: Schema.Number,
  maxBudgetUsd: Schema.Number,
  costUsd: Schema.Number,
  output: Schema.String,
  error: Schema.NullOr(Schema.String),
  cancelRequested: Schema.Boolean,
  commit: Schema.optionalKey(Schema.String),
  pr: Schema.optionalKey(PullRequestRef),
  dispatch: Schema.optionalKey(DispatchDecision),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type TaskRecord = typeof TaskRecordSchema.Type;
const decodeRecord = Schema.decodeUnknownSync(TaskRecordSchema);
export const decodeTask = (input: unknown): Task => {
  const { id, kind, prompt, project, projectName, base, branch, worktree, delivery, yolo, target, surface, model, maxTurns, maxBudgetUsd, dispatch, createdAt, ...run } = decodeRecord(input);
  const policy = {
    ...(delivery !== undefined ? { delivery } : {}), ...(yolo !== undefined ? { yolo } : {}), ...(target !== undefined ? { target } : {}), ...(surface !== undefined ? { surface } : {}),
  };
  return { id, createdAt, intake: { kind, prompt, project, ...(projectName !== undefined ? { projectName } : {}), base, branch, worktree, model, maxTurns, maxBudgetUsd, ...(dispatch !== undefined ? { dispatch } : {}) }, policy, run };
};
/** Flattens a task into its record; decoding puts the fields in stored order. */
export const encodeTask = ({ id, createdAt, intake, policy, run }: Task): TaskRecord => decodeRecord({ id, ...intake, ...policy, ...run, createdAt });
/** A record as first written at intake, which has always led with project and base. */
export const encodeCreatedTask = (task: Task): TaskRecord => {
  const { project, base, ...rest } = encodeTask(task);
  return { project, base, ...rest };
};
/** Any failure without a more specific tag, such as Git, SDK, or file I/O. */
export class AppError extends Schema.TaggedError<AppError>()("AppError", { message: Schema.String }) {}
/** A caller-supplied value was rejected before any state changed. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", { message: Schema.String }) {}
/** No task, decision, or steer has the requested identity. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { message: Schema.String }) {}
/** A write came from a generation that no longer owns the task. */
export class StaleGeneration extends Schema.TaggedError<StaleGeneration>()("StaleGeneration", { message: Schema.String }) {}
/** A living local process already owns the task. */
export class LiveOwner extends Schema.TaggedError<LiveOwner>()("LiveOwner", { message: Schema.String }) {}
/** The recorded owner's liveness cannot be proven either way. */
export class OwnerUnknown extends Schema.TaggedError<OwnerUnknown>()("OwnerUnknown", { message: Schema.String }) {}
/** A task, decision, or steer is not in a state that permits the requested move. */
export class InvalidTransition extends Schema.TaggedError<InvalidTransition>()("InvalidTransition", { message: Schema.String }) {}
/** The task's project already runs as many attempts as its capacity allows; the task is unchanged. */
export class AtCapacity extends Schema.TaggedError<AtCapacity>()("AtCapacity", { message: Schema.String }) {}
/** Merge authority refused a merge; `waiting` is true when a required check is still pending or unreported. */
export class MergeRefused extends Schema.TaggedError<MergeRefused>()("MergeRefused", { message: Schema.String, waiting: Schema.Boolean }) {}
/** The attempt stopped because the task was cancelled. */
export class TaskCancelled extends Schema.TaggedError<TaskCancelled>()("TaskCancelled", { message: Schema.String }) {}
/** The attempt was aborted before it could finish; resume reconciles it. */
export class RunInterrupted extends Schema.TaggedError<RunInterrupted>()("RunInterrupted", { message: Schema.String }) {}
/** The attempt ended without a successful, verified result. */
export class RunFailed extends Schema.TaggedError<RunFailed>()("RunFailed", { message: Schema.String }) {}

const tagged = [AppError, InvalidInput, NotFound, StaleGeneration, LiveOwner, OwnerUnknown, InvalidTransition, AtCapacity, MergeRefused, TaskCancelled, RunInterrupted, RunFailed] as const;
export type FirstmateError = InstanceType<typeof tagged[number]>;

/** Keeps a tagged error as is and wraps anything else as an `AppError`. */
export const appError = (cause: unknown): FirstmateError => tagged.some(error => cause instanceof error)
  ? cause as FirstmateError : new AppError({ message: cause instanceof Error ? cause.message : String(cause) });

export const DecisionSchema = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  generation: Schema.String,
  tool: Schema.String,
  input: Schema.Record(Schema.String, Schema.Unknown),
  status: Schema.Literals(["pending", "allow", "deny", "expired"]),
  answer: Schema.String,
  createdAt: Schema.String,
});
export type Decision = typeof DecisionSchema.Type;
export const decodeDecision = Schema.decodeUnknownSync(DecisionSchema);

/**
 * pending: not yet given to a worker. submitted: written to a generation's
 * input stream, receipt unproven. delivered: the CLI echoed it or the session
 * transcript holds it. acknowledged: a reply was stamped with it, with a later
 * steer, or with a resume prompt naming it. uncertain: an ended generation
 * left no proof either way; only an explicit requeue resends it.
 */
export const SteerStatus = Schema.Literals(["pending", "submitted", "delivered", "acknowledged", "uncertain"]);
export type SteerStatus = typeof SteerStatus.Type;
/**
 * A durable steering message. `id` is also the SDK user-message UUID, so SDK
 * echoes, reply stamps and transcripts all refer to the same identity.
 */
export const SteerSchema = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  sequence: Schema.Number,
  text: Schema.String,
  status: SteerStatus,
  generation: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Steer = typeof SteerSchema.Type;
export const decodeSteer = Schema.decodeUnknownSync(SteerSchema);

/** Lifecycle control, separate from steering text: interrupt stops the attempt; relaunch also resumes its exact session. */
export const ControlVerb = Schema.Literals(["interrupt", "relaunch"]);
export type ControlVerb = typeof ControlVerb.Type;
/**
 * A lifecycle request addressed to one generation. Its owner applies it when
 * it stops; a request its generation ends without applying expires.
 */
export const ControlSchema = Schema.Struct({
  id: Schema.String,
  taskId: Schema.String,
  generation: Schema.String,
  verb: ControlVerb,
  reason: Schema.String,
  /** The opening prompt for the attempt a relaunch starts. */
  prompt: Schema.NullOr(Schema.String),
  status: Schema.Literals(["requested", "applied", "expired"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Control = typeof ControlSchema.Type;
export const decodeControl = Schema.decodeUnknownSync(ControlSchema);

/** Who handles a wake: the captain through the CLI, or the supervisor's own recovery handlers. */
export const WakeConsumer = Schema.Literals(["captain", "supervisor"]);
export type WakeConsumer = typeof WakeConsumer.Type;
/**
 * finished, failed, decision, steer, escalated, published, landed, hold, refresh: reported to the captain.
 * stale, orphaned, relaunch, resume: recovery the supervisor carries out.
 * source-result, source-down, note, mention, followup, upstream, outbox: delivered by an extension
 * (a process source's captured result, a source stranded or failed to start, a captain inbox note,
 * a Relay mention, a promised final reply that is due, an upstream signal, an outbound send that failed).
 */
export const WakeKind = Schema.Literals(["finished", "failed", "decision", "steer", "escalated", "published", "landed", "hold", "refresh", "stale", "orphaned", "relaunch", "resume",
  "source-result", "source-down", "note", "mention", "followup", "upstream", "outbox"]);
export type WakeKind = typeof WakeKind.Type;
/**
 * An actionable wake. `key` makes recording it idempotent; `claim` is the
 * consumer generation that was last given it, and only that generation's
 * acknowledgement retires it.
 */
export const WakeSchema = Schema.Struct({
  sequence: Schema.Number,
  key: Schema.String,
  consumer: WakeConsumer,
  kind: WakeKind,
  /** The task the wake is about; null for an extension wake about no task. */
  taskId: Schema.NullOr(Schema.String),
  /** The extension record an extension wake is about, such as `source:<id>#<sequence>` or `note:<id>`; wakes recorded before extensions have none. */
  subject: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The task generation the wake is about. */
  generation: Schema.NullOr(Schema.String),
  /** The decision, steer, or control it concerns. */
  ref: Schema.NullOr(Schema.String),
  /** The event it was classified from; condition wakes have none. */
  cause: Schema.NullOr(Schema.Number),
  detail: Schema.String,
  status: Schema.Literals(["pending", "claimed", "acknowledged"]),
  claim: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Wake = typeof WakeSchema.Type;
export const decodeWake = Schema.decodeUnknownSync(WakeSchema);

/** away: the captain is gone and captain-relevant wakes wait for the return. quiet: the captain is present with routine wakes kept off. */
export const PostureMode = Schema.Literals(["away", "quiet"]);
export type PostureMode = typeof PostureMode.Type;
/**
 * One away or quiet session of a home; no active session means present.
 * `words` is the captain's away words exactly as given, the whole mandate,
 * which nothing parses. New words replace them at once and the replaced
 * words stay in `superseded` for the return brief.
 */
export const PostureSchema = Schema.Struct({
  id: Schema.String,
  mode: PostureMode,
  words: Schema.NullOr(Schema.String),
  superseded: Schema.Array(Schema.Struct({ words: Schema.NullOr(Schema.String), from: Schema.String, to: Schema.String })),
  /** When the current words were recorded. */
  wordsAt: Schema.String,
  enteredAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  /** return and quiet-off are the captain's; replaced is a quiet session an away entry replaced. */
  endedBy: Schema.NullOr(Schema.Literals(["return", "quiet-off", "replaced"])),
});
export type Posture = typeof PostureSchema.Type;
export const decodePosture = Schema.decodeUnknownSync(PostureSchema);
/**
 * How a posture handled one captain wake: `routine` was handled silently and
 * acknowledged by the supervisor, `captain` was batched for the captain and
 * stays open in the wake queue until the captain acknowledges it.
 */
export const TriagedSchema = Schema.Struct({
  wake: Schema.Number,
  posture: Schema.String,
  verdict: Schema.Literals(["routine", "captain"]),
  kind: WakeKind,
  taskId: Schema.NullOr(Schema.String),
  detail: Schema.String,
  why: Schema.String,
  at: Schema.String,
});
export type Triaged = typeof TriagedSchema.Type;
/** The memory files a home loads into worker context: working preferences and curated learnings beside the shared preferences record. */
export const MemoryFile = Schema.Literals(["preferences", "shared", "learnings"]);
export type MemoryFile = typeof MemoryFile.Type;
/** The memory generations an attempt's worker context loaded. */
export const MemoryManifest = Schema.Array(Schema.Struct({ file: MemoryFile, generation: Schema.String, bytes: Schema.Number, truncated: Schema.Boolean }));
/** The home's own history of posture, memory, and stow changes, one event per change, committed with it. */
export const HomeEventData = {
  "posture.entered": Schema.Struct({ posture: Schema.String, mode: PostureMode, words: Schema.NullOr(Schema.String) }),
  "posture.words-replaced": Schema.Struct({ posture: Schema.String, words: Schema.NullOr(Schema.String), previous: Schema.NullOr(Schema.String) }),
  "posture.exited": Schema.Struct({ posture: Schema.String, mode: PostureMode, by: Schema.Literals(["return", "quiet-off", "replaced"]), command: Schema.NullOr(Schema.String) }),
  "memory.changed": Schema.Struct({ file: MemoryFile, change: Schema.Literals(["append", "replace"]), generation: Schema.NullOr(Schema.String), bytes: Schema.Number }),
  "stow.filed": Schema.Struct({
    noted: Schema.Array(Schema.String), holds: Schema.Array(Schema.String), batched: Schema.Array(Schema.Number), learnings: Schema.Number, posture: Schema.NullOr(Schema.String),
  }),
} as const;
export type HomeEventType = keyof typeof HomeEventData;
export const HomeEventSchema = Schema.Struct({ sequence: Schema.Number, type: Schema.String, data: Schema.Unknown, createdAt: Schema.String });
export type HomeEvent = typeof HomeEventSchema.Type;

export const SupervisorSettingsSchema = Schema.Struct({
  concurrency: Schema.Number,
  pollMs: Schema.Number,
  staleMs: Schema.Number,
  recoveries: Schema.Number,
  /** Time between forge reviews of open yolo PRs; records written before forge delivery have none. */
  forgeMs: Schema.optionalKey(Schema.Number),
  /** Time between secondmate reviews and before an unhandled source result is announced again, when the start named them; a restart passes them on. */
  secondmateMs: Schema.optionalKey(Schema.Number),
  reannounceMs: Schema.optionalKey(Schema.Number),
});
export type SupervisorSettings = typeof SupervisorSettingsSchema.Type;
/** The home's supervisor lease: present while held, and left behind by an owner that died. */
export const SupervisorSchema = Schema.Struct({
  generation: Schema.String,
  pid: Schema.Number,
  host: Schema.String,
  startedAt: Schema.String,
  reviewedAt: Schema.NullOr(Schema.String),
  stopRequested: Schema.Boolean,
  /** Asked to drain: start nothing new and stop once its running attempts and validations end; records written before self-update have none. */
  drainRequested: Schema.optionalKey(Schema.Boolean),
  lastError: Schema.NullOr(Schema.String),
  settings: SupervisorSettingsSchema,
});
export type Supervisor = typeof SupervisorSchema.Type;
export const decodeSupervisor = Schema.decodeUnknownSync(SupervisorSchema);

/**
 * A project's standing delivery posture: one of the delivery modes, or
 * `no-mistakes-prod-only`, a conditional policy under which each ship's
 * declared surface picks the mode (internal-only: direct-PR; otherwise
 * no-mistakes).
 */
export const ProjectPosture = Schema.Literals(["no-mistakes", "direct-PR", "local-only", "no-mistakes-prod-only"]);
export type ProjectPosture = typeof ProjectPosture.Type;
/** The forge a project's `origin` remote is, as registered; GitHub is the only adapter so far. */
export const ProjectForge = Schema.Literals(["github"]);
/**
 * A registered project: the home's record of a clone and the captain's
 * standing defaults for its tasks. A task resolves its delivery mode, yolo,
 * base, target, and branch prefix from it at intake and records the result,
 * so changing a project never rewrites an existing task.
 */
export const ProjectSchema = Schema.Struct({
  name: Schema.String,
  /** The clone's repository root, an absolute path in this host's native form. */
  clone: Schema.String,
  /** The local branch tasks start from and land on unless a task overrides it. */
  defaultBranch: Schema.String,
  delivery: ProjectPosture,
  yolo: Schema.Boolean,
  /** Prepended to a task ID to name its branch; may be empty. */
  branchPrefix: Schema.String,
  /** Most attempts running at once for the project; null is uncapped. */
  capacity: Schema.NullOr(Schema.Number),
  /** Null exactly when the posture is local-only, which publishes nothing. */
  forge: Schema.NullOr(ProjectForge),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Project = typeof ProjectSchema.Type;
const decodeProjectRecord = Schema.decodeUnknownSync(ProjectSchema);
/** Letters, digits, dot, underscore, dash, and inner spaces: a name that is never a path on any OS. */
export const projectNamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9._ -]{0,62}[A-Za-z0-9._-])?$/;
/** What is wrong with a project record beyond its shape, in words that say what to change. */
export const projectProblems = (project: Project): string[] => [
  !projectNamePattern.test(project.name) && "its name must be 1-64 letters, digits, dots, underscores, dashes, or inner spaces",
  !isAbsolute(project.clone) && "clone must be an absolute path",
  !project.defaultBranch.trim() && "defaultBranch must name a local branch",
  /\s|\.\.|[~^:?*[\\]|^[-/]|\.lock$|@\{/.test(project.branchPrefix) && "branchPrefix must be usable at the start of a Git branch name",
  project.capacity !== null && !(Number.isSafeInteger(project.capacity) && project.capacity >= 1) && `capacity must be a positive integer or null (uncapped), not ${project.capacity}`,
  project.delivery === "local-only" && project.forge !== null && "a local-only project publishes nothing, so its forge must be null",
  project.delivery !== "local-only" && project.forge === null && `a ${project.delivery} project publishes to a forge, so its forge must be github`,
].filter((problem): problem is string => typeof problem === "string");
const malformedProject = (name: string, what: string) => new InvalidInput({
  message: `Project "${name}" in the registry is malformed: ${what}. Fix it with firstmate project update "${name}" (see --help), or unregister it with firstmate project remove "${name}"`,
});
/**
 * Decodes a registry record, refusing a malformed one with an error that
 * names the project, everything wrong with its shape (or else with its
 * values), and the commands that fix it.
 */
export const decodeProject = (name: string, input: unknown): Project => {
  let project: Project;
  try { project = decodeProjectRecord(input, { errors: "all" }); }
  catch (error) { throw malformedProject(name, (error instanceof Error ? error.message : String(error)).replace(/\n\s*at /g, " at ").split("\n").map(line => line.trim()).filter(Boolean).join("; ")); }
  const problems = [...(project.name !== name ? [`its record is named "${project.name}"`] : []), ...projectProblems(project)];
  if (problems.length) throw malformedProject(name, problems.join("; "));
  return project;
};
/** Decodes a registry record as stored, JSON text included. */
export const parseProject = (name: string, json: string): Project => {
  let input: unknown;
  try { input = JSON.parse(json); } catch { throw malformedProject(name, "its record is not valid JSON"); }
  return decodeProject(name, input);
};

/** How intake chose a ship's delivery mode or yolo. */
const PostureSource = Schema.Literals(["explicit", "registry", "surface", "unregistered-default"]);
/**
 * How intake resolved a task's project and, for a ship, its delivery policy.
 * `gap` names what the captain should know, such as an unregistered project.
 */
export const IntakeResolution = Schema.Struct({
  project: Schema.NullOr(Schema.String),
  matchedBy: Schema.NullOr(Schema.Literals(["name", "clone"])),
  posture: Schema.NullOr(ProjectPosture),
  delivery: Schema.optionalKey(Schema.Struct({ mode: DeliveryMode, from: PostureSource })),
  yolo: Schema.optionalKey(Schema.Struct({ on: Schema.Boolean, from: PostureSource })),
  surface: Schema.NullOr(Surface),
  gap: Schema.NullOr(Schema.String),
});
export type IntakeResolution = typeof IntakeResolution.Type;
/** A queued task the supervisor left queued because its project was at capacity. */
export const Deferred = Schema.Struct({ project: Schema.String, capacity: Schema.Number, holders: Schema.Array(Schema.String) });
export type Deferred = typeof Deferred.Type;
/** The registry's own history, one event per change, committed with the change. */
export const ProjectEventData = {
  "project.added": ProjectSchema,
  "project.updated": ProjectSchema,
  "project.removed": Schema.Struct({ name: Schema.String }),
} as const;
export type ProjectEventType = keyof typeof ProjectEventData;
export const ProjectEventSchema = Schema.Struct({
  sequence: Schema.Number,
  project: Schema.String,
  type: Schema.String,
  data: Schema.Unknown,
  createdAt: Schema.String,
});
export type ProjectEvent = typeof ProjectEventSchema.Type;

/**
 * A persistent secondmate: a supervisor in its own isolated home, with a
 * charter and a natural-language routing scope, launched as a separate local
 * process. `projects` are the registered projects it may run, a
 * non-exclusive list copied into its home; a local-only project stays with
 * the main home. `launch` is the bounded relaunch policy's record.
 */
export const SecondmateLaunch = Schema.Struct({
  /** Whether the captain wants it running; only a running one is relaunched. */
  desired: Schema.Literals(["running", "stopped"]),
  /** The process last launched, and where. */
  pid: Schema.NullOr(Schema.Number),
  host: Schema.NullOr(Schema.String),
  launchedAt: Schema.NullOr(Schema.String),
  /** Automatic relaunches since the captain's last explicit launch. */
  attempts: Schema.Number,
  /** Most automatic relaunches before the exits escalate to the captain. */
  limit: Schema.Number,
  /** Every exit the supervisor has observed, across launches. */
  exits: Schema.Number,
  lastExitAt: Schema.NullOr(Schema.String),
  /** The captain hold opened when the relaunches ran out; nothing relaunches it until an explicit launch. */
  exhausted: Schema.NullOr(Schema.String),
  /** Supervisor options passed on every launch and relaunch. */
  args: Schema.Array(Schema.String),
});
export type SecondmateLaunch = typeof SecondmateLaunch.Type;
export const SecondmateSchema = Schema.Struct({
  id: Schema.String,
  charter: Schema.String,
  scope: Schema.String,
  projects: Schema.Array(Schema.String),
  /** The secondmate's own home, an absolute path. */
  home: Schema.String,
  status: Schema.Literals(["active", "retired"]),
  launch: SecondmateLaunch,
  /** The shared captain preferences generation last pushed to its home; null when none was. */
  preferences: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  retiredAt: Schema.NullOr(Schema.String),
});
export type Secondmate = typeof SecondmateSchema.Type;
export const decodeSecondmate = Schema.decodeUnknownSync(SecondmateSchema);
/** Letters, digits, dot, underscore, and dash, starting with a letter or digit. */
export const secondmateIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * The identity a secondmate home records about itself: which secondmate it
 * is and the main home it answers to. A home without it is a main home.
 */
export const SecondmateIdentity = Schema.Struct({
  id: Schema.String, parent: Schema.String, charter: Schema.String, scope: Schema.String, createdAt: Schema.String,
});
export type SecondmateIdentity = typeof SecondmateIdentity.Type;
/** The captain's shared preferences, authoritative in the main home and read-only copies in secondmate homes. */
export const SharedPreferences = Schema.Struct({
  text: Schema.String,
  /** A content hash: a copy with the same generation holds the same text. */
  generation: Schema.String,
  updatedAt: Schema.String,
  /** The main home a secondmate's copy came from; null in the main home itself. */
  from: Schema.NullOr(Schema.String),
});
export type SharedPreferences = typeof SharedPreferences.Type;
/**
 * Routed work: a new work item described in the request, or items moved by
 * a handoff. A request's work is what its correlation identity names.
 */
export const RoutedWork = Schema.Struct({
  kind: Schema.Literals(["work", "handoff"]),
  title: Schema.String,
  /** For work: the task kind, project, and prompt of the item the secondmate creates. */
  taskKind: Schema.NullOr(TaskKind),
  project: Schema.NullOr(Schema.String),
  prompt: Schema.NullOr(Schema.String),
  surface: Schema.NullOr(Surface),
  /** For a handoff: the items it moved. */
  items: Schema.Array(Schema.String),
});
export type RoutedWork = typeof RoutedWork.Type;
/**
 * One line of a secondmate's published status for a request: what its home
 * recorded, never what its worker said. `document` points at a saved
 * report; `final` is set once every routed item has stopped.
 */
export const PublishedStatus = Schema.Struct({
  at: Schema.String,
  state: Schema.String,
  item: Schema.NullOr(Schema.String),
  task: Schema.NullOr(Schema.String),
  commit: Schema.NullOr(Schema.String),
  pr: Schema.NullOr(Schema.String),
  document: Schema.NullOr(Schema.String),
  detail: Schema.String,
  final: Schema.Boolean,
});
export type PublishedStatus = typeof PublishedStatus.Type;
/**
 * The main home's record of a request to a secondmate, keyed by its
 * correlation identity and written before delivery. `replies` mirror the
 * secondmate's published status lines for this correlation, read from its
 * home; a transport carries only the correlation and the routed work.
 */
export const RequestSchema = Schema.Struct({
  correlation: Schema.String,
  secondmate: Schema.String,
  work: RoutedWork,
  status: Schema.Literals(["pending", "delivered", "accepted", "replied"]),
  replies: Schema.Array(PublishedStatus),
  createdAt: Schema.String,
  deliveredAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type Request = typeof RequestSchema.Type;
export const decodeRequest = Schema.decodeUnknownSync(RequestSchema);
/**
 * A secondmate home's record of a request it received: the routed work, the
 * items it holds for it, and the status it publishes back.
 */
export const InboxSchema = Schema.Struct({
  correlation: Schema.String,
  from: Schema.String,
  work: RoutedWork,
  status: Schema.Literals(["received", "accepted", "refused", "done"]),
  items: Schema.Array(Schema.String),
  published: Schema.Array(PublishedStatus),
  receivedAt: Schema.String,
  updatedAt: Schema.String,
});
export type Inbox = typeof InboxSchema.Type;
export const decodeInbox = Schema.decodeUnknownSync(InboxSchema);
/**
 * A backlog handoff to a secondmate, durable in the main home before either
 * home changes. While `prepared`, its items are in transit and owned by the
 * main home through this record; the secondmate's receipt of the
 * correlation is what places them there, after which the handoff is
 * `placed`. An interrupted handoff is recovered forward, or `restored` to
 * the main backlog when the secondmate can no longer receive it.
 */
export const HandoffSchema = Schema.Struct({
  id: Schema.String,
  secondmate: Schema.String,
  correlation: Schema.String,
  items: Schema.Array(ItemSchema),
  phase: Schema.Literals(["prepared", "placed", "restored"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Handoff = typeof HandoffSchema.Type;
export const decodeHandoff = Schema.decodeUnknownSync(HandoffSchema);
/** The secondmate registry's own history, one event per change, committed with the change. */
export const SecondmateEventData = {
  "secondmate.created": SecondmateSchema,
  "secondmate.launched": Schema.Struct({ pid: Schema.Number, by: Schema.Literals(["captain", "supervisor"]), attempt: Schema.Number, limit: Schema.Number }),
  "secondmate.exited": Schema.Struct({ pid: Schema.NullOr(Schema.Number), exits: Schema.Number, detail: Schema.String }),
  "secondmate.exhausted": Schema.Struct({ attempts: Schema.Number, limit: Schema.Number, exits: Schema.Number, hold: Schema.String, item: Schema.String }),
  "secondmate.stopped": Schema.Struct({ reason: Schema.String }),
  "secondmate.retired": Schema.Struct({ home: Schema.String }),
  "secondmate.retire-refused": Schema.Struct({ reasons: Schema.Array(Schema.String) }),
  "preferences.pushed": Schema.Struct({ generation: Schema.NullOr(Schema.String) }),
  "request.created": Schema.Struct({ correlation: Schema.String, work: RoutedWork }),
  "request.delivered": Schema.Struct({ correlation: Schema.String }),
  "request.replied": Schema.Struct({ correlation: Schema.String, status: PublishedStatus }),
  "handoff.prepared": Schema.Struct({ id: Schema.String, correlation: Schema.String, items: Schema.Array(Schema.String) }),
  "handoff.placed": Schema.Struct({ id: Schema.String, recovered: Schema.Boolean }),
  "handoff.restored": Schema.Struct({ id: Schema.String, reason: Schema.String }),
} as const;
export type SecondmateEventType = keyof typeof SecondmateEventData;
export const SecondmateEventSchema = Schema.Struct({
  sequence: Schema.Number,
  secondmate: Schema.String,
  type: Schema.String,
  data: Schema.Unknown,
  createdAt: Schema.String,
});
export type SecondmateEvent = typeof SecondmateEventSchema.Type;

const RecoveryCause = Schema.Literals(["stale", "orphaned"]);
/**
 * The captain's explicit word to merge one exact commit. Each waiver names
 * one required check that may be red or unreported for that commit.
 */
export const MergeApproval = Schema.Struct({ commit: Schema.String, waivers: Schema.Array(Schema.String), note: Schema.String });
export type MergeApproval = typeof MergeApproval.Type;
/** Local Git proof that a task's commit is on its target branch, and the authority it landed under. */
export const LocalLanding = Schema.Struct({
  commit: Schema.String,
  target: Schema.String,
  /** The target's commit before landing and after it. */
  before: Schema.String,
  after: Schema.String,
  /** False when the target already contained the commit, so no fast-forward was needed. */
  fastForward: Schema.Boolean,
  basis: Schema.Literals(["captain", "yolo"]),
  /** The event sequence of the approval relied on, if any. */
  approval: Schema.NullOr(Schema.Number),
  waived: Schema.Array(Schema.String),
});
export type LocalLanding = typeof LocalLanding.Type;
/** The forge's acceptance of a PR merge bound to `head`, recorded before its landing is proven. */
export const PullRequestMerged = Schema.Struct({
  url: Schema.String,
  number: Schema.Number,
  head: Schema.String,
  mergeCommit: Schema.String,
  basis: Schema.Literals(["captain", "yolo"]),
  approval: Schema.NullOr(Schema.Number),
  waived: Schema.Array(Schema.String),
});
export type PullRequestMerged = typeof PullRequestMerged.Type;
/**
 * Forge proof that a PR's merge commit is on its target branch. `basis` is
 * `external` when the forge reports the PR merged with no merge recorded here.
 */
export const ForgeLanding = Schema.Struct({
  via: Schema.Literal("forge"),
  commit: Schema.String,
  target: Schema.String,
  url: Schema.String,
  number: Schema.Number,
  mergeCommit: Schema.String,
  /** The target's head when the forge showed the merge commit on it. */
  targetHead: Schema.String,
  basis: Schema.Literals(["captain", "yolo", "external"]),
  approval: Schema.NullOr(Schema.Number),
  waived: Schema.Array(Schema.String),
});
export type ForgeLanding = typeof ForgeLanding.Type;
export const LandingProof = Schema.Union([LocalLanding, ForgeLanding]);
export type LandingProof = typeof LandingProof.Type;
/** A guarded fast-forward of the project clone's target branch to the remote's, after a forge landing. */
export const CloneRefresh = Schema.Struct({
  project: Schema.String,
  target: Schema.String,
  /** The local target before and after; equal when it already contained the remote's head. */
  before: Schema.String,
  after: Schema.String,
  fastForward: Schema.Boolean,
});
export type CloneRefresh = typeof CloneRefresh.Type;
/**
 * The captain's explicit word that a task's unlanded work may be discarded
 * by cleanup. `head` is the task branch's commit when it was given (null
 * when the branch did not exist); a branch that moves afterwards needs a new
 * authorization.
 */
export const DiscardAuthorization = Schema.Struct({ reason: Schema.String, head: Schema.NullOr(Schema.String) });
export type DiscardAuthorization = typeof DiscardAuthorization.Type;
/**
 * Why cleanup removed a task's isolated copy and branch: `landed` on its
 * landing proof, `report` for a scout whose report exists, or `discard` under
 * the authorization recorded at event sequence `authorization`.
 */
export const Cleaned = Schema.Struct({
  basis: Schema.Literals(["landed", "report", "discard"]),
  authorization: Schema.NullOr(Schema.Number),
  worktree: Schema.String,
  branch: Schema.String,
  /** The branch head that was removed, or null when the branch was already gone. */
  head: Schema.NullOr(Schema.String),
  /** False when that part was already absent, such as after an interrupted cleanup. */
  removedWorktree: Schema.Boolean,
  removedBranch: Schema.Boolean,
});
export type Cleaned = typeof Cleaned.Type;
const via = <const V extends string>(value: V) => Schema.Struct({ via: Schema.Literal(value) });
/** Why a steer moved to its new status. */
export const SteerEvidence = Schema.Union([
  via("input-stream"), via("cli-replay"), via("reply-stamp"),
  Schema.Struct({ via: Schema.Literal("later-reply-stamp"), stamp: Schema.String }),
  Schema.Struct({ via: Schema.Literal("resume-prompt-stamp"), prompt: Schema.String }),
  via("transcript"), via("transcript-absent"), via("transcript-unavailable"), via("no-session"), via("explicit-requeue"),
]);
export type SteerEvidence = typeof SteerEvidence.Type;
const SteerMoved = Schema.Struct({ id: Schema.String, sequence: Schema.Number, evidence: SteerEvidence });

/** The event vocabulary: each event type and the data it carries. */
export const EventData = {
  "task.created": Schema.Struct({ kind: TaskKind, project: Schema.String, base: Schema.String }),
  // Since the project registry, intake records how it resolved the project and policy.
  "intake.resolved": IntakeResolution,
  // Since dispatch, intake records how it chose the runtime, model, and effort.
  "dispatch.resolved": DispatchDecision,
  "task.deferred": Deferred,
  "run.started": Schema.Struct({ resume: Schema.Boolean }),
  // Since memory, each attempt records which memory generations its worker context loaded.
  "memory.loaded": Schema.Struct({ files: MemoryManifest }),
  "run.interrupted": Schema.Struct({ reason: Schema.String }),
  // Records written before supervision carry no state.
  "run.stopped": Schema.Struct({ error: Schema.String, state: Schema.optionalKey(Schema.Literals(["failed", "interrupted", "cancelled"])) }),
  // Since cleanup, an attempt that creates the isolated copy also records the commit it started from.
  "worktree.ready": Schema.Struct({ path: Schema.String, start: Schema.optionalKey(Schema.String) }),
  "prompt.submitted": Schema.Struct({ id: Schema.String, prompt: Schema.String, answers: Schema.Array(Schema.String) }),
  "session.recorded": Schema.Struct({ sessionId: Schema.String }),
  "agent.text": Schema.Struct({ text: Schema.String }),
  "agent.tool": Schema.Struct({ name: Schema.String, id: Schema.String }),
  "agent.result": Schema.Struct({ subtype: Schema.String, isError: Schema.Boolean, costUsd: Schema.Number }),
  // Ship results since delivery modes also carry the branch head they stopped at.
  "task.result": Schema.Struct({ state: TaskState, commit: Schema.optionalKey(Schema.String) }),
  "decision.requested": DecisionSchema,
  "decision.answered": Schema.Struct({ id: Schema.String, status: Schema.Literals(["allow", "deny"]), answer: Schema.String }),
  "decision.expired": Schema.Struct({ id: Schema.String }),
  "steer.enqueued": Schema.Struct({ id: Schema.String, sequence: Schema.Number }),
  "steer.pending": SteerMoved,
  "steer.submitted": SteerMoved,
  "steer.delivered": SteerMoved,
  "steer.acknowledged": SteerMoved,
  "steer.uncertain": SteerMoved,
  "steer.unsettled": Schema.Struct({ ids: Schema.Array(Schema.String) }),
  "input.closed": Schema.Struct({}),
  "cancel.requested": Schema.Struct({}),
  "control.requested": Schema.Struct({ id: Schema.String, verb: ControlVerb, reason: Schema.String }),
  "control.applied": Schema.Struct({ id: Schema.String, verb: ControlVerb }),
  "control.expired": Schema.Struct({ id: Schema.String }),
  "recovery.attempted": Schema.Struct({ attempt: Schema.Number, limit: Schema.Number, cause: RecoveryCause, detail: Schema.String }),
  "recovery.exhausted": Schema.Struct({ attempts: Schema.Number, limit: Schema.Number, cause: RecoveryCause, detail: Schema.String }),
  "merge.approved": MergeApproval,
  "merge.flagged": Schema.Struct({ reason: Schema.String }),
  "pr.opened": PullRequestRef,
  "pr.updated": PullRequestRef,
  "pr.failed": Schema.Struct({ error: Schema.String }),
  "pr.merged": PullRequestMerged,
  "task.landed": LandingProof,
  "validation.started": Schema.Struct({ id: Schema.String, commit: Schema.String }),
  "validation.run": Schema.Struct({ id: Schema.String, runId: Schema.String }),
  "validation.gate": Schema.Struct({ id: Schema.String, gate: PipelineGate }),
  // Recorded before the response is sent, so a crash between the two never applies an answer to a later gate.
  "validation.responded": Schema.Struct({
    id: Schema.String, runId: Schema.String, step: Schema.String, occurrence: Schema.Number, action: GateAction, findings: Schema.Array(Schema.String),
    by: Schema.Literals(["policy", "captain"]), hold: Schema.NullOr(Schema.String), reason: Schema.String,
  }),
  "validation.passed": Schema.Struct({ id: Schema.String, runId: Schema.String, outcome: Schema.String, url: Schema.String, head: Schema.String, pipelineHead: Schema.NullOr(Schema.String) }),
  "validation.failed": Schema.Struct({ id: Schema.String, runId: Schema.NullOr(Schema.String), outcome: Schema.NullOr(Schema.String), error: Schema.String }),
  "hold.opened": Schema.Struct({ id: Schema.String, question: Schema.String, validation: Schema.String, gate: PipelineGate }),
  "hold.answered": Schema.Struct({ id: Schema.String, action: GateAction, text: Schema.String, findings: Schema.Array(Schema.String) }),
  // Since the backlog: the item a task was dispatched from, and a scout's attested captain-call inventory.
  "item.linked": Schema.Struct({ item: Schema.String }),
  "scout.attested": Schema.Struct({ items: Schema.Array(Schema.String), none: Schema.Boolean }),
  "clone.refreshed": CloneRefresh,
  "clone.refused": Schema.Struct({ project: Schema.String, target: Schema.String, reason: Schema.String }),
  "discard.authorized": DiscardAuthorization,
  "cleanup.refused": Schema.Struct({ reason: Schema.String }),
  "task.cleaned": Cleaned,
} as const;
export type EventType = keyof typeof EventData;
export type EventDataOf<T extends EventType> = typeof EventData[T]["Type"];

export const TaskEventSchema = Schema.Struct({
  sequence: Schema.Number,
  taskId: Schema.String,
  generation: Schema.NullOr(Schema.String),
  type: Schema.String,
  data: Schema.Unknown,
  createdAt: Schema.String,
});
export type TaskEvent = typeof TaskEventSchema.Type;
const decodeEnvelope = Schema.decodeUnknownSync(TaskEventSchema);
const isEventType = (type: string): type is EventType => Object.hasOwn(EventData, type);
/** Decodes data for a type in the vocabulary; other types keep their data as recorded. */
export const decodeEventData = (type: string, data: unknown): unknown =>
  isEventType(type) ? Schema.decodeUnknownSync(EventData[type] as Schema.Codec<unknown>)(data) : data;
export const decodeEvent = (input: unknown): TaskEvent => {
  const event = decodeEnvelope(input);
  return { ...event, data: decodeEventData(event.type, event.data) };
};

export const activeStates = new Set<TaskState>(["provisioning", "running", "waiting"]);
export const transitions: Record<TaskState, readonly TaskState[]> = {
  queued: ["provisioning", "cancelled"],
  provisioning: ["running", "failed", "interrupted", "cancelled"],
  running: ["waiting", "ready", "local-ready", "completed", "failed", "interrupted", "cancelled"],
  waiting: ["running", "failed", "interrupted", "cancelled"],
  // A ready direct-PR ship is published as a PR, and a resumed one updates that PR; a ready no-mistakes ship is validated.
  // Cleanup of unlanded work needs a recorded discard authorization; see cleanTask.
  ready: ["provisioning", "pr-open", "validating", "cleaned"],
  // The pipeline owns the branch while validating, so no attempt may start; a failed validation returns to ready.
  validating: ["pr-open", "ready"],
  "local-ready": ["provisioning", "landed", "cleaned"],
  "pr-open": ["provisioning", "landed", "cleaned"],
  // Landed work is on its target; follow-up work is a new task.
  landed: ["cleaned"],
  completed: ["provisioning", "cleaned"],
  failed: ["provisioning", "cleaned"],
  // Cancelling an interrupted task keeps a supervisor from resuming it.
  interrupted: ["provisioning", "cancelled", "cleaned"],
  cancelled: ["provisioning", "cleaned"],
  // The isolated copy and branch are gone; nothing can run or land again.
  cleaned: [],
};
