import {createExecutionService,CompletionError} from './execution.js';
import express from 'express';
import type { AuthService, PermField } from '../auth.js';
import type { AuditLog, AuditEvent } from '../audit.js';
import type { ChecklistStorage } from './db.js';
import { ChecklistError, createShiftService } from './shifts.js';
import { createRunService, type RunActor } from './runs.js';
export function createRunRouter(storage:ChecklistStorage,auth:AuthService,audit:Pick<AuditLog,'write'>,now:()=>Date=()=>new Date()) {
 const execution=storage.available?createExecutionService(storage.db,now):null;
 const router=express.Router(),shifts=storage.available?createShiftService(storage.db,now):null,runs=storage.available?createRunService(storage.db,now):null;
 function actor(res:express.Response):RunActor {const u=res.locals.user;return {id:u.id,username:u.username,full_name:u.full_name,
  view_checklists:auth.can(u,'view_checklists'),create_checklists:auth.can(u,'create_checklists'),edit_own_checklists:auth.can(u,'edit_own_checklists'),manage_checklists:auth.can(u,'manage_checklists')};}
 function endpoint(method:'get'|'post'|'put'|'patch'|'delete',path:string,perm:PermField,event:string|undefined,action:(req:express.Request,res:express.Response)=>any) {
  router[method](path,(req,res,next)=>{
   const requested={...req.params};
   let logged=false;
   res.locals.recordChecklist=(result:'SUCCESS'|'ERROR',data:any={})=>{
    if(logged||!event)return;logged=true;
    const u=res.locals.auditActor,r=data.run??data;
    try {for(const name of data.events??[event])audit.write({event:name==='CHECKLIST_CREATE'&&data.outcome==='existing'?'CHECKLIST_NORMAL_DAY_CONFLICT':name==='CHECKLIST_CREATE'&&r.is_extra?'CHECKLIST_ADMIN_EXTRA_CREATE':name,module:'CHECKLIST',result,
     user:u?.username??'anonymous',name:u?.full_name??'',ip:req.ip,description:result==='SUCCESS'?'Checklist operation completed':'Checklist operation failed',
     checklist_id:event.startsWith('CHECKLIST_SHIFT_')?undefined:r.id??requested.id,
     schedule_version_id:event.startsWith('CHECKLIST_SHIFT_')?r.id??requested.id:undefined,
     template_version:r.template_version_snapshot,shift:r.shift_label_snapshot,work_date:r.work_date,revision:data.item?.revision??data.section?.revision??r.revision,section_id:data.section_id??requested.sectionId,item_id:data.item_id??requested.itemId,changed_fields:data.changed_fields} as AuditEvent);}catch{/* never undo the operation */}
   };
   res.once('finish',()=>res.locals.recordChecklist('ERROR'));res.once('close',()=>res.locals.recordChecklist('ERROR'));next();
  },auth.requireAuth,auth.requirePerm(perm),(req,res,next)=>{
   if(!runs||!shifts)return res.status(503).json({error:'Yoxlama modulu hazırda əlçatan deyil'});
   try {const data=action(req,res);res.locals.recordChecklist('SUCCESS',data);res.status(method==='post'&&(data.outcome==='created'||event==='CHECKLIST_SHIFT_SCHEDULE_CREATE')?201:200).json(data);}catch(e){next(e);}
  });
 }
 endpoint('patch','/checklists/:id/items/:itemId','view_checklists','CHECKLIST_ITEM_UPDATE',(q,s)=>execution!.item(String(q.params.id),String(q.params.itemId),q.body,actor(s)));
 endpoint('patch','/checklists/:id/sections/:sectionId','view_checklists','CHECKLIST_NOTE_UPDATE',(q,s)=>execution!.section(String(q.params.id),String(q.params.sectionId),q.body,actor(s)));
 endpoint('post','/checklists/:id/complete','view_checklists','CHECKLIST_COMPLETE',(q,s)=>execution!.complete(String(q.params.id),actor(s)));
 const base='/checklist-shift-schedules';
 endpoint('get',base,'manage_checklist_shifts',undefined,()=>shifts!.list());
 endpoint('post',base,'manage_checklist_shifts','CHECKLIST_SHIFT_SCHEDULE_CREATE',(q,s)=>shifts!.create(q.body,actor(s).id));
 endpoint('get',base+'/:id','manage_checklist_shifts',undefined,q=>shifts!.get(String(q.params.id)));
 endpoint('put',base+'/:id','manage_checklist_shifts','CHECKLIST_SHIFT_SCHEDULE_UPDATE',q=>shifts!.update(String(q.params.id),q.body));
 endpoint('post',base+'/:id/publish','manage_checklist_shifts','CHECKLIST_SHIFT_SCHEDULE_PUBLISH',(q,s)=>shifts!.publish(String(q.params.id),q.body?.revision,actor(s).id,false));
 endpoint('post',base+'/:id/activate','manage_checklist_shifts','CHECKLIST_SHIFT_SCHEDULE_MAKE_CURRENT',q=>shifts!.activate(String(q.params.id),q.body?.revision));
 endpoint('post',base+'/:id/archive','manage_checklist_shifts','CHECKLIST_SHIFT_SCHEDULE_ARCHIVE',(q,s)=>shifts!.archive(String(q.params.id),q.body?.revision,actor(s).id));
 endpoint('delete',base+'/:id','manage_checklist_shifts','CHECKLIST_SHIFT_SCHEDULE_DELETE',q=>shifts!.remove(String(q.params.id)));
 endpoint('get','/checklists/context','view_checklists',undefined,(q,s)=>{
  const retention=runs!.archiveExpired();
  if(retention.count)try{const u=s.locals.auditActor;audit.write({event:'CHECKLIST_RETENTION_ARCHIVE',module:'CHECKLIST',result:'SUCCESS',user:u?.username??'system',name:u?.full_name??'',ip:q.ip,description:`Archived ${retention.count} checklist run(s) older than ${retention.cutoff}`,changed_fields:'retention_archived_at'});}catch{/* retention remains committed */}
  return {...runs!.context(actor(s)),retention};
 });
 endpoint('post','/checklists','view_checklists','CHECKLIST_CREATE',(q,s)=>runs!.create(actor(s),q.body));
 endpoint('get','/checklists','view_checklists','CHECKLIST_VIEW',(q,s)=>runs!.list(actor(s),q.query));
 endpoint('get','/checklists/:id','view_checklists','CHECKLIST_VIEW',(q,s)=>runs!.get(String(q.params.id),actor(s)));
 endpoint('get','/checklists/:id/sections/:sectionId','view_checklists','CHECKLIST_VIEW',(q,s)=>{
  const result=runs!.section(String(q.params.id),String(q.params.sectionId),actor(s));
  resAuditRun(s,runs!.get(String(q.params.id),actor(s)));return result;
 });
 function resAuditRun(res:express.Response,data:unknown){res.locals.recordChecklist('SUCCESS',data);}
 endpoint('delete','/checklists/:id','manage_checklists','CHECKLIST_DELETE',(q,s)=>runs!.remove(String(q.params.id),actor(s),q.body?.delete_reason));
 router.use((e:unknown,_q:express.Request,s:express.Response,next:express.NextFunction)=>{if(e instanceof CompletionError)return s.status(422).json({error:e.message,...e.details});if(e instanceof ChecklistError)return s.status(e.status).json({error:e.message});next(e);});
 return router;
}
