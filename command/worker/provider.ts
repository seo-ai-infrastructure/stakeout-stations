import type {Power,Job,Device} from '../src/lib/types';
import {resolveVariables} from '../src/lib/scheduling';
export type Row=Record<string,unknown>;
export function normalizePower(status:unknown):Power{return ({1:'on',2:'off',3:'expired',4:'expired',10:'starting',11:'configuring'} as Record<string,Power>)[String(status)]??'unknown';}
export function expiry(value:unknown):string|null{if(value==null||value==='')return null;const n=Number(value);const date=Number.isFinite(n)?new Date(n<1e12?n*1000:n):new Date(String(value));return Number.isFinite(+date)?date.toISOString():null;}
export function providerDate(date:Date,zone:string,seconds=false):string{const p=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);const get=(k:string)=>p.find(x=>x.type===k)!.value;return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}${seconds?':'+get('second'):''}`;}
export function taskPayload(job:Job,device:Device,zone:string,now=new Date()):Row{return {name:job.provider_name,template_id:job.template_snapshot.external_id,template_type:job.template_snapshot.template_type,images:[{image_id:device.external_id,issue_at:providerDate(new Date(+now+120000),zone),config:resolveVariables(job,device)}]};}
export class ProviderError extends Error{constructor(public code:number,message='DuoPlus request failed'){super(`${message} (${code})`);}}
export class DuoPlus {
 private next=0;
 constructor(private key:string,private guard:()=>Promise<void>,private fetcher:typeof fetch=fetch){}
 async call(endpoint:string,payload:Row):Promise<Row>{
  await new Promise(r=>setTimeout(r,Math.max(0,this.next-Date.now())));await this.guard();this.next=Date.now()+1250;
  const response=await this.fetcher(`https://openapi.duoplus.net/api/v1/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json','DuoPlus-API-Key':this.key,Lang:'en'},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
  if(response.status===429){this.next=Date.now()+60000;throw new ProviderError(429,'Rate limited; waiting before the next request');}
  let body:Row;try{body=await response.json() as Row;}catch{throw new ProviderError(502,'Unreadable provider response');}
  const code=Number(body.code);if(!response.ok||code!==200){if(code===429)this.next=Date.now()+60000;throw new ProviderError(code||response.status);}
  if(!body.data||typeof body.data!=='object')throw new ProviderError(502,'Provider response has no data');return body.data as Row;
 }
 async list(endpoint:string,payload:Row={}):Promise<Row[]>{const rows:Row[]=[];for(let page=1;page<=100;page++){const data=await this.call(endpoint,{...payload,page,pagesize:100});if(!Array.isArray(data.list))throw new ProviderError(502,'Provider list is missing');rows.push(...data.list);const total=Number(data.total_page);if(Number.isFinite(total)&&page>=Math.max(1,total))return rows;if(!Number.isFinite(total)&&data.list.length<100)return rows;}throw new ProviderError(502,'Provider pagination did not complete');}
 async tasks(job:Job,zone:string):Promise<Row[]>{const rows=await this.list('automation/taskList',{name:job.provider_name,issue_at_start:providerDate(new Date(Date.parse(job.created_at)-86400000),zone,true),issue_at_end:providerDate(new Date(Date.now()+86400000),zone,true)});return rows.filter(r=>r.name===job.provider_name);}
 async power(device:Device,on:boolean):Promise<void>{const data=await this.call(on?'cloudPhone/powerOn':'cloudPhone/powerOff',{image_ids:[device.external_id]});if(Array.isArray(data.fail)&&data.fail.some(r=>r===device.external_id||typeof r==='object'&&r!==null&&['id','image_id'].some(k=>(r as Row)[k]===device.external_id)))throw new ProviderError(422,'Power command rejected');}
}
