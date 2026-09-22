import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import express from 'express';
import session from 'express-session';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {reportLinkEnv} from './fixtures/report-link-env.js';
import {migrateReportRequests} from '../src/reports/migrations.js';
import {migrateChecklistDatabase} from '../src/checklists/migrations.js';
import {createReportLinkRouter} from '../src/checklists/report-link-routes.js';
import {BackupManager} from '../src/backup.js';
import {localDate,localTimestamp} from '../src/local-time.js';
async function fixture(t:any,missing=false,failAudit=false){
 const e=reportLinkEnv(':memory:',':memory:',missing),root=await fs.mkdtemp(path.join(os.tmpdir(),'cns-links-'));
 const audit:any[]=[],backup=new BackupManager(e.journal,path.join(root,'Backup'),x=>audit.push(x));let backupCalls=0,dropNext=false;
 const app=express();app.use((q,s,n)=>{const json=s.json;s.json=function(body){if(dropNext&&q.method==='POST'&&q.path.endsWith('/report')){dropNext=false;s.destroy();return s;}return json.call(this,body);};n();});app.use(express.json());app.use(session({secret:'test-only',resave:false,saveUninitialized:false}));
 app.use('/api',createReportLinkRouter({available:true,db:e.db},e.journal,e.auth,{write(x){if(failAudit)throw Error('audit failed');audit.push(x);}},()=>{backupCalls++;backup.requestExcel();},e.now));
 app.post('/api/reports',e.auth.requireAuth,(q,s,n)=>{try{s.json(e.reports.createManual(s.locals.user,q.body));}catch(error:any){s.status(error.status??500).json({error:error.message});}});
 app.use((err:any,_q:express.Request,s:express.Response,_n:express.NextFunction)=>s.status(err.status??500).json({error:err.status?err.message:'internal'}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await backup.stop();e.close();await fs.rm(root,{recursive:true,force:true});});
 const call=async(method='POST',body:unknown={},user=1,url=`/api/checklists/${e.run.id}/items/${e.itemId}/report`)=>{const r=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`+url,{method,headers:{'Content-Type':'application/json','X-CNS-Token':e.auth.signAuthToken(user)},body:method==='GET'?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 return {...e,call,audit,backup,root,backupCalls:()=>backupCalls,dropNextResponse:()=>{dropNext=true;}};
}
test('API acceptance: snapshot autofill, retries, relation GET, permission separation, retained link and deleted report',async t=>{
 const e=await fixture(t);
 for(const user of [3,4,5])assert.equal((await e.call('POST',{},user)).status,403);
 assert.equal((await e.call('POST',{},2)).status,403);
 assert.equal((await e.call('POST',{},1,'/api/reports')).status,403);
 const manual=await e.call('POST',{xidmet:'Manual',sistem:'System',nasazliq:'Issue',nasazliq_vaxti:'2026-09-19 09:00'},5,'/api/reports');assert.equal(manual.status,200);
 const first=await e.call();assert.equal(first.status,201);assert.equal(first.body.state,'linked');
 const report=e.journal.prepare('SELECT * FROM reports WHERE id=?').get(first.body.report_id) as any;
 assert.equal(report.user_id,1);assert.equal(report.xidmet,'CES');assert.equal(report.obyekt,'Bakı');assert.equal(report.sistem,'SUP/APP / SDD');assert.equal(report.nasazliq,'SECRET_PROBLEM');assert.equal(report.nasazliq_vaxti,localTimestamp(e.now()).slice(0,16));
 const retry=await e.call();assert.equal(retry.status,200);assert.equal(retry.body.report_id,first.body.report_id);
 const read=await e.call('GET',{},3);assert.equal(read.status,200);assert.equal(read.body.can_view_report,false);assert.equal(read.body.nasazliq,undefined);
 const actor={id:1,username:'tech',full_name:'Texnik',view_checklists:true,create_checklists:true,edit_own_checklists:true,manage_checklists:false};
 e.execution.item(e.run.id,e.itemId,{expectedRevision:2,result:'ok'},actor);assert.equal((await e.call()).body.report_id,first.body.report_id);
 e.journal.prepare('DELETE FROM reports WHERE id=?').run(first.body.report_id);assert.equal((await e.call('GET')).body.state,'deleted');assert.equal((await e.call()).body.state,'deleted');
 assert.equal((e.journal.prepare('SELECT COUNT(*) n FROM report_creation_requests').get() as any).n,1);
 assert.equal((e.journal.prepare('SELECT COUNT(*) n FROM reports').get() as any).n,1,'only manual report remains');
 assert.ok(!JSON.stringify(e.audit).includes('SECRET_PROBLEM'));assert.ok(e.audit.some(a=>a.event==='REPORT_CREATE_FROM_CHECKLIST'&&a.operation_id));assert.ok(e.audit.some(a=>a.event==='REPORT_CREATE'));
 await e.backup.flush();assert.ok(e.backupCalls()>=1);assert.ok((await fs.stat(path.join(e.root,'Backup','Excel',`CNS-Jurnal-${localDate()}.xlsx`))).size>0);
});
test('missing fields, invalid results, foreign IDs, expiry, Engineer and historical Admin',async t=>{
 const e=await fixture(t,true);const missing=await e.call();assert.equal(missing.status,422);assert.deepEqual(missing.body.missing_fields,[{key:'xidmet',label:'Xidmət'}]);
 assert.equal((e.db.prepare('SELECT COUNT(*) n FROM checklist_report_links').get() as any).n,0);
 assert.equal((await e.call('POST',{xidmet:'CES',nasazliq_vaxti:'spoof'})).status,422);
 for(const result of ['ok','na',null]){e.db.prepare('UPDATE checklist_run_items SET result=? WHERE id=?').run(result,e.itemId);assert.equal((await e.call('POST',{xidmet:'CES'})).status,422);}
 e.db.prepare("UPDATE checklist_run_items SET result='problem',comment=' ' WHERE id=?").run(e.itemId);assert.equal((await e.call('POST',{xidmet:'CES'})).status,422);
 e.db.prepare("UPDATE checklist_run_items SET comment='Restored issue' WHERE id=?").run(e.itemId);
 const other=e.createRun(2);assert.equal((await e.call('POST',{xidmet:'CES'},1,`/api/checklists/${e.run.id}/items/${other.itemId}/report`)).status,404);
 assert.equal((await e.call('POST',{xidmet:'CES'},2,`/api/checklists/${other.run.id}/items/${other.itemId}/report`)).status,201);
 e.set('2026-09-19T16:00:01Z');assert.equal((await e.call('POST',{xidmet:'CES'})).status,403);assert.equal((await e.call('POST',{xidmet:'CES'},6)).status,201);
});
test('fault: journal commit succeeds, checklist link update fails; retry recovers without duplicate',async t=>{
 const e=await fixture(t);e.db.exec("CREATE TRIGGER fail_link BEFORE UPDATE OF state ON checklist_report_links WHEN NEW.state='linked' BEGIN SELECT RAISE(ABORT,'fault'); END");
 assert.equal((await e.call()).status,500);const pending=e.db.prepare('SELECT * FROM checklist_report_links').get() as any;
 assert.equal(pending.state,'error');assert.equal((e.journal.prepare('SELECT COUNT(*) n FROM reports').get() as any).n,1);assert.equal(e.backupCalls(),1);
 e.db.exec('DROP TRIGGER fail_link');const retry=await e.call();assert.equal(retry.status,200);assert.equal(retry.body.recovered,true);assert.equal(retry.body.operation_id,pending.operation_id);assert.equal((e.journal.prepare('SELECT COUNT(*) n FROM reports').get() as any).n,1);
 assert.ok(e.audit.some(a=>a.event==='REPORT_LINK_ERROR'));assert.ok(e.audit.some(a=>a.event==='REPORT_LINK_RECOVERED'));
});
test('fault: pending intent survives failed report insert and request insert rollback; same operation retries',async t=>{
 const e=await fixture(t);e.journal.exec("CREATE TRIGGER fail_report BEFORE INSERT ON reports BEGIN SELECT RAISE(ABORT,'fault'); END");assert.equal((await e.call()).status,500);
 const op=(e.db.prepare('SELECT operation_id FROM checklist_report_links').get() as any).operation_id;e.journal.exec('DROP TRIGGER fail_report');
 e.journal.exec("CREATE TRIGGER fail_request BEFORE INSERT ON report_creation_requests BEGIN SELECT RAISE(ABORT,'fault'); END");assert.equal((await e.call()).status,500);assert.equal((e.journal.prepare('SELECT COUNT(*) n FROM reports').get() as any).n,0);
 e.journal.exec('DROP TRIGGER fail_request');assert.equal((await e.call()).body.operation_id,op);assert.equal((await e.call()).body.operation_id,op);
 assert.equal((e.journal.prepare('SELECT COUNT(*) n FROM reports').get() as any).n,1);
});
test('concurrent HTTP calls, audit failure and migration repeat preserve one operation',async t=>{
 const e=await fixture(t,false,true);const results=await Promise.all([e.call(),e.call()]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(results[0].body.report_id,results[1].body.report_id);
 migrateChecklistDatabase(e.db);migrateReportRequests(e.journal);assert.equal((e.journal.prepare('SELECT COUNT(*) n FROM report_creation_requests').get() as any).n,1);
 assert.deepEqual((e.journal.pragma('table_info(report_creation_requests)') as any[]).map(c=>c.name),['request_id','report_id','actor_user_id','created_at']);
 assert.throws(()=>e.journal.exec('DELETE FROM report_creation_requests'));assert.throws(()=>e.db.exec('DELETE FROM checklist_report_links'));assert.throws(()=>e.db.exec("UPDATE checklist_report_links SET operation_id='hacked'"));
});
test('independent concurrent processes use one journal report and one operation',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cns-links-processes-')),jf=path.join(root,'jurnal.db'),cf=path.join(root,'checklist.db'),e=reportLinkEnv(jf,cf);
 t.after(async()=>{e.close();await fs.rm(root,{recursive:true,force:true});});const args=['node_modules/tsx/dist/cli.mjs','test/fixtures/report-link-worker.ts',jf,cf,e.run.id,e.itemId];
 const exec=promisify(execFile),results=await Promise.all([exec(process.execPath,args),exec(process.execPath,args)]);const rows=results.map(r=>JSON.parse(r.stdout));assert.equal(rows[0].report_id,rows[1].report_id);assert.equal(rows[0].operation_id,rows[1].operation_id);
 assert.equal((e.journal.prepare('SELECT COUNT(*) n FROM reports').get() as any).n,1);
});

test('lost successful HTTP response retries the same report; pending also survives an unwritable link row',async t=>{
 const e=await fixture(t);e.dropNextResponse();await assert.rejects(()=>e.call());assert.equal((e.journal.prepare('SELECT COUNT(*) n FROM reports').get() as any).n,1);
 const retry=await e.call();assert.equal(retry.status,200);assert.equal(retry.body.created,false);
 const second=e.createRun(2),url=`/api/checklists/${second.run.id}/items/${second.itemId}/report`;
 e.db.exec("CREATE TRIGGER fail_all_link_updates BEFORE UPDATE ON checklist_report_links BEGIN SELECT RAISE(ABORT,'fault'); END");
 assert.equal((await e.call('POST',{},2,url)).status,500);assert.equal((e.db.prepare('SELECT state FROM checklist_report_links WHERE run_item_id=?').get(second.itemId) as any).state,'pending');
 e.db.exec('DROP TRIGGER fail_all_link_updates');assert.equal((await e.call('POST',{},2,url)).body.recovered,true);
 assert.equal((e.journal.prepare('SELECT COUNT(*) n FROM reports').get() as any).n,2);
 e.runs.remove(second.run.id,{id:6,username:'admin',full_name:'Admin',view_checklists:true,create_checklists:true,edit_own_checklists:true,manage_checklists:true},'Test deletion');
 assert.equal((await e.call('POST',{},6,url)).status,403);
});
