import type Database from 'better-sqlite3';
export interface Answer {id:string;run_section_id:string;required_snapshot:number;result:null|'ok'|'problem'|'na';comment:string}
export function isItemComplete(item:Answer):boolean {
 return !(item.required_snapshot && item.result===null) && !(['problem','na'].includes(item.result??'')&&!item.comment.trim());
}
export function isSectionComplete(items:Answer[]):boolean {return items.every(isItemComplete);}
export function checklistProgress(db:Database.Database,id:string) {
 const sections=db.prepare('SELECT id,name_snapshot AS name,sort_order_snapshot AS sort_order FROM checklist_run_sections WHERE run_id=? ORDER BY sort_order_snapshot').all(id) as {id:string;name:string;sort_order:number}[];
 const items=db.prepare('SELECT i.* FROM checklist_run_items i JOIN checklist_run_sections s ON s.id=i.run_section_id WHERE s.run_id=? ORDER BY s.sort_order_snapshot,i.sort_order_snapshot').all(id) as (Answer&{name_snapshot:string})[];
 const navigator=sections.map(s=>{const own=items.filter(i=>i.run_section_id===s.id);return {...s,completed:isSectionComplete(own),problem_count:own.filter(i=>i.result==='problem').length,na_count:own.filter(i=>i.result==='na').length};});
 return {progress:{completed_sections:navigator.filter(s=>s.completed).length,total_sections:sections.length,
  completed_required_items:items.filter(i=>i.required_snapshot&&isItemComplete(i)).length,total_required_items:items.filter(i=>i.required_snapshot).length,
  ok_count:items.filter(i=>i.result==='ok').length,problem_count:items.filter(i=>i.result==='problem').length,na_count:items.filter(i=>i.result==='na').length,
  unanswered_required_count:items.filter(i=>i.required_snapshot&&i.result===null).length},navigator,
  incompleteSections:navigator.filter(s=>!s.completed),incompleteItems:items.filter(i=>!isItemComplete(i)).map(i=>({id:i.id,section_id:i.run_section_id,name:i.name_snapshot,reason:i.result===null?'answer_required':'comment_required'}))};
}
