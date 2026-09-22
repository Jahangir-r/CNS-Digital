import type Database from 'better-sqlite3';
import {ChecklistError,object,invalid,revision} from './shifts.js';
import {canEditChecklistRun,type RunActor,type RunRow} from './runs.js';
import {checklistProgress} from './progress.js';
export class CompletionError extends ChecklistError {
 constructor(public details:Pick<ReturnType<typeof checklistProgress>,'incompleteSections'|'incompleteItems'>){super(422,'Yoxlama tamamlanmayıb');}
}
export function createExecutionService(db:Database.Database,now:()=>Date=()=>new Date()) {
 function editable(id:string,actor:RunActor){
  const r=db.prepare('SELECT * FROM checklist_runs WHERE id=?').get(id) as RunRow|undefined;
  if(!r)throw new ChecklistError(404,'Yoxlama tapılmadı');
  if(!actor.view_checklists||!canEditChecklistRun(r,actor,now()))throw new ChecklistError(403,'Bu yoxlamanı dəyişdirməyə icazə yoxdur');return r;
 }
 function note(value:unknown):string {if(typeof value!=='string'||value.length>5000)return invalid('Qeyd 5000 simvoldan çox olmamalıdır');return value;}
 function after(run:RunRow,actor:RunActor,stamp:string,event:string,changed_fields:string,extra:Record<string,unknown>){
  const state=checklistProgress(db,run.id),reopened=run.status==='completed'&&state.incompleteSections.length>0;
  const status=reopened?'in_progress':run.status;
  db.prepare('UPDATE checklist_runs SET status=?,completed_at=?,updated_at=?,revision=revision+1 WHERE id=?').run(status,status==='completed'?stamp:null,stamp,run.id);
  const events=[event];if(run.status==='completed')events.push('CHECKLIST_EDIT_AFTER_COMPLETE');if(reopened)events.push('CHECKLIST_REOPEN');if(actor.manage_checklists)events.push('CHECKLIST_ADMIN_EDIT');
  return {...state,...extra,run:db.prepare('SELECT * FROM checklist_runs WHERE id=?').get(run.id) as RunRow,events,changed_fields};
 }
 const item=db.transaction((id:string,itemId:string,input:unknown,actor:RunActor)=>{
  const run=editable(id,actor),b=object(input);
  if(Object.keys(b).some(k=>!['expectedRevision','result','comment'].includes(k))||(!('result'in b)&&!('comment'in b)))invalid();
  const row=db.prepare('SELECT i.* FROM checklist_run_items i JOIN checklist_run_sections s ON s.id=i.run_section_id WHERE i.id=? AND s.run_id=?').get(itemId,id) as {revision:number;result:string|null;comment:string;run_section_id:string}|undefined;
  if(!row)throw new ChecklistError(404,'Yoxlamanın bəndi tapılmadı');revision(b.expectedRevision,row.revision);
  if('result'in b && ![null,'ok','problem','na'].includes(b.result as any))invalid('Nəticə düzgün deyil');
  const stamp=now().toISOString();db.prepare('UPDATE checklist_run_items SET result=?,comment=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?')
   .run('result'in b?b.result:row.result,'comment'in b?note(b.comment):row.comment,actor.id,stamp,itemId);
  return after(run,actor,stamp,'CHECKLIST_ITEM_UPDATE',Object.keys(b).filter(k=>k!=='expectedRevision').join(','),{item:db.prepare('SELECT * FROM checklist_run_items WHERE id=?').get(itemId),item_id:itemId,section_id:row.run_section_id});
 });
 const section=db.transaction((id:string,sectionId:string,input:unknown,actor:RunActor)=>{
  const run=editable(id,actor),b=object(input);if(Object.keys(b).some(k=>!['expectedRevision','section_comment'].includes(k)))invalid();
  const row=db.prepare('SELECT * FROM checklist_run_sections WHERE id=? AND run_id=?').get(sectionId,id) as {revision:number}|undefined;
  if(!row)throw new ChecklistError(404,'Yoxlamanın mövqeyi tapılmadı');revision(b.expectedRevision,row.revision);
  const stamp=now().toISOString();db.prepare('UPDATE checklist_run_sections SET section_comment=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?').run(note(b.section_comment),actor.id,stamp,sectionId);
  return after(run,actor,stamp,'CHECKLIST_NOTE_UPDATE','section_comment',{section:db.prepare('SELECT * FROM checklist_run_sections WHERE id=?').get(sectionId),section_id:sectionId});
 });
 const complete=db.transaction((id:string,actor:RunActor)=>{
  const run=editable(id,actor),state=checklistProgress(db,id);
  if(state.incompleteSections.length||!state.progress.total_sections)throw new CompletionError({incompleteSections:state.incompleteSections,incompleteItems:state.incompleteItems});
  if(run.status==='completed')return {...state,run,events:[],changed_fields:''};
  const stamp=now().toISOString();db.prepare("UPDATE checklist_runs SET status='completed',first_completed_at=COALESCE(first_completed_at,?),completed_at=?,updated_at=?,revision=revision+1 WHERE id=?").run(stamp,stamp,stamp,id);
  return {...state,run:db.prepare('SELECT * FROM checklist_runs WHERE id=?').get(id) as RunRow,events:['CHECKLIST_COMPLETE'],changed_fields:'status,completed_at'};
 });
 return {item:(id:string,i:string,b:unknown,a:RunActor)=>item.immediate(id,i,b,a),section:(id:string,s:string,b:unknown,a:RunActor)=>section.immediate(id,s,b,a),complete:(id:string,a:RunActor)=>complete.immediate(id,a)};
}
