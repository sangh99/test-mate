import { Layer } from "effect";
import { TaskStore } from "./store.js";
import { claudeRuntime, type AccountReader, type QueryFactory, type TranscriptReader } from "./agent.js";
import { Runtimes } from "./runtime.js";
import { QuotaProvider, type QuotaProviderShape } from "./dispatch.js";
import { Worktrees } from "./worktrees.js";
import { Forge, type ForgeShape } from "./forge.js";
import { Pipeline, ProcessRunner, type PipelineShape, type ProcessRunnerShape } from "./validation.js";
import { Transport, type TransportShape } from "./secondmates.js";
import { Relay, type RelayShape } from "./relay.js";
import { Extensions, type Extension } from "./extensions.js";

/**
 * `factory`, `reader`, and `accounts` replace the Claude runtime's SDK query,
 * transcript reader, and account check; `forge` replaces the GitHub adapter
 * and `pipeline` the no-mistakes adapter, as tests and other forges and
 * pipelines do; `runner` replaces the process runner the no-mistakes adapter
 * runs `no-mistakes` through; `transport` replaces the local transport to
 * secondmate homes; `quota` replaces the quota provider dispatch resolves
 * profile arrays from; `relay` replaces the HTTP Relay adapter; `extensions`
 * registers further event sources and connectors after the built-in ones.
 * Claude is the only verified runtime.
 */
