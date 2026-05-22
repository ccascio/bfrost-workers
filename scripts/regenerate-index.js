/**
 * BFrost worker registry — index regenerator.
 *
 * Reads all workers/<id>.json files, sorts them, and writes index.json.
 * Run automatically by CI on every push to main.
 *
 * Sort order: most recently updated first, then alphabetically by name.
 *
 * Exit codes:
 *   0 — success (index written or already up to date)
 *   1 — error
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const workersDir = join(root, 'workers');
const indexPath = join(root, 'index.json');

// Load all worker files
const files = readdirSync(workersDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const workers = files.map((f) => {
  try {
    return JSON.parse(readFileSync(join(workersDir, f), 'utf8'));
  } catch (err) {
    console.error(`Failed to parse ${f}: ${err.message}`);
    process.exit(1);
  }
});

// Sort: most recently updated first, then alphabetically by name
workers.sort((a, b) => {
  const dateDiff =
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  if (dateDiff !== 0) return dateDiff;
  return a.name.localeCompare(b.name);
});

// Write index.json (pretty-printed, trailing newline)
const output = JSON.stringify(workers, null, 2) + '\n';

// Check if anything actually changed
let existing = '';
try {
  existing = readFileSync(indexPath, 'utf8');
} catch {
  // index.json doesn't exist yet — that's fine
}

if (output === existing) {
  console.log('index.json is already up to date.');
  process.exit(0);
}

writeFileSync(indexPath, output, 'utf8');
console.log(`index.json regenerated — ${workers.length} worker(s).`);
process.exit(0);
