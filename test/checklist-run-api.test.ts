import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import express from 'express';
import session from 'express-session';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {createAuthService} from '../src/auth.js';
import {createRunRouter} from '../src/checklists/run-routes.js';
import {createTemplateRouter} from '../src/checklists/template-routes.js';
import {createTemplateService} from '../src/checklists/templates.js';
import {migrateChecklistDatabase} from '../src/checklists/migrations.js';
import {scheduleFixture} from './fixtures/checklist-schedule.js';
import {templateFixture} from './fixtures/checklist-template.js';
async function fixture(t:any,available=true,failAudit=false){
 const db=new Database(':memory:'),journal=new Database(':memory:');db.pragma('foreign_keys=ON');migrateChecklistDatabase(db);
 journal.exec(`CREATE TABLE roles(name TEXT PRIMARY KEY,view_checklists INTEGER,create_checklists INTEGER,edit_own_checklists INTEGER,manage_checklists INTEGER,manage_checklist_templates INTEGER,manage_checklist_shifts INTEGER);
 INSERT INTO roles VALUES('admin',1,1,1,1,1,1),('tech',1,1,1,0,0,0),('reader',1,0,0,0,0,0),('templates',1,0,0,0,1,0),('shifts',1,0,0,0,0,1),('none',0,0,0,0,0,0);
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,active INTEGER DEFAULT 1,deleted INTEGER DEFAULT 0);
 INSERT INTO users(id,username,full_name,role) VALUES(1,'admin','Admin','admin'),(2,'tech','Texnik','tech'),(3,'reader','Reader','reader'),(4,'templates','Templates','templates'),(5,'shifts','Shifts','shifts'),(6,'none','None','none');`);
 let instant=new Date('2026-09-19T00:00:00Z');const audit:any[]=[];const logger={write(e:any){if(failAudit)throw Error('audit disk failure');audit.push(e);}};
 const auth=createAuthService(journal,'test-only'),app=express();app.use(express.json());app.use(session({secret:'test-only',resave:false,saveUninitialized:false}));
 const storage=available?{available:true as const,db}:{available:false as const,db:null};
 app.use('/api',createTemplateRouter(storage,auth,logger));app.use('/api',createRunRouter(storage,auth,logger,()=>instant));
 app.use((_e:unknown,_q:express.Request,s:express.Response,_next:express.NextFunction)=>s.status(500).json({error:'internal'}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close();journal.close();});
 const call=async(url:string,method='GET',body?:unknown,user=1)=>{const r=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`+url,{method,headers:{'Content-Type':'application/json',...(user?{'X-CNS-Token':auth.signAuthToken(user)}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const templates=createTemplateService(db);let v=templates.create({code:'DAILY',name:'Daily'},1);v=templates.update(v.id,{...templateFixture,revision:1});v=templates.publish(v.id,2,1);
 return {call,db,journal,audit,v,set:(d:string)=>{instant=new Date(d);}};
}

test('schedule and run API: permissions, safe context, duplicate POST, snapshots and audit',async t=>{
 const {call,db,journal,audit,v,set}=await fixture(t);
 assert.equal((await call('/checklists/context','GET',undefined,0)).status,401);
 assert.equal((await call('/checklists/context','GET',undefined,6)).status,403);
 assert.equal((await call('/checklists/context','GET',undefined,3)).body.can_create,false);
 assert.equal((await call('/checklists','POST',{},2)).body.error,'Növbə cədvəli təyin edilməyib');
 const s=await call('/checklist-shift-schedules','POST',scheduleFixture,5);assert.equal(s.status,201);
 for(const user of [2,3,4])for(const [url,method,body] of [
 ['/checklist-shift-schedules','GET',undefined],['/checklist-shift-schedules','POST',scheduleFixture],
 [`/checklist-shift-schedules/${s.body.id}`,'GET',undefined],[`/checklist-shift-schedules/${s.body.id}`,'PUT',{...scheduleFixture,revision:1}],
 [`/checklist-shift-schedules/${s.body.id}/publish`,'POST',{revision:1}],[`/checklist-shift-schedules/${s.body.id}/archive`,'POST',{revision:1}]
 ] as const)assert.equal((await call(url,method,body,user)).status,403);
 assert.equal((await call(`/checklist-shift-schedules/${s.body.id}`,'PUT',{...scheduleFixture,revision:99},5)).status,409);
 assert.equal((await call(`/checklist-shift-schedules/${s.body.id}/publish`,'POST',{revision:1},5)).status,200);
 assert.equal((await call(`/checklist-shift-schedules/${s.body.id}/activate`,'POST',{revision:2},5)).status,200);
 assert.equal((await call(`/checklist-shift-schedules/${s.body.id}`,'PUT',{...scheduleFixture,revision:2},5)).status,409);
 set('2026-09-20T01:00:00Z');
 const context=await call('/checklists/context','GET',undefined,2);assert.equal(context.body.can_create,true);assert.equal(context.body.work_date,'2026-09-19');assert.equal(context.body.current_template.version_label,'1.0');assert.equal(context.body.rules,undefined);
 for(const url of [`/checklist-template-versions/${v.id}`,`/checklist-templates/${v.template_id}/versions`])assert.equal((await call(url,'GET',undefined,2)).status,403);
 for(const body of [{user_id:1},{template_version_id:v.id},{shift_period_id:'x'}])assert.equal((await call('/checklists','POST',body,2)).status,422);
 assert.equal((await call('/checklists','POST',{},3)).status,403);
 assert.equal((await call('/checklists','POST',{is_extra:true,override_reason:'request'},2)).status,403);
 const pair=await Promise.all([call('/checklists','POST',{},2),call('/checklists','POST',{},2)]);
 assert.deepEqual(pair.map(r=>r.status).sort(),[200,201]);assert.deepEqual(pair.map(r=>r.body.outcome).sort(),['created','existing']);
 const run=pair[0].body.run;assert.equal(pair[1].body.run.id,run.id);assert.equal(run.user_id,2);assert.equal(run.employee_name_snapshot,'Texnik');
 assert.equal((await call('/checklists/context','GET',undefined,2)).body.existing_run_id,run.id);
 assert.equal((await call('/checklists','POST',{is_extra:true},1)).status,422);
 assert.equal((await call('/checklists','POST',{is_extra:true,override_reason:'Retest'},1)).status,201);
 assert.equal((await call(`/checklists/${run.id}`,'GET',undefined,3)).status,200);
 const section=await call(`/checklists/${run.id}/sections/${run.sections[0].id}`,'GET',undefined,3);assert.equal(section.status,200);assert.equal(section.body.items[0].result,null);
 assert.equal((await call(`/checklists/${run.id}/sections/missing`)).status,404);
 assert.equal((await call('/checklists?page=1&page_size=1&work_date=2026-09-19&user=2','GET',undefined,3)).body.total,1);
 assert.equal((await call('/checklists?page_size=0')).status,422);
 assert.equal((await call(`/checklists/${run.id}`,'DELETE',{delete_reason:'reason'},2)).status,403);
 assert.equal((await call(`/checklists/${run.id}`,'DELETE',{},1)).status,422);
 assert.equal((await call(`/checklists/${run.id}`,'DELETE',{delete_reason:'reason'},1)).status,200);
 assert.equal((await call('/checklists','POST',{},2)).body.outcome,'created');
 assert.equal((await call(`/checklists/${run.id}`,'GET',undefined,3)).status,404);
 assert.equal((await call(`/checklist-shift-schedules/${s.body.id}/archive`,'POST',{revision:2},5)).status,200);
 for(const event of ['CHECKLIST_SHIFT_SCHEDULE_CREATE','CHECKLIST_SHIFT_SCHEDULE_UPDATE','CHECKLIST_SHIFT_SCHEDULE_PUBLISH','CHECKLIST_SHIFT_SCHEDULE_ARCHIVE','CHECKLIST_CREATE','CHECKLIST_ADMIN_EXTRA_CREATE','CHECKLIST_VIEW','CHECKLIST_DELETE'])assert.ok(audit.some(e=>e.event===event),event);
 const created=audit.find(e=>e.event==='CHECKLIST_CREATE'&&e.result==='SUCCESS');assert.equal(created.checklist_id,run.id);assert.equal(created.work_date,'2026-09-19');assert.equal(created.user,'tech');assert.equal(created.template_version,'1.0');assert.ok(created.ip);assert.ok(!JSON.stringify(audit).includes('equipment_name'));
 assert.deepEqual(journal.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'checklist_%'").all(),[]);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_runs WHERE is_extra=0').get() as any).n,2);assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_runs WHERE is_extra=0 AND deleted_at IS NULL').get() as any).n,1);
});

test('unavailable checklist storage returns 503 and audit failure preserves run commit',async t=>{
 const unavailable=await fixture(t,false);assert.equal((await unavailable.call('/checklists/context')).status,503);
 const {call,set}=await fixture(t,true,true);const s=await call('/checklist-shift-schedules','POST',scheduleFixture);assert.equal(s.status,201);
 await call(`/checklist-shift-schedules/${s.body.id}/publish`,'POST',{revision:1});await call(`/checklist-shift-schedules/${s.body.id}/activate`,'POST',{revision:2});set('2026-09-19T05:00:00Z');
 const r=await call('/checklists','POST',{},2);assert.equal(r.status,201);assert.equal((await call(`/checklists/${r.body.run.id}`)).status,200);
});
