import type Database from "better-sqlite3";
import type { User, Report } from "../db.js";
import type { AuthService } from "../auth.js";
import { REPORT_FIELDS, normalizePersonText, pickReport } from "./normalization.js";

export class ReportServiceError extends Error {
  constructor(public readonly status: 400 | 403, message: string) {
    super(message);
    this.name = "ReportServiceError";
  }
}

export function createReportService(db: Database.Database, auth: Pick<AuthService, "can" | "isShiftEngineer">) {
  function insert(user: User, body: Record<string, unknown>) {
    const report = pickReport(body);
    if (!report.xidmet || !report.sistem || !report.nasazliq || !report.nasazliq_vaxti) {
      throw new ReportServiceError(400, "Xidmət, sistem, nasazlıq və nasazlıq vaxtı mütləqdir");
    }
    const shiftEngineer = auth.isShiftEngineer(user);
    if (shiftEngineer) report.cavabdeh = normalizePersonText(user.full_name, true);
    const info = db.prepare(
      `INSERT INTO reports (user_id, owner_user_id, ${REPORT_FIELDS.join(",")}) VALUES (?,?,${REPORT_FIELDS.map(() => "?").join(",")})`
    ).run(user.id, shiftEngineer ? user.id : null, ...REPORT_FIELDS.map(field => report[field]));
    return { id: info.lastInsertRowid };
  }

  function createManual(user:User,body:Record<string,unknown>) {
    if(!auth.can(user,"create_reports"))throw new ReportServiceError(403,"İcazə yoxdur");
    return insert(user,body);
  }
  function request(requestId:string) {
    return db.prepare("SELECT * FROM report_creation_requests WHERE request_id=?").get(requestId) as {request_id:string;report_id:number;actor_user_id:number;created_at:string}|undefined;
  }
  // Internal API only. The checklist coordinator verifies ownership, snapshots and binds the server operation ID.
  const idempotent=db.transaction((user:User,requestId:string,body:Record<string,unknown>)=>{
    if(!auth.can(user,"create_reports_from_checklist"))throw new ReportServiceError(403,"İcazə yoxdur");
    const existing=request(requestId);if(existing)return {...existing,created:false};
    const result=insert(user,body),created_at=new Date().toISOString();
    db.prepare("INSERT INTO report_creation_requests VALUES(?,?,?,?)").run(requestId,Number(result.id),user.id,created_at);
    return {request_id:requestId,report_id:Number(result.id),actor_user_id:user.id,created_at,created:true};
  });
  function canEdit(user: User, report: Report): boolean {
    if (!auth.can(user, "edit_reports")) return false;
    if (!auth.isShiftEngineer(user)) return true;
    return report.owner_user_id === user.id && !report.berpa_vaxti;
  }

  function canDelete(user: User, _report: Report): boolean {
    if (auth.isShiftEngineer(user)) return false;
    return auth.can(user, "delete_reports");
  }

  // HTTP handlers retain the existing audit/backup hooks after successful writes.

  return { createManual, canEdit, canDelete, request, createIdempotent:(u:User,id:string,b:Record<string,unknown>)=>idempotent.immediate(u,id,b),
    exists:(id:number)=>!!db.prepare("SELECT 1 FROM reports WHERE id=?").get(id) };
}
