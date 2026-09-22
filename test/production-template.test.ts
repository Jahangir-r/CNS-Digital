import {test} from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import {migrateChecklistDatabase} from '../src/checklists/migrations.js';
import {createTemplateService,structureHash,validateStructure} from '../src/checklists/templates.js';
import {importProductionTemplate,productionSource,productionReference} from '../src/checklists/production-template.js';
import {templateWorkbook} from '../src/checklists/template-excel.js';
const counts=[6,5,5,7,6,6,7,6,5,7,5,6,4,6,4,7,4,7,4,5,4,5,5,9,10,7,10,7,10,24];
test('production draft: exact approved structure, ordering, keys, references, idempotency, edited/published protection and Excel',async()=>{
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');migrateChecklistDatabase(db);
 try{
  const {outcome,version:v}=importProductionTemplate(db,1);assert.equal(outcome,'created');assert.equal(v.status,'draft');assert.equal(v.version_label,'1.0');
  assert.deepEqual(v.sections.map(s=>s.items.length),counts);assert.equal(v.sections.flatMap(s=>s.items).length,203);
  assert.equal(new Set(v.sections.map(s=>s.stable_key)).size,30);
  for(const [n,s] of v.sections.entries()){
   assert.equal(s.sort_order,n);assert.equal(s.active,1);assert.equal(s.service_name,'');assert.equal(s.object_name,'');assert.equal(new Set(s.items.map(i=>i.stable_key)).size,s.items.length);
   for(const [j,i] of s.items.entries()){assert.equal(i.sort_order,j);assert.equal(i.active,1);assert.equal(i.required,1);assert.doesNotMatch(i.name,/Mini PC|MNG|Garex|çat var/);}
  }
  assert.equal(v.sections[15].items[1].name,'Phoenix');assert.equal(v.sections[15].items[1].stable_key,'PHOENIX');assert.equal(v.sections[9].items[1].name,'Phoenix');assert.equal(v.sections[9].items[1].stable_key,'PHOENIX');assert.equal(v.sections[22].items[2].name,'SELVA');assert.equal(v.sections[29].items.at(-1)?.stable_key,'POLYOT_1_126_675_RX_REC');
  assert.equal(productionReference().headers['service header'],'U və RRTT Xidməti');assert.equal(productionReference().handwritten_notes.length,27);assert.deepEqual(productionReference().resolved_abbreviations.MNG,{display_name:'ManageAir',manufacturer:'Indra',stable_key:'MANAGEAIR',structure_status:'review_only: handwritten occurrence does not add an item or determine its section'});assert.equal(productionReference().unresolved.some((x:any)=>x.item_key==='PHOENIX'),false);
  assert.equal(productionReference().unresolved.some((x:any)=>x.text.includes('HHİE')||x.text.includes('EGL- nə ümumi baxış')),false);
  assert.deepEqual(importProductionTemplate(db,1),{outcome:'unchanged',version:v});
  assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_templates').get() as any).n,1);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM checklist_template_versions').get() as any).n,1);
  const book=new ExcelJS.Workbook();await book.xlsx.load(await templateWorkbook(v,productionReference()).xlsx.writeBuffer());
  const sheet=book.getWorksheet('Şablon strukturu')!;assert.equal(sheet.rowCount,204);
  let row=2;for(const s of v.sections)for(const i of s.items){assert.equal(sheet.getRow(row).getCell(2).value,s.name);assert.equal(sheet.getRow(row).getCell(4).value,i.name);assert.equal(sheet.getRow(row).getCell(13).value,i.stable_key);row++;}
  const service=createTemplateService(db),edited=service.update(v.id,{...validateStructure(v),name_snapshot:'User edit',revision:v.revision});
  assert.throws(()=>importProductionTemplate(db,1),/Qaralama dəyişdirilib/);assert.deepEqual(service.get(v.id),edited);
  // Independent in-memory test only: verify importer cannot modify a published version.
  const published=service.publish(edited.id,edited.revision,1);assert.equal(importProductionTemplate(db,1).outcome,'protected');assert.deepEqual(service.get(v.id),published);
  const historical=templateWorkbook(service.get(v.id));assert.equal(historical.getWorksheet('Şablon strukturu')!.rowCount,204);
  assert.equal(structureHash(validateStructure(productionSource().structure)),structureHash(validateStructure(v)));
 }finally{db.close();}
});
