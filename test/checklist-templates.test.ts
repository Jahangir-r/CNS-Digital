import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateChecklistDatabase } from "../src/checklists/migrations.js";
import { createTemplateService, TemplateError, structureHash, validateStructure } from "../src/checklists/templates.js";

import { templateFixture } from "./fixtures/checklist-template.js";

function setup(t: any) {
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON"); migrateChecklistDatabase(db);
  t.after(() => db.close());
  return { db, service: createTemplateService(db) };
}
const fails = (status: number) => (error: unknown) => error instanceof TemplateError && error.status === status;

test("acceptance: v1.0 structure, IDs, ordering, hash and metadata survive clone/edit/publish v1.1", t => {
  const { db, service } = setup(t);
  let first = service.create({ code: "TEST", name: "Technical test" },1);
  assert.equal(first.version_label,"1.0"); assert.equal(first.status,"draft"); assert.equal(first.revision,1);
  first = service.update(first.id,{ ...templateFixture, revision: 1 });
  assert.equal(first.revision,2);
  first = service.publish(first.id,first.revision,1);
  assert.equal(first.status,"published"); assert.match(first.content_hash!,/^[a-f0-9]{64}$/);
  const saved = JSON.stringify(first);
  const secondDraft = service.clone(first.id,2);
  assert.equal(secondDraft.version_label,"1.1"); assert.equal(secondDraft.based_on_version_id,first.id);
  assert.equal(secondDraft.content_hash,null); assert.equal(secondDraft.revision,1);
  assert.notEqual(secondDraft.sections[0].id,first.sections[0].id);
  assert.notEqual(secondDraft.sections[0].items[0].id,first.sections[0].items[0].id);
  assert.deepEqual(validateStructure(secondDraft),validateStructure(first));
  const edited = structuredClone(templateFixture);
  edited.sections[0].name = "Changed SUP/APP";
  edited.sections[1].items.push({ stable_key: "EXTRA", name: "Extra", equipment_name: "Radio", sort_order: 1, required: false, active: true });
  let second = service.update(secondDraft.id,{ ...edited, revision: secondDraft.revision });
  second = service.publish(second.id,second.revision,2);
  second = service.activate(second.id,second.revision);
  assert.notEqual(second.content_hash,first.content_hash);
  assert.equal(JSON.stringify(service.get(first.id)),saved);
  assert.equal((db.prepare("SELECT current_version_id FROM checklist_templates").get() as any).current_version_id,second.id);
  assert.equal(service.clone(first.id,1).version_label,"1.2");
});

test("draft revision conflicts and invalid structures do not partially overwrite; publish validation", t => {
  const { db, service } = setup(t);
  const version = service.create({ code: "TEST", name: "Test" },1);
  assert.throws(() => service.publish(version.id,1,1),fails(422));
  const updated = service.update(version.id,{ ...templateFixture,revision:1 });
  assert.throws(() => service.update(version.id,{ ...templateFixture,revision:1 }),fails(409));
  assert.throws(() => service.publish(version.id,1,1),fails(409));
  const invalid = structuredClone(templateFixture); invalid.sections[1].sort_order=0;
  assert.throws(() => service.update(version.id,{ ...invalid,revision:2 }),fails(422));
  assert.deepEqual(service.get(version.id),updated);
  // A failure after DELETEs during a replacement must roll the entire save back.
  db.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON checklist_items WHEN NEW.stable_key='VCS' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => service.update(version.id,{ ...templateFixture,revision:2 }),/test failure/);
  assert.deepEqual(service.get(version.id),updated);
  db.exec('DROP TRIGGER reject_fixture');
  assert.equal(service.clone(version.id,1).version_label,'1.1');
});

