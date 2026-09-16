'use client';
import { useEffect, useRef, useState } from 'react';
import { X, ArrowRight, ShieldCheck } from 'lucide-react';
import { Campaign, surfaces, validateCampaign } from '../lib/campaign';
export default function CampaignBuilder({onClose,onSave}:{onClose:()=>void;onSave:(c:Campaign)=>void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [chosen,setChosen]=useState<string[]>([surfaces[0],surfaces[1]]);
  const [errors,setErrors]=useState<string[]>([]);
  useEffect(()=>{dialog.current?.showModal();},[]);
  function submit(e:React.FormEvent<HTMLFormElement>){
    e.preventDefault();const f=new FormData(e.currentTarget);
    const values={business:String(f.get('business')).trim(),listing:String(f.get('listing')).trim(),location:String(f.get('location')).trim(),keywords:[...new Set(String(f.get('keywords')).split('\n').map(k=>k.trim()).filter(Boolean))],days:Number(f.get('days')),warmup:Number(f.get('warmup')),devices:Number(f.get('devices')),concurrency:Number(f.get('concurrency')),surfaces:chosen};
    const invalid=validateCampaign(values); setErrors(invalid); if(invalid.length)return;
    onSave({...values,id:crypto.randomUUID(),createdAt:new Date().toISOString(),status:'draft'});
  }
  return <dialog ref={dialog} onCancel={onClose} className="builder"><div className="dialog-heading"><div><span className="muted">Managed search observation</span><h2>New campaign</h2></div><button className="icon-button" onClick={onClose} aria-label="Close campaign builder"><X/></button></div><form onSubmit={submit}>
    <fieldset><legend>01 / Business & market</legend><label>Business name<input name="business" required maxLength={160} placeholder="South Beach Auto Accident Attorney" autoFocus/></label><label>Google Business / Maps listing<input name="listing" type="url" required placeholder="https://maps.google.com/…"/></label><label>Target city or neighborhood<input name="location" required maxLength={160} placeholder="Miami Beach, FL"/></label><label>Keywords <span className="muted">one per line</span><textarea name="keywords" required rows={3} placeholder={'car accident lawyer near me\npersonal injury lawyer'}/></label></fieldset>
    <fieldset><legend>02 / Observation plan</legend><div className="form-grid"><label>Total days<input name="days" type="number" min={11} max={45} defaultValue={45} required/></label><label>Warmup days<input name="warmup" type="number" min={10} max={30} defaultValue={14} required/></label><label>Devices<input name="devices" type="number" min={1} max={100} defaultValue={5} required/></label><label>Requested parallel slots<input name="concurrency" type="number" min={1} max={100} defaultValue={3} required/></label></div><p className="hint">Warmup is part of the total duration. Longer warmup is an experimental choice, not a guarantee of accuracy. Capacity and device models are confirmed before activation.</p></fieldset>
    <fieldset><legend>03 / Target surfaces</legend><div className="surface-options">{surfaces.map(s=><label key={s} className="check-label"><input type="checkbox" checked={chosen.includes(s)} onChange={e=>setChosen(e.target.checked?[...chosen,s]:chosen.filter(v=>v!==s))}/>{s}</label>)}</div></fieldset>
    <div className="managed-note"><ShieldCheck size={20}/><div><strong>Devices and proxies, managed for you.</strong><p>No DuoPlus API key required. Customer proxy and custom routine configuration will be available during provisioning.</p></div></div>
    {errors.length>0&&<ul className="errors" role="alert">{errors.map(e=><li key={e}>{e}</li>)}</ul>}
    <footer className="dialog-footer"><span>Saved in this browser · no devices started</span><button className="button primary" type="submit">Save campaign draft <ArrowRight size={16}/></button></footer>
  </form></dialog>;
}
