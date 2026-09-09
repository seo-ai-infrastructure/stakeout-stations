import { cookies } from 'next/headers';
import { ApiError, authenticated, databaseError, handleApi, json } from '@/lib/api';
import { hasPartialSupabaseConfiguration, isSupabaseConfigured } from '@/lib/supabase/config';
import { uuidSchema } from '@/lib/validation';
import type { DashboardData } from '@/shared/types';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return handleApi(async () => {
    const empty: DashboardData = { configured: false, demo: true, user_email: null, organization: null, role: null, devices: [], keys: [], ticks: [], jobs: [], templates: [] };
    if (hasPartialSupabaseConfiguration()) throw new ApiError(503, 'Supabase setup is incomplete. Configure both its URL and publishable key.');
    if (!isSupabaseConfigured()) return json(empty);
    const { supabase, user } = await authenticated();
    const selected = request.headers.get('x-organization-id') || (await cookies()).get('station_org')?.value;
    if (selected) uuidSchema.parse(selected);
    let membershipQuery = supabase.from('org_members').select('org_id,role').eq('user_id', user.id);
    if (selected) membershipQuery = membershipQuery.eq('org_id', selected);
    const membership = await membershipQuery.order('created_at', { ascending: true }).limit(1).maybeSingle();
    databaseError(membership.error);
    if (!membership.data) {
      if (selected) throw new ApiError(403, 'Your selected workspace is unavailable. Sign out and sign in to select an available workspace.');
      return json({ ...empty, configured: true, demo: false, user_email: user.email });
    }
    const orgId = membership.data.org_id;
    const [org, devices, keys, ticks, jobs, templates, inventory] = await Promise.all([
      supabase.from('organizations').select('*').eq('id', orgId).single(),
      supabase.from('devices').select('*').eq('org_id', orgId).order('station_code').limit(1000),
      supabase.from('api_keys').select('*').eq('org_id', orgId).order('created_at').limit(100),
      supabase.from('telemetry_ticks').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(400),
      supabase.from('jobs').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(100),
      supabase.from('rpa_templates').select('*').eq('org_id', orgId).order('name').limit(200),
      supabase.from('fleet_inventory').select('*').eq('org_id', orgId).limit(100),
    ]);
    for (const result of [org, devices, keys, ticks, jobs, templates, inventory]) databaseError(result.error);
    return json({ configured: true, demo: false, user_email: user.email, organization: org.data, role: membership.data.role, devices: devices.data, keys: keys.data, ticks: ticks.data, jobs: jobs.data, templates: templates.data, inventory: inventory.data });
  });
}
