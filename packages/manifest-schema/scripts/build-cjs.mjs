import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const esmPath = resolve(root, 'dist/index.js');
const cjsPath = resolve(root, 'dist/index.cjs');

const esm = readFileSync(esmPath, 'utf8');
const exportedNames = [...esm.matchAll(/^export const ([A-Z_]+)\s*=/gm)].map((match) => match[1]);

if (exportedNames.length === 0) {
  throw new Error('No exported constants found in dist/index.js; refusing to write empty CJS bundle.');
}

let cjs = esm.replace(/^export const ([A-Z_]+)\s*=/gm, 'const $1 =');
cjs += '\n';
for (const name of exportedNames) {
  cjs += `exports.${name} = ${name};\n`;
}

mkdirSync(dirname(cjsPath), { recursive: true });
writeFileSync(cjsPath, `'use strict';\n${cjs}`);

