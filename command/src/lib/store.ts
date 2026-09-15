import {useEffect,useState,useCallback} from 'react';
import {createClient,type Session} from '@supabase/supabase-js';
import {createDemo,tickDemo} from './demo';
import {jobsForDay} from './scheduling';
import type {State,Schedule,Device,Template,Job} from './types';
const url=import.meta.env.VITE_SUPABASE_URL,key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const supabase=url&&key?createClient(url,key):null;
const demoKey='stakeout-command-demo-v1';
function loadDemo():State {try{const s=JSON.parse(localStorage.getItem(demoKey)||'null');if(s?.workspace.id==='demo'&&s.jobs?.length)return s;}catch{}return createDemo();}
export function useCommand(){
 const [state,setState]=useState<State>(loadDemo),[session,setSession]=useState<Session|null>(null),[demo,setDemo]=useState(true),[error,setError]=useState(''),[loading,setLoading]=useState(false);
 useEffect(()=>{if(!supabase)return;supabase.auth.getSession().then(({data})=>{setSession(data.session);if(data.session)setDemo(false);});const {data}=supabase.auth.onAuthStateChange((_,s)=>{setSession(s);if(s)setDemo(false);});return()=>data.subscription.unsubscribe();},[]);
 const refresh=useCallback(async()=>{if(demo||!session||!supabase)return;const {error:e}=await supabase.rpc('cmd_action',{action:'bootstrap',payload:{}});if(e)throw e;
 const names=['workspaces','devices','templates','schedules','jobs','events'];const results=await Promise.all(names.map(n=>{let q=supabase!.from(`cmd_${n}`).select('*');if(n==='jobs')q=q.gte('created_at',new Date(Date.now()-30*86400000).toISOString()).order('created_at',{ascending:false}).limit(1000);if(n==='events')q=q.order('created_at',{ascending:false}).limit(50);return q;}));
 for(const r of results)if(r.error)throw r.error;
 const jobs=new Map<string,Job>((results[4].data as Job[]).map(j=>[j.id,j]));
 for(let offset=0;;offset+=1000){const r=await supabase.from('cmd_jobs').select('*').in('status',['queued','starting','submitting','running','stopping','attention']).order('id').range(offset,offset+999);if(r.error)throw r.error;for(const j of r.data as Job[])jobs.set(j.id,j);if(r.data.length<1000)break;}
 setState({workspace:results[0].data![0],devices:results[1].data!,templates:results[2].data!,schedules:results[3].data!,jobs:[...jobs.values()],events:results[5].data!} as State);
 },[demo,session]);
 useEffect(()=>{if(demo){setState(loadDemo());return;}setLoading(true);setState({workspace:{...createDemo().workspace,id:'loading',name:'My workspace',paused:true,connected:false,verified_capacity:null,last_sync:null,last_heartbeat:null},devices:[],templates:[],schedules:[],jobs:[],events:[]});refresh().catch(e=>setError(e.message)).finally(()=>setLoading(false));const id=setInterval(()=>refresh().catch(e=>setError(e.message)),10000);return()=>clearInterval(id);},[demo,refresh]);
 useEffect(()=>{if(!demo)return;const id=setInterval(()=>setState(s=>tickDemo(s)),2000);return()=>clearInterval(id);},[demo]);
 useEffect(()=>{if(demo&&state.workspace.id==='demo'){try{localStorage.setItem(demoKey,JSON.stringify(state));}catch{}}},[state,demo]);
 const action=async(name:string,payload:Record<string,unknown>={})=>{setError('');if(!demo){if(!supabase||!session)throw new Error('Sign in first');const {error}=await supabase.rpc('cmd_action',{action:name,payload});if(error)throw error;await refresh();return;}
 setState(current=>{const s=structuredClone(current);if(name==='settings')Object.assign(s.workspace,payload);
 else if(name==='device'){const d=s.devices.find(d=>d.id===payload.id);if(d)Object.assign(d,payload);}
 else if(name==='template'){const t={...payload,id:payload.id||crypto.randomUUID(),variables_confirmed:true,version:1} as Template;const i=s.templates.findIndex(x=>x.id===t.id);if(i>=0)s.templates[i]=t;else s.templates.push(t);}
 else if(name==='schedule'){const schedule={...payload,id:payload.id||crypto.randomUUID()} as Schedule;const i=s.schedules.findIndex(x=>x.id===schedule.id);if(i>=0)s.schedules[i]=schedule;else s.schedules.push(schedule);const jobs=jobsForDay(schedule,schedule.start_date,s.templates);s.jobs.push(...jobs.filter(j=>!s.jobs.some(x=>x.id===j.id)));}
 else if(name==='toggle_schedule'){const sc=s.schedules.find(x=>x.id===payload.id);if(sc)sc.enabled=!!payload.enabled;if(!payload.enabled)for(const j of s.jobs)if(j.schedule_id===payload.id&&j.status==='queued')j.status='cancelled';}
 else if(name==='cancel_job'){const j=s.jobs.find(j=>j.id===payload.id);if(j?.status==='queued')j.status='cancelled';}
 else if(name==='retry_job'){const j=s.jobs.find(j=>j.id===payload.id);if(j?.status==='failed')s.jobs.push({...j,id:crypto.randomUUID(),status:'queued',attempt:j.attempt+1,started_at:null,finished_at:null,error:null});}
 else if(name==='sync'){s.workspace.last_sync=new Date().toISOString();}
 return s;});};
 return {state,demo,session,error,setError,loading,action,refresh,enterDemo:()=>{setDemo(true);setState(loadDemo());},enterLive:()=>setDemo(false),resetDemo:()=>{const s=createDemo();localStorage.setItem(demoKey,JSON.stringify(s));setState(s);},signOut:async()=>{await supabase?.auth.signOut();setDemo(true);}};
}
