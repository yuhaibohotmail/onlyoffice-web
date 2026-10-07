#!/usr/bin/env node
/**
 * Refuse to build a release from anything but a clean tree sitting exactly on `v<version>`.
 *
 *   node scripts/release-guard.mjs              # check this repository; exit 0 = ok, 1 = refused
 *   node scripts/release-guard.mjs --root DIR   # check another checkout of it
 *
 * Why: the "Get source code" link in the UI points at the tag `v<package.json version>`
 * (AGPL-3.0 section 13 asks for the corresponding source of *this* version). A package built
 * from a dirty tree, or from commits after the tag, runs code that the link does not lead to,
 * and nothing reports it: the link still opens. `make-release.mjs` calls this first, and a
 * packaging script outside this repository that bundles `embed-poc/dist`
 * should run it against the checkout it packages.
 *
 * "Clean" includes untracked files: the release copies the working tree, so an untracked file
 * would ship. Files ignored by .gitignore are not counted (they are excluded from the copy).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Returns `{ ok, version, tag, problems: string[] }`. Never throws for a refusal. */
export function checkReleaseTree(root) {
  const problems = [];
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  } catch (e) {
    problems.push("cannot read the version from package.json: " + e.message);
  }
  const tag = version ? "v" + version : null;

  try {
    git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    problems.push(root + " is not a git checkout, so there is no way to tell which tag it is");
    return { ok: false, version, tag, problems };
  }

  const dirty = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) {
    const lines = dirty.split("\n");
    problems.push(
      "the working tree is not clean (" + lines.length + " path(s)); first ones:\n" +
        lines.slice(0, 5).map((l) => "      " + l).join("\n"),
    );
  }

  if (tag) {
    let tagsHere = [];
    try {
      tagsHere = git(root, ["tag", "--points-at", "HEAD"]).split("\n").filter(Boolean);
    } catch {
      /* no tags */
    }
    if (!tagsHere.includes(tag)) {
      problems.push(
        "HEAD is not tagged " + tag + " (tags on HEAD: " + (tagsHere.length ? tagsHere.join(", ") : "none") + "). " +
          "Commit the version bump, tag that commit " + tag + ", push the tag, then build from it.",
      );
    }
  }
  return { ok: problems.length === 0, version, tag, problems };
}

/** Print the verdict the way the release scripts do. Returns true when the tree may be released. */
export function reportReleaseTree(root, out = console) {
  const r = checkReleaseTree(root);
  if (r.ok) {
    out.log("✓ release guard: clean tree on " + r.tag);
    return true;
  }
  out.error("✗ refusing to build a release from " + root + ":");
  for (const p of r.problems) out.error("  - " + p);
  out.error(
    "  The UI links its source code to the tag " + (r.tag || "v<version>") +
      "; a package built from anything else would point users at code it does not run.",
  );
  return false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--root");
  const root = path.resolve(i > 0 ? process.argv[i + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  process.exit(reportReleaseTree(root) ? 0 : 1);
}
