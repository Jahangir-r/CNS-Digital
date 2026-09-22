import test from 'node:test';
import express from 'express';
import session from 'express-session';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {createRunRouter} from '../src/checklists/run-routes.js';
import {createReportLinkRouter} from '../src/checklists/report-link-routes.js';
import {createTemplateRouter} from '../src/checklists/template-routes.js';
import {scheduleFixture} from './fixtures/checklist-schedule.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import {ChecklistBackup} from '../src/checklists/backup.js';
import {readChecklistSnapshot,buildChecklistWorkbook} from '../src/checklists/backup-excel.js';
import {reportLinkEnv} from './fixtures/report-link-env.js';
import {localDate} from '../src/local-time.js';
import {createTemplateService} from '../src/checklists/templates.js';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function setup(t:any,options:any={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cns-checklist-backup-')),env=reportLinkEnv(path.join(root,'jurnal.db'),path.join(root,'checklist.db'));
 let at=new Date(2026,8,20,0,15,42,123);const events:any[]=[],directory=path.join(root,'Backup','Checklist');
 const manager=new ChecklistBackup(env.db,directory,e=>events.push(e),{now:()=>at,debounceMs:20,maxDelayMs:80,checkMs:40,applicationVersion:'test',...options});
 t.after(async()=>{await manager.stop();env.close();await fs.rm(root,{recursive:true,force:true});});
 return {...env,root,directory,events,manager,date:()=>at,setDate:(value:Date)=>{at=value;},dbFile:()=>path.join(directory,'Database',`checklist-${localDate(at)}.db`),excelFile:()=>path.join(directory,'Excel',`Checklist-${localDate(at)}.xlsx`)};
}
const actor={id:1,username:'tech',full_name:'Texnik',view_checklists:true,create_checklists:true,edit_own_checklists:true,manage_checklists:false};
test('acceptance: online WAL backup, standalone restore, human Excel, history, links, daily overwrite and rollover',async t=>{
 const e=await setup(t);e.db.pragma('wal_autocheckpoint=0');const section=e.runs.section(e.run.id,(e.run.sections[1] as any).id,actor) as any;
 e.execution.item(e.run.id,section.items[0].id,{expectedRevision:1,result:'na',comment:'Moved'},actor);
 e.links.create(e.run.id,e.itemId,e.user(),{});e.execution.complete(e.run.id,actor);
 const templates=createTemplateService(e.db),v=templates.clone(e.run.template_version_id,1);templates.publish(v.id,1,1);
 // Include a soft-deleted run and an OK answer in the emergency export.
 const extra=e.createRun(2);e.db.prepare("UPDATE checklist_run_items SET result='ok' WHERE id=?").run(extra.itemId);
 e.runs.remove(extra.run.id,{...actor,id:6,manage_checklists:true},'Historical deletion');
 await e.manager.checkDaily();
 assert.ok((await fs.stat(e.dbFile())).size>0);assert.ok((await fs.stat(e.excelFile())).size>0);
 const copy=new Database(e.dbFile(),{readonly:true});try{
  assert.equal(copy.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(copy.pragma('foreign_key_check'),[]);
  const sourceTables=e.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();assert.deepEqual(copy.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),sourceTables);
  for(const {name} of sourceTables as {name:string}[])assert.deepEqual(copy.prepare(`SELECT * FROM ${name}`).all(),e.db.prepare(`SELECT * FROM ${name}`).all());
  assert.equal((copy.prepare('SELECT COUNT(*) n FROM checklist_report_links').get() as any).n,1);
 }finally{copy.close();}
 const book=new ExcelJS.Workbook();await book.xlsx.readFile(e.excelFile());assert.deepEqual(book.worksheets.map(w=>w.name),['Xülasə','Yoxlamalar','Mövqelər','Yoxlama bəndləri','Problemlər','Şablon versiyaları','Şablon strukturu','Növbələr','Backup məlumatı']);
 const all=JSON.stringify(book.worksheets.map(s=>s.getSheetValues()));assert.ok(all.includes('SECRET_PROBLEM'));assert.ok(all.includes('Moved'));assert.ok(all.includes('Texnik'));assert.ok(all.includes('1.1'));assert.ok(all.includes('Şablon hash'));assert.ok(!all.includes('password'));
 assert.equal(book.getWorksheet('Problemlər')!.rowCount,3);assert.equal(book.getWorksheet('Şablon versiyaları')!.rowCount,3);assert.equal(book.getWorksheet('Yoxlamalar')!.rowCount,3);
 const old=await fs.readFile(e.excelFile());e.execution.item(e.run.id,e.itemId,{expectedRevision:2,result:'ok'},actor);e.manager.request();await e.manager.flush();assert.notDeepEqual(await fs.readFile(e.excelFile()),old);
 assert.deepEqual((await fs.readdir(path.join(e.directory,'Database'))),[`checklist-${localDate(e.date())}.db`]);
 const previous=localDate(e.date());e.setDate(new Date(2026,8,21,0,0,1));await e.manager.checkDaily();assert.ok((await fs.stat(e.dbFile())).size);assert.ok((await fs.stat(e.excelFile())).size);
 assert.ok((await fs.readdir(path.join(e.directory,'Excel'))).includes(`Checklist-${previous}.xlsx`));assert.ok(e.events.some(e=>e.event==='CHECKLIST_BACKUP_ROLLOVER'));
 assert.ok(e.events.some(e=>e.module==='CHECKLIST'&&e.filename&&typeof e.duration_ms==='number'));
});
test('snapshot is detached and consistent before slow Excel serialization; changes during backup trigger another pass',async t=>{
 let writes=0,entered!:()=>void,release!:()=>void;const enteredPromise=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const e=await setup(t,{writeExcel:async(book:ExcelJS.Workbook,file:string)=>{writes++;if(writes===1){entered();await gate;}await book.xlsx.writeFile(file);}});
 const snapshot=readChecklistSnapshot(e.db);const initial=snapshot.checklist_run_items.find(i=>i.id===e.itemId)!.comment;
 const work=e.manager.flush();await enteredPromise;
 e.db.prepare('UPDATE checklist_run_items SET comment=? WHERE id=?').run('Newest committed comment',e.itemId);
 assert.equal(snapshot.checklist_run_items.find(i=>i.id===e.itemId)!.comment,initial);
 release();await work;assert.equal(writes,2);const book=new ExcelJS.Workbook();await book.xlsx.readFile(e.excelFile());assert.ok(JSON.stringify(book.getWorksheet('Yoxlama bəndləri')!.getSheetValues()).includes('Newest committed comment'));
});
test('debounce coalesces frequent changes and max delay prevents starvation',async t=>{
 const e=await setup(t);await e.manager.flush();const first=e.events.filter(e=>e.event==='CHECKLIST_BACKUP_EXCEL_SUCCESS').length;
 for(let n=0;n<20;n++)e.manager.request();await delay(60);await e.manager.flush();assert.equal(e.events.filter(e=>e.event==='CHECKLIST_BACKUP_EXCEL_SUCCESS').length,first+1);
 const before=e.events.filter(e=>e.event==='CHECKLIST_BACKUP_EXCEL_SUCCESS').length;
 const interval=setInterval(()=>e.manager.request(),8);await delay(145);clearInterval(interval);await e.manager.flush();assert.ok(e.events.filter(e=>e.event==='CHECKLIST_BACKUP_EXCEL_SUCCESS').length>before);
});
test('Excel/DB failure preserves prior files, cleans temporary files, retries and never undoes the saved answer',async t=>{
 let failExcel=false,failDb=false;const e=await setup(t,{writeExcel:async(book:ExcelJS.Workbook,file:string)=>{if(failExcel){await fs.writeFile(file,'partial');throw Object.assign(Error('private data'),{code:'EIO'});}await book.xlsx.writeFile(file);},writeDatabase:async(file:string)=>{if(failDb){await fs.writeFile(file,'partial');throw Object.assign(Error('private data'),{code:'ENOSPC'});}await e.db.backup(file);}});
 await e.manager.flush();const dbBefore=await fs.readFile(e.dbFile()),excelBefore=await fs.readFile(e.excelFile());failExcel=true;failDb=true;
 const answer=e.execution.item(e.run.id,e.itemId,{expectedRevision:2,comment:'Saved despite backup failure'},actor);assert.equal(answer.run.id,e.run.id);e.manager.request();await e.manager.flush();
 assert.deepEqual(await fs.readFile(e.dbFile()),dbBefore);assert.deepEqual(await fs.readFile(e.excelFile()),excelBefore);
 assert.equal((e.db.prepare('SELECT comment FROM checklist_run_items WHERE id=?').get(e.itemId) as any).comment,'Saved despite backup failure');
 assert.ok(e.events.some(e=>e.event==='CHECKLIST_BACKUP_DB_ERROR'&&e.error_code==='ENOSPC'));assert.ok(e.events.some(e=>e.event==='CHECKLIST_BACKUP_EXCEL_ERROR'&&e.error_code==='EIO'));assert.ok(!JSON.stringify(e.events).includes('private data'));
 for(const dir of ['Excel','Database'])assert.ok((await fs.readdir(path.join(e.directory,dir))).every(n=>!n.startsWith('.')));
 failExcel=false;failDb=false;await e.manager.checkDaily();assert.notDeepEqual(await fs.readFile(e.excelFile()),excelBefore);
});
test('startup, timer-only rollover, missing file recovery and final shutdown flush',async t=>{
 const e=await setup(t);e.manager.start();await e.manager.checkDaily();await fs.unlink(e.excelFile());await e.manager.checkDaily();assert.ok((await fs.stat(e.excelFile())).size);
 e.setDate(new Date(2026,8,22,0,1));await delay(100);await e.manager.flush();assert.ok((await fs.stat(e.dbFile())).size);
 e.db.prepare("UPDATE checklist_run_items SET comment='Final shutdown state' WHERE id=?").run(e.itemId);await e.manager.stop();
 const copy=new Database(e.dbFile(),{readonly:true});assert.equal((copy.prepare('SELECT comment FROM checklist_run_items WHERE id=?').get(e.itemId) as any).comment,'Final shutdown state');copy.close();
});
test('shutdown timeout is bounded and late writer cannot replace published backup',async t=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);const e=await setup(t,{shutdownMs:30,writeExcel:async(book:ExcelJS.Workbook,file:string)=>{await gate;await book.xlsx.writeFile(file);}});
 const running=e.manager.flush();await delay(20);const start=Date.now();await e.manager.stop();assert.ok(Date.now()-start<500);release();await running;
 assert.ok(e.events.some(e=>e.error_code==='SHUTDOWN_TIMEOUT'));await assert.rejects(fs.access(e.excelFile()));
});
test('local filenames use server calendar date, not UTC date',async t=>{
 const e=await setup(t);await e.manager.flush();assert.ok(e.dbFile().endsWith(`checklist-${localDate(e.date())}.db`));
 const book=buildChecklistWorkbook(readChecklistSnapshot(e.db),{at:e.date(),source:e.db.name,databaseFile:'test.db',excelFile:'test.xlsx'});
 assert.ok(JSON.stringify(book.getWorksheet('Backup məlumatı')!.getSheetValues()).includes(e.date().toISOString()));
 if(e.date().getTimezoneOffset()!==0)assert.notEqual(localDate(e.date()),e.date().toISOString().slice(0,10));
});

