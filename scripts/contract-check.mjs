#!/usr/bin/env node
/**
 * G7 contract fixture gate.
 *
 * Usage: node scripts/contract-check.mjs [rootDir]
 * Defaults to the repository root derived from this script's location.
 *
 * Manifest format: <64 lowercase hex>  <path>, one per line.
 * Paths are resolved against the repository root first (matching the checked-in
 * manifest), with a contract-dir-relative fallback; the resolved path must stay
 * inside <root>/tests/contract.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, '..');
const root = resolve(process.argv[2] ?? defaultRoot);
const contractDir = join(root, 'tests', 'contract');
const manifestPath = join(contractDir, 'manifest.sha256');

function isInside(base, target) {
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function resolveManifestPath(relPath) {
  const candidates = [resolve(root, relPath), resolve(contractDir, relPath)];

  for (const candidate of candidates) {
    if (isInside(contractDir, candidate) && existsSync(candidate)) return candidate;
  }

  // Keep the first in-scope candidate so a missing file gets a precise error.
  for (const candidate of candidates) {
    if (isInside(contractDir, candidate)) return candidate;
  }

  return null;
}

function toPosixPath(value) {
  return value.split(sep).join('/');
}

function walkJsonFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

function fail(errors) {
  for (const message of errors) {
    console.error(`[contract:check] ${message}`);
  }
  console.error(`[contract:check] FAILED: ${errors.length} error(s)`);
  process.exitCode = 1;
}

function main() {
  const errors = [];

  if (!existsSync(contractDir) || !statSync(contractDir).isDirectory()) {
    fail([`missing contract directory: ${contractDir}`]);
    return;
  }

  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    fail([`missing manifest: ${manifestPath}`]);
    return;
  }

  const manifest = readFileSync(manifestPath, 'utf8');
  const lines = manifest.split(/\r?\n/);
  const listed = new Set();
  let verified = 0;

  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue;

    const lineNo = index + 1;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) {
      errors.push(
        `${manifestPath}:${lineNo}: invalid manifest line (expected "<64 lowercase hex>  <path>")`,
      );
      continue;
    }

    const [, expectedHash, relPath] = match;
    const resolvedPath = resolveManifestPath(relPath);
    if (!resolvedPath) {
      errors.push(`${manifestPath}:${lineNo}: path escapes tests/contract: ${relPath}`);
      continue;
    }

    const key = toPosixPath(relative(contractDir, resolvedPath));
    if (listed.has(key)) {
      errors.push(`duplicate manifest entry: ${key}`);
      continue;
    }
    listed.add(key);

    if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
      errors.push(`${manifestPath}:${lineNo}: missing file: ${relPath}`);
      continue;
    }

    const actualHash = createHash('sha256').update(readFileSync(resolvedPath)).digest('hex');
    if (actualHash !== expectedHash) {
      errors.push(`${manifestPath}:${lineNo}: sha256 mismatch: ${relPath}`);
      continue;
    }

    verified += 1;
  }

  const jsonFiles = walkJsonFiles(contractDir);
  for (const file of jsonFiles) {
    const key = toPosixPath(relative(contractDir, file));
    if (!listed.has(key)) {
      errors.push(`unlisted JSON fixture: ${key}`);
    }
  }

  if (errors.length > 0) {
    fail(errors);
    return;
  }

  console.log(
    `[contract:check] OK: ${verified} file(s) verified; ${jsonFiles.length} JSON fixture(s) listed.`,
  );
}

try {
  main();
} catch (err) {
  fail([err instanceof Error ? err.message : String(err)]);
}
