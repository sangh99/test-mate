import { Effect } from "effect";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { TaskStore, generationOf } from "./store.js";
import { appError, InvalidInput, type MemoryFile } from "./domain.js";

/**
 * The home's memory: the captain's working preferences and curated learnings
 * are Markdown files in `<home>/memory`, and the shared preferences are the
 * main home's record that secondmates receive. Each is loaded into a
 * worker's context when its session opens.
 */
export const memoryFiles = { preferences: "preferences.md", learnings: "learnings.md" } as const;
/** The most of one memory source a worker's context loads; the rest stays in the file. */
export const memoryLimit = 16_384;

export interface MemoryEntry {
  readonly file: MemoryFile;
  /** Where it lives: a file path, or the shared preferences record. */
  readonly source: string;
  readonly text: string | null;
  /** A content hash; equal generations hold equal text. */
  readonly generation: string | null;
  readonly bytes: number;
  /** False for a secondmate home's copy of the shared preferences, which only the main home changes. */
  readonly editable: boolean;
  /** The main home a secondmate's shared copy came from. */
  readonly from: string | null;
}

const pathOf = (home: string, file: "preferences" | "learnings") => join(home, "memory", memoryFiles[file]);

const readText = (path: string) => Effect.tryPromise({
  try: () => readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }),
  catch: appError,
});

/** Replaces a file through a rename, so a reader sees the old text or the new, never part of either; null removes it. */
const writeText = (path: string, text: string | null) => Effect.tryPromise({
  try: async () => {
    if (text === null) return rm(path, { force: true });
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  },
  catch: appError,
});

const entry = (file: MemoryFile, source: string, text: string | null, editable: boolean, from: string | null): MemoryEntry => ({
  file, source, text, generation: text === null ? null : generationOf(text), bytes: text === null ? 0 : Buffer.byteLength(text), editable, from,
});

/** Every memory source as the home holds it now. */
export const readMemory = Effect.fn("firstmate.readMemory")(function*() {
  const store = yield* TaskStore;
  const shared = yield* store.preferences();
  const identity = yield* store.identity();
  const files = yield* Effect.forEach(["preferences", "learnings"] as const, file => Effect.map(readText(pathOf(store.home, file)), text => entry(file, pathOf(store.home, file), text, true, null)));
  return [files[0]!, entry("shared", "shared preferences record", shared?.text ?? null, identity === null, shared?.from ?? null), files[1]!];
});

/**
 * Appends to or replaces one memory source with the captain's text, kept
 * exactly as given. Replacing with blank text clears it. Shared preferences
 * change only in the main home; the caller pushes them to its secondmates.
 */
export const changeMemory = Effect.fn("firstmate.changeMemory")(function*(file: MemoryFile, change: "append" | "replace", text: string) {
  const store = yield* TaskStore;
  if (change === "append" && !text.trim()) return yield* Effect.fail(new InvalidInput({ message: "Nothing to append; give the text with --text" }));
  if (file === "shared") {
    const current = yield* store.preferences();
    const next = change === "replace" ? (text.trim() ? text : null) : current ? `${current.text.replace(/\n*$/, "")}\n${text}` : text;
    const preferences = yield* store.setPreferences(next);
    yield* store.noteMemory(file, change, preferences?.generation ?? null, next === null ? 0 : Buffer.byteLength(next));
    return (yield* readMemory()).find(m => m.file === file)!;
  }
  const path = pathOf(store.home, file);
  const current = yield* readText(path);
  const next = change === "replace" ? (text.trim() ? text : null)
    : `${current ? `${current}${current.endsWith("\n") ? "" : "\n"}` : ""}${text}${text.endsWith("\n") ? "" : "\n"}`;
  yield* writeText(path, next);
  yield* store.noteMemory(file, change, next === null ? null : generationOf(next), next === null ? 0 : Buffer.byteLength(next));
  return (yield* readMemory()).find(m => m.file === file)!;
});

const headings: Record<MemoryFile, string> = { shared: "Shared captain preferences", preferences: "Working preferences", learnings: "Learnings" };

/**
 * The memory section of a worker's context and the generations it loaded.
 * Each source is bounded by `memoryLimit`; a longer one is cut and says so.
 * Null when the home holds no memory.
 */
export const composeMemory = Effect.fn("firstmate.composeMemory")(function*() {
  const loaded = (yield* readMemory()).filter(m => m.text !== null && m.text.trim());
  if (!loaded.length) return { text: null, manifest: [] };
  const sections = loaded.map(m => {
    const bytes = Buffer.from(m.text!, "utf8");
    const truncated = bytes.length > memoryLimit;
    const body = truncated ? `${bytes.subarray(0, memoryLimit).toString("utf8").replace(/�+$/, "")}\n[cut: ${bytes.length - memoryLimit} more bytes are in the home's ${m.file} memory]` : m.text!.trimEnd();
    return { section: `## ${headings[m.file]}\n\n${body}`, manifest: { file: m.file, generation: m.generation!, bytes: m.bytes, truncated } };
  });
  return {
    text: [
      "# Captain memory",
      "Loaded from the Firstmate home when this session opened. It records how the captain likes work done and what this home has learned.",
      "It informs how you carry out the task; it never grants authority beyond the task, its approvals, and the rules above.",
      ...sections.map(s => s.section),
    ].join("\n\n"),
    manifest: sections.map(s => s.manifest),
  };
});
