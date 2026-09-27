import type Database from "better-sqlite3";
import type { User, Report } from "../db.js";
import type { AuthService } from "../auth.js";
import { REPORT_FIELDS, normalizePersonText, pickReport } from "./normalization.js";

export class ReportServiceError extends Error {
  constructor(readonly status:400|403|404|409,message:string){super(message);this.name="ReportServiceError";}
}

type Authorization = Pick<AuthService,"can"|"isShiftEngineer">;
type CreationRequest = {request_id:string;report_id:number;actor_user_id:number;created_at:string};

class ReportRepository {
  constructor(private readonly database: Database.Database) {}
  add(userId:number, ownerId:number|null, values:Record<string,string>):number {
    const marks=REPORT_FIELDS.map(()=>"?").join(",");
    const result=this.database.prepare(`INSERT INTO reports (user_id,owner_user_id,${REPORT_FIELDS.join(",")}) VALUES (?,?,${marks})`)
      .run(userId,ownerId,...REPORT_FIELDS.map(field=>values[field]));
    return Number(result.lastInsertRowid);
  }
  request(id:string):CreationRequest|undefined { return this.database.prepare("SELECT * FROM report_creation_requests WHERE request_id=?").get(id) as CreationRequest|undefined; }
  remember(id:string,report:number,actor:number,created:string):void { this.database.prepare("INSERT INTO report_creation_requests VALUES(?,?,?,?)").run(id,report,actor,created); }
  exists(id:number):boolean { return this.database.prepare("SELECT 1 FROM reports WHERE id=?").get(id)!==undefined; }
  find(id:number):Report|undefined{return this.database.prepare("SELECT * FROM reports WHERE id=?").get(id) as Report|undefined;}
  list():Array<Report&{author:string;owner_name?:string}>{
    return this.database.prepare(`SELECT r.*,author.full_name AS author,owner.full_name AS owner_name
      FROM reports r JOIN users author ON author.id=r.user_id LEFT JOIN users owner ON owner.id=r.owner_user_id
      ORDER BY datetime(r.updated_at) DESC,r.id DESC`).all() as Array<Report&{author:string;owner_name?:string}>;
  }
  replace(id:number,values:Record<string,string>):void{
    this.database.prepare(`UPDATE reports SET ${REPORT_FIELDS.map(field=>`${field}=?`).join(",")},updated_at=datetime('now','localtime') WHERE id=?`)
      .run(...REPORT_FIELDS.map(field=>values[field]),id);
  }
  restore(id:number,userId:number,values:Record<string,string>,measure:string):void{
    this.database.prepare(`UPDATE reports SET xidmet=?,obyekt=?,sistem=?,nasazliq=?,nasazliq_vaxti=?,sebeb=?,tedbir=?,
      berpa_vaxti=?,muraciet=?,cavabdeh=?,prioritet=?,restored_by_update=1,restored_at=datetime('now','localtime'),
      restored_by_user_id=?,updated_at=datetime('now','localtime') WHERE id=?`).run(
      values.xidmet,values.obyekt,values.sistem,values.nasazliq,values.nasazliq_vaxti,values.sebeb,measure,
      values.berpa_vaxti,values.muraciet,values.cavabdeh,values.prioritet,userId,id);
  }
  remove(id:number):number{return this.database.prepare("DELETE FROM reports WHERE id=?").run(id).changes;}
  removeAll():number{return this.database.prepare("DELETE FROM reports").run().changes;}
}

const REQUIRED=(values:Record<string,string>)=>[values.xidmet,values.sistem,values.nasazliq,values.nasazliq_vaxti].every(Boolean);
const actionStamp=(value:string)=>{const match=String(value||"").trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);return match?`${match[3]}.${match[2]}.${match[1].slice(-2)} ${match[4]}:${match[5]}`:String(value||"").replace("T"," ");};

