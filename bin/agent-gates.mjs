#!/usr/bin/env node
import {
  evaluateFixLoopHealth,
  evaluateScopeDivergence,
  findingsFromGates,
  findingsFromReviews,
  mergeFindingLedger,
} from "../src/index.mjs";

const cmd = process.argv[2] ?? "demo";

if (cmd === "demo") {
  console.log("=== agent-verification-gates · Offline Fix-Loop Demo ===\n");

  const attempts = [
    {
      index: 1,
      changedPaths: ["src/auth.js", "tests/auth.test.js"],
      diffBytes: 1_840,
      gates: [{ id: "unit-tests", passed: true }],
      reviews: [
        {
          reviewerId: "security-review",
          findings: [
            { severity: "blocking", file: "src/auth.js", line: 42, message: "Token comparison is not constant-time" },
            { severity: "blocking", file: "src/auth.js", line: 71, message: "Missing redirect origin validation" },
          ],
        },
      ],
    },
    {
      index: 2,
      changedPaths: ["src/auth.js", "src/session.js", "tests/auth.test.js"],
      diffBytes: 3_120,
      gates: [{ id: "unit-tests", passed: true }],
      reviews: [
        {
          reviewerId: "security-review",
          findings: [
            { severity: "blocking", file: "src/auth.js", line: 42, message: "Token comparison is not constant-time" },
          ],
        },
      ],
    },
    {
      index: 3,
      changedPaths: [
        "src/auth.js", "src/session.js", "src/router.js", "src/config.js",
        "src/http.js", "src/logger.js", "src/metrics.js", "src/db.js", "tests/auth.test.js",
      ],
      diffBytes: 78_900,
      gates: [{ id: "unit-tests", passed: true }],
      reviews: [
        {
          reviewerId: "security-review",
          findings: [
            { severity: "blocking", file: "src/auth.js", line: 42, message: "Token comparison is not constant-time" },
          ],
        },
      ],
    },
  ];

  let ledger = [];
  const seenAttempts = [];

  for (const attempt of attempts) {
    seenAttempts.push(attempt);
    const findings = [
      ...findingsFromGates(attempt.gates),
      ...findingsFromReviews(attempt.reviews),
    ];
    ledger = mergeFindingLedger(ledger, findings, attempt.index);
    const health = evaluateFixLoopHealth(ledger, { maxRepeatedBlocking: 3 });
    const scope = evaluateScopeDivergence(seenAttempts);

    console.log(`Attempt #${attempt.index}  files=${attempt.changedPaths.length}  diff=${attempt.diffBytes}B`);
    console.log(
      `  Ledger : open_blocking=${health.counts.openBlocking}  resolved=${health.counts.resolved}  stalled=${health.stalled}`,
    );
    console.log(
      `  Scope  : diverged=${scope.diverged} (paths=${scope.pathsDiverged}, bytes=${scope.bytesDiverged})`,
    );
    if (health.stalled || scope.diverged) {
      const reasons = [
        ...health.reasons,
        ...(scope.pathsDiverged ? ["scope_paths_exceeded"] : []),
        ...(scope.bytesDiverged ? ["scope_bytes_exceeded"] : []),
      ];
      console.log(`  Action : HALT REPAIR LOOP -> [${reasons.join(", ")}]`);
    } else {
      console.log("  Action : CONTINUE -> dispatch next targeted fix");
    }
    console.log("");
  }
} else {
  console.log("Usage: agent-gates demo");
  process.exitCode = 1;
}
