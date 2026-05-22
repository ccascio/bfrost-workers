/**
 * BFrost worker registry — validation script.
 *
 * Checks every workers/<id>.json against schema.json plus extra business rules
 * that JSON Schema alone cannot express.
 *
 * Exit codes:
 *   0 — all valid
 *   1 — one or more errors (printed to stderr)
 */

import { readFileSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const workersDir = join(root, 'workers');
const schemaPath = join(root, 'schema.json');

// ---------------------------------------------------------------------------
// Load schema and initialise AJV
// ---------------------------------------------------------------------------

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

// ---------------------------------------------------------------------------
// Gather all worker files
// ---------------------------------------------------------------------------

const files = readdirSync(workersDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

if (files.length === 0) {
  console.error('❌  No worker files found in workers/');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate each file
// ---------------------------------------------------------------------------

let totalErrors = 0;
const seenIds = new Map(); // id → filename

const semverRe =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?(?:\+([\w.-]+))?$/;

const semverRangeRe = /^(>=?|<=?|~|\^|=)?\s*\d+\.\d+\.\d+/;

// Known permission values (must mirror types.ts)
const KNOWN_PERMISSIONS = new Set([
  'network:http',
  'network:https',
  'storage:worker-kv',
  'filesystem:scoped-read',
  'filesystem:scoped-write',
  'filesystem:workspace-read',
  'operator-notify',
  'local-process',
]);

// Heuristic patterns that look like secrets
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{20,}\b/,          // OpenAI-style keys
  /\bAIza[A-Za-z0-9_-]{35}\b/,         // Google API keys
  /\bghp_[A-Za-z0-9]{36,}\b/,          // GitHub PATs
  /\bxox[bpoa]-[A-Za-z0-9-]{10,}\b/,   // Slack tokens
  /\bAC[a-z0-9]{32}\b/,                 // Twilio SIDs
  /["']password["']\s*:\s*["'][^"']+/i, // literal "password": "..."
  /["']secret["']\s*:\s*["'][^"']+/i,   // literal "secret": "..."
  /["']token["']\s*:\s*["'][^"']+/i,    // literal "token": "..."
];

for (const file of files) {
  const filePath = join(workersDir, file);
  const errors = [];

  // --- Parse JSON ---
  let worker;
  try {
    worker = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    errors.push(`JSON parse error: ${err.message}`);
    reportErrors(file, errors);
    totalErrors += errors.length;
    continue;
  }

  // --- AJV schema validation ---
  if (!validate(worker)) {
    for (const e of validate.errors ?? []) {
      errors.push(`Schema: ${e.instancePath || '(root)'} ${e.message}`);
    }
  }

  // --- File name must match id ---
  const expectedFile = `${worker.id}.json`;
  if (file !== expectedFile) {
    errors.push(`File name "${file}" does not match worker id "${worker.id}" (expected "${expectedFile}")`);
  }

  // --- ID uniqueness ---
  if (worker.id) {
    if (seenIds.has(worker.id)) {
      errors.push(`Duplicate id "${worker.id}" — already declared in ${seenIds.get(worker.id)}`);
    } else {
      seenIds.set(worker.id, file);
    }
  }

  // --- latestVersion must match first non-yanked version ---
  if (worker.versions?.length > 0 && worker.latestVersion) {
    const firstLive = worker.versions.find((v) => !v.yanked);
    if (firstLive && firstLive.version !== worker.latestVersion) {
      errors.push(
        `latestVersion "${worker.latestVersion}" does not match first non-yanked version "${firstLive.version}". ` +
        `versions[] must be sorted newest-first.`,
      );
    }
  }

  // --- All versions must have valid semver ---
  for (const v of worker.versions ?? []) {
    if (v.version && !semverRe.test(v.version)) {
      errors.push(`Version "${v.version}" is not valid semver.`);
    }
    if (v.bfrostEngine && !semverRangeRe.test(v.bfrostEngine)) {
      errors.push(`bfrostEngine "${v.bfrostEngine}" does not look like a semver range.`);
    }
  }

  // --- Top-level latestVersion and bfrostEngine ---
  if (worker.latestVersion && !semverRe.test(worker.latestVersion)) {
    errors.push(`latestVersion "${worker.latestVersion}" is not valid semver.`);
  }
  if (worker.bfrostEngine && !semverRangeRe.test(worker.bfrostEngine)) {
    errors.push(`bfrostEngine "${worker.bfrostEngine}" does not look like a semver range.`);
  }

  // --- Permissions must be from the known enum ---
  for (const perm of worker.permissions ?? []) {
    if (!KNOWN_PERMISSIONS.has(perm)) {
      errors.push(`Unknown permission "${perm}". Allowed values: ${[...KNOWN_PERMISSIONS].join(', ')}`);
    }
  }

  // --- Secret scan (heuristic) ---
  const raw = readFileSync(filePath, 'utf8');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(raw)) {
      errors.push(`Possible secret detected matching pattern ${pattern}. Remove credentials from the manifest.`);
    }
  }

  // --- No path traversal in declared paths ---
  const rawStr = JSON.stringify(worker);
  if (rawStr.includes('../')) {
    errors.push('Manifest contains "../" path traversal sequence.');
  }

  // --- trust must not be Trusted for community submissions ---
  // (Trusted is reserved for BFrost core maintainers)
  if (worker.trust === 'Trusted' && worker.author !== '@bfrost-team') {
    errors.push(
      `trust "Trusted" is reserved for @bfrost-team workers. Use "Community" or "Review" for community submissions.`,
    );
  }

  reportErrors(file, errors);
  totalErrors += errors.length;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

if (totalErrors === 0) {
  console.log(`✅  ${files.length} worker file(s) validated successfully.`);
  process.exit(0);
} else {
  console.error(`\n❌  ${totalErrors} error(s) found across ${files.length} file(s). Fix all errors before opening a PR.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reportErrors(file, errors) {
  if (errors.length === 0) {
    console.log(`  ✓  ${file}`);
    return;
  }
  console.error(`\n  ✗  ${file}`);
  for (const e of errors) {
    console.error(`       • ${e}`);
  }
}