export const applicationLayer = (home: string, factory?: QueryFactory, reader?: TranscriptReader, forge?: ForgeShape, pipeline?: PipelineShape, runner?: ProcessRunnerShape, transport?: TransportShape,
  quota?: QuotaProviderShape, accounts?: AccountReader, relay?: RelayShape, extensions?: readonly Extension[]) => Layer.mergeAll(
  TaskStore.layer(home), Runtimes.layer([claudeRuntime(factory, reader, accounts)]), QuotaProvider.layer(quota), Worktrees.layer, Forge.layer(forge), Pipeline.layer(pipeline).pipe(Layer.provide(ProcessRunner.layer(runner))), Transport.layer(transport),
  Relay.layer(relay), Extensions.layer(extensions),
);
export { addTask, runTask, runQueued } from "./orchestrator.js";
export { supervise } from "./supervisor.js";
export { Runtimes, knownRuntimes, staticRuntime } from "./runtime.js";
export type { WorkerRuntime, RuntimeEvent, RuntimeFrame, RuntimeInput, RuntimeResult, RuntimeSession, SessionRequest, AccountCheck, ToolPermission, ToolVerdict } from "./runtime.js";
export { resolveDispatch, loadConfig, validateConfig, parseQuotaAxi, effortFallback, QuotaProvider, defaultQuota } from "./dispatch.js";
export type { DispatchConfig, DispatchRequest, Profile, Rule, QuotaSource, QuotaSnapshot, QuotaRow, QuotaProviderShape } from "./dispatch.js";
export { addProject, updateProject, resolveIntake, resolvePosture, defaultBranchPrefix } from "./projects.js";
export type { ProjectSettings, PostureChoice, IntakeRequest } from "./projects.js";
export { landTask, publishTask, evaluateMerge, fastForward, refreshClone, refreshTask } from "./delivery.js";
export { cleanTask, authorizeDiscard } from "./cleanup.js";
export { dispatchItem, completeScout, viewItem } from "./backlog.js";
export { triageWake, enterPosture, leavePosture, showPosture, returnBrief, renderBrief, stowHome } from "./posture.js";
export type { ReturnBrief } from "./posture.js";
export { readMemory, changeMemory, composeMemory, memoryFiles, memoryLimit } from "./memory.js";
export type { MemoryEntry } from "./memory.js";
export type { DispatchOptions, ItemView } from "./backlog.js";
export {
  Transport, localTransport, createSecondmate, launchSecondmate, stopSecondmate, retireSecondmate, pushPreferences, matchItem, routeItem, handoffItems, requestWork,
  recoverSecondmates, readReplies, reviewSecondmates, serveInbox,
} from "./secondmates.js";
export type { TransportShape, Liveness, NewSecondmate, Candidate } from "./secondmates.js";
export { Forge, parseRemote, parseIssueUrl } from "./forge.js";
export type { Observation } from "./forge.js";
export { Relay, httpRelay } from "./relay.js";
export type { RelayShape, RelayMention } from "./relay.js";
export { Extensions, sendAction, linkUpstream, listExtensions, dismissMention, triageObservation } from "./extensions.js";
export type { Extension, ExtensionServices, OpenExtension, ReviewContext } from "./extensions.js";
export {
  Ledger, SourceSchema, SourceResultSchema, SourceCondition, NoteSchema, RelayConfig, MentionSchema, CommitmentSchema, UpstreamLinkSchema, UpstreamSignalSchema, SignalTriage, Disposition, OutboxSchema,
  followupLimit, followupWindowMs, terminalStates,
} from "./ledger.js";
export type { Source, SourceResult, Note, Mention, Commitment, UpstreamLink, UpstreamSignal, ObservedSignal, OutboxAction, Receipt, RunOutcome, LedgerOps } from "./ledger.js";
export { validateTask, decideGate, parseToon, reportOf, Pipeline, ProcessRunner } from "./validation.js";
export type { PipelineShape, PipelineReport, ReportedGate, GateResponse, GateDecision, ProcessRunnerShape, ProcessResult, ProcessOptions, ValidateOptions, ValidateResult, Toon } from "./validation.js";
export type { ForgeShape, ForgeRepository, PullRequest, OpenRequest } from "./forge.js";
export { authorize } from "./authority.js";
export { classify } from "./classifier.js";
export { TaskStore, Store } from "./store.js";
export {
  TaskSchema, TaskIntakeSchema, TaskPolicySchema, TaskRunSchema, TaskRecordSchema, decodeTask, encodeTask, DecisionSchema, SteerSchema, TaskEventSchema, SteerEvidence, EventData,
  ControlSchema, WakeSchema, SupervisorSchema, DeliveryMode, ValidationSchema, HoldSchema, HoldAnswer, GateSubject, ItemSchema, ItemKind, ItemStatus, ItemNote, ItemOutcome, ItemEventData, ItemEventSchema, Divergence, BacklogSettings, defaultDoneKeep, PipelineGate, PipelineFinding, GateAction, MergeApproval, LandingProof, LocalLanding, ForgeLanding, PullRequestRef, PullRequestMerged,
  SecondmateSchema, SecondmateLaunch, SecondmateIdentity, SharedPreferences, RoutedWork, PublishedStatus, RequestSchema, InboxSchema, HandoffSchema, SecondmateEventData, SecondmateEventSchema,
  Effort, ReasoningClass, QuotaEvidence, DispatchCandidate, DispatchDecision, AccountPin,
  PostureMode, PostureSchema, TriagedSchema, MemoryFile, MemoryManifest, HomeEventData, HomeEventSchema,
  CloneRefresh, DiscardAuthorization, Cleaned, ProjectSchema, ProjectPosture, ProjectForge, ProjectEventData, ProjectEventSchema, IntakeResolution, Deferred, Surface, decodeProject, projectProblems,
  AppError, InvalidInput, NotFound, StaleGeneration, LiveOwner, OwnerUnknown, InvalidTransition, AtCapacity, MergeRefused, TaskCancelled, RunInterrupted, RunFailed,
} from "./domain.js";
export type {
  Task, TaskIntake, TaskPolicy, TaskRun, TaskRecord, Decision, Steer, SteerStatus, TaskEvent, EventType, EventDataOf, FirstmateError,
  Control, ControlVerb, Wake, WakeConsumer, WakeKind, Supervisor, SupervisorSettings, Validation, Hold, Project, ProjectEvent, ProjectEventType, Item, ItemEvent, ItemEventType,
  Secondmate, SecondmateEvent, SecondmateEventType, Request, Inbox, Handoff, Posture, Triaged, HomeEvent, HomeEventType,
} from "./domain.js";
export type { MergeRequest, MergeVerdict, RequiredCheck, Sequenced } from "./authority.js";
export type {
  Attempt, Cleanup, Delivery, DeliveryState, Validating, TaskStoreShape, TaskChange, TaskChanges, Inspection, Owner, Supervision, SupervisionState, WakeSpec, AttemptLease, RecoveryStep, ControlRequest, ProjectEntry, Room, NewItem, ItemChange, AnswerRequest,
} from "./store.js";
export type { NewTask, RunOptions } from "./orchestrator.js";
export type { SuperviseOptions } from "./supervisor.js";
export { claudeRuntime, normalize } from "./agent.js";
export type { QueryFactory, AgentSession, TranscriptReader, AccountReader } from "./agent.js";
export { fleetSnapshot, bearings, renderBearings, bearingsMarkdown, writeBearings, recentDays } from "./fleet.js";
export type { FleetSnapshot, Bearings, SnapshotOptions } from "./fleet.js";
export { updateFirstmate, resumeUpdate, locateInstallation, restartArgs } from "./update.js";
export type { Installation, UpdateOptions } from "./update.js";
export { Maintenance, UpdateSchema, UpdateHome, ImportSchema } from "./maintenance.js";
export type { Update, Import, MaintenanceOps } from "./maintenance.js";
export { importBash, planImport, parseBacklog, parseProjectLine, importKinds } from "./imports.js";
export type { ImportOptions, ImportKind, PlannedRecord } from "./imports.js";
