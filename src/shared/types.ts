export type Provider = 'duoplus' | 'wigle';
export type DeviceStatus = 'STATIONARY' | 'NAVIGATING' | 'OFFLINE';
export type EnvironmentStatus = 'pending' | 'syncing' | 'synced' | 'partial' | 'no_results' | 'failed';
export interface Device {
  id: string; org_id: string; station_code: string; duoplus_device_id: string;
  status: DeviceStatus; mode: 'LIVE' | 'SIMULATION'; is_powered: boolean; ticks_enabled: boolean;
  lat: number; lng: number; anchor_lat: number; anchor_lng: number; s2_cell_id: string;
  altitude: number; accuracy_meters: number; speed: number; bearing: number;
  ssid: string | null; bssid: string | null; mcc_mnc: string | null; signal_dbm: number | null;
  environment_status: EnvironmentStatus; environment_version: number; environment_synced_at: string | null;
  environment_refresh_enabled: boolean; environment_radius_meters: number;
  route: [number, number][]; route_progress_meters: number; route_speed_mps: number;
  identity_locked_at?: string | null; identity_status?: 'unverified' | 'locked' | 'drift'; identity_changed_fields?: string[];
  control_version: number; last_error: string | null; last_tick_at: string | null;
  updated_at: string; created_at: string;
}
export interface ApiKeyMetadata {
  id: string; org_id: string; provider: Provider; key_alias: string;
  status: 'ready' | 'rate_limited' | 'invalid' | 'untested';
  last_used_at: string | null; rate_limit_reset_at: string | null; created_at: string;
}
export interface TelemetryTick {
  id?: string | number; event_id: string; device_id: string; org_id: string;
  lat: number; lng: number; accuracy_meters: number; provider: string;
  source: 'simulated' | 'command_accepted'; created_at: string;
}
export interface Organization {
  id: string; name: string; capacity: number; duoplus_interval_ms: number;
  telemetry_interval_ms: number; history_retention_days: number; created_at: string;
}
export interface JobRecord {
  id: string; org_id: string; device_id: string | null;
  kind: 'environment_sync' | 'device_sync' | 'rpa' | 'power_on' | 'power_off';
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed';
  payload: Record<string, unknown>; attempts: number; last_error: string | null;
  created_at: string; updated_at: string;
}
export interface RpaTemplate { template_type?: 1 | 2; id: string; org_id: string; name: string; duoplus_template_id: string; variables: Record<string, unknown>; created_at: string; }
export interface DashboardData {
  inventory?: import('./inventory').FleetInventory[];
  configured: boolean; demo: boolean; user_email: string | null;
  organization: Organization | null; role: 'owner' | 'admin' | 'member' | null;
  devices: Device[]; keys: ApiKeyMetadata[]; ticks: TelemetryTick[]; jobs: JobRecord[]; templates: RpaTemplate[];
}
