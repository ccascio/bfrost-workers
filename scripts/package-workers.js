/**
 * Build installable BFrost worker bundles from packages/<worker-id>/.
 *
 * Each output archive contains one top-level directory named after the worker id.
 * BFrost compiles TypeScript sources on install/load, so package-local dist/
 * directories are intentionally excluded from release archives.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(root, 'packages');
const distDir = join(root, 'dist');

const requested = process.argv.slice(2);
const workerIds = requested.length > 0
  ? requested
  : readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const results = [];

for (const id of workerIds) {
  const workerDir = join(packagesDir, id);
  const manifestPath = join(workerDir, 'worker.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.id !== id) {
    throw new Error(`${manifestPath}: manifest id "${manifest.id}" does not match directory "${id}".`);
  }

  const tarOutput = join(distDir, `${id}.tar`);
  const output = `${tarOutput}.gz`;
  execFileSync('tar', [
    '--no-mac-metadata',
    '--exclude', `${id}/dist`,
    '--exclude', `${id}/node_modules`,
    '-cf', tarOutput,
    '-C', packagesDir,
    id,
  ], {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  execFileSync('gzip', ['-n', '-f', tarOutput], { stdio: 'inherit' });

  const bytes = readFileSync(output);
  results.push({
    id,
    version: manifest.version,
    path: `dist/${id}.tar.gz`,
    bundleSha256: createHash('sha256').update(bytes).digest('hex'),
    bundleSizeBytes: statSync(output).size,
  });
}

console.log(JSON.stringify(results, null, 2));
