import { checklistProgress } from './progress.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ChecklistError, createShiftService, localParts, object, text, invalid } from './shifts.js';
import { createTemplateService } from './templates.js';
export interface RunActor { id:number;username:string;full_name:string;view_checklists:boolean;create_checklists:boolean;edit_own_checklists:boolean;manage_checklists:boolean }
export interface RunRow {
 id:string;user_id:number;employee_name_snapshot:string;template_version_snapshot:string;
 shift_period_id:string;shift_label_snapshot:string;work_date:string;edit_until_snapshot:string;
 deleted_at:string|null;status:string;username_snapshot:string;template_id:string;template_version_id:string;
 template_content_hash:string;local_date:string;timezone_snapshot:string;period_starts_at_snapshot:string;period_ends_at_snapshot:string;
 started_at:string;started_local_at:string;first_completed_at:string|null;completed_at:string|null;updated_at:string;revision:number;
 is_extra:number;override_reason:string|null;deleted_by:number|null;delete_reason:string|null;
 checklist_day:string|null;
 retention_archived_at:string|null;
}
export function canEditChecklistRun(run: Pick<RunRow,'user_id'|'edit_until_snapshot'|'deleted_at'>,actor:RunActor,now=new Date()):boolean {
 if(run.deleted_at)return false;
 return actor.manage_checklists || (actor.edit_own_checklists && run.user_id===actor.id && now.getTime()<=Date.parse(run.edit_until_snapshot));
}
export function createRunService(db:Database.Database,now:()=>Date=()=>new Date()) {
 const shifts=createShiftService(db,now),templates=createTemplateService(db);
 function retentionCutoff() {
  const parts=localParts(now(),'Asia/Baku').date.split('-').map(Number);
  const day=new Date(Date.UTC(parts[0],parts[1]-1,parts[2]));day.setUTCDate(day.getUTCDate()-30);
  return day.toISOString().slice(0,10);
 }
 const archiveExpired=db.transaction(()=>{
  const cutoff=retentionCutoff(),stamp=now().toISOString();
  const ids=(db.prepare(`SELECT id FROM checklist_runs WHERE retention_archived_at IS NULL AND work_date<?`).all(cutoff) as {id:string}[]).map(row=>row.id);
  if(ids.length)db.prepare(`UPDATE checklist_runs SET retention_archived_at=? WHERE retention_archived_at IS NULL AND work_date<?`).run(stamp,cutoff);
  return {count:ids.length,ids,cutoff,archived_at:stamp};
 });
 function currentTemplate() {
  const rows=db.prepare(`SELECT v.id,v.version_label,v.name_snapshot FROM checklist_templates t JOIN checklist_template_versions v ON v.id=t.current_version_id
   WHERE t.archived_at IS NULL AND v.status='published' ORDER BY t.id`).all() as {id:string;version_label:string;name_snapshot:string}[];
  if(!rows.length)throw new ChecklistError(409,'Aktiv yoxlama şablonu mövcud deyil');
  if(rows.length!==1)throw new ChecklistError(409,'Gündəlik yoxlama üçün yalnız bir aktiv şablon olmalıdır');
  return rows[0];
 }
 function raw(id:string):RunRow {
  const r=db.prepare('SELECT * FROM checklist_runs WHERE id=?').get(id) as RunRow|undefined;
  if(!r)throw new ChecklistError(404,'Yoxlama tapılmadı');return r;
 }
 function visible(id:string,actor:RunActor) {
  if(!actor.view_checklists)throw new ChecklistError(403,'İcazə yoxdur');
  const r=raw(id);if(r.deleted_at&&!actor.manage_checklists)throw new ChecklistError(404,'Yoxlama tapılmadı');return r;
 }
 function read(id:string,actor:RunActor) {
  const run=visible(id,actor);
  // Historical reads never join a current template or schedule.
  const sections=db.prepare('SELECT * FROM checklist_run_sections WHERE run_id=? ORDER BY sort_order_snapshot').all(id);
  return {...run,sections,...checklistProgress(db,id),server_time:now().toISOString(),can_edit:canEditChecklistRun(run,actor,now())};
 }
 const create=db.transaction((actor:RunActor,input:unknown)=>{
  if(!actor.view_checklists)throw new ChecklistError(403,'İcazə yoxdur');
  const b=object(input??{});
  for(const key of Object.keys(b))if(!['is_extra','override_reason'].includes(key))invalid('Server tərəfindən təyin olunan sahələr göndərilə bilməz');
  if(b.is_extra!==undefined&&typeof b.is_extra!=='boolean')invalid();
  const extra=b.is_extra===true;
  if(extra ? !actor.manage_checklists : !actor.create_checklists)throw new ChecklistError(403,'Yoxlama yaratmağa icazə yoxdur');
  const reason=extra?text(b.override_reason):null;
  if(!extra&&b.override_reason!==undefined)invalid();
  const instant=now(),p=shifts.resolveCurrentShift(instant);
  const checklistDay=localParts(instant,'Asia/Baku').date;
  if(!extra){const existing=db.prepare('SELECT * FROM checklist_runs WHERE checklist_day=? AND is_extra=0 AND deleted_at IS NULL').get(checklistDay) as RunRow|undefined;
   if(existing)return {outcome:'existing' as const,run:existing.deleted_at?{...existing,sections:[],can_edit:false}:read(existing.id,actor)};}
  const v=templates.get(currentTemplate().id),id=randomUUID(),timestamp=instant.toISOString(),local=localParts(instant,p.timezone_snapshot);
  db.prepare(`INSERT INTO checklist_runs(id,user_id,username_snapshot,employee_name_snapshot,template_id,template_version_id,template_version_snapshot,template_content_hash,
   shift_period_id,shift_label_snapshot,work_date,local_date,timezone_snapshot,period_starts_at_snapshot,period_ends_at_snapshot,edit_until_snapshot,
   started_at,started_local_at,updated_at,is_extra,override_reason,checklist_day)
   VALUES (@id,@user,@username,@name,@template,@version,@label,@hash,@period,@shift,@work,@date,@timezone,@starts,@ends,@edit,@stamp,@local,@stamp,@extra,@reason,@day)`)
   .run({id,user:actor.id,username:actor.username,name:actor.full_name,template:v.template_id,version:v.id,label:v.version_label,hash:v.content_hash,
    period:p.id,shift:p.label_snapshot,work:p.work_date,date:local.date,timezone:p.timezone_snapshot,starts:p.starts_at,ends:p.ends_at,edit:p.edit_until,
    stamp:timestamp,local:local.date+'T'+local.time,extra:+extra,reason,day:extra?null:checklistDay});
  const addSection=db.prepare(`INSERT INTO checklist_run_sections(id,run_id,template_section_id,stable_key_snapshot,name_snapshot,sort_order_snapshot,active_snapshot,service_name_snapshot,object_name_snapshot,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)`);
  const addItem=db.prepare(`INSERT INTO checklist_run_items(id,run_section_id,template_item_id,stable_key_snapshot,name_snapshot,equipment_name_snapshot,sort_order_snapshot,required_snapshot,active_snapshot,updated_at,technology_card_snapshot) VALUES (?,?,?,?,?,?,?,?,1,?,?)`);
  for(const section of v.sections.filter(s=>s.active)) {
   const sid=randomUUID();addSection.run(sid,id,section.id,section.stable_key,section.name,section.sort_order,section.service_name,section.object_name,timestamp);
   for(const item of section.items.filter(i=>i.active))addItem.run(randomUUID(),sid,item.id,item.stable_key,item.name,item.equipment_name,item.sort_order,item.required,timestamp,item.technology_card);
  }
  return {outcome:'created' as const,run:read(id,actor)};
 });
 const context=db.transaction((actor:RunActor)=>{
  if(!actor.view_checklists)throw new ChecklistError(403,'İcazə yoxdur');
  let error:string|null=null,shift:ReturnType<typeof shifts.current>|null=null,template:ReturnType<typeof currentTemplate>|null=null,existing:RunRow|undefined;
  try {shift=shifts.current(now());}catch(e){if(!(e instanceof ChecklistError))throw e;error=e.message;}
  if(shift)existing=db.prepare(`SELECT * FROM checklist_runs WHERE checklist_day=? AND is_extra=0 AND deleted_at IS NULL`)
   .get(localParts(now(),'Asia/Baku').date) as RunRow|undefined;
  try{template=currentTemplate();}catch(e){if(!(e instanceof ChecklistError))throw e;error??=e.message;}
  const editable=existing?canEditChecklistRun(existing,actor,now()):false;
  return {current_shift:shift,work_date:shift?.work_date??null,current_template:template,can_create:actor.create_checklists&&!!shift&&!!template&&!existing,can_create_extra:actor.manage_checklists&&!!shift&&!!template,can_manage:actor.manage_checklists,
   existing_run_id:existing?.id??null,existing_run_deleted:!!existing?.deleted_at,existing_run_owner:existing?.user_id===actor.id,
   existing_run_status:existing?.status??null,existing_run_can_edit:editable,error};
 });
 function list(actor:RunActor,input:Record<string,unknown>) {
  if(!actor.view_checklists)throw new ChecklistError(403,'İcazə yoxdur');
  const integer=(v:unknown,fallback:number,max:number)=>{if(v===undefined)return fallback;const n=Number(v);if(!Number.isSafeInteger(n)||n<1||n>max)invalid();return n;};
  const page=integer(input.page,1,1000000),page_size=integer(input.page_size,25,100),conditions=['deleted_at IS NULL','retention_archived_at IS NULL'],params:unknown[]=[];
  for(const [key,col] of Object.entries({date:'work_date',work_date:'work_date',user:'user_id',shift:'shift_label_snapshot',status:'status',template_version:'template_version_snapshot'})) {
   if(input[key]!==undefined){conditions.push(`${col}=?`);params.push(text(input[key]));}
  }
  const where=conditions.join(' AND '),total=(db.prepare(`SELECT COUNT(*) n FROM checklist_runs WHERE ${where}`).get(...params) as {n:number}).n;
  const rows=db.prepare(`SELECT id,employee_name_snapshot AS employee_name,work_date,shift_label_snapshot AS shift_label,started_at,completed_at,status,template_version_snapshot AS template_version,is_extra,timezone_snapshot
   FROM checklist_runs WHERE ${where} ORDER BY started_at DESC,id LIMIT ? OFFSET ?`).all(...params,page_size,(page-1)*page_size);
  return {rows:rows.map(row=>({...row as object,can_edit:canEditChecklistRun(row as RunRow,actor,now()),progress:checklistProgress(db,(row as {id:string}).id).progress})),page,page_size,total};
 }
 const remove=db.transaction((id:string,actor:RunActor,reason:unknown)=>{
  if(!actor.manage_checklists)throw new ChecklistError(403,'İcazə yoxdur');const why=text(reason),r=raw(id);
  if(!r.deleted_at)db.prepare('UPDATE checklist_runs SET deleted_at=?,deleted_by=?,delete_reason=?,updated_at=?,revision=revision+1 WHERE id=?').run(now().toISOString(),actor.id,why,now().toISOString(),id);
  return raw(id);
 });
 return {create:(a:RunActor,b:unknown)=>create.immediate(a,b),context:(a:RunActor)=>context(a),get:read,list,
  archiveExpired:()=>archiveExpired.immediate(),
  section:(id:string,sid:string,a:RunActor)=>{visible(id,a);const s=db.prepare('SELECT * FROM checklist_run_sections WHERE id=? AND run_id=?').get(sid,id) as Record<string,unknown>|undefined;if(!s)throw new ChecklistError(404,'Mövqe tapılmadı');return {...s,items:db.prepare('SELECT * FROM checklist_run_items WHERE run_section_id=? ORDER BY sort_order_snapshot').all(sid)};},
  remove:(id:string,a:RunActor,r:unknown)=>remove.immediate(id,a,r)};
}
