import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 50 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;

function assertString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new TypeError(`${label} must be a non-empty string without NUL bytes`);
  }
  return value;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function assertSafeRelativePath(value, label) {
  assertString(value, label);
  if (path.isAbsolute(value)) throw new TypeError(`${label} must be relative`);
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new TypeError(`${label} must not escape its root`);
  }
  return normalized;
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.has(key));
}

/**
 * Pure-JS image header parser for PNG, JPEG, and WebP (zero OS dependencies).
 * Verifies magic bytes AND positive image dimensions.
 */
export function inspectImageHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // PNG: 8-byte signature + IHDR chunk (width @ 16..20, height @ 20..24)
  if (
    buffer.length >= 24
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && buffer.subarray(12, 16).toString("ascii") === "IHDR"
  ) {
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width > 0 && height > 0) return { imageType: "png", width, height };
    return null;
  }

  // JPEG: SOI (FF D8) + scan for SOF0/SOF1/SOF2 marker
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset + 4 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        offset += 2;
        continue;
      }
      const segmentLength = buffer.readUInt16BE(offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) break;
      const isSOF = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSOF && offset + 9 <= buffer.length) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        if (width > 0 && height > 0) return { imageType: "jpeg", width, height };
      }
      offset += 2 + segmentLength;
    }
    return null;
  }

  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
  if (
    buffer.length >= 30
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      if (width > 0 && height > 0) return { imageType: "webp", width, height };
    } else if (chunk === "VP8L" && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0) return { imageType: "webp", width, height };
    } else if (chunk === "VP8 " && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      const width = buffer.readUInt16LE(26) & 0x3fff;
      const height = buffer.readUInt16LE(28) & 0x3fff;
      if (width > 0 && height > 0) return { imageType: "webp", width, height };
    }
  }

  return null;
}

/**
 * Inspects a UI verification evidence manifest emitted by an AI agent or test runner.
 * Rejects path escapes, missing/spoofed screenshots, digest mismatches, and failed scenarios.
 */
export async function inspectEvidenceManifest(artifactDir, manifestRelativePath, {
  requireScenarios = false,
} = {}) {
  const root = await realpath(artifactDir);
  const relManifest = assertSafeRelativePath(manifestRelativePath, "manifestPath");
  const absManifest = path.resolve(root, relManifest);
  if (!isWithin(root, absManifest)) {
    return { valid: false, errors: ["manifestPath escapes artifact directory"], screenshots: [], scenarios: [] };
  }

  const errors = [];
  let manifest;
  try {
    const canonicalManifest = await realpath(absManifest);
    if (!isWithin(root, canonicalManifest)) {
      return { valid: false, errors: ["manifestPath symlink escapes artifact directory"], screenshots: [], scenarios: [] };
    }
    const stat = await lstat(canonicalManifest);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MANIFEST_BYTES) {
      return { valid: false, errors: ["manifest file has invalid size or type"], screenshots: [], scenarios: [] };
    }
    manifest = JSON.parse(await readFile(canonicalManifest, "utf8"));
  } catch (error) {
    return { valid: false, errors: [`Unable to read manifest: ${error.message}`], screenshots: [], scenarios: [] };
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["manifest must be a JSON object"], screenshots: [], scenarios: [] };
  }

  if (!Array.isArray(manifest.screenshots) || manifest.screenshots.length === 0) {
    errors.push("manifest.screenshots must be a non-empty array");
  }

  const inspectedScreenshots = [];
  const screenshotPaths = new Set();

  for (const [index, entry] of (manifest.screenshots ?? []).entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`screenshots[${index}] must be an object`);
      continue;
    }
    if (!hasOnlyKeys(entry, new Set(["path", "description", "sha256"]))) {
      errors.push(`screenshots[${index}] contains unsupported fields`);
    }
    let relShot;
    try {
      relShot = assertSafeRelativePath(entry.path, `screenshots[${index}].path`);
      assertString(entry.description, `screenshots[${index}].description`);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (entry.sha256 !== undefined && !SHA256_RE.test(entry.sha256)) {
      errors.push(`screenshots[${index}].sha256 must be a lowercase 64-char hex digest`);
    }
    const absShot = path.resolve(root, relShot);
    if (!isWithin(root, absShot)) {
      errors.push(`screenshots[${index}].path escapes artifact directory`);
      continue;
    }
    try {
      const canonicalShot = await realpath(absShot);
      if (!isWithin(root, canonicalShot)) {
        errors.push(`screenshots[${index}].path symlink escapes artifact directory`);
        continue;
      }
      const stat = await lstat(canonicalShot);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SCREENSHOT_BYTES) {
        errors.push(`screenshots[${index}].path has an invalid file size`);
        continue;
      }
      const raw = await readFile(canonicalShot);
      const header = inspectImageHeader(raw);
      if (!header) {
        errors.push(`screenshots[${index}].path is not a valid PNG, JPEG, or WebP image`);
        continue;
      }
      const digest = createHash("sha256").update(raw).digest("hex");
      if (entry.sha256 !== undefined && entry.sha256 !== digest) {
        errors.push(`screenshots[${index}].sha256 does not match file content`);
      }
      screenshotPaths.add(relShot);
      inspectedScreenshots.push({
        path: relShot,
        description: entry.description,
        sha256: digest,
        imageType: header.imageType,
        width: header.width,
        height: header.height,
        bytes: stat.size,
      });
    } catch (error) {
      errors.push(`screenshots[${index}] could not be read: ${error.message}`);
    }
  }

  const inspectedScenarios = [];
  if (requireScenarios && (!Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0)) {
    errors.push("manifest.scenarios must be a non-empty array when requireScenarios is true");
  }

  for (const [index, scenario] of (manifest.scenarios ?? []).entries()) {
    if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
      errors.push(`scenarios[${index}] must be an object`);
      continue;
    }
    try {
      assertString(scenario.id, `scenarios[${index}].id`);
      assertString(scenario.title, `scenarios[${index}].title`);
      assertString(scenario.observed, `scenarios[${index}].observed`);
      if (typeof scenario.passed !== "boolean") {
        throw new TypeError(`scenarios[${index}].passed must be a boolean`);
      }
      const shotPath = assertSafeRelativePath(scenario.screenshotPath, `scenarios[${index}].screenshotPath`);
      if (!screenshotPaths.has(shotPath)) {
        throw new TypeError(`scenarios[${index}].screenshotPath must reference an inspected screenshot`);
      }
      if (!scenario.passed) {
        errors.push(`scenarios[${index}] (${scenario.id}) did not pass`);
      }
      inspectedScenarios.push({
        id: scenario.id,
        title: scenario.title,
        observed: scenario.observed,
        passed: scenario.passed,
        screenshotPath: shotPath,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    screenshots: inspectedScreenshots,
    scenarios: inspectedScenarios,
  };
}
