'use client';
import { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { demoPoints } from '../lib/campaign';
export default function ObservationMap({selected, onSelect}: {selected:string; onSelect:(id:string)=>void}) {
  const container = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onSelect); selectRef.current = onSelect;
  const markers = useRef<{id:string; element:HTMLButtonElement}[]>([]);
  const [failed,setFailed] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    maplibregl.setWorkerUrl('/maplibre/6.8.0/maplibre-gl-worker.mjs');
    let map: maplibregl.Map;
    try { map = new maplibregl.Map({container:container.current, center:[-80.133,25.777],zoom:13.8, attributionControl:{compact:true},style:{version:8,sources:{basemap:{type:'raster',tiles:['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],tileSize:256,attribution:'© OpenStreetMap contributors © CARTO'}},layers:[{id:'basemap',type:'raster',source:'basemap'}]}}); }
    catch { setFailed(true); return; }
    map.on('error',()=>setFailed(true));
    const fitPoints = () => map.fitBounds([[-80.141,25.768],[-80.125,25.786]],{padding:55,duration:0});
    fitPoints();
    map.on('resize',fitPoints);
    map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');
    markers.current=demoPoints.map(p=>{
      const element = document.createElement('button'); element.type='button';
      element.className=`map-rank ${p.rank===null?'missing':p.rank>3?'amber':'green'}`;
      element.textContent=p.rank===null?'—':String(p.rank);
      element.setAttribute('aria-label',`${p.id}: ${p.rank===null?'capture unavailable':`sample rank ${p.rank}`}`);
      element.onclick=()=>selectRef.current(p.id);
      new maplibregl.Marker({element}).setLngLat([p.lng,p.lat]).addTo(map);
      return {id:p.id,element};
    });
    return()=>{markers.current=[];map.remove();};
  },[]);
  useEffect(()=>{markers.current.forEach(m=>{m.element.classList.toggle('chosen',m.id===selected);m.element.setAttribute('aria-pressed',String(m.id===selected));});},[selected]);
  return <div className="map-wrap"><div ref={container} className="map-canvas" aria-label="Miami Beach sample observation locations"/>{failed&&<p className="map-error">Map tiles unavailable. Select a location below.</p>}<div className="map-caption">Illustrative ranks · not measured results</div></div>;
}
