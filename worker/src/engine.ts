import { Queue, Worker, DelayedError, UnrecoverableError, type Job } from 'bullmq';
import Redis from 'ioredis';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { JobRecord, Organization, Device } from '../../src/shared/types';
import { Providers } from './providers';
import { database, required, getOrg, getDevice } from './db';
import { EnvironmentSync } from './environment';
import { Fleet } from './fleet';
import { InventoryDiscovery } from './inventory';
import { HistorySpool } from './history';
import { Telemetry } from './telemetry';
import { RpaRunner } from './rpa';
import { withLease } from './rate-limit';
import { verifyIdentity } from './identity-check';
import { type EngineConfig, OperationError, ProviderError, RetryAtError, safeError } from './config';

interface WorkItem { org_id: string; outbox_id?: string; }
interface TenantQueue { queue: Queue<WorkItem>; worker: Worker<WorkItem>; tickQueue: Queue<WorkItem>; tickWorker: Worker<WorkItem>; }

export class Engine {
  readonly db: SupabaseClient;
  readonly redis: Redis;
  private providers: Providers;
  private environment: EnvironmentSync;
  private history: HistorySpool;
  private fleet: Fleet;
  private inventory: InventoryDiscovery;
  private telemetry: Telemetry;
  private rpa: RpaRunner;
  private tenants = new Map<string, TenantQueue>();
  private envQueue: Queue<WorkItem>;
  private envWorker: Worker<WorkItem>;
  private timers: ReturnType<typeof setInterval>[] = [];
  private subscriptions: ReturnType<SupabaseClient['channel']>[] = [];
  private stopping = false;
  private supervising = false;
  lastSupervisorAt: string | null = null;
  lastHistoryFlushAt: string | null = null;
  lastError: string | null = null;

  constructor(private config: EngineConfig) {
    this.db = database(config.supabaseUrl, config.supabaseKey);
    this.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    this.redis.on('error', () => { this.lastError = 'Redis unavailable'; });
    this.providers = new Providers(this.db, this.redis);
    this.environment = new EnvironmentSync(this.db, this.redis, this.providers);
    this.history = new HistorySpool(this.db, this.redis);
    this.fleet = new Fleet(this.db, this.redis, this.providers);
    this.inventory = new InventoryDiscovery(this.db, this.providers);
    this.telemetry = new Telemetry(this.db, this.redis, this.providers, this.fleet, this.history, config.batchSize);
    this.rpa = new RpaRunner(this.db, this.redis, this.providers, this.fleet);
    this.envQueue = new Queue<WorkItem>('environment-sync-queue', { connection: this.connection() });
    this.envWorker = this.makeWorker('environment-sync-queue', 4);
  }

