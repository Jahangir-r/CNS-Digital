import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {TEMPLATE_SCHEMA} from '../src/checklists/template-schema.js';
import {migrateChecklistDatabase} from '../src/checklists/migrations.js';
import {createShiftService,wallTime,ChecklistError} from '../src/checklists/shifts.js';
import {createRunService,canEditChecklistRun,type RunActor} from '../src/checklists/runs.js';
import {createTemplateService} from '../src/checklists/templates.js';
import {templateFixture} from './fixtures/checklist-template.js';
const owner:RunActor={id:1,username:'tech',full_name:'Original Name',view_checklists:true,create_checklists:true,edit_own_checklists:true,manage_checklists:false};
const admin={...owner,id:2,username:'manager',manage_checklists:true};
import {scheduleFixture} from './fixtures/checklist-schedule.js';

function setup(t:any,filename=':memory:') {
 const db=new Database(filename);db.pragma('foreign_keys=ON');db.pragma('busy_timeout=5000');db.pragma('journal_mode=WAL');migrateChecklistDatabase(db);t.after(()=>db.close());
 let instant=new Date('2026-09-19T00:00:00Z');const now=()=>instant;
 const shifts=createShiftService(db,now),runs=createRunService(db,now),templates=createTemplateService(db);
 function seed(){let v=templates.create({code:'DAILY',name:'Daily'},1);const data=structuredClone(templateFixture);data.sections.push({...structuredClone(data.sections[0]),stable_key:'INACTIVE',sort_order:99,active:false});v=templates.update(v.id,{...data,revision:1});v=templates.publish(v.id,v.revision,1);
 let s=shifts.create(scheduleFixture,1);s=shifts.publish(s.id,s.revision,1);return {v,s};}
 return {db,shifts,runs,templates,seed,set:(s:string)=>{instant=new Date(s);}};
}
const fails=(status:number)=>(e:unknown)=>e instanceof ChecklistError&&e.status===status;

test('schedule lifecycle, revision, SQL immutability, validation and timezone boundaries',t=>{
 const {db,shifts,set}=setup(t);const s=shifts.create(scheduleFixture,1);
 assert.equal(s.status,'draft');assert.equal(s.version,1);
 assert.throws(()=>shifts.update(s.id,{...scheduleFixture,revision:9}),fails(409));
 const edited=shifts.update(s.id,{...scheduleFixture,revision:1});assert.equal(edited.revision,2);
 const published=shifts.publish(s.id,2,1);assert.equal(published.status,'published');
 assert.throws(()=>shifts.update(s.id,{...scheduleFixture,revision:3}),fails(409));
 for(const sql of [`UPDATE checklist_shift_schedule_versions SET timezone='UTC'`,
  `UPDATE checklist_shift_rules SET label='hacked'`,
  `INSERT OR REPLACE INTO checklist_shift_schedule_versions SELECT * FROM checklist_shift_schedule_versions`,
  `INSERT OR REPLACE INTO checklist_shift_rules SELECT * FROM checklist_shift_rules`])assert.throws(()=>db.exec(sql));
 set('2026-09-19T05:15:00Z');const day=shifts.resolveCurrentShift();assert.equal(day.label_snapshot,'Gündüz');assert.equal(day.work_date,'2026-09-19');assert.equal(day.starts_at,'2026-09-19T04:00:00.000Z');
 assert.deepEqual(shifts.resolveCurrentShift(),day);
 set('2026-09-20T01:00:00Z');const night=shifts.resolveCurrentShift();assert.equal(night.shift_key,'NIGHT');assert.equal(night.work_date,'2026-09-19');assert.equal(night.ends_at,'2026-09-20T04:00:00.000Z');assert.equal(night.edit_until,night.ends_at);
 set('2026-09-20T04:00:00Z');assert.equal(shifts.resolveCurrentShift().shift_key,'DAY');
 assert.equal(wallTime('2026-01-02','09:00','Asia/Tokyo'),'2026-01-02T00:00:00.000Z');
 assert.throws(()=>wallTime('2026-03-08','02:30','America/New_York'),fails(409));assert.throws(()=>wallTime('2026-11-01','01:30','America/New_York'),fails(409));
 const bad={...scheduleFixture,rules:[scheduleFixture.rules[0],{...scheduleFixture.rules[0],shift_key:'OTHER',sort_order:2}]};const badDraft=shifts.create(bad,1);assert.throws(()=>shifts.publish(badDraft.id,1,1),fails(422));
 assert.throws(()=>shifts.create({...scheduleFixture,timezone:'Invalid/Zone'},1),fails(422));
 shifts.archive(s.id,3,1);assert.throws(()=>shifts.current(),fails(409));assert.throws(()=>db.exec("UPDATE checklist_shift_schedule_versions SET archived_by=9"));
});

