/**
 * The release guard: a package may only be built from a clean tree sitting exactly on the tag
 * `v<package.json version>`. Each case builds a throwaway git repository in a temp directory.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkReleaseTree } from "../release-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GUARD = path.join(ROOT, "scripts", "release-guard.mjs");

function repo(version = "1.2.3") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oow-release-guard-"));
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q");
  g("config", "user.email", "test@example.invalid");
  g("config", "user.name", "test");
  g("config", "commit.gpgsign", "false");
  g("config", "tag.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }) + "\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return { dir, g };
}

test("control: clean and exactly on v<version> is accepted", () => {
  const { dir, g } = repo();
  g("tag", "v1.2.3");
  const r = checkReleaseTree(dir);
  assert.equal(r.ok, true, r.problems.join("\n"));
  assert.equal(r.tag, "v1.2.3");
});

test("no tag on HEAD is refused", () => {
  const { dir } = repo();
  const r = checkReleaseTree(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /not tagged v1\.2\.3/);
});

test("commits after the tag are refused", () => {
  const { dir, g } = repo();
  g("tag", "v1.2.3");
  fs.writeFileSync(path.join(dir, "more.txt"), "x");
  g("add", "-A");
  g("commit", "-q", "-m", "after the tag");
  assert.equal(checkReleaseTree(dir).ok, false);
});

test("a tag for another version is refused", () => {
  const { dir, g } = repo();
  g("tag", "v1.2.2");
  assert.equal(checkReleaseTree(dir).ok, false);
});

test("a modified tracked file is refused", () => {
  const { dir, g } = repo();
  g("tag", "v1.2.3");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "1.2.3", x: 1 }) + "\n");
  const r = checkReleaseTree(dir);
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /not clean/);
});

test("an untracked file is refused (it would be copied into the package)", () => {
  const { dir, g } = repo();
  g("tag", "v1.2.3");
  fs.writeFileSync(path.join(dir, "stray.txt"), "x");
  assert.equal(checkReleaseTree(dir).ok, false);
});

test("an ignored file does not count", () => {
  const { dir, g } = repo();
  g("tag", "v1.2.3");
  fs.mkdirSync(path.join(dir, "ignored"));
  fs.writeFileSync(path.join(dir, "ignored", "x"), "x");
  assert.equal(checkReleaseTree(dir).ok, true);
});

test("the command line exits 1 on refusal and 0 when accepted", () => {
  const { dir, g } = repo();
  assert.equal(spawnSync(process.execPath, [GUARD, "--root", dir]).status, 1);
  g("tag", "v1.2.3");
  assert.equal(spawnSync(process.execPath, [GUARD, "--root", dir]).status, 0);
});

test("make-release runs the guard before anything else, and agrees with it about this checkout", () => {
  // OOW_RELEASE_GUARD_ONLY stops make-release right after the guard. In case it ever stops
  // honouring that, --no-vendor and --out keep a stray run small and out of release/
  // (an unguarded run of this test once rebuilt the whole 1.5 GB package there).
  const expected = checkReleaseTree(ROOT).ok ? 0 : 1;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "oow-release-out-"));
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "make-release.mjs"), "--no-vendor", "--out", out], {
    env: { ...process.env, OOW_RELEASE_GUARD_ONLY: "1" },
    encoding: "utf8",
  });
  assert.equal(r.status, expected, r.stdout + r.stderr);
  if (expected === 1) assert.match(r.stderr, /refusing to build a release/);
  else assert.match(r.stdout, /release guard: clean tree on v/);
  assert.deepEqual(fs.readdirSync(out), [], "nothing was assembled");
});
