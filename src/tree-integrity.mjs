import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_LIST_BYTES = 32 * 1024 * 1024;

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL bytes`);
  }
  if (path.isAbsolute(value)) throw new TypeError(`${label} must be relative`);
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new TypeError(`${label} must not escape its root`);
  }
  return normalized;
}

async function updateHashFromFile(hash, filePath) {
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
}

async function runGit(root, args, signal) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    cwd: root,
    maxBuffer: MAX_GIT_LIST_BYTES,
    encoding: "utf8",
    signal,
  });
  return stdout;
}

/**
 * Computes a deterministic SHA-256 fingerprint of a git worktree including
 * staged, unstaged, and untracked (non-ignored) files, modes, and symlink targets.
 * Ideal for asserting that read-only test gates or reviewers did not modify the repo.
 */
export async function gitTreeHash(worktree, { signal } = {}) {
  if (typeof worktree !== "string" || !path.isAbsolute(worktree)) {
    throw new TypeError("worktree must be an absolute directory path");
  }
  const root = await realpath(worktree);
  const meta = await lstat(root);
  if (!meta.isDirectory() || meta.isSymbolicLink()) {
    throw new TypeError("worktree must be a real directory");
  }

  const statusOut = await runGit(
    root,
    ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    signal,
  );
  const listingOut = await runGit(
    root,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    signal,
  );

  const files = listingOut.split("\0").filter(Boolean).sort();
  const hash = createHash("sha256");
  hash.update("agent-verification-gates-tree-v1\0");
  hash.update(statusOut);
  hash.update("\0");

  for (const relativePath of files) {
    const normalized = assertSafeRelativePath(relativePath, "git path");
    const absolutePath = path.resolve(root, normalized);
    if (!isWithin(root, absolutePath)) {
      throw new Error(`git path escapes worktree: ${relativePath}`);
    }
    hash.update(relativePath);
    hash.update("\0");
    try {
      const metadata = await lstat(absolutePath);
      hash.update(String(metadata.mode & 0o7777));
      hash.update("\0");
      if (metadata.isSymbolicLink()) {
        hash.update("symlink\0");
        hash.update(await readlink(absolutePath));
      } else if (metadata.isFile()) {
        hash.update("file\0");
        await updateHashFromFile(hash, absolutePath);
      } else if (metadata.isDirectory()) {
        hash.update("directory\0");
      } else {
        hash.update("special\0");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      hash.update("missing\0");
    }
    hash.update("\0");
  }

  return hash.digest("hex");
}

/**
 * Runs an async verification callback and confirms the git worktree remained
 * byte-for-byte identical before and after execution.
 */
export async function runReadOnlyGate(worktree, gateFn, { id = "gate", signal } = {}) {
  const beforeTreeHash = await gitTreeHash(worktree, { signal });
  let passed = false;
  let errorMessage = null;
  let value = null;

  try {
    value = await gateFn();
    passed = true;
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  const afterTreeHash = await gitTreeHash(worktree, { signal });
  const treeModified = beforeTreeHash !== afterTreeHash;

  return {
    id,
    passed: passed && !treeModified,
    treeModified,
    beforeTreeHash,
    afterTreeHash,
    treeHashError: treeModified
      ? `Read-only gate '${id}' mutated the worktree (${beforeTreeHash.slice(0, 12)} -> ${afterTreeHash.slice(0, 12)})`
      : null,
    error: errorMessage,
    value,
  };
}