test('run acceptance: template v1.0 and shift S1 snapshots survive v1.1 and S2',t=>{
 const {db,shifts,runs,templates,seed,set}=setup(t);const {v,s}=seed();set('2026-09-20T01:00:00Z');
 const first=runs.create(owner,{});assert.equal(first.outcome,'created');const id=first.run.id;
 const ownerContext=runs.context(owner),otherContext=runs.context({...owner,id:9,username:'other'});
 assert.equal(ownerContext.existing_run_owner,true);assert.equal(ownerContext.existing_run_can_edit,true);assert.equal(ownerContext.existing_run_status,'in_progress');
 assert.equal(otherContext.existing_run_owner,false);assert.equal(otherContext.existing_run_can_edit,false);
 assert.equal(first.run.template_version_snapshot,'1.0');assert.equal(first.run.template_content_hash,v.content_hash);
 assert.equal(first.run.employee_name_snapshot,owner.full_name);assert.equal(first.run.username_snapshot,owner.username);
 assert.equal(first.run.work_date,'2026-09-19');assert.equal(first.run.local_date,'2026-09-20');assert.equal(first.run.shift_label_snapshot,'Gecə');
 assert.equal(first.run.timezone_snapshot,'Asia/Baku');assert.equal(first.run.started_local_at,'2026-09-20T05:00:00');assert.equal(first.run.sections.length,2);
 const section=runs.section(id,(first.run.sections[0] as any).id,owner) as any;assert.equal(section.items.length,1);assert.equal(section.items[0].result,null);
 assert.equal(section.name_snapshot,v.sections[0].name);assert.equal(section.items[0].name_snapshot,v.sections[0].items[0].name);
 const frozen=JSON.stringify({...first.run,can_edit:undefined,server_time:undefined}),frozenSection=JSON.stringify(section);
 let clone=templates.clone(v.id,1);const changed=structuredClone(templateFixture);changed.sections[0].name='Changed';clone=templates.update(clone.id,{...changed,revision:1});templates.publish(clone.id,clone.revision,1);
 let next=shifts.create({based_on_version_id:s.id,effective_from:'2026-09-20T04:00:00.000Z',cycle_anchor:'2026-09-20T04:00:00.000Z'},1);
 next=shifts.update(next.id,{...next,revision:1,rules:next.rules.map(r=>({...r,label:'New '+r.label}))});shifts.publish(next.id,next.revision,1);
 set('2026-09-21T05:00:00Z');assert.equal(JSON.stringify({...runs.get(id,{...owner,full_name:'Renamed'}),can_edit:undefined,server_time:undefined}),frozen);
 assert.equal(JSON.stringify(runs.section(id,section.id,owner)),frozenSection);
 const second=runs.create(owner,{});assert.equal(second.run.template_version_snapshot,'1.1');assert.equal(second.run.shift_label_snapshot,'New Gündüz');
 assert.equal(runs.get(id,owner).can_edit,false);assert.equal(runs.get(id,admin).can_edit,true);
 assert.equal(runs.list(owner,{page:'1',page_size:'1'}).total,2);assert.equal(runs.list(owner,{work_date:'2026-09-19',template_version:'1.0',user:'1',shift:'Gecə',status:'in_progress'}).rows.length,1);
 for(const table of ['checklist_shift_periods','checklist_runs','checklist_run_sections','checklist_run_items'])assert.throws(()=>db.exec(`DELETE FROM ${table}`));
 assert.throws(()=>db.exec("UPDATE checklist_runs SET work_date='2026-01-01'"));assert.throws(()=>db.exec("UPDATE checklist_run_items SET name_snapshot='hacked'"));
 migrateChecklistDatabase(db);assert.equal(runs.get(id,owner).template_version_snapshot,'1.0');assert.deepEqual(db.pragma('foreign_key_check'),[]);
});

test('31-day retention archives old history without deleting snapshots or report-safe run data',t=>{
 const {db,runs,seed,set}=setup(t);seed();
 const ids:string[]=[];
 for(let day=0;day<35;day++){
  const at=new Date(Date.UTC(2026,8,19+day,5));set(at.toISOString());
  ids.push(runs.create(owner,{}).run.id);
 }
 set('2026-10-23T05:00:00.000Z');
 const result=runs.archiveExpired();
 assert.equal(result.cutoff,'2026-09-23');assert.equal(result.count,4);
 assert.equal(runs.list(owner,{page:1,page_size:100}).total,31);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_runs').get() as any).n,35,'retention never physically deletes historical runs');
 assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_run_sections').get() as any).n,70);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_run_items').get() as any).n,70);
 assert.ok((db.prepare('SELECT retention_archived_at FROM checklist_runs WHERE id=?').get(ids[0]) as any).retention_archived_at);
 assert.equal(runs.archiveExpired().count,0,'cleanup is idempotent');
 assert.deepEqual(db.pragma('foreign_key_check'),[]);
});

