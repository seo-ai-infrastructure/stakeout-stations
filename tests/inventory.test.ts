import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inventoryMetadata, inventoryExpired, mergedInventory, type FleetInventory } from '../src/shared/inventory';
import { InventoryDiscovery } from '../worker/src/inventory';

test('inventory metadata excludes credentials and hardware identity fields', () => {
  assert.deepEqual(inventoryMetadata([{ id: 'phone-a', name: 'Phone A', status: '1', expired_at: '2000000000', proxy: { password: 'secret' }, imei: 'private', gps: { latitude: 99 } }]), [{ id: 'phone-a', name: 'Phone A', status: 1, expired_at: 2000000000 }]);
  assert.throws(() => inventoryMetadata([{ name: 'missing id' }]), /device ID/);
});

test('inventory deduplicates shared accounts, clears empty snapshots and excludes expired phones', () => {
  const snapshot = (time: string, status: number): FleetInventory => ({ org_id: 'org-a', key_id: time, devices: [{ id: 'phone-a', name: 'A', status, expired_at: null }], synced_at: time, checked_at: time, status: 'ready', last_error: null });
  assert.equal(mergedInventory([snapshot('2026-09-09T01:00:00Z', 2), snapshot('2026-09-09T02:00:00Z', 1)])[0]?.status, 1);
  assert.equal(mergedInventory([{ ...snapshot('2026-09-09T01:00:00Z', 1), devices: [] }]).length, 0);
  assert.equal(inventoryExpired({ id: 'a', name: 'A', status: 3, expired_at: null }), true);
  assert.equal(inventoryExpired({ id: 'a', name: 'A', status: 2, expired_at: 1 }), true);
  assert.equal(inventoryExpired({ id: 'a', name: 'A', status: 2, expired_at: null }), false);
});

test('discovery keeps prior data on errors and never writes device controls', async () => {
  let stored: Record<string, unknown> | null = null;
  let shouldFail = false;
  let rows: unknown[] = [{ id: 'phone-a', status: 2, name: 'A', secret: 'never save' }];
  const db = { from(table: string) {
    assert.equal(table, 'fleet_inventory');
    const query = {
      select() { return query; },
      eq(column: string, value: string) { assert.equal(value, column === 'org_id' ? 'org-a' : 'key-a'); return query; },
      maybeSingle: async () => ({ data: stored, error: null }),
      upsert: async (value: Record<string, unknown>) => { stored = { ...value }; return { error: null }; },
      update(value: Record<string, unknown>) { stored = { ...stored, ...value }; return query; },
      then(resolve: (value: unknown) => void) { resolve({ error: null }); },
    };
    return query;
  } };
  const provider = { inventory: async (org: string, interval: number, key: string) => {
    assert.equal(org, 'org-a'); assert.equal(key, 'key-a'); assert.equal(interval, 1200);
    if (shouldFail) throw new Error('Provider failure with secret payload');
    return rows;
  } };
  const discovery = new InventoryDiscovery(db as never, provider as never);
  const org = { id: 'org-a', duoplus_interval_ms: 1200 } as never;
  await discovery.refreshKey(org, 'key-a');
  assert.equal((stored as unknown as FleetInventory).devices.length, 1);
  assert.equal(JSON.stringify(stored).includes('never save'), false);
  shouldFail = true;
  await discovery.refreshKey(org, 'key-a');
  assert.equal((stored as unknown as FleetInventory).devices.length, 1);
  assert.equal((stored as unknown as FleetInventory).status, 'error');
  assert.equal(JSON.stringify(stored).includes('secret payload'), false);
  shouldFail = false; rows = [];
  await discovery.refreshKey(org, 'key-a');
  assert.deepEqual((stored as unknown as FleetInventory).devices, []);
  assert.equal((stored as unknown as FleetInventory).status, 'ready');
});
