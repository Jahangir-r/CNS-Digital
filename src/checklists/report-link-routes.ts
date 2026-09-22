import express from 'express';
import type Database from 'better-sqlite3';
import type {ChecklistStorage} from './db.js';
import type {AuthService} from '../auth.js';
import type {AuditLog,AuditEvent} from '../audit.js';
import {createReportService,ReportServiceError} from '../reports/service.js';
import {createReportLinkService,MissingReportFields} from './report-links.js';
import {ChecklistError} from './shifts.js';
export function createReportLinkRouter(storage:ChecklistStorage,journal:Database.Database,auth:AuthService,audit:Pick<AuditLog,'write'>,backup:(res:express.Response)=>void,now:()=>Date=()=>new Date()){
 const router=express.Router(),service=storage.available?createReportLinkService(storage.db,createReportService(journal,auth),auth,now):null;
 const path='/checklists/:id/items/:itemId/report';
 function log(req:express.Request,res:express.Response,event:string,result:'SUCCESS'|'ERROR',data:any={}){try{const u=res.locals.auditActor;audit.write({module:'CHECKLIST',event,result,user:u?.username??'anonymous',name:u?.full_name??'',ip:req.ip,
  checklist_id:String(res.locals.reportLinkIds?.id??req.params.id),item_id:String(res.locals.reportLinkIds?.itemId??req.params.itemId),operation_id:data.operation_id,report_id:data.report_id} as AuditEvent);}catch{/* nonfatal */}}
 router.get(path,auth.requireAuth,auth.requirePerm('view_checklists'),(q,s,n)=>{if(!service)return s.status(503).json({error:'Yoxlama modulu hazırda əlçatan deyil'});try{s.json(service.get(String(q.params.id),String(q.params.itemId),s.locals.user));}catch(e){n(e);}});
 router.post(path,(q,s,n)=>{s.locals.reportLinkIds={...q.params};s.once('finish',()=>{if(s.statusCode>=400)log(q,s,'REPORT_LINK_ERROR','ERROR',s.locals.relation);});n();},auth.requireAuth,auth.requirePerm('view_checklists'),auth.requirePerm('create_reports_from_checklist'),(q,s,n)=>{
  if(!service)return s.status(503).json({error:'Yoxlama modulu hazırda əlçatan deyil'});
  try{const result=service.create(String(q.params.id),String(q.params.itemId),s.locals.user,q.body,(r,l)=>{
   s.locals.relation={operation_id:l.operation_id,report_id:r.report_id};
   try{backup(s);}catch{/* report is already committed */}
   if(r.created){log(q,s,'REPORT_CREATE','SUCCESS',s.locals.relation);log(q,s,'REPORT_CREATE_FROM_CHECKLIST','SUCCESS',s.locals.relation);}
  });if(result.recovered)log(q,s,'REPORT_LINK_RECOVERED','SUCCESS',result);s.status(result.created?201:200).json(result);
  }catch(e){try{s.locals.relation=service.get(String(q.params.id),String(q.params.itemId),s.locals.user);}catch{}n(e);}
 });
 router.use((e:unknown,_q:express.Request,s:express.Response,n:express.NextFunction)=>{
  if(e instanceof MissingReportFields)return s.status(422).json({error:e.message,missing_fields:e.missing_fields});
  if(e instanceof ChecklistError||e instanceof ReportServiceError)return s.status(e.status).json({error:e.message});n(e);
 });return router;
}
