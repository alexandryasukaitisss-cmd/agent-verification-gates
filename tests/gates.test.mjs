import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  deterministicFindingId,
  evaluateFixLoopHealth,
  evaluateScopeDivergence,
  findingsFromGates,
  findingsFromReviews,
  gitTreeHash,
  inspectEvidenceManifest,
  inspectImageHeader,
  mergeFindingLedger,
  runReadOnlyGate,
} from "../src/index.mjs";

const execFileAsync = promisify(execFile);

function makeMinimalPng(width = 16, height = 12) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from("IHDR", "ascii");
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type RGB
  const crc = Buffer.alloc(4);
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc]);
}

test("deterministicFindingId is stable regardless of property insertion order", () => {
  const a = deterministicFindingId({
    kind: "reviewer",
    sourceId: "sec",
    severity: "blocking",
    file: "src/app.js",
    line: 12,
    message: "Unsafe eval",
  });
  const b = deterministicFindingId({
    message: "Unsafe eval",
    line: 12,
    file: "src/app.js",
    severity: "blocking",
    sourceId: "sec",
    kind: "reviewer",
  });
  assert.equal(a, b);
  assert.match(a, /^reviewer:[0-9a-f]{64}$/);
});

test("mergeFindingLedger tracks open, resolved, repeated, and reopened findings", () => {
  const f1 = { kind: "reviewer", sourceId: "r1", severity: "blocking", file: "a.js", line: 10, message: "Bug A" };
  const f2 = { kind: "reviewer", sourceId: "r1", severity: "blocking", file: "b.js", line: 20, message: "Bug B" };

  let ledger = mergeFindingLedger([], [f1, f2], 1);
  assert.equal(ledger.length, 2);
  assert.ok(ledger.every((entry) => entry.status === "open" && entry.occurrenceCount === 1));

  // Attempt 2: Bug B fixed, Bug A still present
  ledger = mergeFindingLedger(ledger, [f1], 2);
  const entryA = ledger.find((e) => e.message === "Bug A");
  const entryB = ledger.find((e) => e.message === "Bug B");
  assert.equal(entryA.status, "open");
  assert.equal(entryA.occurrenceCount, 2);
  assert.equal(entryB.status, "resolved");
  assert.equal(evaluateFixLoopHealth(ledger, { maxRepeatedBlocking: 3 }).stalled, false);

  // Attempt 3: Bug A repeats 3rd time AND Bug B regresses (reopened!)
  ledger = mergeFindingLedger(ledger, [f1, f2], 3);
  const health = evaluateFixLoopHealth(ledger, { maxRepeatedBlocking: 3, maxReopenedBlocking: 1 });
  assert.equal(health.passed, false);
  assert.equal(health.stalled, true);
  assert.deepEqual(health.reasons, ["repeated_blocking_finding", "oscillating_regression"]);
  assert.equal(health.repeatedBlocking.length, 1);
  assert.equal(health.oscillatingBlocking.length, 1);
});

test("findingsFromGates and findingsFromReviews normalize both structured and legacy shapes", () => {
  const gateFindings = findingsFromGates([
    { id: "lint", passed: true },
    { id: "test", passed: false, required: true, stderr: "2 tests failed" },
    { id: "audit", passed: true, treeModified: true, treeHashError: "modified lockfile" },
  ]);
  assert.equal(gateFindings.length, 2);
  assert.equal(gateFindings[0].kind, "gate");
  assert.equal(gateFindings[1].kind, "policy");
  assert.equal(gateFindings[1].severity, "blocking");

  const reviewFindings = findingsFromReviews([
    { reviewerId: "rev-a", blockingIssues: ["SQL injection"], warnings: ["Long function"] },
    { reviewerId: "rev-b", findings: [{ severity: "blocking", file: "x.js", line: 3, message: "Leak" }] },
  ]);
  assert.equal(reviewFindings.length, 3);
  assert.equal(reviewFindings.filter((f) => f.severity === "blocking").length, 2);
  assert.equal(reviewFindings.filter((f) => f.severity === "warning").length, 1);
});

