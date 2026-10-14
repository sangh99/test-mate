import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { TaskStore } from "./store.js";
import { addProject, type ProjectSettings } from "./projects.js";
import { changeMemory, readMemory } from "./memory.js";
import { appError, InvalidInput, itemIdPattern, projectNamePattern, type ItemKind, type MemoryFile, type ProjectPosture } from "./domain.js";
import type { Import } from "./maintenance.js";

/**
 * An explicit, opt-in import of selected Bash Firstmate records: the project
 * registry (`data/projects.md`), queued backlog items and their captain holds
 * (`data/backlog.md`), and the captain's preferences, shared preferences, and
 * learnings (`data/captain.md`, `data/captain-shared.md`, `data/learnings.md`).
 * Nothing is imported unless asked, and the Bash home is only read. The plan
 * is computed first; applying it imports each planned record once.
 */

export const importKinds = ["projects", "backlog", "preferences", "learnings"] as const;
export type ImportKind = typeof importKinds[number];

export interface ImportOptions {
  /** The Bash home, or its `data` directory. */
  readonly from: string;
  /** Where the Bash home's project clones are (default `<from>/projects`). */
  readonly clones?: string;
  /** The record kinds to import (default all). */
  readonly only?: readonly ImportKind[];
  /** Imports the plan; without it nothing changes. */
  readonly apply?: boolean;
}

/** One record of the plan: what it would become here, or why it is skipped. */
export interface PlannedRecord {
  readonly kind: Import["kind"];
  readonly key: string;
  /** The Bash record, as its source line or file. */
  readonly source: string;
  readonly target: string;
  readonly action: "import" | "skip";
  readonly reason: string | null;
  readonly digest: string;
  /** The values it is imported with. */
  readonly values?: Record<string, unknown>;
}

const digestOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const readOptional = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : null;

/** A project registry line, by the Bash registry's own grammar (bin/fm-project-mode.sh). */
export function parseProjectLine(line: string) {
  const match = /^- (.+?)(?: \[([^\]]*)\])? - (.*)$/.exec(line.trimEnd());
  if (!match) return null;
  const tokens = (match[2] ?? "").split(/\s+/).filter(Boolean);
  let yolo = false, branchPrefix: string | null = null, forge: string | null = null;
  const rest: string[] = [];
  for (const token of tokens) {
    if (token === "+yolo") yolo = true;
    else if (token.startsWith("branch=")) branchPrefix = token.slice("branch=".length);
    else if (token.startsWith("forge=")) forge = token.slice("forge=".length);
    else rest.push(token);
  }
  return { name: match[1]!, mode: rest.join(" ") || "no-mistakes", yolo, branchPrefix, forge, description: match[3]! };
}

/** A hold reason as bin/fm-hold-reason-lib.sh stores it: plain, or `fm-hold-v1:` and base64 UTF-8. */
const decodeReason = (reason: string) => reason.startsWith("fm-hold-v1:") ? Buffer.from(reason.slice("fm-hold-v1:".length), "base64").toString("utf8") : reason;

/** A backlog line in a tasks-axi Markdown backlog, with its section and indented body. */
export function parseBacklog(text: string) {
  const items: { section: string; done: boolean; id: string; title: string; tags: Record<string, string>; blockedBy: string[]; body: string[]; line: string }[] = [];
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) { section = heading[1]!.trim().toLowerCase(); continue; }
    const entry = /^- \[( |x)\] (\S+) - (.*)$/.exec(line);
    if (entry) {
      let rest = entry[3]!.trimEnd();
      const tags: Record<string, string> = {};
      // Only the trailing tags tasks-axi writes are read, so a title's own parentheses stay in the title.
      for (;;) {
        const tag = /\s\((kind|repo|hold|hold-kind|hold-until|until|pr): ([^()]*)\)$/.exec(rest) ?? /\s\((since|done|added) ([^()]*)\)$/.exec(rest);
        if (!tag) break;
        tags[tag[1]!] = tag[2]!.trim();
        rest = rest.slice(0, tag.index).trimEnd();
      }
      const blocked = /\s+blocked-by: (\S+(?:,\s*\S+)*)$/.exec(rest);
      if (blocked) rest = rest.slice(0, blocked.index).trimEnd();
      items.push({ section, done: entry[1] === "x", id: entry[2]!, title: rest, tags, blockedBy: blocked ? blocked[1]!.split(",").map(s => s.trim()).filter(Boolean) : [], body: [], line });
      continue;
    }
    if (/^ {2}\S/.test(line) && items.length) items.at(-1)!.body.push(line.trim());
  }
  return items;
}

const postures: readonly string[] = ["no-mistakes", "direct-PR", "local-only", "no-mistakes-prod-only"];
const kinds: readonly string[] = ["ship", "scout", "captain"];

