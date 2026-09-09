'use client';
import { useState, type FormEvent } from 'react';
import { ShieldCheck, Info } from 'lucide-react';
import type { DashboardData, Device, Provider } from '@/shared/types';
import type { useDashboard } from './use-dashboard';
import type { InventoryDevice } from '@/shared/inventory';
import { makeDemoData } from './demo-data';
import { Modal, SubmitButton } from './ui';

type Mutation = ReturnType<typeof useDashboard>['mutate'];
export type Dialog = 'register' | 'key' | 'template' | 'relocate' | 'navigate' | 'organization' | null;
export function ActionDialog({ dialog, onClose, mutate, busy, data, device, inventoryDevice }: { dialog: Exclude<Dialog, null>; onClose: () => void; mutate: Mutation; busy: boolean; data: DashboardData; device?: Device; inventoryDevice?: InventoryDevice }) {
  const [provider, setProvider] = useState<Provider>('duoplus');
  const [error, setError] = useState('');
  const relocating = dialog === 'relocate';
  const title = { register: 'Register station', key: 'Add API key', template: 'Add RPA template', relocate: 'Relocate station', navigate: 'Set navigation route', organization: 'Create your workspace' }[dialog];
  const descriptions = {
    register: 'Assign a device and anchor location. Environment provisioning runs once after registration.',
    key: 'Your credentials stay encrypted and are only used by your workspace.',
    template: 'Connect a DuoPlus RPA template and its default variables.',
    relocate: 'Set a new anchor location. This schedules a fresh environment lookup.',
    navigate: 'Define a route as longitude, latitude pairs, one point per line.',
    organization: 'Keep your devices, credentials, and team in one isolated workspace.',
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError('');
    const fields = new FormData(event.currentTarget);
    const text = (name: string) => String(fields.get(name) || '').trim();
    let okay = false;
    try {
      if (dialog === 'register') {
        const body = { station_code: text('station_code'), duoplus_device_id: text('duoplus_device_id'), lat: Number(text('lat')), lng: Number(text('lng')), mode: text('mode') };
        okay = await mutate('/api/devices', 'POST', body, 'Station registered', current => {
          const base = makeDemoData().devices[0];
          const added: Device = { ...base, ...body, mode: 'SIMULATION', id: `demo-${Date.now()}`, status: 'OFFLINE', is_powered: false, ticks_enabled: false, anchor_lat: body.lat, anchor_lng: body.lng, last_tick_at: null };
          return { ...current, devices: [...current.devices, added] };
        });
      }
      if (dialog === 'key') {
        if (provider === 'wigle' && !fields.has('commercial')) throw new Error('Confirm your WiGLE authorization before adding credentials.');
        const secret = provider === 'wigle' ? JSON.stringify({ apiName: text('api_name'), apiToken: text('secret'), commercialUseAuthorized: true }) : text('secret');
        const key_alias = text('key_alias');
        okay = await mutate('/api/keys', 'POST', { provider, key_alias, secret }, 'Credential added', current => ({ ...current, keys: [...current.keys, { id: `demo-key-${Date.now()}`, org_id: 'demo', provider, key_alias, status: 'untested', last_used_at: null, rate_limit_reset_at: null, created_at: new Date().toISOString() }] }));
      }
      if (dialog === 'template') {
        const variables = JSON.parse(text('variables') || '{}');
        if (typeof variables !== 'object' || Array.isArray(variables) || variables === null) throw new Error('Variables must be a JSON object.');
        const body = { name: text('name'), duoplus_template_id: text('duoplus_template_id'), template_type: Number(text('template_type')) as 1 | 2, variables };
        okay = await mutate('/api/templates', 'POST', body, 'Template added', current => ({ ...current, templates: [...current.templates, { ...body, id: `demo-template-${Date.now()}`, org_id: 'demo', created_at: new Date().toISOString() }] }));
      }
      if (dialog === 'organization') okay = await mutate('/api/organizations', 'POST', { name: text('name') }, 'Workspace created');
      if (relocating && device) {
        const lat = Number(text('lat')), lng = Number(text('lng'));
        okay = await mutate(`/api/devices/${device.id}`, 'PATCH', { action: 'relocate', lat, lng }, 'Station relocated', current => ({ ...current, devices: current.devices.map(d => d.id === device.id ? { ...d, lat, lng, anchor_lat: lat, anchor_lng: lng, route: [], route_progress_meters: 0, status: d.is_powered ? 'STATIONARY' : 'OFFLINE', speed: 0, environment_status: 'pending', environment_version: d.environment_version + 1, ssid: null, bssid: null, mcc_mnc: null } : d) }));
      }
      if (dialog === 'navigate' && device) {
        const route = text('route').split('\n').filter(Boolean).map(line => line.split(',').map(Number)) as [number, number][];
        if (route.length < 2 || route.some(p => p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) throw new Error('Add at least two valid longitude, latitude pairs.');
        const route_speed_mps = Number(text('route_speed_mps'));
        okay = await mutate(`/api/devices/${device.id}`, 'PATCH', { action: 'navigate', route, route_speed_mps }, 'Navigation route saved', current => ({ ...current, devices: current.devices.map(d => d.id === device.id ? { ...d, route, route_speed_mps, route_progress_meters: 0, speed: route_speed_mps, status: 'NAVIGATING' } : d) }));
      }
      if (okay) onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the form and try again.'); }
  };
  return <Modal title={title} description={descriptions[dialog]} onClose={onClose}>
    <form className="dialog-form" onSubmit={submit}>
      {data.demo && <div className="form-note"><Info size={15} />Preview only. Changes stay in this browser session.</div>}
      {(dialog === 'register' || relocating) && <>
        {dialog === 'register' && <><label>Station code<input name="station_code" defaultValue={inventoryDevice ? `STATION-${inventoryDevice.id.slice(0, 12)}` : undefined} placeholder="LAKELAND-S2-G" maxLength={64} pattern="[a-zA-Z0-9 _.\-]+" required autoComplete="off" /></label><label>DuoPlus device ID<input name="duoplus_device_id" defaultValue={inventoryDevice?.id} readOnly={!!inventoryDevice} placeholder={data.demo ? 'preview-device-7' : 'Your DuoPlus device ID'} maxLength={128} required autoComplete="off" /></label></>}
        <div className="form-grid"><label>Latitude<input name="lat" type="number" step="any" min="-90" max="90" defaultValue={inventoryDevice ? undefined : device?.anchor_lat ?? 28.0395} required /></label><label>Longitude<input name="lng" type="number" step="any" min="-180" max="180" defaultValue={inventoryDevice ? undefined : device?.anchor_lng ?? -81.9498} required /></label></div>
        {dialog === 'register' && <label>Execution mode<select name="mode" defaultValue={inventoryDevice ? "LIVE" : "SIMULATION"}><option value="SIMULATION">Simulation</option><option value="LIVE" disabled={data.demo}>Live device</option></select></label>}
        <div className="form-note"><ShieldCheck size={16} />WiGLE runs during provisioning, outside the telemetry loop.</div>
      </>}
      {dialog === 'key' && <>
        <label>Provider<select value={provider} onChange={e => setProvider(e.target.value as Provider)}><option value="duoplus">DuoPlus</option><option value="wigle">WiGLE</option></select></label>
        <label>Key alias<input name="key_alias" placeholder="Production account" required maxLength={80} autoComplete="off" /></label>
        {provider === 'wigle' && <label>API name<input name="api_name" required autoComplete="off" /></label>}
        <label>{provider === 'wigle' ? 'API token' : 'API key'}<input name="secret" type="password" placeholder={data.demo ? 'Use a sample value in demo' : 'Paste your private credential'} required autoComplete="new-password" /></label>
        {provider === 'wigle' && <div className="license-confirmation"><label className="checkbox-label"><input type="checkbox" name="commercial" required />I have WiGLE authorization for commercial use.</label><p>WiGLE credentials alone do not grant commercial-use rights. <a href="https://wigle.net/eula.html" target="_blank" rel="noreferrer">Review WiGLE terms</a></p></div>}
        <p className="muted small">{data.demo ? 'Demo discards credential values; only the alias appears in your preview.' : 'Credential values are encrypted and never returned to your browser after saving.'}</p>
      </>}
      {dialog === 'template' && <><label>Template name<input name="name" placeholder="Chrome SERP observation" required maxLength={120} /></label><label>Template source<select name="template_type" defaultValue="2"><option value="2">Custom template</option><option value="1">Official template</option></select></label><label>DuoPlus template ID<input name="duoplus_template_id" placeholder="Your template ID" required /></label><label>Default variables · JSON<textarea name="variables" defaultValue={'{\n  "keyword": "plumber near me"\n}'} rows={5} spellCheck={false} /></label></>}
      {dialog === 'organization' && <label>Workspace name<input name="name" placeholder="Stakeout Search" required maxLength={120} /></label>}
      {dialog === 'navigate' && <><label>Route points · longitude, latitude<textarea name="route" rows={6} defaultValue={`${device?.lng ?? -81.9498}, ${device?.lat ?? 28.0395}\n${((device?.lng ?? -81.9498) + .002).toFixed(6)}, ${((device?.lat ?? 28.0395) + .001).toFixed(6)}`} spellCheck={false} required /></label><label>Travel speed · meters / second<input name="route_speed_mps" type="number" step="0.1" min="0.1" max="40" defaultValue={1.4} required /></label></>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <div className="modal-footer"><button type="button" className="button" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{dialog === 'key' ? 'Save credential' : dialog === 'template' ? 'Save template' : dialog === 'navigate' ? 'Save route' : title}</SubmitButton></div>
    </form>
  </Modal>;
}
