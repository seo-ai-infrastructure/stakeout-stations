'use client';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { makeDemoData } from '@/components/demo-data';
const StationMap = dynamic(() => import('@/components/station-map').then(m => m.StationMap), { ssr: false });

export default function MapPreview() {
  const sample = useMemo(() => makeDemoData(), []);
  const [id, select] = useState(sample.devices[0]?.id);
  return <main style={{ padding: 20 }}><p style={{ marginBottom: 16 }}>Map preview · sample stations only · <a href="/">Return to dashboard</a></p><div style={{ height: '80vh' }}><StationMap devices={sample.devices} selected={sample.devices.find(d => d.id === id)} ticks={sample.ticks} onSelect={select} demo /></div></main>;
}