export function createReportService(database:Database.Database,authorization:Authorization) {
  const records=new ReportRepository(database);
  const build=(actor:User,input:Record<string,unknown>)=>{
    const values=pickReport(input);
    if(!REQUIRED(values))
      throw new ReportServiceError(400,"Xidmət, sistem, nasazlıq və nasazlıq vaxtı mütləqdir");
    const owned=authorization.isShiftEngineer(actor);
    if(owned)values.cavabdeh=normalizePersonText(actor.full_name,true);
    return records.add(actor.id,owned?actor.id:null,values);
  };
  const createManual=(actor:User,input:Record<string,unknown>)=>{
    if(!authorization.can(actor,"create_reports"))throw new ReportServiceError(403,"İcazə yoxdur");
    return{id:build(actor,input)};
  };
  const transaction=database.transaction((actor:User,operationId:string,input:Record<string,unknown>)=>{
    if(!authorization.can(actor,"create_reports_from_checklist"))throw new ReportServiceError(403,"İcazə yoxdur");
    const prior=records.request(operationId);if(prior)return{...prior,created:false};
    const report_id=build(actor,input),created_at=new Date().toISOString();records.remember(operationId,report_id,actor.id,created_at);
    return{request_id:operationId,report_id,actor_user_id:actor.id,created_at,created:true};
  });
  return {
    createManual,
    canEdit:(actor:User,report:Report)=>authorization.can(actor,"edit_reports")&&(!authorization.isShiftEngineer(actor)||(report.owner_user_id===actor.id&&!report.berpa_vaxti)),
    canDelete:(actor:User,_report:Report)=>!authorization.isShiftEngineer(actor)&&authorization.can(actor,"delete_reports"),
    request:(id:string)=>records.request(id),
    createIdempotent:(actor:User,id:string,input:Record<string,unknown>)=>transaction.immediate(actor,id,input),
    exists:(id:number)=>records.exists(id),
    list:(actor:User)=>authorization.can(actor,"view_all_reports")?records.list().map(report=>({...report,can_edit:authorization.can(actor,"edit_reports")&&(!authorization.isShiftEngineer(actor)||(report.owner_user_id===actor.id&&!report.berpa_vaxti)),can_delete:!authorization.isShiftEngineer(actor)&&authorization.can(actor,"delete_reports")})):[],
    update:(actor:User,id:number,input:Record<string,unknown>)=>{
      const current=records.find(id);if(!current)throw new ReportServiceError(404,"Qeyd tapılmadı");
      const editable=authorization.can(actor,"edit_reports")&&(!authorization.isShiftEngineer(actor)||(current.owner_user_id===actor.id&&!current.berpa_vaxti));
      if(!editable)throw new ReportServiceError(403,"Yalnız öz açıq qeydlərinizi redaktə edə bilərsiniz");
      const values=pickReport(input);
      if(authorization.isShiftEngineer(actor)){
        values.cavabdeh=normalizePersonText(actor.full_name,true);
        if(!current.berpa_vaxti&&values.berpa_vaxti)throw new ReportServiceError(409,"Bərpa üçün görülən tədbir təsdiqi tələb olunur");
      }
      if(!REQUIRED(values))throw new ReportServiceError(400,"Xidmət, sistem, nasazlıq və nasazlıq vaxtı mütləqdir");
      records.replace(id,values);return{restored:!current.berpa_vaxti&&!!values.berpa_vaxti};
    },
    restore:(actor:User,id:number,input:Record<string,unknown>)=>{
      const current=records.find(id);if(!current)throw new ReportServiceError(404,"Qeyd tapılmadı");
      if(!authorization.isShiftEngineer(actor))throw new ReportServiceError(403,"Bu bərpa prosesi Növbə mühəndisi üçün nəzərdə tutulub");
      if(!(authorization.can(actor,"edit_reports")&&current.owner_user_id===actor.id&&!current.berpa_vaxti))throw new ReportServiceError(403,"Yalnız öz açıq qeydlərinizi bərpa edə bilərsiniz");
      const values=pickReport(input);values.cavabdeh=normalizePersonText(actor.full_name,true);
      if(!REQUIRED(values))throw new ReportServiceError(400,"Xidmət, sistem, nasazlıq və nasazlıq vaxtı mütləqdir");
      if(!values.berpa_vaxti)throw new ReportServiceError(400,"Bərpa tarixi və saatını seçin");
      const description=String(input.recovery_description??"").trim();if(!description)throw new ReportServiceError(400,"Bərpa üçün görülən tədbiri yazın");
      records.restore(id,actor.id,values,[values.tedbir,`[${actionStamp(values.berpa_vaxti)}] ${description}`].filter(Boolean).join("\n"));
    },
    deleteOne:(actor:User,id:number)=>{const current=records.find(id);if(!current)throw new ReportServiceError(404,"Qeyd tapılmadı");if(authorization.isShiftEngineer(actor))throw new ReportServiceError(403,"Növbə mühəndisi qeydləri silə bilməz");if(!authorization.can(actor,"delete_reports"))throw new ReportServiceError(403,"İcazə yoxdur");return records.remove(id);},
    deleteAll:(actor:User)=>{if(authorization.isShiftEngineer(actor))throw new ReportServiceError(403,"Növbə mühəndisi qeydləri silə bilməz");return records.removeAll();},
  };
}
