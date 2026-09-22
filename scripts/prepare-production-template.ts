// Prepare a review artifact in an explicitly supplied, NEW directory outside the project.
// Never opens an existing database and never publishes or seeds on server startup.
import fs from 'node:fs';
import path from 'node:path';
import {openChecklistDatabase} from '../src/checklists/db.js';
import {importProductionTemplate,productionSource,productionReference} from '../src/checklists/production-template.js';
import {templateWorkbook} from '../src/checklists/template-excel.js';
const target=process.argv[2],actor=Number(process.argv[3]);
if(!target||!Number.isSafeInteger(actor)||actor<1)throw Error('Usage: tsx scripts/prepare-production-template.ts NEW_EXTERNAL_DIRECTORY ACTOR_ID');
const root=path.resolve(target),project=fs.realpathSync(process.cwd()),parent=fs.realpathSync(path.dirname(root));
const actual=path.join(parent,path.basename(root));
if(actual===project||actual.startsWith(project+path.sep))throw Error('Use a new external review directory, not the project');
fs.mkdirSync(actual); // EEXIST deliberately rejects any existing destination/database.
const storage=openChecklistDatabase(actual,()=>{});
if(!storage.available)throw Error('Review storage unavailable');
try{
 const result=importProductionTemplate(storage.db,actor),v=result.version;
 await templateWorkbook(v,productionReference()).xlsx.writeFile(path.join(actual,'Checklist-Template-v1.0.xlsx'));
 const summary={scope:'REVIEW DATABASE ONLY',template_id:v.template_id,version_id:v.id,code:productionSource().code,version:v.version_label,status:v.status,sections:v.sections.map(s=>({key:s.stable_key,name:s.name,items:s.items.length})),items:v.sections.reduce((n,s)=>n+s.items.length,0),repeat:importProductionTemplate(storage.db,actor).outcome};
 fs.writeFileSync(path.join(actual,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
}finally{storage.db.close();}
