import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {User} from '../db.js';
import type {AuthService} from '../auth.js';
import type {createReportService} from '../reports/service.js';
import {canEditChecklistRun,type RunRow} from './runs.js';
import {ChecklistError,object,invalid} from './shifts.js';
import {localTimestamp} from '../local-time.js';
type Reports=ReturnType<typeof createReportService>;
interface Link {id:string;run_item_id:string;operation_id:string;report_id:number|null;state:'pending'|'linked'|'error';requested_by:number;requested_at:string;linked_at:string|null;last_error_code:string|null}
export class MissingReportFields extends ChecklistError {
 constructor(public missing_fields:{key:string;label:string}[]){super(422,'Nasazlıq üçün çatışmayan sahələri doldurun');}
}
export function createReportLinkService(db:Database.Database,reports:Reports,auth:Pick<AuthService,'can'>,now:()=>Date=()=>new Date()) {
 function item(runId:string,itemId:string,user:User,write=false){
  if(!auth.can(user,'view_checklists'))throw new ChecklistError(403,'İcazə yoxdur');
  const run=db.prepare('SELECT * FROM checklist_runs WHERE id=?').get(runId) as RunRow|undefined;
  if(!run)throw new ChecklistError(404,'Yoxlama tapılmadı');
  const canEdit=canEditChecklistRun(run,{id:user.id,username:user.username,full_name:user.full_name,view_checklists:true,create_checklists:false,
   edit_own_checklists:auth.can(user,'edit_own_checklists'),manage_checklists:auth.can(user,'manage_checklists')},now());
  if(write&&(!canEdit||!auth.can(user,'create_reports_from_checklist')))throw new ChecklistError(403,'Nasazlıq yaratmağa icazə yoxdur');
  if(run.deleted_at&&!auth.can(user,'manage_checklists'))throw new ChecklistError(404,'Yoxlama tapılmadı');
  const row=db.prepare(`SELECT i.*,s.name_snapshot AS position,s.service_name_snapshot,s.object_name_snapshot FROM checklist_run_items i
   JOIN checklist_run_sections s ON s.id=i.run_section_id WHERE i.id=? AND s.run_id=?`).get(itemId,runId) as {result:string|null;comment:string;name_snapshot:string;equipment_name_snapshot:string;position:string;service_name_snapshot:string;object_name_snapshot:string}|undefined;
  if(!row)throw new ChecklistError(404,'Yoxlamanın bəndi tapılmadı');return {row,canEdit};
 }
 const link=(id:string)=>db.prepare('SELECT * FROM checklist_report_links WHERE run_item_id=?').get(id) as Link|undefined;
 function payload(row:ReturnType<typeof item>['row'],input:unknown){
  if(row.result!=='problem')throw new ChecklistError(422,'Yalnız Problem nəticəsi üçün nasazlıq yaradıla bilər');
  if(!row.comment.trim())throw new ChecklistError(422,'Problem üçün qeyd tələb olunur');
  const b=object(input??{}),data:Record<string,unknown>={xidmet:row.service_name_snapshot,obyekt:row.object_name_snapshot,
   sistem:[row.position,row.equipment_name_snapshot||row.name_snapshot].filter(Boolean).join(' / '),nasazliq:row.comment,nasazliq_vaxti:localTimestamp(now()).slice(0,16)};
  const allowed=['xidmet','sistem'].filter(k=>!String(data[k]??'').trim());
  for(const k of Object.keys(b)){if(!allowed.includes(k))invalid('Yalnız çatışmayan sahələr göndərilə bilər');if(typeof b[k]!=='string'||(b[k] as string).length>500)invalid();data[k]=(b[k] as string).trim();}
  const missing=allowed.filter(k=>!data[k]);if(missing.length)throw new MissingReportFields(missing.map(key=>({key,label:key==='xidmet'?'Xidmət':'Sistem'})));return data;
 }
 function get(runId:string,itemId:string,user:User){
  const {row,canEdit}=item(runId,itemId,user),l=link(itemId),request=l?reports.request(l.operation_id):undefined,id=l?.report_id??request?.report_id??null;
  const deleted=id!==null&&!reports.exists(id),writable=canEdit&&auth.can(user,'create_reports_from_checklist');
  return {state:deleted?'deleted':l?.state??'none',report_id:id,created_at:request?.created_at??null,operation_id:l?.operation_id??null,
   can_view_report:id!==null&&!deleted&&auth.can(user,'view_all_reports'),can_create:writable&&!l&&row.result==='problem'&&!!row.comment.trim(),
   can_retry:writable&&!!l&&l.state!=='linked'&&!deleted&&(!!request||(row.result==='problem'&&!!row.comment.trim()))};
 }
 function create(runId:string,itemId:string,user:User,input:unknown,onJournalCommit:(r:ReturnType<Reports['createIdempotent']>,l:Link)=>void=()=>{}){
  // Durable pending intent commits before touching the journal database.
  const pending=db.transaction(()=>{const {row}=item(runId,itemId,user,true);const old=link(itemId);if(old)return old;
   payload(row,input);const id=randomUUID(),operation=randomUUID();db.prepare("INSERT INTO checklist_report_links(id,run_item_id,operation_id,state,requested_by,requested_at) VALUES(?,?,?,'pending',?,?)").run(id,itemId,operation,user.id,now().toISOString());return link(itemId)!;
  }).immediate();
  let phase='JOURNAL_WRITE_FAILED';
  try {
   // Lock checklist state while validating/creating: concurrent answer edits cannot change the checked snapshot midway.
   const result=db.transaction(()=>{const {row}=item(runId,itemId,user,true),l=link(itemId)!;
    const existing=reports.request(l.operation_id);
    const r=existing?{...existing,created:false}:reports.createIdempotent(user,l.operation_id,payload(row,input));
    try{onJournalCommit(r,l);}catch{/* audit/backup must not undo either database commit */}
    phase='LINK_WRITE_FAILED';
    if(l.state!=='linked')db.prepare("UPDATE checklist_report_links SET report_id=?,state='linked',linked_at=?,last_error_code=NULL WHERE id=?").run(r.report_id,now().toISOString(),l.id);
    return {...get(runId,itemId,user),created:r.created,recovered:!r.created&&l.state!=='linked'};
   }).immediate();return result;
  }catch(error){try{db.prepare("UPDATE checklist_report_links SET state='error',last_error_code=? WHERE id=? AND state!='linked'").run(phase,pending.id);}catch{/* pending intent still supports retry */}throw error;}
 }
 return {get,create};
}
