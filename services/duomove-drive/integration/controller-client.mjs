/** Server-only Node 22 adapter. Authorize the user and acquire your device lease first. */
import { setTimeout as delay } from 'node:timers/promises';

const terminal = new Set(['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED', 'INTERRUPTED']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isTerminal = run => terminal.has(run?.state);
export const safeToRelease = run => isTerminal(run) && run.detail?.cleanup_ok === true && run.detail?.session_id === run.id;

export class DriveError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'DriveError'; this.status = status; }
}

export class DriveClient {
  #origin; #token; #fetch; #timeout;
  constructor({ origin, token, fetchImpl = fetch, timeoutMs = 8000 }) {
    const url = new URL(origin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new DriveError('Use a configured service origin without credentials, path or query');
    if (typeof token !== 'string' || token.length < 32) throw new DriveError('Server token is required');
    this.#origin = url.origin; this.#token = token; this.#fetch = fetchImpl; this.#timeout = timeoutMs;
  }
  async #request(method, path, body) {
    let response;
    try {
      response = await this.#fetch(this.#origin + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.#timeout),
        headers: { authorization: `Bearer ${this.#token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new DriveError('Drive service unavailable; operation outcome may be uncertain'); }
    if (!response.ok) throw new DriveError(`Drive service returned HTTP ${response.status}`, response.status);
    try { return await response.json(); } catch { throw new DriveError('Invalid drive service response'); }
  }
  #id(runId) { if (!uuid.test(runId)) throw new DriveError('A durable run UUID is required'); return runId; }
  targets() { return this.#request('GET', '/v1/targets'); }
  plan(options) { return this.#request('POST', '/v1/plans', options); }
  start({ runId, target, plan }) {
    return this.#request('POST', '/v1/runs', { run_id: this.#id(runId), target, plan });
  }
  status(runId) { return this.#request('GET', `/v1/runs/${this.#id(runId)}`); }
  cancel(runId) { return this.#request('POST', `/v1/runs/${this.#id(runId)}/cancel`); }
  async wait(runId, { signal, onProgress = async () => {}, pollMs = 2000, timeoutMs = 14_460_000 } = {}) {
    const deadline = performance.now() + timeoutMs;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const run = await this.status(runId);
        await onProgress(run); // Renew the caller's distributed device lease here.
        if (isTerminal(run)) return run;
        if (performance.now() >= deadline) throw new DriveError('Drive wait timed out');
        await delay(pollMs, undefined, { signal });
      }
    } catch (error) {
      // A failed observer/lease renewal must request a stop. Never release the
      // caller's device lease here: cancellation acknowledgement is asynchronous.
      try { await this.cancel(runId); } catch { /* Caller must reconcile the device. */ }
      throw error;
    }
  }
}

// Retrying start is safe only with the SAME durable runId, target and plan.
// Inspect safeToRelease(result) before restoring telemetry or releasing a slot.
// A false result requires phone-status reconciliation; it is not proof of cleanup.
