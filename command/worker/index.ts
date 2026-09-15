import {createServer} from 'node:http';
import {createClient} from '@supabase/supabase-js';
import {randomUUID} from 'node:crypto';
import {DuoPlus,normalizePower,expiry,taskPayload,ProviderError} from './provider';
import {jobsForDay,dateInZone,resolveVariables} from '../src/lib/scheduling';
import {activeStatuses,type Job,type Device,type Template,type Schedule,type Workspace} from '../src/lib/types';
const workerId=randomUUID();const enabled=process.env.WORKER_ENABLED!=='false';
const db=process.env.SUPABASE_URL&&process.env.SUPABASE_SECRET_KEY?createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}}):null;
let lastTick=Date.now(),lastError:string|null=null,stopping=false;
async function checked<T>(promise:PromiseLike<{data:T;error:{message:string}|null}>):Promise<T>{const r=await promise;if(r.error)throw new Error(r.error.message);return r.data;}
const requireDb=()=>{if(!db)throw new Error('Worker requires Supabase URL and server key');return db;};
async function patchJob(id:string,fields:Record<string,unknown>){await checked(requireDb().from('cmd_jobs').update(fields).eq('id',id));}
async function event(workspace_id:string,message:string,kind='info'){await checked(requireDb().from('cmd_events').insert({workspace_id,message,kind}));}
async function lease(target:string){const ok=await checked(requireDb().rpc('cmd_worker_lease',{target,worker:workerId}));if(!ok)throw new Error('Workspace is controlled by another worker');}
const providers=new Map<string,DuoPlus>();
async function provider(w:Workspace){if(!providers.has(w.id)||w.sync_requested){const key=await checked(requireDb().rpc('cmd_worker_key',{target:w.id}));if(!key)throw new Error('No DuoPlus key configured');providers.set(w.id,new DuoPlus(String(key),()=>lease(w.id)));}return providers.get(w.id)!;}
async function sync(w:Workspace,p:DuoPlus,includeTemplates:boolean){
 const rows=await p.list('cloudPhone/list');const ids=new Set<string>();
 const existing=await checked(requireDb().from('cmd_devices').select('*').eq('workspace_id',w.id)) as Device[];
 for(const row of rows){if(typeof row.id!=='string')throw new Error('Unrecognized device ID in inventory');ids.add(row.id);const old=existing.find(d=>d.external_id===row.id);const exp=expiry(row.expired_at);let power=normalizePower(row.status);if(exp&&Date.parse(exp)<Date.now()&&power==='off')power='expired';
 await checked(requireDb().from('cmd_devices').upsert({...(old??{}),workspace_id:w.id,external_id:row.id,name:String(row.name||row.id),power,expired_at:exp,last_seen:new Date().toISOString()},{onConflict:'workspace_id,external_id'}));}
 for(const old of existing.filter(d=>!ids.has(d.external_id)))await checked(requireDb().from('cmd_devices').update({power:'unknown'}).eq('id',old.id));
 const subs=new Map<string,Record<string,unknown>>();for(const free_status of [0,1])for(const row of await p.list('subscriptionStartup/list',{free_status}))subs.set(String(row.id),row);
 const count=[...subs.values()].filter(row=>{const end=expiry(row.expired_at);return end&&Date.parse(end)>Date.now();}).length;
 if(includeTemplates){for(const [endpoint,type] of [['automation/userTemplateList',2],['automation/officialTemplateList',1]] as const){for(const row of await p.list(endpoint)){if(typeof row.id!=='string')continue;const old=await checked(requireDb().from('cmd_templates').select('id').eq('workspace_id',w.id).eq('external_id',row.id).eq('template_type',type).maybeSingle());if(!old)await checked(requireDb().from('cmd_templates').insert({workspace_id:w.id,external_id:row.id,template_type:type,name:String(row.name||row.id),description:String(row.desc||'')}));}}}
 await checked(requireDb().from('cmd_workspaces').update({last_sync:new Date().toISOString(),verified_capacity:count,capacity:count,sync_requested:false,last_error:null}).eq('id',w.id));
}
async function materialize(w:Workspace){const schedules=await checked(requireDb().from('cmd_schedules').select('*').eq('workspace_id',w.id).eq('enabled',true)) as Schedule[],templates=await checked(requireDb().from('cmd_templates').select('*').eq('workspace_id',w.id)) as Template[];
 for(const schedule of schedules){for(const offset of [0,1]){const date=dateInZone(new Date(Date.now()+offset*86400000),schedule.timezone);let generated:Job[];try{generated=jobsForDay(schedule,date,templates);}catch(e){await event(w.id,`Schedule ${schedule.name}: ${(e as Error).message}`,'error');continue;}if(!generated.length)continue;const rows=generated.map(j=>{const id=randomUUID();return {...j,id,workspace_id:w.id,occurrence_key:j.id,provider_name:`cmd-${id}`};});await checked(requireDb().from('cmd_jobs').upsert(rows,{onConflict:'workspace_id,occurrence_key',ignoreDuplicates:true}));}}
}
async function advance(w:Workspace,p:DuoPlus,j:Job,device:Device){
 if(j.status==='starting'){
  if(device.power==='on'){
   // Record intent BEFORE sending. A crash or timeout never authorizes a second submission.
   let payload:ReturnType<typeof taskPayload>;try{payload=taskPayload(j,device,w.provider_timezone);}catch(e){await patchJob(j.id,{status:'stopping',outcome:'failed',error:(e as Error).message});return;}await patchJob(j.id,{status:'submitting',submission_at:new Date().toISOString()});
   try{await p.call('automation/addTask',payload);await event(w.id,`${device.name}: ${j.template_snapshot.name} submitted`);}catch(e){await patchJob(j.id,{error:e instanceof ProviderError?e.message:'Task submission uncertain; reconciling provider logs'});}return;
  }
  if(!j.power_requested_at&&device.power==='off'){
   try{resolveVariables(j,device);}catch(e){await patchJob(j.id,{status:'failed',finished_at:new Date().toISOString(),error:(e as Error).message});return;}
   await patchJob(j.id,{power_requested_at:new Date().toISOString()});try{await p.power(device,true);}catch(e){await patchJob(j.id,{status:'attention',error:e instanceof ProviderError?e.message:'Power-on result uncertain; slot held'});}return;
  }
  if(Date.now()-Date.parse(j.started_at??j.created_at)>180000)await patchJob(j.id,{status:'attention',error:'Power-on has not been confirmed. Slot remains reserved.'});return;
 }
 if(j.status==='submitting'||j.status==='running'||j.status==='attention'){
  if(!j.submission_at){if(device.power==='on')await patchJob(j.id,{status:'starting',error:null});return;}
  const records=await p.tasks(j,w.provider_timezone);
  if(records.length){await patchJob(j.id,{provider_records:records});const statuses=records.map(r=>Number(r.status));
   if(statuses.every(v=>[3,4,5].includes(v))){const outcome=statuses.every(v=>v===3)?'completed':'failed';await patchJob(j.id,{status:'stopping',outcome,error:outcome==='failed'?'DuoPlus reported failure or cancellation':null});await event(w.id,`${device.name}: task ${outcome}; checking remaining daily tasks`);return;}
   if(statuses.some(v=>![0,1,2,3,4,5].includes(v)))await patchJob(j.id,{status:'attention',error:'Unknown provider task status; slot held'});
   else if(statuses.includes(2))await patchJob(j.id,{status:'attention',error:'Task paused in DuoPlus; resume or cancel it there'});
   else if(Date.now()-Date.parse(j.submission_at)>Math.max(30,j.template_snapshot.duration_minutes*3)*60000)await patchJob(j.id,{status:'attention',error:'Task exceeded its expected duration; inspect DuoPlus. Slot held.'});
   else await patchJob(j.id,{status:'running',error:null});
  }else if(Date.now()-Date.parse(j.submission_at)>180000)await patchJob(j.id,{status:'attention',error:'Submission not found in provider logs. Inspect DuoPlus before retrying; slot held.'});return;
 }
 if(j.status==='stopping'){
  const statusData=await p.call('cloudPhone/status',{image_ids:[device.external_id]});
  const observed=Array.isArray(statusData.list)?statusData.list.find((r:Record<string,unknown>)=>r.id===device.external_id):null;
  const actual=observed?normalizePower(observed.status):'unknown';
  await checked(requireDb().from('cmd_devices').update({power:actual,last_seen:new Date().toISOString()}).eq('id',device.id));
  if(actual==='off'){await patchJob(j.id,{status:j.outcome??'failed',finished_at:new Date().toISOString()});await event(w.id,`${device.name} confirmed off · subscription slot released`);return;}
  // Never infer shutdown from missing inventory, expiry, an API acknowledgment, or elapsed time.
  if(actual==='on'){
   const next=await checked(requireDb().rpc('cmd_continue',{target:w.id,worker:workerId,finished:j.id})) as Job[];
   if(next.length){await event(w.id,`${device.name}: next task starting · keeping its subscription slot`);await advance(w,p,next[0],{...device,power:'on'});return;}
   await p.power(device,false);return;
  }
  await patchJob(j.id,{error:'Waiting for confirmed device shutdown; slot remains reserved'});
 }
}
async function tickWorkspace(w:Workspace){
 await lease(w.id);const p=await provider(w);
 const needSync=w.sync_requested||!w.last_sync||Date.now()-Date.parse(w.last_sync)>30000;
 if(needSync)await sync(w,p,w.sync_requested||!w.last_sync);
 await materialize(w);
 const devices=await checked(requireDb().from('cmd_devices').select('*').eq('workspace_id',w.id)) as Device[];
 const jobs=await checked(requireDb().from('cmd_jobs').select('*').eq('workspace_id',w.id).in('status',activeStatuses)) as Job[];
 for(const job of jobs){const d=devices.find(d=>d.id===job.device_id);if(d)await advance(w,p,job,d);}
 // Claim is transactional, account-scoped, and counts all observed powered phones plus reservations.
 for(let slot=0;slot<devices.length;slot++){
 const claimed=await checked(requireDb().rpc('cmd_claim',{target:w.id,worker:workerId})) as Job[];
 if(!claimed.length)break;
 for(const job of claimed){const d=devices.find(d=>d.id===job.device_id);if(d)await advance(w,p,job,d);}
 }
 await checked(requireDb().from('cmd_workspaces').update({last_heartbeat:new Date().toISOString()}).eq('id',w.id));
}
async function loop(){while(!stopping){lastTick=Date.now();if(enabled&&db){try{const workspaces=await checked(db.from('cmd_workspaces').select('*').eq('connected',true)) as Workspace[];for(const w of workspaces){try{await tickWorkspace(w);}catch(e){const message=e instanceof ProviderError?e.message:(e as Error).message;if(!message.includes('another worker'))await checked(db.from('cmd_workspaces').update({last_error:message,last_heartbeat:new Date().toISOString()}).eq('id',w.id));}}lastError=null;}catch(e){lastError=(e as Error).message;console.error('Controller iteration failed; retrying');}}await new Promise(r=>setTimeout(r,5000));}}
createServer((req,res)=>{if(req.url!=='/health'){res.writeHead(404);res.end();return;}const healthy=!enabled||!!db&&Date.now()-lastTick<300000;res.writeHead(healthy?200:503,{'Content-Type':'application/json'});res.end(JSON.stringify({status:!enabled?'disabled':healthy?'ready':'unavailable',configured:!!db,enabled,last_tick:new Date(lastTick).toISOString(),error:lastError?'Controller connection requires attention':null}));}).listen(Number(process.env.PORT||8080),'0.0.0.0');
process.on('SIGTERM',()=>{stopping=true;setTimeout(()=>process.exit(0),27000).unref();});
void loop();
