'use client';
import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { Expand, Layers, LocateFixed, MapPin, Minus, Plus } from 'lucide-react';
import type { Device, TelemetryTick } from '@/shared/types';

function circle(lng: number, lat: number, meters: number) {
  return Array.from({ length: 49 }, (_, i) => {
    const angle = i * 2 * Math.PI / 48;
    return [lng + meters * Math.cos(angle) / (111320 * Math.cos(lat * Math.PI / 180)), lat + meters * Math.sin(angle) / 111320];
  });
}
export function StationMap({ devices, selected, ticks, onSelect, demo }: { devices: Device[]; selected?: Device; ticks: TelemetryTick[]; onSelect: (id: string) => void; demo: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<Map<string, maplibregl.Marker>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [failureReason, setFailureReason] = useState('The basemap could not load. Station coordinates remain available in the inspector.');
  const [showTrails, setShowTrails] = useState(true);
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;
  useEffect(() => {
    if (!container.current) return;
    try {
      // MapLibre 6 no longer bundles its worker into the main script. Serve the
      // exact installed version from our origin instead of a missing chunk URL.
      maplibregl.setWorkerUrl(`/maplibre/${maplibregl.getVersion()}/maplibre-gl-worker.mjs`);
      const instance = new maplibregl.Map({
        container: container.current, style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
        center: [-81.9498, 28.0395], zoom: 13.1, attributionControl: false, pitch: 0,
      });
      map.current = instance;
      instance.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
      instance.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-right');
      let ready = false;
      const timeout = setTimeout(() => { if (!ready) setFailed(true); }, 15000);
      instance.on('load', () => { ready = true; clearTimeout(timeout); setLoaded(true); setFailed(false); });
      instance.on('error', event => { if (!ready) { console.error('Station map resource failed', event.error); setFailed(true); } });
      const observer = new ResizeObserver(() => instance.resize()); observer.observe(container.current);
      return () => { clearTimeout(timeout); observer.disconnect(); instance.remove(); map.current = null; markers.current.clear(); };
    } catch (error) {
      console.error('Station map initialization failed', error);
      if (error instanceof maplibregl.GPUInitializationError) setFailureReason('This browser could not initialize WebGL2. Enable graphics acceleration or open the dashboard in another browser.');
      setFailed(true);
    }
  }, []);
  useEffect(() => {
    const instance = map.current;
    if (!instance || !loaded) return;
    for (const [id, marker] of markers.current) { if (!devices.some(d => d.id === id)) { marker.remove(); markers.current.delete(id); } }
    devices.forEach((device, i) => {
      const active = device.id === selected?.id;
      let marker = markers.current.get(device.id);
      if (!marker) {
        const element = document.createElement('button');
        element.type = 'button'; element.addEventListener('click', () => onSelectRef.current(device.id));
        marker = new maplibregl.Marker({ element }).setLngLat([device.lng, device.lat]).addTo(instance);
        markers.current.set(device.id, marker);
      }
      const element = marker.getElement();
      element.classList.add('station-marker');
      element.classList.toggle('selected', active);
      for (const status of ['offline', 'stationary', 'navigating']) element.classList.toggle(status, status === device.status.toLowerCase());
      element.setAttribute('aria-label', `Select ${device.station_code}`);
      element.textContent = device.station_code.split('-').at(-1)?.slice(0, 2) || String(i + 1);
      marker.setLngLat([device.lng, device.lat]);
    });
    const features: Feature[] = [];
    devices.filter(d => d.is_powered).forEach(device => {
      features.push({ type: 'Feature', properties: { kind: 'boundary', selected: device.id === selected?.id }, geometry: { type: 'Polygon', coordinates: [circle(device.anchor_lng, device.anchor_lat, 15)] } });
      if (device.route.length >= 2) features.push({ type: 'Feature', properties: { kind: 'route' }, geometry: { type: 'LineString', coordinates: device.route } });
      const points = ticks.filter(t => t.device_id === device.id).slice(0, 30).reverse().map(t => [t.lng, t.lat]);
      if (points.length >= 2) features.push({ type: 'Feature', properties: { kind: 'trail' }, geometry: { type: 'LineString', coordinates: points } });
    });
    const geojson: FeatureCollection = { type: 'FeatureCollection', features };
    const source = instance.getSource('station-data') as GeoJSONSource | undefined;
    if (source) source.setData(geojson);
    else {
      instance.addSource('station-data', { type: 'geojson', data: geojson });
      instance.addLayer({ id: 'boundary-fill', type: 'fill', source: 'station-data', filter: ['==', ['get', 'kind'], 'boundary'], paint: { 'fill-color': '#b6f36c', 'fill-opacity': .1 } });
      instance.addLayer({ id: 'boundary-line', type: 'line', source: 'station-data', filter: ['==', ['get', 'kind'], 'boundary'], paint: { 'line-color': '#b6f36c', 'line-width': 1, 'line-opacity': .5 } });
      instance.addLayer({ id: 'routes', type: 'line', source: 'station-data', filter: ['==', ['get', 'kind'], 'route'], paint: { 'line-color': '#b6f36c', 'line-width': 2, 'line-dasharray': [2, 3], 'line-opacity': .7 } });
      instance.addLayer({ id: 'trails', type: 'line', source: 'station-data', filter: ['==', ['get', 'kind'], 'trail'], paint: { 'line-color': '#b6f36c', 'line-width': 2, 'line-opacity': .65 } });
    }
  }, [devices, selected?.id, ticks, loaded]);
  useEffect(() => {
    if (!loaded || !selected || !map.current) return;
    map.current.flyTo({ center: [selected.anchor_lng, selected.anchor_lat], duration: 900, essential: false });
  }, [selected?.id, selected?.anchor_lat, selected?.anchor_lng, loaded]);
  useEffect(() => {
    if (!loaded || !map.current?.getLayer('trails')) return;
    map.current.setLayoutProperty('trails', 'visibility', showTrails ? 'visible' : 'none');
    map.current.setLayoutProperty('routes', 'visibility', showTrails ? 'visible' : 'none');
  }, [showTrails, loaded]);
  const fit = () => {
    if (!map.current || !devices.length) return;
    const bounds = new maplibregl.LngLatBounds(); devices.forEach(d => bounds.extend([d.lng, d.lat]));
    map.current.fitBounds(bounds, { padding: 85, maxZoom: 15, duration: 600 });
  };
  return <section className="map-panel panel" ref={shell} aria-label="Station locations map" data-map-state={failed ? 'error' : loaded ? 'ready' : 'loading'}>
    <div ref={container} className="map-canvas" />
    <div className="map-heading"><h2>{demo ? 'Lakeland, Florida' : 'Station network'}</h2><span>{devices.length} stations · 15 m model boundary</span></div>
    <div className="map-actions"><button className="map-button" title="Fit all stations" aria-label="Fit all stations" onClick={fit}><Expand size={18} /></button><button className={`map-button ${showTrails ? 'active' : ''}`} title="Toggle routes and trails" aria-label="Toggle routes and trails" aria-pressed={showTrails} onClick={() => setShowTrails(v => !v)}><Layers size={18} /></button></div>
    <div className="map-zoom"><button className="map-button" aria-label="Zoom in" onClick={() => map.current?.zoomIn()}><Plus size={18} /></button><button className="map-button" aria-label="Zoom out" onClick={() => map.current?.zoomOut()}><Minus size={18} /></button><button className="map-button" aria-label="Center selected station" onClick={() => { if (selected) map.current?.flyTo({ center: [selected.lng, selected.lat], zoom: 17 }); }}><LocateFixed size={18} /></button></div>
    <div className="map-legend"><span><i className="dot lime" />Stationary</span><span><i className="dot mint" />Navigating</span><span><i className="dot gray" />Offline</span></div>
    {!loaded && !failed && <div className="map-starting" role="status">Loading map tiles…</div>}
    {failed && <div className="map-error"><MapPin size={24} /><strong>Map unavailable</strong><span>{failureReason}</span><button className="button" onClick={() => location.reload()}>Reload map</button></div>}
  </section>;
}
