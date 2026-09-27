import path from 'node:path';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import {openChecklistDatabase} from '../src/checklists/db.js';
import {createShiftService,localParts,wallTime,addDays} from '../src/checklists/shifts.js';
import {productionShiftDraft,PRODUCTION_TIMEZONE} from '../src/checklists/production-shift.js';
import {ChecklistBackup} from '../src/checklists/backup.js';

const root=process.cwd(),source=path.join(root,'data','checklist.db'),stamp=new Date().toISOString().replace(/[:.]/g,'-'),folder=path.join(root,'CNS-Digital-Backup','Pre-Deployment',stamp);fs.mkdirSync(folder,{recursive:true});
const pre=path.join(folder,'checklist.db'),readonly=new Database(source,{readonly:true});
const preQuick=(readonly.pragma('quick_check') as {quick_check:string}[]).map(r=>r.quick_check);
const beforeRuns=readonly.prepare('SELECT COUNT(*) count,COALESCE(SUM(revision),0) revisions FROM checklist_runs').get();
const beforeTemplate=readonly.prepare("SELECT v.id,v.status,v.content_hash,(SELECT COUNT(*) FROM checklist_sections s WHERE s.template_version_id=v.id) sections,(SELECT COUNT(*) FROM checklist_items i JOIN checklist_sections s ON s.id=i.section_id WHERE s.template_version_id=v.id) items FROM checklist_template_versions v JOIN checklist_templates t ON t.id=v.template_id WHERE t.code='CNS_DAILY_TECHNICAL_CHECK' AND v.version_label='1.0'").get();
await readonly.backup(pre);readonly.close();
const storage=openChecklistDatabase(root,()=>{});if(!storage.available)throw Error('checklist.db unavailable');const db=storage.db;
try{
 const admin=(new Database(path.join(root,'data','jurnal.db'),{readonly:true}));const actor=(admin.prepare("SELECT id FROM users WHERE role='admin' AND active=1 AND COALESCE(deleted,0)=0 ORDER BY id LIMIT 1").get() as {id:number}|undefined)?.id;admin.close();if(!actor)throw Error('Active admin required');
 const shifts=createShiftService(db),published=(shifts.list() as any[]).find(s=>s.status==='published');if(!published)throw Error('Published schedule not found');
 const local=localParts(new Date(),PRODUCTION_TIMEZONE),date=local.time<'08:00:00'?local.date:local.time<'20:00:00'?local.date:addDays(local.date,1),time=local.time<'08:00:00'?'08:00':local.time<'20:00:00'?'20:00':'08:00',effective=wallTime(date,time,PRODUCTION_TIMEZONE);
 const result=db.transaction(()=>{const draft=shifts.create(productionShiftDraft(effective),actor);const archived=shifts.archive(published.id,published.revision,actor);return{draft,archived};}).immediate();
 const postQuick=(db.pragma('quick_check') as {quick_check:string}[]).map(r=>r.quick_check);
 const afterRuns=db.prepare('SELECT COUNT(*) count,COALESCE(SUM(revision),0) revisions FROM checklist_runs').get();
 const afterTemplate=db.prepare("SELECT v.id,v.status,v.content_hash,(SELECT COUNT(*) FROM checklist_sections s WHERE s.template_version_id=v.id) sections,(SELECT COUNT(*) FROM checklist_items i JOIN checklist_sections s ON s.id=i.section_id WHERE s.template_version_id=v.id) items FROM checklist_template_versions v JOIN checklist_templates t ON t.id=v.template_id WHERE t.code='CNS_DAILY_TECHNICAL_CHECK' AND v.version_label='1.0'").get();
 if(JSON.stringify(beforeRuns)!==JSON.stringify(afterRuns))throw Error('Historical checklist runs changed');
 if(JSON.stringify(beforeTemplate)!==JSON.stringify(afterTemplate))throw Error('Production template changed');
 const backup=new ChecklistBackup(db,path.join(root,'CNS-Digital-Backup','Checklist'),()=>{});backup.request();await backup.flush();
 console.log(JSON.stringify({preDeployment:pre,quickCheck:{before:preQuick,after:postQuick},runs:{before:beforeRuns,after:afterRuns},template:{before:beforeTemplate,after:afterTemplate},archived:{id:result.archived.id,version:result.archived.version,status:result.archived.status},draft:{id:result.draft.id,version:result.draft.version,status:result.draft.status,timezone:result.draft.timezone,effective_from:result.draft.effective_from,rules:result.draft.rules},currentPublished:null},null,2));
}finally{db.close();}
