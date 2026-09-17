import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriveClient, DriveError, safeToRelease } from './controller-client.mjs';

const id = '5a4d8cbd-e72a-4cc8-8dd3-f553088b63f0';
const make = fetchImpl => new DriveClient({ origin: 'http://drive.railway.internal:8000', token: 't'.repeat(40), fetchImpl });
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('start retries retain caller-owned UUID and configured alias', async () => {
  const bodies = [];
  const client = make(async (url, options) => { bodies.push(JSON.parse(options.body)); return response({ id, state: 'QUEUED' }); });
  const request = { runId: id, target: 'phone-one', plan: { version: 1 } };
  await client.start(request); await client.start(request);
  assert.deepEqual(bodies[0], bodies[1]); assert.equal(bodies[0].run_id, id);
  assert.throws(() => client.status('../private'), DriveError);
});

test('failed scheduler lease renewal requests cancellation without releasing ownership', async () => {
  const calls = [];
  const client = make(async (url, options) => { calls.push(options.method + ' ' + new URL(url).pathname); return response({ id, state: 'RUNNING' }); });
  await assert.rejects(client.wait(id, { onProgress: async () => { throw new Error('lease lost'); } }), /lease lost/);
  assert.equal(calls.at(-1), `POST /v1/runs/${id}/cancel`);
});

test('aborted wait requests cancellation even when its signal is already aborted', async () => {
  const calls = [];
  const client = make(async url => { calls.push(url); return response({ id, state: 'RUNNING' }); });
  await assert.rejects(client.wait(id, { signal: AbortSignal.abort() }));
  assert.equal(calls.length, 1); assert.ok(calls[0].endsWith('/cancel'));
});

test('terminal state alone never claims provider cleanup', async () => {
  assert.equal(safeToRelease({ id, state: 'CANCELLED', detail: {} }), false);
  assert.equal(safeToRelease({ id, state: 'FAILED', detail: { cleanup_ok: false, session_id: id } }), false);
  assert.equal(safeToRelease({ id, state: 'COMPLETED', detail: { cleanup_ok: true, session_id: 'other' } }), false);
  assert.equal(safeToRelease({ id, state: 'COMPLETED', detail: { cleanup_ok: true, session_id: id } }), true);
  assert.equal((await make(async () => response({ id, state: 'COMPLETED' })).wait(id)).state, 'COMPLETED');
});

test('redirects are forbidden and error output does not echo credentials', async () => {
  const client = make(async (_, options) => { assert.equal(options.redirect, 'error'); throw new Error(options.headers.authorization); });
  await assert.rejects(client.targets(), error => !error.message.includes('t'.repeat(40)));
});
