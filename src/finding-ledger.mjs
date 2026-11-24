import { createHash } from "node:crypto";

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

/**
 * Produces a deterministic content-addressed finding ID so identical findings
 * keep the same identity across repair attempts regardless of key ordering.
 */
export function deterministicFindingId(finding) {
  const identity = {
    kind: finding.kind,
    sourceId: finding.sourceId,
    severity: finding.severity,
    file: finding.file ?? null,
    line: finding.line ?? null,
    message: finding.message,
  };
  return `${finding.kind}:${createHash("sha256")
    .update(JSON.stringify(canonicalize(identity)))
    .digest("hex")}`;
}

/**
 * Normalizes failed verification gate runs (including read-only tree mutations)
 * into structured findings.
 */
export function findingsFromGates(results = []) {
  return results
    .filter((result) => result?.passed === false || result?.treeModified === true)
    .map((result) => ({
      kind: result.kind === "policy" || result.treeModified ? "policy" : "gate",
      sourceId: result.id,
      severity: result.required === false && !result.treeModified ? "warning" : "blocking",
      file: null,
      line: null,
      message: result.treeModified
        ? result.treeHashError || `Verification gate '${result.id}' modified the repository tree`
        : result.stderr || result.error || "failed",
    }));
}

/**
 * Normalizes structured or legacy reviewer outputs into unified findings.
 */
export function findingsFromReviews(reviews = []) {
  return reviews.flatMap((review) => {
    if (Array.isArray(review?.findings)) {
      return review.findings.map((finding) => ({
        kind: review.kind === "policy" ? "policy" : "reviewer",
        sourceId: review.reviewerId ?? review.providerId ?? "reviewer",
        severity: finding.severity === "warning" ? "warning" : "blocking",
        file: finding.file ?? null,
        line: finding.line ?? null,
        message: finding.message,
      }));
    }
    const sourceId = review?.reviewerId ?? review?.providerId ?? "reviewer";
    return [
      ...(review?.blockingIssues ?? []).map((message) => ({
        kind: review?.kind === "policy" ? "policy" : "reviewer",
        sourceId,
        severity: "blocking",
        file: null,
        line: null,
        message,
      })),
      ...(review?.warnings ?? []).map((message) => ({
        kind: "reviewer",
        sourceId,
        severity: "warning",
        file: null,
        line: null,
        message,
      })),
    ];
  });
}

/**
 * Merges newly observed findings into the historical attempt ledger.
 * - Findings still present stay `open`, increment `occurrenceCount`, and update `lastSeenAttempt`.
 * - Previously open findings that disappeared transition to `resolved`.
 * - Previously resolved findings that reappear transition back to `open` (`reopened: true`).
 */
export function mergeFindingLedger(previousLedger, currentFindings, attemptIndex) {
  if (!Number.isInteger(attemptIndex) || attemptIndex < 1) {
    throw new TypeError("attemptIndex must be a positive integer");
  }
  const previous = Array.isArray(previousLedger) ? previousLedger : [];
  const currentById = new Map();

  for (const raw of currentFindings ?? []) {
    const finding = {
      kind: raw.kind,
      sourceId: raw.sourceId,
      severity: raw.severity,
      file: raw.file ?? null,
      line: raw.line ?? null,
      message: raw.message,
    };
    const id = deterministicFindingId(finding);
    const entry = currentById.get(id) ?? { finding, count: 0 };
    entry.count += 1;
    currentById.set(id, entry);
  }

  const ledger = [];
  const previousById = new Map(previous.map((finding) => [finding.id, finding]));

  for (const [id, { finding, count }] of currentById) {
    const prior = previousById.get(id);
    const reopened = prior?.status === "resolved";
    ledger.push({
      id,
      ...finding,
      firstSeenAttempt: prior?.firstSeenAttempt ?? attemptIndex,
      lastSeenAttempt: attemptIndex,
      occurrenceCount: (prior?.occurrenceCount ?? 0) + count,
      reopenedCount: (prior?.reopenedCount ?? 0) + (reopened ? 1 : 0),
      status: "open",
    });
    previousById.delete(id);
  }

  for (const prior of previousById.values()) {
    ledger.push({
      ...prior,
      reopenedCount: prior.reopenedCount ?? 0,
      status: "resolved",
    });
  }

  return ledger.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Evaluates whether a repair loop has stalled or is oscillating on unresolved
 * blocking findings across attempts.
 */
export function evaluateFixLoopHealth(ledger, {
  maxRepeatedBlocking = 3,
  maxReopenedBlocking = 1,
} = {}) {
  const entries = Array.isArray(ledger) ? ledger : [];
  const openBlocking = entries.filter((item) => item.status === "open" && item.severity === "blocking");
  const openWarnings = entries.filter((item) => item.status === "open" && item.severity === "warning");
  const resolved = entries.filter((item) => item.status === "resolved");

  const repeatedBlocking = openBlocking.filter((item) => item.occurrenceCount >= maxRepeatedBlocking);
  const oscillatingBlocking = openBlocking.filter((item) => (item.reopenedCount ?? 0) >= maxReopenedBlocking);

  const reasons = [];
  if (repeatedBlocking.length > 0) reasons.push("repeated_blocking_finding");
  if (oscillatingBlocking.length > 0) reasons.push("oscillating_regression");

  return {
    passed: openBlocking.length === 0,
    stalled: reasons.length > 0,
    reasons,
    counts: {
      openBlocking: openBlocking.length,
      openWarnings: openWarnings.length,
      resolved: resolved.length,
    },
    repeatedBlocking,
    oscillatingBlocking,
  };
}