test('missing config, duplicate, spoofing, extra, deleted slot and edit permissions',t=>{
 const {db,shifts,runs,templates,set}=setup(t);
 assert.throws(()=>runs.create(owner,{}),/Növbə cədvəli təyin edilməyib/);
 let s=shifts.create(scheduleFixture,1);shifts.publish(s.id,1,1);set('2026-09-19T05:00:00Z');
 assert.throws(()=>runs.create(owner,{}),/Aktiv yoxlama şablonu mövcud deyil/);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_shift_periods').get() as any).n,0,'period creation rolls back with missing template');
 let v=templates.create({code:'DAILY',name:'Daily'},1);v=templates.update(v.id,{...templateFixture,revision:1});templates.publish(v.id,2,1);
 for(const body of [{user_id:99},{template_version_id:'x'},{shift_period_id:'x'}])assert.throws(()=>runs.create(owner,body),fails(422));
 assert.throws(()=>runs.create({...owner,view_checklists:false},{}),fails(403));assert.throws(()=>runs.create({...owner,create_checklists:false},{}),fails(403));
 assert.throws(()=>runs.create(owner,{is_extra:true,override_reason:'reason'}),fails(403));assert.throws(()=>runs.create(admin,{is_extra:true}),fails(422));
 const first=runs.create(owner,{});assert.equal(runs.create(owner,{}).outcome,'existing');assert.equal(runs.create(owner,{}).run.id,first.run.id);
 assert.equal(runs.create(admin,{is_extra:true,override_reason:'Retest'}).run.is_extra,1);
 assert.equal(canEditChecklistRun(first.run,owner,new Date(first.run.edit_until_snapshot)),true);
 assert.equal(canEditChecklistRun(first.run,owner,new Date(Date.parse(first.run.edit_until_snapshot)+1)),false);
 assert.equal(canEditChecklistRun(first.run,{...owner,id:99}),false);assert.equal(canEditChecklistRun(first.run,{...owner,edit_own_checklists:false}),false);
 assert.throws(()=>runs.remove(first.run.id,owner,'remove'),fails(403));runs.remove(first.run.id,admin,'Duplicate investigation');
 const recreated=runs.create(owner,{});assert.equal(recreated.outcome,'created');assert.notEqual(recreated.run.id,first.run.id);assert.ok(runs.get(first.run.id,admin).deleted_at);
 assert.equal(canEditChecklistRun(runs.get(first.run.id,admin),admin),false);
 assert.equal(runs.list(owner,{}).total,2);assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_runs WHERE is_extra=0 AND deleted_at IS NULL').get() as any).n,1);
});

test('one active normal checklist per shift period across same-day and midnight boundaries',t=>{
 const {runs,seed,set}=setup(t);seed();
 set('2026-09-20T22:00:00.000Z');
 const afterMidnight=runs.create(owner,{});assert.equal(afterMidnight.outcome,'created');
 set('2026-09-20T19:30:00.000Z');
 const beforeMidnight=runs.create({...owner,id:9,username:'other'},{});assert.equal(beforeMidnight.outcome,'existing');
 assert.equal(beforeMidnight.run.id,afterMidnight.run.id,'23:30 and 02:00 share one ordinary slot');
 assert.equal(runs.context(owner).can_create,false);
 set('2026-09-21T04:00:00.000Z');
 assert.equal(runs.context(owner).can_create,true,'08:00 opens the next shift slot on the same local date');
 const dayShift=runs.create(owner,{});assert.equal(dayShift.outcome,'created');
 assert.notEqual(dayShift.run.id,afterMidnight.run.id);
 assert.notEqual(dayShift.run.shift_period_id,afterMidnight.run.shift_period_id);
 assert.equal(dayShift.run.local_date,afterMidnight.run.local_date);
});

test('schedule activation cannot split an existing shift and no fallback after archive',t=>{
 const {shifts,seed,set}=setup(t);seed();set('2026-09-19T05:00:00Z');
 const middle=shifts.create({...scheduleFixture,effective_from:'2026-09-19T06:00:00.000Z',cycle_anchor:'2026-09-19T06:00:00.000Z'},1);assert.throws(()=>shifts.publish(middle.id,1,1),fails(422));
 const next=shifts.create({...scheduleFixture,effective_from:'2026-09-20T04:00:00.000Z',cycle_anchor:'2026-09-20T04:00:00.000Z'},1);shifts.publish(next.id,1,1);shifts.archive(next.id,2,1);
 assert.throws(()=>shifts.current(),fails(409));set('2026-09-20T05:00:00Z');assert.throws(()=>shifts.current(),fails(409));
});