/** Plans the import from the Bash home against this home's records, without changing either. */
export const planImport = Effect.fn("firstmate.planImport")(function*(options: ImportOptions) {
  const store = yield* TaskStore;
  const only = new Set(options.only?.length ? options.only : importKinds);
  const root = resolve(options.from);
  const data = existsSync(join(root, "data")) && !existsSync(join(root, "backlog.md")) && !existsSync(join(root, "projects.md")) ? join(root, "data") : root;
  if (!existsSync(data)) return yield* Effect.fail(new InvalidInput({ message: `No Bash Firstmate home at ${root}` }));
  const real = yield* Effect.try({ try: () => realpathSync(data), catch: appError });
  if (!["projects.md", "backlog.md", "captain.md", "captain-shared.md", "learnings.md"].some(file => existsSync(join(real, file)))) {
    return yield* Effect.fail(new InvalidInput({ message: `${real} holds no Bash Firstmate records (projects.md, backlog.md, captain.md, captain-shared.md, learnings.md)` }));
  }
  const clones = resolve(options.clones ?? join(real, "..", "projects"));
  const keyOf = (kind: string, id: string) => `bash:${real}:${kind}:${id}`;
  const records: PlannedRecord[] = [];
  const imported = new Set((yield* store.maintenance.imports()).map(record => record.key));
  const projects = new Set((yield* store.projectEntries()).map(entry => entry.name));
  const plan = (record: Omit<PlannedRecord, "action" | "reason">, reason: string | null) => {
    records.push({ ...record, action: reason === null ? "import" : "skip", reason });
  };
  const skipIfImported = (key: string, reason: string | null) => imported.has(key) ? "already imported" : reason;

  if (only.has("projects")) {
    const text = readOptional(join(real, "projects.md")) ?? "";
    for (const line of text.split(/\r?\n/).filter(l => l.startsWith("- "))) {
      const parsed = parseProjectLine(line);
      if (!parsed) { plan({ kind: "project", key: keyOf("project", digestOf(line)), source: line, target: "(unparsed)", digest: digestOf(line) }, "not a registry line this import can read"); continue; }
      const key = keyOf("project", parsed.name);
      const clone = join(clones, parsed.name);
      // The Bash registry's branch prefix defaults to fm/, so imported projects keep their branch names.
      const settings: ProjectSettings = { delivery: parsed.mode as ProjectPosture, yolo: parsed.yolo, branchPrefix: parsed.branchPrefix ?? "fm/" };
      const reason = skipIfImported(key,
        !projectNamePattern.test(parsed.name) ? "the name is not a valid project name here"
        : !postures.includes(parsed.mode) ? `unknown delivery mode "${parsed.mode}"`
        : parsed.forge !== null ? `forge=${parsed.forge} has no adapter here (GitHub only)`
        : projects.has(parsed.name) ? "a project of that name is already registered"
        : !existsSync(join(clone, ".git")) ? `no clone at ${clone}; pass --clones <directory of the Bash home's clones>`
        : null);
      plan({ kind: "project", key, source: line, target: `project ${parsed.name}`, digest: digestOf(line), values: { name: parsed.name, clone, ...settings } }, reason);
      if (reason === null) projects.add(parsed.name);
    }
  }

  if (only.has("backlog")) {
    const text = readOptional(join(real, "backlog.md")) ?? "";
    const entries = parseBacklog(text);
    const existing = new Set([...(yield* store.items()), ...(yield* store.archivedItems())].map(item => item.id));
    const doneIds = new Set(entries.filter(e => e.done).map(e => e.id));
    const queued = entries.filter(e => !e.done && e.section === "queued");
    for (const entry of entries.filter(e => !(!e.done && e.section === "queued"))) {
      plan({ kind: "item", key: keyOf("item", entry.id), source: entry.line, target: `item ${entry.id}`, digest: digestOf(entry.line) },
        entry.done ? "done in the Bash home" : `${entry.section || "outside any section"} in the Bash home: its work stays there`);
    }
    // Items are planned in dependency order, so a dependency planned for import counts as present.
    const planned = new Set<string>();
    let pending = queued;
    while (pending.length) {
      const next = pending.filter(entry => entry.blockedBy.every(dep => existing.has(dep) || planned.has(dep) || doneIds.has(dep) || !pending.some(p => p.id === dep)));
      const ready = next.length ? next : pending;
      for (const entry of ready) {
        const key = keyOf("item", entry.id);
        const kind = entry.tags.kind ?? "ship";
        const missing = entry.blockedBy.filter(dep => !existing.has(dep) && !planned.has(dep) && !doneIds.has(dep));
        const repo = entry.tags.repo ?? null;
        const holdKind = entry.tags["hold-kind"] ?? null;
        const reason = entry.tags.hold !== undefined ? decodeReason(entry.tags.hold) : null;
        const until = entry.tags["hold-until"] ?? entry.tags.until ?? null;
        const notes = [
          `Imported from the Bash Firstmate backlog at ${real}${entry.tags.since ? `, filed ${entry.tags.since}` : ""}.`,
          ...(repo && !projects.has(repo) ? [`Its Bash repo "${repo}" is not a registered project here; set one with backlog update --project.`] : []),
          ...entry.blockedBy.filter(dep => doneIds.has(dep)).map(dep => `It waited on ${dep}, already done in the Bash home.`),
          ...(reason !== null && holdKind !== "captain" ? [`The Bash home held it (${holdKind ?? "unspecified"} hold): ${reason}`] : []),
          ...entry.body,
        ];
        const skip = skipIfImported(key,
          !itemIdPattern.test(entry.id) ? "the id is not a valid item id here"
          : !kinds.includes(kind) ? `kind "${kind}" has no backlog equivalent here`
          : existing.has(entry.id) ? "an item with that id is already in the backlog"
          : missing.length ? `it depends on ${missing.join(", ")}, which is neither done nor importable`
          : until !== null && Number.isNaN(Date.parse(until)) ? `its date "${until}" is not a date`
          : null);
        plan({
          kind: holdKind === "captain" ? "hold" : "item", key, source: entry.line, target: `item ${entry.id}${holdKind === "captain" ? " held for the captain" : ""}`, digest: digestOf(entry.line),
          values: {
            id: entry.id, title: entry.title, kind: kind as ItemKind, project: repo && projects.has(repo) ? repo : null, dependsOn: entry.blockedBy.filter(dep => !doneIds.has(dep)),
            note: notes.join("\n"), ...(holdKind === "captain" ? { hold: reason ?? "Held for the captain in the Bash home", until } : until !== null ? { deferUntil: until } : {}),
          },
        }, skip);
        if (skip === null) planned.add(entry.id);
      }
      pending = pending.filter(entry => !ready.includes(entry));
    }
  }

  const memories: [MemoryFile, string, ImportKind][] = [["preferences", "captain.md", "preferences"], ["shared", "captain-shared.md", "preferences"], ["learnings", "learnings.md", "learnings"]];
  const memory = yield* readMemory();
  const identity = yield* store.identity();
  for (const [file, name, kind] of memories) {
    if (!only.has(kind)) continue;
    const text = readOptional(join(real, name));
    if (text === null) continue;
    const digest = digestOf(text);
    const key = keyOf(file, digest);
    const current = memory.find(m => m.file === file)?.text ?? "";
    plan({ kind: file, key, source: join(real, name), target: `${file} memory`, digest, values: { bytes: Buffer.byteLength(text) } }, skipIfImported(key,
      !text.trim() ? "the file is empty"
      : file === "shared" && identity ? "shared preferences change only in the main home"
      : current.includes(text.trim()) ? "this home's memory already holds that text"
      : null));
  }
  return { from: real, clones, apply: options.apply === true, records };
});

