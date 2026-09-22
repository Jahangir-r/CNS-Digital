import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import express from "express";
import session from "express-session";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createAuthService } from "../src/auth.js";
import { AuditLog } from "../src/audit.js";
import { createTemplateRouter } from "../src/checklists/template-routes.js";
import { migrateChecklistDatabase } from "../src/checklists/migrations.js";
import { localDate } from "../src/local-time.js";
import { templateFixture } from "./fixtures/checklist-template.js";

async function appFixture(t: any, available=true, failingAudit=false) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cns-template-api-"));
  const journal=new Database(":memory:"), checklist=new Database(":memory:");
  checklist.pragma("foreign_keys=ON");migrateChecklistDatabase(checklist);
  journal.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,full_name TEXT,role TEXT,active INTEGER DEFAULT 1,deleted INTEGER DEFAULT 0);
    CREATE TABLE roles(name TEXT PRIMARY KEY,view_checklists INTEGER,manage_checklist_templates INTEGER,manage_checklist_shifts INTEGER);
    INSERT INTO roles VALUES('custom_manager',1,1,0),('reader',1,0,0),('shift_manager',1,0,1),('none',0,0,0);
    INSERT INTO users(id,username,full_name,role) VALUES(1,'manager','Template Manager','custom_manager'),(2,'reader','Reader','reader'),(3,'shifts','Shift Manager','shift_manager'),(4,'none','No access','none');`);
  const auth=createAuthService(journal,"test-only"), audit=new AuditLog(path.join(root,"logs"));
  const app=express();app.use(express.json());app.use(session({secret:"test-only",resave:false,saveUninitialized:false}));
  app.use("/api",createTemplateRouter(available ? {available:true,db:checklist} : {available:false,db:null},auth,
    failingAudit ? {write(){throw new Error("disk failure");}} : audit));
  app.use((_error: unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(500).json({error:"server error"}));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await audit.flush();journal.close();checklist.close();await fs.rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call=async(url:string,method="GET",body?:unknown,user=1)=>{
    const response=await fetch(base+url,{method,headers:{"Content-Type":"application/json",...(user?{"X-CNS-Token":auth.signAuthToken(user)}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  return {call,journal,checklist,audit,root};
}

test("template API acceptance, conflict codes, permission-only access, archive and safe audit",async t=>{
  const {call,journal,audit,root}=await appFixture(t);
  assert.equal((await call('/api/checklist-templates','GET',undefined,0)).status,401);
  assert.equal((await call('/api/checklist-templates','GET',undefined,4)).status,403);
  assert.equal((await call('/api/checklist-templates','GET',undefined,2)).status,403);
  const created=await call('/api/checklist-templates','POST',{code:'TEST',name:'SECRET_TEMPLATE_CONTENT'});
  assert.equal(created.status,201);assert.equal(created.body.version_label,'1.0');
  const id=created.body.id,tid=created.body.template_id;
  assert.equal((await call(`/api/checklist-templates/${tid}`,'PUT',{name:'Renamed template'})).status,200);
  for (const user of [2,3]) {
    assert.equal((await call(`/api/checklist-templates/${tid}/versions`,'GET',undefined,user)).status,403);
    assert.equal((await call(`/api/checklist-template-versions/${id}`,'GET',undefined,user)).status,403);
  }
  assert.equal((await call('/api/checklist-templates','POST',{code:'TEST',name:'duplicate'})).status,409);
  for(const user of [2,3]) {
    for(const [url,method,body] of [
      ['/api/checklist-templates','POST',{code:'DENIED',name:'Denied'}],
      [`/api/checklist-template-versions/${id}`,'PUT',{...templateFixture,revision:1}],
      [`/api/checklist-template-versions/${id}/clone`,'POST',{}],
      [`/api/checklist-template-versions/${id}/publish`,'POST',{revision:1}],
      [`/api/checklist-template-versions/${id}/archive`,'POST',{revision:1}],
    ] as const) assert.equal((await call(url,method,body,user)).status,403);
  }
  assert.equal((await call(`/api/checklist-template-versions/${id}/publish`,'POST',{revision:1})).status,422);
  const saved=await call(`/api/checklist-template-versions/${id}`,'PUT',{...templateFixture,revision:1});assert.equal(saved.status,200);
  assert.equal((await call(`/api/checklist-template-versions/${id}`,'PUT',{...templateFixture,revision:1})).status,409);
  const published=await call(`/api/checklist-template-versions/${id}/publish`,'POST',{revision:2});assert.equal(published.status,200);
  assert.equal((await call('/api/checklist-templates')).body[0].current_version_id,null);
  assert.equal((await call(`/api/checklist-template-versions/${id}/activate`,'POST',{revision:3})).status,200);
  assert.equal((await call('/api/checklist-templates')).body[0].current_version_id,id);
  assert.equal((await call(`/api/checklist-templates/${tid}`,'PUT',{name:'Forbidden current rename'})).status,409);
  assert.equal((await call(`/api/checklist-template-versions/${id}`,'PUT',{...templateFixture,revision:3})).status,409);
  const clone=await call(`/api/checklist-template-versions/${id}/clone`,'POST',{});assert.equal(clone.status,201);assert.equal(clone.body.version_label,'1.1');
  const changed=structuredClone(templateFixture);changed.sections[0].name='New name';changed.sections[0].items.push({stable_key:'EXTRA',name:'New',equipment_name:'New',sort_order:2,active:true,required:false});
  assert.equal((await call(`/api/checklist-template-versions/${clone.body.id}`,'PUT',{...changed,revision:1})).status,200);
  const next=await call(`/api/checklist-template-versions/${clone.body.id}/publish`,'POST',{revision:2});assert.equal(next.status,200);
  assert.equal((await call('/api/checklist-templates')).body[0].current_version_id,id);
  assert.equal((await call(`/api/checklist-template-versions/${clone.body.id}/activate`,'POST',{revision:3})).status,200);
  assert.deepEqual((await call(`/api/checklist-template-versions/${id}`)).body,published.body);
  assert.equal((await call(`/api/checklist-templates/${tid}/versions`)).body.length,2);
  assert.equal((await call(`/api/checklist-template-versions/${id}/archive`,'POST',{revision:3})).status,200);
  assert.equal((await call('/api/checklist-templates')).body[0].current_version_id,clone.body.id);
  assert.equal((await call(`/api/checklist-template-versions/${clone.body.id}/archive`,'POST',{revision:3})).status,409);
  assert.equal((await call('/api/checklist-templates')).body[0].current_version_id,clone.body.id);
  assert.equal((await call(`/api/checklist-template-versions/${clone.body.id}`,'PUT',{...changed,revision:3})).status,409);
  assert.equal((await call('/api/checklist-template-versions/missing')).status,404);
  assert.equal((await call('/api/checklist-templates/missing/versions')).status,404);
  journal.exec("UPDATE roles SET manage_checklist_templates=0 WHERE name='custom_manager'");
  assert.equal((await call('/api/checklist-templates','POST',{code:'AFTER',name:'After revoked'})).status,403);
  await audit.flush();
  const log=await fs.readFile(path.join(root,'logs',`CNS-Jurnal-${localDate()}.log`),'utf8');
  for(const event of ['CREATE','CLONE','UPDATE','PUBLISH','ARCHIVE','MAKE_CURRENT']) assert.ok(log.includes(`[CHECKLIST_TEMPLATE_${event}]`));
  assert.ok(log.includes('module="CHECKLIST"'));assert.ok(log.includes(`template_id="${tid}"`));
  assert.ok(log.includes('template_version="1.0"'));assert.ok(log.includes('revision="3"'));assert.ok(log.includes('changed_fields='));
  assert.ok(log.includes('result=ERROR'));assert.ok(!log.includes('SECRET_TEMPLATE_CONTENT'));assert.ok(!log.includes('equipment_name'));
  assert.deepEqual(journal.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'checklist_%'").all(),[]);
});

test("template endpoints return 503 when checklist DB is unavailable",async t=>{
  const {call}=await appFixture(t,false);
  assert.equal((await call('/api/checklist-templates')).status,503);
  assert.equal((await call('/api/checklist-templates','POST',{code:'TEST',name:'Test'})).status,503);
});

test("audit writer failure does not undo a committed template",async t=>{
  const {call}=await appFixture(t,true,true);
  const result=await call('/api/checklist-templates','POST',{code:'TEST',name:'Test'});
  assert.equal(result.status,201);
  assert.equal((await call(`/api/checklist-template-versions/${result.body.id}`)).status,200);
});
