'use client';
import { useMemo, useState } from 'react';
import { ChevronDown, RefreshCw, Search } from 'lucide-react';
import type { DashboardData } from '@/shared/types';
import { inventoryExpired, inventoryStatus, mergedInventory, type InventoryDevice } from '@/shared/inventory';

export function FleetInventoryPanel({ data, busy, onRefresh, onRegister }: { data: DashboardData; busy: boolean; onRefresh: () => void; onRegister: (device: InventoryDevice) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [showExpired, setShowExpired] = useState(false);
  const snapshots = data.inventory || [];
  const all = useMemo(() => mergedInventory(data.inventory || []), [data.inventory]);
  const keys = data.keys.filter(key => key.provider === 'duoplus');
  const registered = new Set(data.devices.map(device => device.duoplus_device_id));
  const eligible = all.filter(device => !inventoryExpired(device));
  const visible = (showExpired ? all : eligible).filter(device => `${device.name} ${device.id}`.toLowerCase().includes(search.toLowerCase()));
  const lastSync = snapshots.map(snapshot => snapshot.synced_at).filter(Boolean).sort().at(-1);
  const canManage = data.role === 'owner' || data.role === 'admin';
  const pending = keys.some(key => key.status !== 'invalid' && !snapshots.some(snapshot => snapshot.key_id === key.id));
  return <section className="inventory-panel panel" aria-label="DuoPlus device inventory">
    <div className="inventory-heading"><button className="inventory-toggle" onClick={() => setOpen(value => !value)} aria-expanded={open}><ChevronDown size={16} /><strong>DuoPlus devices</strong><span>{lastSync ? `${eligible.length} available · ${all.length - eligible.length} expired` : 'Waiting for first sync'}</span></button><button className="button small-button" disabled={busy || !canManage || !keys.length} onClick={onRefresh}><RefreshCw size={13} />Refresh fleet</button></div>
    <p className="inventory-note">{!keys.length ? 'Add a DuoPlus API key to discover your phones.' : pending ? 'Waiting for the first device inventory. If this persists, contact your workspace administrator.' : `Auto-refresh every 60 seconds${lastSync ? ` · last successful sync ${new Date(lastSync).toLocaleTimeString()}` : ''}.`} {all.length > 0 && `${eligible.filter(device => !registered.has(device.id)).length} available phones need a station location.`}</p>
    {snapshots.filter(snapshot => snapshot.status === 'error').map(snapshot => <p className="inventory-error" key={snapshot.key_id} role="status">{keys.find(key => key.id === snapshot.key_id)?.key_alias || 'DuoPlus'}: {snapshot.last_error || 'Inventory refresh failed.'} {snapshot.synced_at && 'Showing the last successful snapshot.'}</p>)}
    {keys.filter(key => key.status === 'invalid').map(key => <p className="inventory-error" key={key.id}>{key.key_alias}: provider rejected this credential. Replace it in API keys.</p>)}
    {open && <><div className="inventory-toolbar"><label className="search-field"><Search size={14} /><input aria-label="Search DuoPlus devices" placeholder="Search device name or ID…" value={search} onChange={event => setSearch(event.target.value)} /></label><label className="checkbox-label"><input type="checkbox" checked={showExpired} onChange={event => setShowExpired(event.target.checked)} />Show expired</label></div><div className="table-scroll inventory-list"><table><thead><tr><th>Device</th><th>Provider state</th><th>Station</th></tr></thead><tbody>{visible.map(device => <tr key={device.id}><td><strong>{device.name}</strong><span className="mono muted">{device.id}</span></td><td>{inventoryStatus(device.status)}</td><td>{registered.has(device.id) ? 'Registered' : <button className="button small-button" disabled={!canManage || inventoryExpired(device)} onClick={() => onRegister(device)}>Set station location</button>}</td></tr>)}{!visible.length && <tr><td colSpan={3}>{lastSync ? 'No devices match this view.' : 'Waiting for the first successful inventory sync.'}</td></tr>}</tbody></table></div><p className="inventory-note">Discovery reads your account inventory. Map pins require a saved station location.</p></>}
  </section>;
}