/**
 * Imports the planned records, each once: projects first, then items in
 * dependency order with their captain holds, then memory appended verbatim.
 * A record that fails is reported and the rest continue.
 */
export const importBash = Effect.fn("firstmate.importBash")(function*(options: ImportOptions) {
  const store = yield* TaskStore;
  const plan = yield* planImport(options);
  if (!options.apply) return { ...plan, summary: summarize(plan.records) };
  const outcomes: (PlannedRecord & { outcome: "imported" | "skipped" | "failed"; error?: string })[] = [];
  const order = [...plan.records.filter(r => r.kind === "project"), ...plan.records.filter(r => r.kind === "item" || r.kind === "hold"), ...plan.records.filter(r => r.kind !== "project" && r.kind !== "item" && r.kind !== "hold")];
  for (const record of order) {
    if (record.action === "skip") { outcomes.push({ ...record, outcome: "skipped" }); continue; }
    const values = record.values as unknown;
    const applied = yield* Effect.gen(function*() {
      switch (record.kind) {
        case "project": {
          const { name, clone, ...settings } = values as { name: string; clone: string } & ProjectSettings;
          yield* addProject(name, clone, settings);
          break;
        }
        case "item": case "hold": {
          const v = values as { id: string; title: string; kind: ItemKind; project: string | null; dependsOn: string[]; note: string; hold?: string; until?: string | null; deferUntil?: string };
          yield* store.addItem({ id: v.id, title: v.title, kind: v.kind, ...(v.project ? { project: v.project } : {}), dependsOn: v.dependsOn, note: v.note, ...(v.deferUntil ? { deferUntil: v.deferUntil } : {}) });
          if (v.hold !== undefined) yield* store.holdItem(v.id, { reason: v.hold, until: v.until ?? null });
          break;
        }
        default: {
          const text = readFileSync(record.source, "utf8");
          yield* changeMemory(record.kind as MemoryFile, "append", text);
        }
      }
      yield* store.maintenance.recordImport({ key: record.key, kind: record.kind, source: record.source, digest: record.digest, target: record.target });
    }).pipe(Effect.result);
    outcomes.push(applied._tag === "Success" ? { ...record, outcome: "imported" } : { ...record, outcome: "failed", error: applied.failure.message });
  }
  return { ...plan, records: outcomes, summary: summarize(outcomes) };
});

const summarize = (records: readonly (PlannedRecord & { outcome?: string })[]) => {
  const counts: Record<string, number> = {};
  for (const record of records) {
    const key = `${record.kind} ${record.outcome ?? (record.action === "import" ? "planned" : "skipped")}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};
