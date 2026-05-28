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
 *   dist/trust-check.sql       — SQL CHECK constraint fragment for use in D1
 *                                 migrations. Source-include this snippet to keep
 *                                 the trust column constraint in sync with schema.json
 *                                 without hardcoding values in migration files.
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

// ---------------------------------------------------------------------------
// Write packages/manifest-schema/src/index.ts (the publishable package source)
// ---------------------------------------------------------------------------

const toArray = (arr) => arr.map((v) => `  '${v}'`).join(',\n');

const pkgSrc = `/**
 * @bfrost/manifest-schema
 *
 * Canonical enum types for BFrost worker manifests.
 *
 * This is the single source of truth for TrustLevel, WorkerCategory, and
 * WorkerPermission. BFrost, BFrost-Website, and BFrost-Workers all depend
 * on this package. Adding or removing an enum value is a one-line change
 * here that propagates to all consumers via TypeScript and CI checks.
 *
 * AUTO-GENERATED by scripts/generate-enums.js in BFrost-Workers.
 * Source: schema.json → packages/manifest-schema/src/index.ts
 * Run \`npm run generate:enums\` in BFrost-Workers to regenerate.
 */

// ---------------------------------------------------------------------------
// Trust Levels
// ---------------------------------------------------------------------------

export type TrustLevel =
  | ${toUnion(trustLevels)};

export const TRUST_LEVELS: TrustLevel[] = [
${toArray(trustLevels)},
];

// ---------------------------------------------------------------------------
// Worker Categories
// ---------------------------------------------------------------------------

export type WorkerCategory =
  | ${toUnion(categories)};

export const WORKER_CATEGORIES: WorkerCategory[] = [
${toArray(categories)},
];

// ---------------------------------------------------------------------------
// Worker Permissions (store-level, high-level categories)
// ---------------------------------------------------------------------------

export type WorkerPermission =
  | ${toUnion(permissions)};

export const WORKER_PERMISSIONS: WorkerPermission[] = [
${toArray(permissions)},
];
`;

const pkgSrcDir = resolve(root, 'packages/manifest-schema/src');
mkdirSync(pkgSrcDir, { recursive: true });
writeFileSync(resolve(pkgSrcDir, 'index.ts'), pkgSrc);

// ---------------------------------------------------------------------------
// Write dist/trust-check.sql (D1 migration helper)
// ---------------------------------------------------------------------------

const inList = trustLevels.map((v) => `'${v}'`).join(', ');
const sqlContent =
`-- trust-check.sql
-- Generated from schema.json by scripts/generate-enums.js — do not edit manually.
--
-- Source-include this snippet in D1 migration files to keep the CHECK constraint
-- on the workers table in sync with the canonical trust enum in schema.json:
--
--   .read dist/trust-check.sql
--
-- Or copy the CHECK(...) expression below directly into your CREATE / ALTER TABLE.

-- Trust levels: ${trustLevels.join(', ')}
CHECK(trust IN (${inList}))
`;

writeFileSync(resolve(root, 'dist/trust-check.sql'), sqlContent);

console.log('✓ Generated dist/manifest-enums.json');
console.log('✓ Generated dist/manifest-enums.ts');
console.log('✓ Generated dist/trust-check.sql');
console.log('✓ Generated packages/manifest-schema/src/index.ts');
console.log(`  TrustLevels (${trustLevels.length}): ${trustLevels.join(', ')}`);
console.log(`  Categories  (${categories.length}): ${categories.join(', ')}`);
console.log(`  Permissions (${permissions.length}): ${permissions.join(', ')}`);
