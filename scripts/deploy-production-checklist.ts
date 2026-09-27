import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {openChecklistDatabase} from '../src/checklists/db.js';
import {importProductionTemplate,productionSource} from '../src/checklists/production-template.js';
import {createTemplateService,structureHash,validateStructure} from '../src/checklists/templates.js';
import {createShiftService} from '../src/checklists/shifts.js';
import {currentProductionBoundary,productionShiftDraft} from '../src/checklists/production-shift.js';
import {ChecklistBackup} from '../src/checklists/backup.js';
import {BackupManager} from '../src/backup.js';

const root=process.cwd(),data=path.join(root,'data'),stamp=new Date().toISOString().replace(/[:.]/g,'-');
const pre=path.join(root,'CNS-Digital-Backup','Pre-Deployment',stamp);fs.mkdirSync(pre,{recursive:true});
async function snapshot(name:string){const source=path.join(data,name);if(!fs.existsSync(source))return null;const target=path.join(pre,name);const sourceDb=new Database(source,{readonly:true});try{await sourceDb.backup(target);const copy=new Database(target,{readonly:true});try{if(copy.pragma('quick_check',{simple:true})!=='ok')throw Error(`${name} backup integrity failed`);}finally{copy.close();}}finally{sourceDb.close();}return target;}
const journalBackup=await snapshot('jurnal.db'),checklistBackup=await snapshot('checklist.db');

// Opening storage after the snapshots applies only the existing idempotent migrations.
const journal=(await import('../src/db.js')).db;
const admin=journal.prepare("SELECT id FROM users WHERE role='admin' AND active=1 AND COALESCE(deleted,0)=0 ORDER BY id LIMIT 1").get() as {id:number}|undefined;
if(!admin)throw Error('Active admin actor is required');
const rolesBefore=JSON.stringify(journal.prepare('SELECT id,name FROM roles ORDER BY id').all());
const storage=openChecklistDatabase(root,()=>{});if(!storage.available)throw Error('checklist.db unavailable');
const checklist=storage.db;
try{
 const imported=importProductionTemplate(checklist,admin.id),templates=createTemplateService(checklist);
 let version=imported.version;
 const source=productionSource();
 if(structureHash(validateStructure(version))!==structureHash(validateStructure(source.structure)))throw Error('Production template differs from approved source');
 if(version.status==='draft')version=templates.publish(version.id,version.revision,admin.id);
 if(version.status!=='published'||version.version_label!=='1.0')throw Error('Production v1.0 is not published');

 const shifts=createShiftService(checklist);let schedule=(shifts.list() as any[]).find(row=>row.status==='draft');
 if(!schedule)schedule=shifts.create(productionShiftDraft(currentProductionBoundary()),admin.id);
 schedule=shifts.get(schedule.id);
 if(rolesBefore!==JSON.stringify(journal.prepare('SELECT id,name FROM roles ORDER BY id').all()))throw Error('Role identities changed during deployment');

 const checklistBackups=new ChecklistBackup(checklist,path.join(root,'CNS-Digital-Backup','Checklist'),()=>{});checklistBackups.request();await checklistBackups.flush();
 const reportBackups=new BackupManager(journal,path.join(root,'CNS-Digital-Backup'),()=>{});await reportBackups.checkDaily();await reportBackups.stop();
 console.log(JSON.stringify({preDeployment:{jurnal:journalBackup,checklist:checklistBackup},migrations:checklist.prepare('SELECT * FROM checklist_schema_migrations ORDER BY version').all(),template:{id:version.template_id,version_id:version.id,status:version.status,version:version.version_label,sections:version.sections.length,items:version.sections.flatMap(s=>s.items).length},schedule:{id:schedule.id,version:schedule.version,status:schedule.status,timezone:schedule.timezone,effective_from:schedule.effective_from,rules:schedule.rules},rolesChanged:false},null,2));
}finally{checklist.close();journal.close();}
