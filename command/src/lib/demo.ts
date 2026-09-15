import {type State,type Job,type Schedule,activeStatuses} from './types';
import {jobsForDay,occupiedDevices} from './scheduling';
export function createDemo(deviceCount=10,capacity=3):State {
 const now=new Date(),today=now.toISOString().slice(0,10);
 const templates=['Chrome · Local search','Maps · Business listing','Google · Discovery feed','Chrome · Website check','Maps · Competitor check'].map((name,i)=>({id:`t${i}`,external_id:`demo-template-${i}`,name,description:['Search a local keyword and capture the result.','Open a business listing and inspect its information.','Read the Google discovery feed.','Visit the client website and check page availability.','Inspect nearby competitor listings.'][i],app:name.split(' · ')[0],template_type:2 as const,parameters:i===2?[]:[{key:'keyword',type:'string' as const,required:true,defaultValue:'local businesses near me'}],variables_confirmed:true,duration_minutes:5+i,version:1}));
 const devices=Array.from({length:deviceCount},(_,i)=>({id:`d${i}`,external_id:`DEMO-${1001+i}`,name:`${['Lakeland','Miami','Tampa'][i%3]} ${String(Math.floor(i/3)+1).padStart(2,'0')}`,client:['Sunrise Realty','Coastal Dental','Bay HVAC'][i%3],city:['Lakeland, FL','Miami, FL','Tampa, FL'][i%3],latitude:[28.0395,25.7617,27.9506][i%3],longitude:[-81.9498,-80.1918,-82.4572][i%3],timezone:'America/New_York',power:'off' as const,enabled:true,last_seen:now.toISOString(),expired_at:null}));
 const schedule:Schedule={id:'daily-demo',name:'Daily device routine',device_ids:devices.map(d=>d.id),template_ids:templates.map(t=>t.id),frequency:'daily',days:[1,2,3,4,5],start_date:today,end_date:null,start_time:'00:00',end_time:'23:59',timezone:'UTC',variables:{keyword:'local businesses near me'},enabled:true,priority:1};
 const jobs=jobsForDay(schedule,today,templates,now);let done=0;for(const j of jobs){if(j.position===0||j.position===1&&['d0','d1'].includes(j.device_id)){j.status='completed';j.started_at=new Date(+now-600000).toISOString();j.finished_at=new Date(+now-300000+done*10000).toISOString();done++;}}
 const state:State={workspace:{id:'demo',name:'Demo workspace',capacity,paused:false,timezone:'America/New_York',provider_timezone:'UTC',connected:false,sync_requested:false,last_sync:now.toISOString(),last_heartbeat:now.toISOString(),last_error:null,exclusive_control:false,verified_capacity:capacity},devices,templates,schedules:[schedule],jobs,events:[{id:'welcome',message:`Demo loaded · ${deviceCount} devices, ${capacity} subscription slots, ${deviceCount*5} tasks`,created_at:now.toISOString(),kind:'info'}]};
 return tickDemo(state,now);
}
function event(s:State,message:string,now:Date){s.events.unshift({id:crypto.randomUUID(),message,created_at:now.toISOString(),kind:'info'});s.events=s.events.slice(0,100);}
export function tickDemo(input:State,now=new Date()):State{
 const s=structuredClone(input);s.workspace.last_heartbeat=now.toISOString();
 for(const job of s.jobs.filter(j=>activeStatuses.includes(j.status))){const device=s.devices.find(d=>d.id===job.device_id)!;const age=+now-Date.parse(job.started_at??now.toISOString());
 if(job.status==='stopping'){
 const next=!s.workspace.paused&&device.enabled&&occupiedDevices(s).size<=s.workspace.capacity?s.jobs.filter(j=>j.device_id===device.id&&j.status==='queued'&&Date.parse(j.due_at)<=+now).sort((a,b)=>Date.parse(a.due_at)-Date.parse(b.due_at)||a.position-b.position)[0]:undefined;
 job.status=job.outcome??'completed';job.finished_at=now.toISOString();
 if(next){next.status='running';next.started_at=now.toISOString();event(s,`${device.name} started ${next.template_snapshot.name} · kept its slot`,now);}
 else{device.power='off';event(s,`${device.name} powered off · subscription slot released`,now);}
 }
 else if(job.status==='running'&&age>=job.template_snapshot.duration_minutes*4000){job.status='stopping';job.outcome='completed';event(s,`${device.name} completed ${job.template_snapshot.name}`,now);}}
 if(!s.workspace.paused){const occupied=occupiedDevices(s);for(const j of s.jobs.filter(j=>j.status==='queued').sort((a,b)=>Date.parse(a.deadline_at)-Date.parse(b.deadline_at)||a.position-b.position)){
 if(Date.parse(j.due_at)>+now)continue;
 const d=s.devices.find(d=>d.id===j.device_id);if(!d?.enabled||d.power==='expired'||occupied.has(j.device_id)||occupied.size>=s.workspace.capacity)continue;
 if(s.jobs.some(p=>p.schedule_id===j.schedule_id&&p.device_id===j.device_id&&p.due_at===j.due_at&&p.position<j.position&&!['completed','cancelled','missed','failed'].includes(p.status)))continue;
 j.status='running';j.started_at=now.toISOString();d.power='on';occupied.add(d.id);event(s,`${d.name} started ${j.template_snapshot.name}`,now);
 }}return s;
}