test("deterministic hash ignores IDs and input array order, includes all structural flags and metadata", () => {
  const base = structureHash(templateFixture);
  const reversed = structuredClone(templateFixture); reversed.sections.reverse(); reversed.sections[1].items.reverse();
  assert.equal(structureHash(reversed),base);
  assert.equal(structureHash({ ...templateFixture, id: "not-part-of-hash" } as any),base);
  const mutations = [
    (x: any) => x.sections[0].name="Other",
    (x: any) => x.sections[0].stable_key="OTHER",
    (x: any) => { x.sections[0].sort_order=2; },
    (x: any) => x.sections[0].active=false,
    (x: any) => x.sections[0].service_name="Energy",
    (x: any) => x.sections[0].object_name="Other",
    (x: any) => x.sections[0].items[0].name="Other",
    (x: any) => x.sections[0].items[0].equipment_name="Other",
    (x: any) => x.sections[0].items[0].sort_order=2,
    (x: any) => x.sections[0].items[0].required=false,
    (x: any) => x.sections[0].items[0].active=false,
  ];
  for (const mutate of mutations) { const value = structuredClone(templateFixture); mutate(value); assert.notEqual(structureHash(value),base); }
});

test("SQL protects published/archived versions and descendants, including insert, move and REPLACE", t => {
  const { db, service } = setup(t);
  let version = service.create({ code:"TEST",name:"Test" },1);
  version=service.update(version.id,{ ...templateFixture,revision:1 });
  version=service.publish(version.id,version.revision,1,false);
  const frozen=structuredClone(version);
  const clone=service.clone(version.id,1);
  const section=version.sections[0],item=section.items[0];
  const attempts = [
    () => db.prepare("UPDATE checklist_template_versions SET name_snapshot='hacked' WHERE id=?").run(version.id),
    () => db.prepare("UPDATE checklist_template_versions SET content_hash=? WHERE id=?").run("a".repeat(64),version.id),
    () => db.prepare("UPDATE checklist_template_versions SET status='draft',content_hash=NULL,published_by=NULL,published_at=NULL WHERE id=?").run(version.id),
    () => db.prepare("UPDATE checklist_sections SET name='hacked' WHERE id=?").run(section.id),
    () => db.prepare("UPDATE checklist_sections SET template_version_id=? WHERE id=?").run(clone.id,section.id),
    () => db.prepare("UPDATE checklist_items SET equipment_name='hacked' WHERE id=?").run(item.id),
    () => db.prepare("UPDATE checklist_items SET section_id=? WHERE id=?").run(clone.sections[0].id,item.id),
    () => db.prepare("INSERT INTO checklist_sections VALUES ('new',?,'NEW','New',99,1,'','')").run(version.id),
    () => db.prepare("INSERT INTO checklist_items VALUES ('new',?,'NEW','New','New',99,1,1)").run(section.id),
    () => db.prepare("INSERT OR REPLACE INTO checklist_sections VALUES (?,?,'REPLACED','New',99,1,'','')").run(section.id,clone.id),
    () => db.prepare("INSERT OR REPLACE INTO checklist_items VALUES (?,?,'REPLACED','New','',99,1,1)").run(item.id,clone.sections[0].id),
    () => db.prepare("INSERT OR REPLACE INTO checklist_template_versions(id,template_id,major,minor,version_label,status,name_snapshot,created_by,created_at) VALUES (?,?,1,0,'1.0','draft','hacked',1,'now')").run(version.id,version.template_id),
    () => db.prepare("DELETE FROM checklist_templates WHERE id=?").run(version.template_id),
  ];
  for (const attempt of attempts) assert.throws(attempt);
  assert.deepEqual(service.get(version.id),frozen);
  const archived=service.archive(version.id,version.revision,2);
  for (const attempt of attempts) assert.throws(attempt);
  assert.deepEqual(service.get(version.id),archived);
  assert.equal(archived.content_hash,frozen.content_hash);
  assert.deepEqual(archived.sections,frozen.sections);
  assert.throws(() => db.prepare("UPDATE checklist_template_versions SET archived_by=3 WHERE id=?").run(version.id));
});

