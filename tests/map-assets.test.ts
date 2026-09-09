import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

test('published MapLibre worker and every relative module match the installed version', async () => {
  execFileSync(process.execPath, ['scripts/prepare-map-worker.mjs']);
  const { version } = JSON.parse(await readFile('node_modules/maplibre-gl/package.json', 'utf8'));
  const output = `public/maplibre/${version}`;
  const worker = await readFile(`${output}/maplibre-gl-worker.mjs`, 'utf8');
  assert.equal(worker, await readFile('node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', 'utf8'));
  const modules = [...worker.matchAll(/from\s*["']\.\/([^"']+)["']/g)].map(match => match[1]);
  assert.ok(modules.length > 0, 'worker imports its shared module');
  for (const name of modules) {
    assert.equal(await readFile(`${output}/${name}`, 'utf8'), await readFile(`node_modules/maplibre-gl/dist/${name}`, 'utf8'));
  }
  assert.ok((await readFile(`${output}/LICENSE.txt`, 'utf8')).length > 100);
});
