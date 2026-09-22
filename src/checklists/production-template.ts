import fs from 'node:fs';
import type Database from 'better-sqlite3';
import {createTemplateService, structureHash, validateStructure, TemplateError} from './templates.js';

// Explicit import only: never called by server startup or a migration.
export function productionSource() {
  return JSON.parse(fs.readFileSync(new URL('../../docs/production/checklist-v1.0.json',import.meta.url),'utf8'));
}
export function productionReference() {
  return JSON.parse(fs.readFileSync(new URL('../../docs/production/checklist-v1.0-reference.json',import.meta.url),'utf8'));
}
export function importProductionTemplate(db:Database.Database, actor:number) {
  if(!Number.isSafeInteger(actor)||actor<1) throw new TemplateError(422,'İcraçı ID tələb olunur');
  const source=productionSource(), structure=validateStructure(source.structure), service=createTemplateService(db);
  return db.transaction(()=>{
    const template=db.prepare('SELECT id FROM checklist_templates WHERE code=?').get(source.code) as {id:string}|undefined;
    if(template){
      const row=db.prepare("SELECT id FROM checklist_template_versions WHERE template_id=? AND version_label='1.0'").get(template.id) as {id:string}|undefined;
      if(!row)throw new TemplateError(409,'Mövcud şablonda v1.0 yoxdur; avtomatik dəyişiklik edilmədi');
      const version=service.get(row.id);
      if(version.status!=='draft')return {outcome:'protected',version};
      if(structureHash(validateStructure(version))!==structureHash(structure))
        throw new TemplateError(409,'Qaralama dəyişdirilib; import mövcud məlumatı əvəz etmədi');
      return {outcome:'unchanged',version};
    }
    const initial=service.create({code:source.code,name:source.name},actor);
    return {outcome:'created',version:service.update(initial.id,{...structure,revision:initial.revision})};
  }).immediate();
}