test("evaluateScopeDivergence catches excessive path and diff-byte expansion", () => {
  assert.equal(evaluateScopeDivergence([{ changedPaths: ["a.js"], diffBytes: 500 }]).diverged, false);

  const modest = evaluateScopeDivergence([
    { changedPaths: ["a.js", "b.js"], diffBytes: 2_000 },
    { changedPaths: ["a.js", "b.js", "c.js"], diffBytes: 4_500 },
  ]);
  assert.equal(modest.diverged, false);

  const pathBlowup = evaluateScopeDivergence([
    { changedPaths: ["a.js", "b.js"], diffBytes: 2_000 },
    { changedPaths: ["1", "2", "3", "4", "5", "6", "7", "8"], diffBytes: 4_000 },
  ]);
  assert.equal(pathBlowup.diverged, true);
  assert.equal(pathBlowup.pathsDiverged, true);
  assert.equal(pathBlowup.bytesDiverged, false);

  const byteBlowup = evaluateScopeDivergence([
    { changedPaths: ["a.js", "b.js"], diffBytes: 2_000 },
    { changedPaths: ["a.js", "b.js"], diffBytes: 80_000 },
  ]);
  assert.equal(byteBlowup.diverged, true);
  assert.equal(byteBlowup.pathsDiverged, false);
  assert.equal(byteBlowup.bytesDiverged, true);
});

test("gitTreeHash and runReadOnlyGate detect mutations performed by a gate", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avg-tree-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    await writeFile(path.join(dir, "app.txt"), "hello\n", "utf8");

    const h1 = await gitTreeHash(dir);
    const h2 = await gitTreeHash(dir);
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);

    const cleanResult = await runReadOnlyGate(dir, async () => "ok", { id: "read-only-check" });
    assert.equal(cleanResult.passed, true);
    assert.equal(cleanResult.treeModified, false);

    const mutatingResult = await runReadOnlyGate(
      dir,
      async () => {
        await writeFile(path.join(dir, "sneaky.txt"), "mutated\n", "utf8");
      },
      { id: "sneaky-gate" },
    );
    assert.equal(mutatingResult.passed, false);
    assert.equal(mutatingResult.treeModified, true);
    assert.match(mutatingResult.treeHashError, /mutated the worktree/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectEvidenceManifest validates real PNG screenshots, digests, scenarios, and rejects escapes/spoofs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avg-ui-"));
  try {
    const png = makeMinimalPng(640, 480);
    const pngDigest = createHash("sha256").update(png).digest("hex");
    await mkdir(path.join(dir, "shots"), { recursive: true });
    await writeFile(path.join(dir, "shots/home.png"), png);
    await writeFile(path.join(dir, "shots/fake.png"), "not really a png", "utf8");

    assert.deepEqual(inspectImageHeader(png), { imageType: "png", width: 640, height: 480 });
    assert.equal(inspectImageHeader(Buffer.from("plain text")), null);

    // Valid manifest
    await writeFile(
      path.join(dir, "manifest.json"),
      JSON.stringify({
        screenshots: [{ path: "shots/home.png", description: "Home screen", sha256: pngDigest }],
        scenarios: [{ id: "login", title: "Login works", observed: "Dashboard rendered", passed: true, screenshotPath: "shots/home.png" }],
      }),
    );
    const ok = await inspectEvidenceManifest(dir, "manifest.json", { requireScenarios: true });
    assert.equal(ok.valid, true);
    assert.equal(ok.screenshots[0].width, 640);
    assert.equal(ok.scenarios.length, 1);

    // Spoofed PNG + path traversal + failed scenario
    await writeFile(
      path.join(dir, "bad.json"),
      JSON.stringify({
        screenshots: [
          { path: "shots/fake.png", description: "Fake" },
          { path: "../outside.png", description: "Traversal" },
        ],
        scenarios: [{ id: "s1", title: "Failed", observed: "Blank", passed: false, screenshotPath: "shots/home.png" }],
      }),
    );
    const bad = await inspectEvidenceManifest(dir, "bad.json", { requireScenarios: true });
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.length >= 3);

    // Symlink escape attempt (skipped on Windows environments without symlink privilege)
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "avg-outside-"));
    try {
      const outsidePng = path.join(outsideDir, "secret.png");
      await writeFile(outsidePng, png);
      let symlinkCreated = true;
      try {
        await symlink(outsidePng, path.join(dir, "shots/escaped.png"));
      } catch (err) {
        if (err?.code === "EPERM" || err?.code === "EACCES") {
          symlinkCreated = false;
        } else {
          throw err;
        }
      }
      if (symlinkCreated) {
        await writeFile(
          path.join(dir, "symlink.json"),
          JSON.stringify({ screenshots: [{ path: "shots/escaped.png", description: "Escaped" }] }),
        );
        const escaped = await inspectEvidenceManifest(dir, "symlink.json");
        assert.equal(escaped.valid, false);
        assert.ok(escaped.errors.some((e) => e.includes("symlink escapes")));
      }
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
