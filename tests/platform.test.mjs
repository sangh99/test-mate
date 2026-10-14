import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { symlink, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { agentOptions } from "../dist/agent.js";
import { prepareWorktree } from "../dist/worktrees.js";
import { fixture, exec } from "./helpers.mjs";

test("worktree recovery refuses a replacement on the wrong branch", async t => {
  const f = await fixture(t);
  await prepareWorktree(f.task.intake);
  await exec("git", ["-C", f.task.intake.worktree, "switch", "-c", "unrelated"]);
  await assert.rejects(prepareWorktree(f.task.intake), /differs/);
});

test("worktree recovery refuses an unrelated repository", async t => {
  const f = await fixture(t);
  await mkdir(f.task.intake.worktree, { recursive: true });
  await exec("git", ["init", "-b", f.task.intake.branch, f.task.intake.worktree]);
  await assert.rejects(prepareWorktree(f.task.intake), /different repository/);
});

test("write hook rejects path traversal, Git metadata, and symlink escapes", async t => {
  const f = await fixture(t);
  await prepareWorktree(f.task.intake);
  const options = agentOptions({ task: f.task, prompt: "x", abortController: new AbortController(), canUseTool: async () => ({ behavior: "deny", message: "test" }) });
  const hook = options.hooks.PreToolUse[0].hooks[0];
  const check = path => hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path } });
  assert.equal((await check(join(f.project, "outside.txt"))).hookSpecificOutput.permissionDecision, "deny");
  assert.equal((await check(join(f.task.intake.worktree, "..", "outside.txt"))).hookSpecificOutput.permissionDecision, "deny");
  assert.equal((await check(join(f.task.intake.worktree, ".git"))).hookSpecificOutput.permissionDecision, "deny");
  assert.equal((await check(join(f.task.intake.worktree, "src", "new.txt"))).hookSpecificOutput.permissionDecision, "ask");
  const alias = join(f.task.intake.worktree, "outside-link");
  await symlink(f.project, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await check(join(alias, "new.txt"))).hookSpecificOutput.permissionDecision, "deny");
});

test("CLI works with spaced paths and gives JSON state without model requests", async t => {
  const f = await fixture(t);
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const { stdout } = await exec(process.execPath, [cli, "show", f.task.id, "--home", f.home, "--json"]);
  assert.equal(JSON.parse(stdout).observedState, "queued");
  const help = await exec(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /firstmate resume/);
  await assert.rejects(exec(process.execPath, [cli, "answer", "missing", "--decision", "maybe", "--home", f.home]), /allow or.*deny/);
});

test("base commit is captured at intake and does not follow later source commits", async t => {
  const f = await fixture(t);
  await writeFile(join(f.project, "later.txt"), "later change");
  await exec("git", ["-C", f.project, "add", "."]);
  await exec("git", ["-C", f.project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "later"]);
  await prepareWorktree(f.task.intake);
  const head = await exec("git", ["-C", f.task.intake.worktree, "rev-parse", "HEAD"]);
  assert.equal(head.stdout.trim(), f.task.intake.base);
});
