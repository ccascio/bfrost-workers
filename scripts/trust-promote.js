/**
 * BFrost worker registry — trust auto-promotion.
 *
 * Promotes workers from trust:"Review" to trust:"Community" when the worker
 * has been in the registry for at least PROMOTE_AFTER_DAYS days without
 * security issues flagged.
 *
 * Run on a schedule by .github/workflows/trust-promote.yml (daily).
 * Can also be triggered manually via workflow_dispatch.
 *
 * Exit codes:
 *   0 — success (promotions made or nothing to promote)
 *   1 — error
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const workersDir = join(root, 'workers');

// A worker must be in Review state for this many days before it is promoted.
const PROMOTE_AFTER_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const now = Date.now();
const cutoff = now - PROMOTE_AFTER_DAYS * MS_PER_DAY;

const files = readdirSync(workersDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

let promotedCount = 0;
const promoted = [];

for (const file of files) {
  const filePath = join(workersDir, file);
  let worker;
  try {
    worker = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse ${file}: ${err.message}`);
    continue;
  }

  if (worker.trust !== 'Review') continue;

  const createdAt = new Date(worker.createdAt).getTime();
  if (isNaN(createdAt)) {
    console.warn(`  ⚠  ${file}: invalid createdAt "${worker.createdAt}" — skipping`);
    continue;
  }

  if (createdAt > cutoff) {
    const daysLeft = Math.ceil((createdAt - cutoff) / MS_PER_DAY);
    console.log(`  –  ${worker.id}: in Review for < ${PROMOTE_AFTER_DAYS} days (${daysLeft} day(s) remaining)`);
    continue;
  }

  // Promote
  worker.trust = 'Community';
  writeFileSync(filePath, JSON.stringify(worker, null, 2) + '\n', 'utf8');
  promoted.push(worker.id);
  promotedCount++;
  console.log(`  ✓  ${worker.id}: promoted Review → Community`);
}

if (promotedCount === 0) {
  console.log('No workers to promote.');
} else {
  console.log(`\n${promotedCount} worker(s) promoted: ${promoted.join(', ')}`);
}

process.exit(0);
