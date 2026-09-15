import {activeStatuses,type State,type Schedule,type Device,type Template,type Job} from './types';
export function occupiedDevices(s:State):Set<string>{return new Set([...s.devices.filter(d=>!['off','expired'].includes(d.power)).map(d=>d.id),...s.jobs.filter(j=>activeStatuses.includes(j.status)).map(j=>j.device_id)]);}
export function dateInZone(date:Date,timezone:string):string {const p=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);return ['year','month','day'].map(k=>p.find(x=>x.type===k)!.value).join('-');}
export function wallTime(date:string,time:string,timezone:string):Date {
 const [year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number);const target=Date.UTC(year,month-1,day,hour,minute);let guess=target;
 for(let i=0;i<4;i++){const p=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));const n=(k:string)=>Number(p.find(x=>x.type===k)!.value);const actual=Date.UTC(n('year'),n('month')-1,n('day'),n('hour'),n('minute'));const delta=target-actual;if(!delta)return new Date(guess);guess+=delta;}throw new Error('This local time does not exist because of daylight saving time. Choose another start time.');
}
export function validateSchedule(s:Schedule,devices:Device[],templates:Template[]):void {
 if(!s.name.trim()||!s.device_ids.length||!s.template_ids.length)throw new Error('Choose a name, at least one device, and at least one template.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(s.start_date)||s.end_date&&s.end_date<s.start_date)throw new Error('Check the schedule dates.');
 if(!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(s.start_time))throw new Error('Choose a valid start time.');
 if(s.frequency==='weekly'&&!s.days.length)throw new Error('Choose at least one weekday.');
 new Intl.DateTimeFormat('en',{timeZone:s.timezone});
 for(const id of s.device_ids){const d=devices.find(x=>x.id===id);if(!d||!d.enabled||d.power==='expired')throw new Error('Choose available, assigned devices.');}
 for(const id of s.template_ids){const t=templates.find(x=>x.id===id);if(!t||!t.variables_confirmed)throw new Error('Review template inputs before scheduling.');for(const p of t.parameters){const v=s.variables[p.key]??p.defaultValue??'';if(p.required&&!v.trim())throw new Error(`Enter a value for ${p.key}.`);if(p.type==='number'&&v&&!Number.isFinite(Number(v)))throw new Error(`${p.key} must be a number.`);if(p.type==='boolean'&&v&&!['true','false'].includes(v))throw new Error(`${p.key} must be true or false.`);}}
}
export function jobsForDay(s:Schedule,date:string,templates:Template[],now=new Date()):Job[]{
 if(!s.enabled||date<s.start_date||s.end_date&&date>s.end_date||s.frequency==='once'&&date!==s.start_date)return [];
 const day=new Date(`${date}T12:00:00Z`).getUTCDay();if(s.frequency==='weekly'&&!s.days.includes(day))return [];
 const due=wallTime(date,s.start_time,s.timezone).toISOString(),deadline=wallTime(date,'23:59',s.timezone).toISOString();
 return s.device_ids.flatMap(device_id=>s.template_ids.map((template_id,position)=>{const template=templates.find(t=>t.id===template_id);if(!template)throw new Error('Scheduled template is unavailable');const id=`${s.id}:${date}:${device_id}:${position}`;return {id,device_id,template_id,schedule_id:s.id,status:'queued',due_at:due,deadline_at:deadline,started_at:null,finished_at:null,created_at:now.toISOString(),position,attempt:1,error:null,provider_name:'',template_snapshot:structuredClone(template),variables:{...s.variables}} satisfies Job;}));
}
export function resolveVariables(job:Job,device:Device):Record<string,{key:string;value:string|string[];type:string;required:boolean}>{
 const context:Record<string,string>={'device.name':device.name,'device.city':device.city,'device.latitude':String(device.latitude??''),'device.longitude':String(device.longitude??''),'client.name':device.client};
 return Object.fromEntries(job.template_snapshot.parameters.map(p=>{let value=job.variables[p.key]??p.defaultValue??'';value=value.replace(/\{\{\s*([^}]+?)\s*\}\}/g,(_,key:string)=>{if(!(key in context)||!context[key])throw new Error(`Missing variable ${key}`);return context[key];});if(p.required&&!value.trim())throw new Error(`Missing required input ${p.key}`);return [p.key,{key:p.key,value:p.type==='file'?value.split('\n').filter(Boolean):value,type:p.type,required:p.required}];}));
}
