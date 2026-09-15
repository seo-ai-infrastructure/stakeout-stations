import {test} from 'node:test';import assert from 'node:assert/strict';
import {createDemo,tickDemo} from '../src/lib/demo';import {occupiedDevices,wallTime,jobsForDay,resolveVariables,validateSchedule} from '../src/lib/scheduling';import {normalizePower,taskPayload,DuoPlus} from '../worker/provider';
test('50 tasks on ten devices complete through three slots, with simulated restarts',()=>{let s=createDemo();let max=0;let now=Date.now();for(let i=0;i<500;i++){now+=2000;s=tickDemo(JSON.parse(JSON.stringify(s)),new Date(now));max=Math.max(max,occupiedDevices(s).size);assert.ok(occupiedDevices(s).size<=3);const active=s.jobs.filter(j=>['running','stopping'].includes(j.status));assert.equal(new Set(active.map(j=>j.device_id)).size,active.length);}assert.equal(s.jobs.filter(j=>j.status==='completed').length,50);assert.equal(max,3);assert.equal(occupiedDevices(s).size,0);});
test('paused dispatch drains current work without claiming more',()=>{let s=createDemo();s.workspace.paused=true;s=tickDemo(s,new Date(Date.now()+60000));assert.equal(s.jobs.filter(j=>j.status==='stopping').length,3);s=tickDemo(s,new Date(Date.now()+62000));assert.equal(occupiedDevices(s).size,0);assert.ok(s.jobs.some(j=>j.status==='queued'));});
test('reducing capacity drains occupied slots and prevents new oversubscription',()=>{let s=createDemo();s.workspace.capacity=1;for(let i=0;i<90;i++){s=tickDemo(s,new Date(Date.now()+i*3000));if(i>12)assert.ok(occupiedDevices(s).size<=1);}});
test('manual powered phones and unknown states reserve slots',()=>{const s=createDemo();s.devices[9].power='on';assert.equal(occupiedDevices(s).size,4);s.devices[8].power='unknown';assert.equal(occupiedDevices(s).size,5);});
test('expired devices are ineligible',()=>{let s=createDemo();s.workspace.paused=true;s.devices[9].power='expired';s=tickDemo(s,new Date(Date.now()+60000));s=tickDemo(s,new Date(Date.now()+62000));s.workspace.paused=false;for(let i=0;i<100;i++)s=tickDemo(s,new Date(Date.now()+63000+i*4000));assert.ok(s.jobs.filter(j=>j.device_id==='d9').every(j=>!['running','starting','stopping'].includes(j.status)));});
test('time windows honor timezone and daylight saving transitions',()=>{assert.equal(wallTime('2026-09-10','08:00','America/New_York').toISOString(),'2026-09-10T12:00:00.000Z');assert.equal(wallTime('2026-12-10','08:00','America/New_York').toISOString(),'2026-12-10T13:00:00.000Z');assert.throws(()=>wallTime('2026-03-08','02:30','America/New_York'));});
test('schedule occurrences are stable and one-time recurrence stops',()=>{const s=createDemo(),sc=s.schedules[0];assert.deepEqual(jobsForDay(sc,sc.start_date,s.templates).map(j=>j.id),jobsForDay(sc,sc.start_date,s.templates).map(j=>j.id));sc.frequency='once';assert.equal(jobsForDay(sc,'2099-01-01',s.templates).length,0);});
test('missing template variables prevent submission; snapshots remain independent',()=>{const s=createDemo(),j=s.jobs[0];j.variables.keyword='{{device.city}}';assert.equal(resolveVariables(j,s.devices[0]).keyword.value,'Lakeland, FL');s.devices[0].city='';assert.throws(()=>resolveVariables(j,s.devices[0]));s.templates[0].name='Changed';assert.notEqual(j.template_snapshot.name,s.templates[0].name);});
test('schedule rejects unknown device and unreviewed inputs',()=>{const s=createDemo();s.schedules[0].device_ids=['missing'];assert.throws(()=>validateSchedule(s.schedules[0],s.devices,s.templates));});
test('provider payload uses custom template and a unique run name',()=>{const s=createDemo(),j=s.jobs[0];j.provider_name='cmd-unique';const p=taskPayload(j,s.devices[0],'UTC',new Date('2026-09-10T12:59:30Z'));assert.equal(p.template_type,2);assert.equal(p.name,'cmd-unique');assert.equal((p.images as {issue_at:string}[])[0].issue_at,'2026-09-10 13:01');assert.equal(normalizePower(2),'off');assert.equal(normalizePower(10),'starting');assert.equal(normalizePower(undefined),'unknown');});
test('provider envelope errors are rejected and guards run before requests',async()=>{let guarded=0;const p=new DuoPlus('test-key',async()=>{guarded++;},async()=>new Response(JSON.stringify({code:401,data:{}}),{status:200}));await assert.rejects(()=>p.call('cloudPhone/list',{}),/401/);assert.equal(guarded,1);});

for(const [devices,slots] of [[20,3],[50,5],[100,3]])test(`${devices} devices complete all templates through ${slots} slots despite overdue deadlines`,()=>{
 let s=createDemo(devices,slots);const start=Date.now();for(const d of s.devices)d.power='off';
 for(const j of s.jobs){j.status='queued';j.started_at=null;j.finished_at=null;j.deadline_at=new Date(start-60000).toISOString();}
 let peak=0;for(let tick=0;tick<600;tick++){
 s=tickDemo(s,new Date(start+tick*40000));const n=occupiedDevices(s).size;peak=Math.max(peak,n);assert.ok(n<=slots);
 const active=s.jobs.filter(j=>['running','stopping'].includes(j.status));assert.equal(new Set(active.map(j=>j.device_id)).size,active.length);
 if(s.jobs.every(j=>j.status==='completed'))break;}
 assert.equal(s.jobs.filter(j=>j.status==='completed').length,devices*5);assert.equal(peak,slots);assert.equal(occupiedDevices(s).size,0);
});
test('duration and completion control same-phone continuation',()=>{
 let s=createDemo(20,3);const first=s.jobs.find(j=>j.status==='running')!;first.template_snapshot.duration_minutes=9;
 const start=Date.parse(first.started_at!);s=tickDemo(s,new Date(start+21000));assert.equal(s.jobs.find(j=>j.id===first.id)!.status,'running');
 s=tickDemo(s,new Date(start+36000));assert.equal(s.jobs.find(j=>j.id===first.id)!.status,'stopping');
 s=tickDemo(s,new Date(start+37000));assert.equal(s.jobs.find(j=>j.id===first.id)!.status,'completed');
 assert.equal(s.devices.find(d=>d.id===first.device_id)!.power,'on');assert.ok(s.jobs.some(j=>j.device_id===first.device_id&&j.status==='running'&&j.position>first.position));
});
test('zero subscriptions preserve work; new slots fill automatically',()=>{
 let s=createDemo(50,0);const queued=s.jobs.filter(j=>j.status==='queued').length;s=tickDemo(s,new Date(Date.now()+86400000));
 assert.equal(s.jobs.filter(j=>j.status==='queued').length,queued);assert.equal(occupiedDevices(s).size,0);
 s.workspace.capacity=5;s=tickDemo(s,new Date(Date.now()+86401000));assert.equal(occupiedDevices(s).size,5);
});
