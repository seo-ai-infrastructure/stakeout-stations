export interface InventoryDevice {
  id: string;
  name: string;
  status: number;
  expired_at: number | null;
}
export interface FleetInventory {
  org_id: string;
  key_id: string;
  devices: InventoryDevice[];
  synced_at: string | null;
  checked_at: string;
  status: 'syncing' | 'ready' | 'error';
  last_error: string | null;
}

// Persist an explicit allowlist, never the raw provider response (which can
// contain proxy credentials and device/subscriber identifiers).
export function inventoryMetadata(rows: unknown[]): InventoryDevice[] {
  const devices = new Map<string, InventoryDevice>();
  for (const value of rows) {
    if (!value || typeof value !== 'object') throw new Error('Invalid inventory response');
    const row = value as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id || row.id.length > 128) throw new Error('Invalid inventory device ID');
    const expiry = Number(row.expired_at);
    devices.set(row.id, {
      id: row.id,
      name: typeof row.name === 'string' ? row.name.slice(0, 160) : row.id,
      status: Number.isInteger(Number(row.status)) ? Number(row.status) : -1,
      expired_at: Number.isFinite(expiry) && expiry > 0 ? expiry : null,
    });
  }
  return [...devices.values()];
}

export function mergedInventory(snapshots: FleetInventory[]): InventoryDevice[] {
  const devices = new Map<string, InventoryDevice>();
  // Newer successful snapshots win when several keys see the same account.
  for (const snapshot of [...snapshots].sort((a, b) => (a.synced_at || '').localeCompare(b.synced_at || ''))) {
    for (const device of snapshot.devices) devices.set(device.id, device);
  }
  return [...devices.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function inventoryStatus(status: number): string {
  return ({ 1: 'On', 2: 'Off', 3: 'Expired', 4: 'Renewal required', 10: 'Starting', 11: 'Configuring', 12: 'Configuration failed' } as Record<number, string>)[status] || 'Unknown';
}

export function inventoryExpired(device: InventoryDevice, now = Date.now()): boolean {
  return [3, 4].includes(device.status) || device.expired_at !== null && device.expired_at * 1000 <= now;
}
