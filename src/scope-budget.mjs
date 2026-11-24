/**
 * Detects uncontrolled scope growth across repair attempts so a coding agent
 * fixing a focused bug cannot silently expand into a sweeping repo refactor.
 */
export function evaluateScopeDivergence(attempts, {
  maxPathMultiplier = 1.5,
  minPathOverhead = 5,
  maxByteMultiplier = 2.0,
  minByteOverhead = 65_536,
} = {}) {
  if (!Array.isArray(attempts) || attempts.length < 2) {
    return {
      diverged: false,
      pathsDiverged: false,
      bytesDiverged: false,
      metrics: null,
    };
  }

  const baseline = attempts[0];
  const current = attempts.at(-1);

  const baselinePaths = Array.isArray(baseline?.changedPaths) ? baseline.changedPaths.length : null;
  const currentPaths = Array.isArray(current?.changedPaths) ? current.changedPaths.length : null;
  const baselineBytes = Number.isSafeInteger(baseline?.diffBytes) ? baseline.diffBytes : null;
  const currentBytes = Number.isSafeInteger(current?.diffBytes) ? current.diffBytes : null;

  const pathsDiverged = baselinePaths !== null
    && currentPaths !== null
    && currentPaths > baselinePaths * maxPathMultiplier
    && currentPaths > baselinePaths + minPathOverhead;

  const bytesDiverged = baselineBytes !== null
    && currentBytes !== null
    && currentBytes > baselineBytes * maxByteMultiplier
    && currentBytes > baselineBytes + minByteOverhead;

  return {
    diverged: pathsDiverged || bytesDiverged,
    pathsDiverged,
    bytesDiverged,
    metrics: {
      baselinePaths,
      currentPaths,
      baselineBytes,
      currentBytes,
    },
  };
}