test("current is explicit, protected from archive, and historical versions remain", t => {
  const { db,service }=setup(t);
  let one=service.create({code:"TEST",name:"Test"},1);
  one=service.update(one.id,{...templateFixture,revision:1}); one=service.publish(one.id,one.revision,1);
  one=service.activate(one.id,one.revision);let two=service.clone(one.id,1); two=service.publish(two.id,two.revision,1);two=service.activate(two.id,two.revision);
  assert.equal(one.content_hash,two.content_hash);
  service.archive(one.id,one.revision,1);
  assert.equal((db.prepare("SELECT current_version_id FROM checklist_templates").get() as any).current_version_id,two.id);
  assert.throws(()=>service.archive(two.id,two.revision,1),fails(409));
  assert.equal((db.prepare("SELECT current_version_id FROM checklist_templates").get() as any).current_version_id,two.id);
  assert.equal(service.versions(one.template_id).length,2);
  const draft=service.clone(one.id,1);
  assert.equal(draft.version_label,"1.2");
  service.archive(draft.id,draft.revision,1);
  assert.equal(service.clone(two.id,1).version_label,"1.3");
  assert.throws(() => db.prepare("UPDATE checklist_templates SET current_version_id=? WHERE id=?").run(one.id,one.template_id));
});

test("migration v1 to v2 is repeatable, keeps data and has no production templates", t => {
  const db=new Database(":memory:");t.after(()=>db.close());db.pragma("foreign_keys=ON");
  db.exec("CREATE TABLE checklist_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL); INSERT INTO checklist_schema_migrations VALUES(1,'initialize_checklist_storage','original timestamp')");
  migrateChecklistDatabase(db);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM checklist_templates").get() as any).n,0);
  const service=createTemplateService(db), version=service.create({code:"TEST",name:"Test"},1);
  const before=db.prepare("SELECT * FROM checklist_schema_migrations").all();
  migrateChecklistDatabase(db);
  assert.deepEqual(db.prepare("SELECT * FROM checklist_schema_migrations").all(),before);
  assert.deepEqual(service.get(version.id),version);
  assert.deepEqual(db.pragma("foreign_key_check"),[]);
});

test("activation rollback preserves published version and current pointer", t=>{
  const {db,service}=setup(t);
  let version=service.create({code:"TEST",name:"Test"},1);
  version=service.update(version.id,{...templateFixture,revision:1});
  version=service.publish(version.id,version.revision,1,false);
  db.exec("CREATE TRIGGER reject_current BEFORE UPDATE OF current_version_id ON checklist_templates BEGIN SELECT RAISE(ABORT,'activate failure'); END");
  assert.throws(()=>service.activate(version.id,version.revision),/activate failure/);
  assert.equal(service.get(version.id).status,'published');
  assert.equal((db.prepare("SELECT current_version_id FROM checklist_templates").get() as any).current_version_id,null);
});


test("physical delete removes unused versions, refuses current and returns 404 on repeat", t => {
  const {db,service}=setup(t);
  const draft=service.create({code:"DELETE_ME",name:"Delete me"},1);
  assert.equal(service.remove(draft.id).deleted,true);
  assert.equal(db.prepare("SELECT 1 FROM checklist_template_versions WHERE id=?").get(draft.id),undefined);
  assert.throws(()=>service.remove(draft.id),fails(404));
  let current=service.create({code:"CURRENT",name:"Current"},1);
  current=service.update(current.id,{...templateFixture,revision:1});current=service.publish(current.id,current.revision,1);
  assert.throws(()=>service.remove(current.id),fails(409));
  const unused=service.clone(current.id,1);service.archive(unused.id,unused.revision,1);
  assert.equal(service.remove(unused.id).deleted,true);
});

test("technology card accepts only checkbox combinations and normalizes their order", t => {
  const {service}=setup(t);const version=service.create({code:"TK",name:"TK"},1);
  const reversed=structuredClone(templateFixture);reversed.sections[0].items[0].technology_card="İ1,S1,H1";
  const saved=service.update(version.id,{...reversed,revision:1});
  assert.equal(saved.sections[0].items[0].technology_card,"S1,H1,İ1");
  const invalid=structuredClone(templateFixture);invalid.sections[0].items[0].technology_card="S2";
  assert.throws(()=>service.update(saved.id,{...invalid,revision:saved.revision}),fails(422));
  assert.equal(service.get(saved.id).sections[0].items[0].technology_card,"S1,H1,İ1");
});
