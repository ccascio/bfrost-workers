/**
 * generate-enums.js
 *
 * Reads the canonical enum arrays from schema.json and writes two artifacts:
 *
 *   dist/manifest-enums.json   — machine-readable enum arrays; consumed by
 *                                 the check-manifest-enums scripts in BFrost and
 *                                 BFrost-Website, and by any tool that needs to
 *                                 enumerate valid enum values without running TypeScript.
 *
 *   dist/manifest-enums.ts     — TypeScript type unions derived from the arrays;
 *                                 a human-readable companion for documentation.
 *
 * Run via:  node scripts/generate-enums.js
 * Or:       npm run generate:enums
 *
 * This script is also invoked by `npm run regenerate` (via the pre-step added
 * to package.json) so the artifact stays in sync whenever index.json is rebuilt.
 *
 * The generated dist/manifest-enums.json is committed to the repository and
 * served via the GitHub raw CDN:
 *   https://raw.githubusercontent.com/ccascio/bfrost-workers/main/dist/manifest-enums.json
 *
 * Any repo that declares TrustLevel, WorkerCategory, or WorkerPermission should
 * validate against this file in CI (see scripts/check-manifest-enums.js).
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const schema = JSON.parse(readFileSync(resolve(root, 'schema.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Extract enum arrays from the JSON Schema
// ---------------------------------------------------------------------------

const trustLevels = schema?.properties?.trust?.enum;
const categories  = schema?.properties?.category?.enum;
const permissions = schema?.properties?.permissions?.items?.enum;

if (!Array.isArray(trustLevels) || trustLevels.length === 0) {
  console.error('ERROR: schema.json is missing properties.trust.enum');
  process.exit(1);
}
if (!Array.isArray(categories) || categories.length === 0) {
  console.error('ERROR: schema.json is missing properties.category.enum');
  process.exit(1);
}
if (!Array.isArray(permissions) || permissions.length === 0) {
  console.error('ERROR: schema.json is missing properties.permissions.items.enum');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Write dist/manifest-enums.json
// ---------------------------------------------------------------------------

const enumsJson = {
  _comment: 'Generated from schema.json by scripts/generate-enums.js — do not edit manually.',
  _schema: schema.$id ?? 'unknown',
  trustLevels,
  categories,
  permissions,
};

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(
  resolve(root, 'dist/manifest-enums.json'),
  JSON.stringify(enumsJson, null, 2) + '\n',
);

// ---------------------------------------------------------------------------
// Write dist/manifest-enums.ts (informational — not imported by any runtime)
// ---------------------------------------------------------------------------

const toUnion = (arr) => arr.map((v) => `'${v}'`).join('\n  | ');

const tsContent = `/**
 * Canonical enum types for BFrost worker manifests.
 *
 * AUTO-GENERATED — do not edit. Source: schema.json
 * Run \`npm run generate:enums\` in BFrost-Workers to regenerate.
 *
 * CDN URL (for CI validation scripts in other repos):
 *   https://raw.githubusercontent.com/ccascio/bfrost-workers/main/dist/manifest-enums.json
 */

export type TrustLevel =
  | ${toUnion(trustLevels)};

export type WorkerCategory =
  | ${toUnion(categories)};

export type WorkerPermission =
  | ${toUnion(permissions)};

export const TRUST_LEVELS: TrustLevel[] = ${JSON.stringify(trustLevels)};

export const WORKER_CATEGORIES: WorkerCategory[] = ${JSON.stringify(categories)};

export const WORKER_PERMISSIONS: WorkerPermission[] = ${JSON.stringify(permissions)};
`;

writeFileSync(resolve(root, 'dist/manifest-enums.ts'), tsContent);

console.log('✓ Generated dist/manifest-enums.json');
console.log('✓ Generated dist/manifest-enums.ts');
console.log(`  TrustLevels (${trustLevels.length}): ${trustLevels.join(', ')}`);
console.log(`  Categories  (${categories.length}): ${categories.join(', ')}`);
console.log(`  Permissions (${permissions.length}): ${permissions.join(', ')}`);
