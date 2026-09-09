import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(root, 'node_modules/maplibre-gl');
const { version } = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
const output = resolve(root, `public/maplibre/${version}`);
await mkdir(output, { recursive: true });
await copyFile(resolve(packageRoot, 'dist/maplibre-gl-worker.mjs'), resolve(output, 'maplibre-gl-worker.mjs'));
await copyFile(resolve(packageRoot, 'dist/maplibre-gl-shared.mjs'), resolve(output, 'maplibre-gl-shared.mjs'));
await copyFile(resolve(packageRoot, 'LICENSE.txt'), resolve(output, 'LICENSE.txt'));
console.log(`Prepared MapLibre ${version} worker`);