  private connection() {
    // BullMQ and application Redis share URL, not an ioredis instance/version type.
    const url = new URL(this.config.redisUrl);
    return { host: url.hostname, port: Number(url.port || 6379), username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined, db: Number(url.pathname.slice(1) || 0),
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}), maxRetriesPerRequest: null };
  }

  private makeWorker(name: string, concurrency: number): Worker<WorkItem> {
    const worker = new Worker<WorkItem>(name, (job, token) => this.process(job, token), {
      connection: this.connection(), concurrency, lockDuration: 120_000,
      settings: { backoffStrategy: (attempts, _type, error) => error instanceof RetryAtError ? Math.max(1000, error.retryAt - Date.now()) : Math.min(300_000, 5000 * 2 ** Math.max(0, attempts - 1)) },
    });
    worker.on('error', () => { this.lastError = 'Queue worker unavailable'; });
    worker.on('failed', (job, error) => {
      if (!job?.data.outbox_id) return;
      if (job.attemptsMade < Number(job.opts.attempts ?? 1) && !(error instanceof UnrecoverableError)) return;
      void this.db.from('jobs').update({ status: 'failed', last_error: error instanceof UnrecoverableError ? error.message : safeError(error) }).eq('org_id', job.data.org_id).eq('id', job.data.outbox_id).then(() => undefined);
    });
    return worker;
  }

  private tenant(orgId: string): TenantQueue {
    let tenant = this.tenants.get(orgId);
    if (!tenant) {
      const name = `tenant_${orgId.replaceAll('-', '')}`;
      const tickName = `${name}_telemetry`;
      tenant = { queue: new Queue<WorkItem>(name, { connection: this.connection() }), worker: this.makeWorker(name, 1), tickQueue: new Queue<WorkItem>(tickName, { connection: this.connection() }), tickWorker: this.makeWorker(tickName, 1) };
      this.tenants.set(orgId, tenant);
    }
    return tenant;
  }

  async start(): Promise<void> {
    await this.redis.ping();
    await this.supervise();
    this.timers.push(setInterval(() => { void this.supervise().catch(() => { this.lastError = 'Supervisor refresh unavailable'; }); }, 1200));
    this.timers.push(setInterval(() => { void this.history.flush().then(() => { this.lastHistoryFlushAt = new Date().toISOString(); }).catch(() => { this.lastError = 'History backlog retained for retry'; }); }, 30_000));
    const changes = this.db.channel('engine-control-supervisor').on('postgres_changes', { event: '*', schema: 'public', table: 'devices' }, () => { void this.supervise().catch(() => undefined); }).on('postgres_changes', { event: '*', schema: 'public', table: 'api_keys' }, () => { void this.supervise().catch(() => undefined); }).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'jobs' }, () => { void this.supervise().catch(() => undefined); }).subscribe();
    this.subscriptions.push(changes);
  }

  private async supervise(): Promise<void> {
    if (this.stopping || this.supervising) return;
    this.supervising = true;
    try {
      const organizations = await required<Organization[]>(await this.db.from('organizations').select('*'));
      const ids = new Set(organizations.map((org) => org.id));
      for (const org of organizations) {
        const tenant = this.tenant(org.id);
        // Discovery shares the tenant queue and provider rate gate. It only
        // reads inventory; it never changes a station or activates controls.
        if (await this.redis.set(`inventory-schedule:${org.id}`, '1', 'EX', 60, 'NX') === 'OK') {
          await tenant.queue.add('inventory', { org_id: org.id }, { jobId: 'coalesced-inventory', removeOnComplete: true, removeOnFail: true, attempts: 1 });
        }
        // One coalesced batch per tenant: stalled workers cannot accumulate stale coordinates.
        if (await this.redis.set(`tick-schedule:${org.id}`, '1', 'PX', Math.max(1200, org.duoplus_interval_ms), 'NX') === 'OK') {
          await tenant.tickQueue.add('tick', { org_id: org.id }, { jobId: 'coalesced-tick', removeOnComplete: true, removeOnFail: true, attempts: 1 });
        }
        await this.dispatchOutbox(org.id);
        await this.monthlyMaintenance(org);
      }
      for (const [id, tenant] of this.tenants) if (!ids.has(id)) {
        await Promise.all([tenant.worker.close(), tenant.tickWorker.close()]); await Promise.all([tenant.queue.close(), tenant.tickQueue.close()]); this.tenants.delete(id);
      }
      this.lastSupervisorAt = new Date().toISOString();
      this.lastError = null;
    } finally { this.supervising = false; }
  }

  private async dispatchOutbox(orgId: string): Promise<void> {
    const jobs = await required<JobRecord[]>(await this.db.from('jobs').select('*').eq('org_id', orgId).in('status', ['pending', 'queued', 'running']).order('created_at', { ascending: true }).limit(100));
    for (const row of jobs) {
      const queue = row.kind === 'environment_sync' ? this.envQueue : this.tenant(orgId).queue;
      const existing = await queue.getJob(row.id);
      if (existing) continue;
      await withLease(this.redis, `outbox-dispatch:${row.id}`, async () => {
        const saved = await this.db.from('jobs').update({ status: 'queued', updated_at: new Date().toISOString() }).eq('org_id', orgId).eq('id', row.id).in('status', ['pending', 'queued', 'running']);
        if (saved.error) throw new Error('Outbox unavailable');
        await queue.add('operation', { org_id: orgId, outbox_id: row.id }, { jobId: row.id, attempts: 8, backoff: { type: 'provider' }, removeOnComplete: { age: 86400, count: 10000 }, removeOnFail: { age: 7 * 86400, count: 10000 } });
      });
    }
  }

  private async monthlyMaintenance(org: Organization): Promise<void> {
    if (await this.redis.set(`monthly-check:${org.id}`, '1', 'EX', 3600, 'NX') !== 'OK') return;
    const devices = await required<Device[]>(await this.db.from('devices').select('*').eq('org_id', org.id).eq('environment_refresh_enabled', true).lt('environment_synced_at', new Date(Date.now() - 30 * 86400_000).toISOString()));
    for (const device of devices) {
      const active = await this.db.from('jobs').select('id', { count: 'exact', head: true }).eq('org_id', org.id).eq('device_id', device.id).eq('kind', 'environment_sync').in('status', ['pending', 'queued', 'running']);
      if (active.error) throw new Error('Maintenance queue unavailable');
      if ((active.count ?? 0) > 0) continue;
      const saved = await this.db.from('jobs').insert({ org_id: org.id, device_id: device.id, kind: 'environment_sync', payload: { environment_version: device.environment_version, target_lat: device.anchor_lat, target_lng: device.anchor_lng, force_refresh: true } });
      if (saved.error) throw new Error('Maintenance queue unavailable');
    }
  }

  private async process(job: Job<WorkItem>, token?: string): Promise<void> {
    if (this.stopping) throw new RetryAtError(Date.now() + 5000);
    const org = await getOrg(this.db, job.data.org_id);
    if (!job.data.outbox_id) {
      if (job.name === 'inventory') await this.inventory.refresh(org);
      else await this.telemetry.run(org);
      return;
    }
    const row = await required<JobRecord>(await this.db.from('jobs').select('*').eq('org_id', org.id).eq('id', job.data.outbox_id).single());
    if (row.status === 'completed' || row.status === 'failed') return;
    const attempt = row.attempts + 1;
    const started = await this.db.from('jobs').update({ status: 'running', attempts: attempt, last_error: null, updated_at: new Date().toISOString() }).eq('org_id', org.id).eq('id', row.id);
    if (started.error) throw new Error('Outbox attempt unavailable');
    const attemptRow = await required<{ id: string }>(await this.db.from('job_attempts').insert({ org_id: org.id, job_id: row.id, attempt, status: 'running' }).select('id').single());
    try {
      let complete = true;
      if (row.kind === 'environment_sync') {
        if (!row.device_id) throw new OperationError('Environment sync requires a station');
        const device = await getDevice(this.db, org.id, row.device_id);
        const version = Number(row.payload.environment_version ?? device.environment_version);
        await this.environment.run(org.id, row.device_id, version, row.payload.force_refresh === true, row.id);
      } else if (row.kind === 'device_sync') {
        await this.inventory.refresh(org);
        const synced = await withLease(this.redis, `power-pool:${org.id}`, async () => {
          await this.fleet.sync(org, typeof row.payload.key_id === 'string' ? row.payload.key_id : undefined);
          return true;
        }, 180_000);
        if (!synced) throw new RetryAtError(Date.now() + 5000);
        const registered = await required<Device[]>(await this.db.from('devices').select('*').eq('org_id', org.id).eq('mode', 'LIVE'));
        for (const device of registered) {
          const { keyId } = await this.fleet.accessible(org, device);
          await verifyIdentity(this.db, this.providers, org, device, keyId);
        }
      } else {
        if (!row.device_id) throw new OperationError('This operation requires a station');
        const result = await withLease(this.redis, `device-lock:${org.id}:${row.device_id}`, async (valid) => {
          const device = await getDevice(this.db, org.id, row.device_id!);
          if (device.mode !== 'LIVE') throw new OperationError('Live device operations require a live station');
          if (!valid()) throw new RetryAtError(Date.now() + 5000);
          if (row.kind === 'rpa') return this.rpa.run(org, device, row);
          const rpaLock = await this.redis.get(`rpa-device:${org.id}:${device.id}`);
          if (row.kind === 'power_off' && rpaLock) throw new OperationError('An RPA task is running on this station');
          const powered = await withLease(this.redis, `power-pool:${org.id}`, async () => { await this.fleet.power(org, device, row.kind === 'power_on'); return true; }, 180_000);
          if (!powered) throw new RetryAtError(Date.now() + 5000);
          return true;
        }, 180_000);
        if (result === undefined) throw new RetryAtError(Date.now() + 5000);
        complete = result;
      }
      await this.db.from('job_attempts').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('org_id', org.id).eq('id', attemptRow.id);
      if (!complete) {
        await job.moveToDelayed(Date.now() + 30_000, token);
        throw new DelayedError();
      }
      const done = await this.db.from('jobs').update({ status: 'completed', last_error: null, updated_at: new Date().toISOString() }).eq('org_id', org.id).eq('id', row.id);
      if (done.error) throw new Error('Outbox completion unavailable');
      if (row.kind === 'rpa' && row.device_id) await this.releaseRpaLock(org.id, row.device_id, row.id);
    } catch (error) {
      if (error instanceof DelayedError) throw error;
      const message = safeError(error);
      await this.db.from('job_attempts').update({ status: 'failed', error: message, finished_at: new Date().toISOString() }).eq('org_id', org.id).eq('id', attemptRow.id);
      await this.db.from('jobs').update({ last_error: message, updated_at: new Date().toISOString() }).eq('org_id', org.id).eq('id', row.id);
      if (row.kind === 'environment_sync' && row.device_id) await this.db.from('devices').update({ environment_status: 'failed', last_error: message }).eq('org_id', org.id).eq('id', row.device_id).eq('environment_version', Number(row.payload.environment_version));
      if (error instanceof OperationError || error instanceof ProviderError && [400, 401, 403, 422].includes(error.status)) throw new UnrecoverableError(message);
      throw error;
    }
  }

  private async releaseRpaLock(orgId: string, deviceId: string, jobId: string): Promise<void> {
    await this.redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, `rpa-device:${orgId}:${deviceId}`, jobId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.timers.forEach(clearInterval);
    await Promise.all(this.subscriptions.map((channel) => this.db.removeChannel(channel)));
    await Promise.all([this.envWorker.close(), ...[...this.tenants.values()].flatMap((tenant) => [tenant.worker.close(), tenant.tickWorker.close()])]);
    await this.history.flush().catch(() => undefined);
    await Promise.all([this.envQueue.close(), ...[...this.tenants.values()].flatMap((tenant) => [tenant.queue.close(), tenant.tickQueue.close()])]);
    await this.redis.quit();
  }
}