test('HTTP commit observer backs up templates, schedules, answers and partial report-link failure without affecting responses',async t=>{
 let failExcel=false;const e=await setup(t,{writeExcel:async(book:ExcelJS.Workbook,file:string)=>{if(failExcel)throw Object.assign(Error('disk'),{code:'EIO'});await book.xlsx.writeFile(file);}});
 e.journal.exec("ALTER TABLE roles ADD COLUMN manage_checklist_templates INTEGER DEFAULT 0; ALTER TABLE roles ADD COLUMN manage_checklist_shifts INTEGER DEFAULT 0; UPDATE roles SET manage_checklist_templates=1,manage_checklist_shifts=1 WHERE name='admin'");
 const app=express();app.use(e.manager.middleware());app.use(express.json());app.use(session({secret:'test',resave:false,saveUninitialized:false}));
 app.use('/api',createTemplateRouter({available:true,db:e.db},e.auth,{write(){}}));app.use('/api',createRunRouter({available:true,db:e.db},e.auth,{write(){}},e.now));app.use('/api',createReportLinkRouter({available:true,db:e.db},e.journal,e.auth,{write(){}},()=>{},e.now));
 app.use((_e:unknown,_q:express.Request,s:express.Response,_n:express.NextFunction)=>s.status(500).json({error:'test'}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const call=async(url:string,method:string,body:unknown)=>{const r=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`+url,{method,headers:{'Content-Type':'application/json','X-CNS-Token':e.auth.signAuthToken(6)},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 await e.manager.checkDaily();
 const template=await call('/checklist-templates','POST',{code:'BACKUP_TEST',name:'New draft'});assert.equal(template.status,201);
 const schedule=await call('/checklist-shift-schedules','POST',{...scheduleFixture,effective_from:'2026-09-20T04:00:00.000Z'});assert.equal(schedule.status,201);
 assert.equal((await call(`/checklist-shift-schedules/${schedule.body.id}/publish`,'POST',{revision:1})).status,200);
 failExcel=true;assert.equal((await call(`/checklists/${e.run.id}/items/${e.itemId}`,'PATCH',{expectedRevision:2,comment:'HTTP commit survived'})).status,200);await e.manager.flush();assert.ok(e.events.some(e=>e.event==='CHECKLIST_BACKUP_EXCEL_ERROR'));
 e.db.exec("CREATE TRIGGER fail_link_backup BEFORE UPDATE OF state ON checklist_report_links WHEN NEW.state='linked' BEGIN SELECT RAISE(ABORT,'test'); END");
 assert.equal((await call(`/checklists/${e.run.id}/items/${e.itemId}/report`,'POST',{})).status,500);
 failExcel=false;await e.manager.flush();const copy=new Database(e.dbFile(),{readonly:true});try{
 assert.ok(copy.prepare("SELECT 1 FROM checklist_templates WHERE code='BACKUP_TEST'").get());assert.ok(copy.prepare('SELECT 1 FROM checklist_shift_schedule_versions WHERE id=?').get(schedule.body.id));
 assert.equal((copy.prepare('SELECT comment FROM checklist_run_items WHERE id=?').get(e.itemId) as any).comment,'HTTP commit survived');
 assert.equal((copy.prepare('SELECT state FROM checklist_report_links').get() as any).state,'error');
 }finally{copy.close();}
});

test('rollover during active backup publishes both files for the new day',async t=>{
 let enter!:()=>void,release!:()=>void,calls=0;const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
 const e=await setup(t,{writeDatabase:async(file:string)=>{if(++calls===1){enter();await gate;}await e.db.backup(file);}});
 const work=e.manager.flush();await entered;e.setDate(new Date(2026,8,21,0,0,1));const check=e.manager.checkDaily();release();await Promise.all([work,check]);
 assert.ok((await fs.stat(e.dbFile())).size);assert.ok((await fs.stat(e.excelFile())).size);assert.equal(calls,2);
});
