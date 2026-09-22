import Database from 'better-sqlite3';
import {migrateChecklistDatabase} from '../../src/checklists/migrations.js';
import {migrateReportRequests} from '../../src/reports/migrations.js';
import {createAuthService} from '../../src/auth.js';
import {createReportService} from '../../src/reports/service.js';
import {createReportLinkService} from '../../src/checklists/report-links.js';
import {createTemplateService} from '../../src/checklists/templates.js';
import {createShiftService} from '../../src/checklists/shifts.js';
import {createRunService} from '../../src/checklists/runs.js';
import {createExecutionService} from '../../src/checklists/execution.js';
import {REPORT_FIELDS} from '../../src/reports/normalization.js';
import {templateFixture} from './checklist-template.js';
import {scheduleFixture} from './checklist-schedule.js';
export function reportLinkEnv(journalFile=':memory:',checklistFile=':memory:',missing=false){
 const journal=new Database(journalFile),db=new Database(checklistFile);for(const d of [journal,db]){d.pragma('journal_mode=WAL');d.pragma('foreign_keys=ON');d.pragma('busy_timeout=5000');}
 journal.exec(`CREATE TABLE roles(name TEXT PRIMARY KEY,view_checklists INTEGER,create_checklists INTEGER,edit_own_checklists INTEGER,manage_checklists INTEGER,create_reports_from_checklist INTEGER,create_reports INTEGER,view_all_reports INTEGER,shift_engineer_access INTEGER);
 INSERT INTO roles VALUES('technician',1,1,1,0,1,0,1,0),('engineer',1,1,1,0,1,0,1,0),('employee',1,0,0,0,0,0,0,0),('shift_engineer',1,0,0,0,0,1,1,1),('manual_only',1,1,1,1,0,1,1,0),('admin',1,1,1,1,1,1,1,0);
 CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,active INTEGER DEFAULT 1,deleted INTEGER DEFAULT 0);
 INSERT INTO users(id,username,full_name,role) VALUES(1,'tech','Texnik','technician'),(2,'engineer','Engineer','engineer'),(3,'employee','Employee','employee'),(4,'shift','Shift','shift_engineer'),(5,'manual','Manual','manual_only'),(6,'admin','Admin','admin');
 CREATE TABLE reports(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,owner_user_id INTEGER,${REPORT_FIELDS.map(f=>`${f} TEXT NOT NULL DEFAULT ''`).join(',')},created_at TEXT DEFAULT (datetime('now')),updated_at TEXT DEFAULT (datetime('now')));`);
 migrateChecklistDatabase(db);migrateReportRequests(journal);let instant=new Date('2026-09-19T00:00:00Z');const now=()=>instant;
 const auth=createAuthService(journal,'test-only'),reports=createReportService(journal,auth),links=createReportLinkService(db,reports,auth,now);
 const templates=createTemplateService(db);let v=templates.create({code:'DAILY',name:'Daily'},1);const structure=structuredClone(templateFixture);if(missing)structure.sections[0].service_name='';v=templates.update(v.id,{...structure,revision:1});templates.publish(v.id,2,1);
 const shifts=createShiftService(db,now),s=shifts.create(scheduleFixture,1);shifts.publish(s.id,1,1);instant=new Date('2026-09-19T05:00:00Z');
 const runs=createRunService(db,now),execution=createExecutionService(db,now);
 const user=(id=1)=>journal.prepare('SELECT * FROM users WHERE id=?').get(id) as any;
 function createRun(id=1){const restore=instant;if((db.prepare("SELECT COUNT(*) n FROM checklist_runs WHERE is_extra=0 AND deleted_at IS NULL").get() as any).n)instant=new Date(instant.getTime()+86400000);const u=user(id),a={id:u.id,username:u.username,full_name:u.full_name,view_checklists:true,create_checklists:true,edit_own_checklists:true,manage_checklists:false};
 const run=runs.create(a,{}).run,section=runs.section(run.id,(run.sections[0] as any).id,a) as any;
 execution.item(run.id,section.items[0].id,{expectedRevision:1,result:'problem',comment:'SECRET_PROBLEM'},a);
 instant=restore;
 return {run,itemId:section.items[0].id,sectionId:section.id};}
 const seeded=createRun();return {journal,db,auth,reports,links,runs,execution,user,createRun,...seeded,now,set:(d:string)=>{instant=new Date(d);},close(){db.close();journal.close();}};
}
