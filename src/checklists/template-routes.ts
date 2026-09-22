import express from "express";
import {templateWorkbook} from "./template-excel.js";
import {productionReference} from "./production-template.js";
import type { AuthService } from "../auth.js";
import type { AuditLog, AuditEvent } from "../audit.js";
import type { ChecklistStorage } from "./db.js";
import { createTemplateService, TemplateError, type Version } from "./templates.js";

export function createTemplateRouter(storage: ChecklistStorage, auth: AuthService, audit: Pick<AuditLog, "write">) {
  const router = express.Router();
  const service = storage.available ? createTemplateService(storage.db) : null;
  const available: express.RequestHandler = (_req,res,next) => {
    if (!service) return res.status(503).json({ error: "Yoxlama modulu hazırda əlçatan deyil" });
    next();
  };
  const read = [auth.requireAuth, auth.requirePerm("manage_checklist_templates"), available];
  router.get("/checklist-templates", ...read, (_req,res) => res.json(service!.list()));
  router.get("/checklist-templates/:id/versions", ...read, (req,res) => res.json(service!.versions(String(req.params.id))));
  router.get("/checklist-template-versions/:id", ...read, (req,res) => res.json(service!.get(String(req.params.id))));

  function reference(id: string) {
    const v=service!.get(id);
    const t=(service!.list() as {id:string;code:string}[]).find(t=>t.id===v.template_id);
    return t?.code==='CNS_DAILY_TECHNICAL_CHECK' && v.version_label==='1.0' ? productionReference() : null;
  }
  router.get('/checklist-template-versions/:id/reference', ...read, (req,res)=>res.json(reference(String(req.params.id))));
  router.get('/checklist-template-versions/:id/export', ...read, async (req,res,next)=>{
    try {
      const v=service!.get(String(req.params.id));
      const bytes=await templateWorkbook(v,reference(v.id)).xlsx.writeBuffer();
      res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.attachment(`Checklist-Template-v${v.version_label}.xlsx`);res.send(Buffer.from(bytes));
    } catch(error){next(error);}
  });

  function track(event: string, changed_fields: string): express.RequestHandler {
    return (req,res,next) => {
      let recorded = false;
      res.locals.templateAudit = (version?: Version, failed = false) => {
        if (recorded) return;
        recorded = true;
        try {
          // Resolve only identifiers for a failed request; never log submitted template JSON.
          if (!version && service && req.params.id) {
            try { version = service.get(String(req.params.id)); } catch { /* not found or unavailable */ }
          }
          const actor = res.locals.auditActor;
          const entry: AuditEvent = {
            module: "CHECKLIST", event, changed_fields,
            user: actor?.username ?? "anonymous", name: actor?.full_name ?? "", ip: req.ip,
            template_id: version?.template_id, template_version_id: version?.id,
            template_version: version?.version_label, revision: version?.revision,
            result: failed ? "ERROR" : "SUCCESS", description: failed ? "Template operation failed" : "Template operation committed",
          };
          audit.write(entry);
        } catch { /* audit failure must not change a committed operation */ }
      };
      res.once("finish", () => { if (!recorded) res.locals.templateAudit(undefined,true); });
      res.once("close", () => { if (!recorded) res.locals.templateAudit(undefined,true); });
      next();
    };
  }
  function mutation(event: string, fields: string, action: (req: express.Request, actor: number) => Version, status = 200) {
    return [track(event,fields), auth.requireAuth, auth.requirePerm("manage_checklist_templates"), available,
      ((req,res) => {
        const version = action(req,res.locals.user.id);
        res.locals.templateAudit(version);
        res.status(status).json(version);
      }) as express.RequestHandler];
  }
  router.post("/checklist-templates", ...mutation("CHECKLIST_TEMPLATE_CREATE", "code,name,initial_version",
    (req,actor) => service!.create(req.body,actor),201));
  router.put("/checklist-templates/:id",track("CHECKLIST_TEMPLATE_UPDATE","name"),auth.requireAuth,auth.requirePerm("manage_checklist_templates"),available,(req,res)=>{const result=service!.rename(String(req.params.id),req.body);res.locals.templateAudit();res.json(result);});
  router.post("/checklist-template-versions/:id/clone", ...mutation("CHECKLIST_TEMPLATE_CLONE", "version,structure",
    (req,actor) => service!.clone(String(req.params.id),actor),201));
  router.put("/checklist-template-versions/:id", ...mutation("CHECKLIST_TEMPLATE_UPDATE", "name_snapshot,sections,items,technology_card",
    req => service!.update(String(req.params.id),req.body)));
  router.post("/checklist-template-versions/:id/publish", ...mutation("CHECKLIST_TEMPLATE_PUBLISH", "status,content_hash,current_version_id",
    (req,actor) => service!.publish(String(req.params.id),req.body?.revision,actor,false)));
  router.post("/checklist-template-versions/:id/activate", ...mutation("CHECKLIST_TEMPLATE_MAKE_CURRENT", "current_version_id",
    req => service!.activate(String(req.params.id),req.body?.revision)));
  router.post("/checklist-template-versions/:id/archive", ...mutation("CHECKLIST_TEMPLATE_ARCHIVE", "status,archived_at,current_version_id",
    (req,actor) => service!.archive(String(req.params.id),req.body?.revision,actor)));
  router.delete("/checklist-template-versions/:id",track("CHECKLIST_TEMPLATE_DELETE","physical_delete"),auth.requireAuth,auth.requirePerm("manage_checklist_templates"),available,(req,res)=>{
    const result=service!.remove(String(req.params.id));res.locals.templateAudit();res.json(result);
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof TemplateError) return res.status(error.status).json({ error: error.message });
    next(error);
  });
  return router;
}