test('two independent processes create exactly one ordinary run with SQLite locking',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cns-runs-concurrent-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'checklist.db'),{db,seed}=setup(t,file);seed();
 const exec=promisify(execFile);const args=[path.resolve('node_modules/tsx/dist/cli.mjs'),path.resolve('test/fixtures/create-checklist-run.ts'),file];
 const outputs=await Promise.all([exec(process.execPath,args),exec(process.execPath,args)]);
 const results=outputs.map(o=>JSON.parse(o.stdout));assert.equal(results[0].run.id,results[1].run.id);assert.deepEqual(results.map(r=>r.outcome).sort(),['created','existing']);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_runs').get() as any).n,1);assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_shift_periods').get() as any).n,1);
});


test('migration 2 to 3 preserves templates, repeats safely and leaves production tables empty',t=>{
 const db=new Database(':memory:');t.after(()=>db.close());db.pragma('foreign_keys=ON');
 db.exec("CREATE TABLE checklist_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); INSERT INTO checklist_schema_migrations VALUES(1,'init','old'),(2,'templates','old')");
 db.exec(TEMPLATE_SCHEMA);migrateChecklistDatabase(db);const templates=createTemplateService(db);let v=templates.create({code:'OLD',name:'Old'},1);v=templates.update(v.id,{...templateFixture,revision:1});v=templates.publish(v.id,2,1);
 assert.deepEqual(templates.get(v.id),v);assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_runs').get() as any).n,0);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_shift_schedule_versions').get() as any).n,0);
 const ledger=db.prepare('SELECT * FROM checklist_schema_migrations').all();migrateChecklistDatabase(db);assert.deepEqual(db.prepare('SELECT * FROM checklist_schema_migrations').all(),ledger);
});

test('snapshot natural keys cannot be overwritten with INSERT OR REPLACE and rollback is atomic',t=>{
 const {db,runs,seed,set}=setup(t);seed();set('2026-09-19T05:00:00Z');const r=runs.create(owner,{});
 for(const table of ['checklist_runs','checklist_shift_periods','checklist_run_sections','checklist_run_items']) {
  const columns=(db.pragma(`table_info(${table})`) as {name:string}[]).map(c=>c.name);
  const select=columns.map(c=>c==='id'?"'replacement-id'":c).join(',');
  assert.throws(()=>db.exec(`INSERT OR REPLACE INTO ${table} SELECT ${select} FROM ${table} LIMIT 1`));
 }
 db.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON checklist_run_items BEGIN SELECT RAISE(ABORT,'snapshot failure'); END");
 assert.throws(()=>runs.create({...admin,id:99},{is_extra:true,override_reason:'snapshot test'}),/snapshot failure/);
 assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_runs').get() as any).n,1);assert.equal(runs.get(r.run.id,owner).id,r.run.id);
});

test('cyclic schedule and manager-only extra permission',t=>{
 const {shifts,runs,seed,set}=setup(t);seed();set('2026-09-19T05:00:00Z');
 assert.equal(runs.create({...admin,create_checklists:false},{is_extra:true,override_reason:'Inspection'}).outcome,'created');
 assert.throws(()=>runs.create({...admin,create_checklists:false},{}),fails(403));
 const s=shifts.create({timezone:'America/New_York',effective_from:'2026-09-21T12:00:00.000Z',cycle_anchor:'2026-09-21T12:00:00.000Z',rules:[{...scheduleFixture.rules[0],applicable_days:[]},{...scheduleFixture.rules[1],applicable_days:[]}]},1);
 shifts.publish(s.id,1,1);set('2026-09-21T13:00:00Z');assert.equal(shifts.current().starts_at,'2026-09-21T12:00:00.000Z');
 set('2026-09-22T13:00:00Z');assert.ok(shifts.current());
});

test('physical shift delete removes unused draft/archived and refuses current or historical',t=>{
 const {db,shifts}=setup(t);const draft=shifts.create(scheduleFixture,1);
 assert.equal(shifts.remove(draft.id).deleted,true);assert.throws(()=>shifts.remove(draft.id),fails(404));
 let current=shifts.create(scheduleFixture,1);current=shifts.publish(current.id,current.revision,1);
 assert.throws(()=>shifts.remove(current.id),fails(409));
 const old=shifts.create({...scheduleFixture,effective_from:'2026-09-20T04:00:00.000Z'},1);
 const archived=shifts.archive(old.id,old.revision,1);assert.equal(shifts.remove(archived.id).deleted,true);
 assert.equal(db.prepare('SELECT 1 FROM checklist_shift_schedule_versions WHERE id=?').get(old.id),undefined);
});
