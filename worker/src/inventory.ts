import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApiKeyMetadata, Organization } from '../../src/shared/types';
import { inventoryMetadata, type FleetInventory } from '../../src/shared/inventory';
import { Providers, type ProviderDevice } from './providers';
import { required } from './db';
import { safeError } from './config';

export class InventoryDiscovery {
  constructor(private db: SupabaseClient, private providers: Providers) {}

  async refresh(org: Organization): Promise<void> {
    const keys = await required<ApiKeyMetadata[]>(await this.db.from('api_keys').select('*').eq('org_id', org.id).eq('provider', 'duoplus').neq('status', 'invalid'));
    for (const key of keys) await this.refreshKey(org, key.id);
  }

  async refreshKey(org: Organization, keyId: string): Promise<ProviderDevice[] | null> {
    const previous = await this.db.from('fleet_inventory').select('*').eq('org_id', org.id).eq('key_id', keyId).maybeSingle();
    if (previous.error) throw new Error('Inventory storage unavailable');
    const old = previous.data as FleetInventory | null;
    const base = { org_id: org.id, key_id: keyId, devices: old?.devices || [], synced_at: old?.synced_at || null, checked_at: new Date().toISOString() };
    const started = await this.db.from('fleet_inventory').upsert({ ...base, status: 'syncing', last_error: null });
    if (started.error) throw new Error('Inventory storage unavailable');
    try {
      const rows = await this.providers.inventory(org.id, org.duoplus_interval_ms, keyId);
      const saved = await this.db.from('fleet_inventory').upsert({ ...base, devices: inventoryMetadata(rows), synced_at: new Date().toISOString(), status: 'ready', last_error: null });
      if (saved.error) throw new Error('Inventory storage unavailable');
      return rows;
    } catch (error) {
      // Retain the last successful snapshot on transient failures. A subsequent
      // successful empty inventory clears devices instead of keeping ghosts.
      const failed = await this.db.from('fleet_inventory').update({ status: 'error', last_error: safeError(error) }).eq('org_id', org.id).eq('key_id', keyId);
      if (failed.error) throw new Error('Inventory storage unavailable');
      return null;
    }
  }
}
