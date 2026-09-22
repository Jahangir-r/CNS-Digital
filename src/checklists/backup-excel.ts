import type Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import {localTimestamp} from '../local-time.js';
import {isSectionComplete,type Answer} from './progress.js';
const tables=['checklist_schema_migrations','checklist_templates','checklist_template_versions','checklist_sections','checklist_items',
 'checklist_shift_schedule_versions','checklist_shift_rules','checklist_shift_periods','checklist_shift_current','checklist_runs','checklist_run_sections','checklist_run_items','checklist_report_links'] as const;
type Row=Record<string,any>;
export type ChecklistSnapshot=Record<typeof tables[number],Row[]>;
export function readChecklistSnapshot(db:Database.Database):ChecklistSnapshot {
 return db.transaction(()=>Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()])) as ChecklistSnapshot)();
}
export interface BackupMetadata {at:Date;source:string;databaseFile:string;excelFile:string;applicationVersion?:string}
const yes=(v:unknown)=>v?'Bəli':'Xeyr';
const status=(v:string)=>({draft:'Qaralama',published:'Dərc edilib',archived:'Arxivləşdirilib',completed:'Tamamlandı',in_progress:'Davam edir',pending:'Gözləyir',linked:'Əlaqələndirilib',error:'Xəta',ok:'OK',problem:'Problem',na:'N/A'}[v]??v);
export function buildChecklistWorkbook(s:ChecklistSnapshot,meta:BackupMetadata):ExcelJS.Workbook {
 const book=new ExcelJS.Workbook();book.creator='CNS Digital';book.title='CNS Digital — Checklist backup';book.created=meta.at;
 function sheet(name:string,headers:string[],rows:unknown[][]){
  const sh=book.addWorksheet(name);sh.columns=headers.map(header=>({header,width:24}));
  for(const row of rows)sh.addRow(row.map(v=>v===undefined||v===null?'':v));
  sh.views=[{state:'frozen',ySplit:1}];sh.autoFilter={from:{row:1,column:1},to:{row:1,column:headers.length}};
  sh.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sh.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF315D7C'}};
  sh.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};});return sh;
 }
 const runs=s.checklist_runs,sections=s.checklist_run_sections,items=s.checklist_run_items,versions=s.checklist_template_versions;
 const runById=new Map(runs.map(r=>[r.id,r])),sectionById=new Map(sections.map(r=>[r.id,r]));
 const links=new Map(s.checklist_report_links.map(r=>[r.run_item_id,r]));
 const itemsBySection=new Map<string,Row[]>();for(const i of items){const list=itemsBySection.get(i.run_section_id)??[];list.push(i);itemsBySection.set(i.run_section_id,list);}
 const sectionsByRun=new Map<string,Row[]>();for(const section of sections){const list=sectionsByRun.get(section.run_id)??[];list.push(section);sectionsByRun.set(section.run_id,list);}
 const complete=(section:Row)=>isSectionComplete((itemsBySection.get(section.id)??[]) as Answer[]);
 const count=(rows:Row[],value:string)=>rows.filter(r=>r.result===value).length;
 const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
 const currentVersions=s.checklist_templates.filter(t=>!t.archived_at).flatMap(t=>versions.filter(v=>v.id===t.current_version_id&&v.status==='published').map(v=>`${t.name} v${v.version_label}`));
 const activated=new Set(s.checklist_shift_current.map(v=>v.schedule_version_id));
 const schedule=s.checklist_shift_schedule_versions.filter(v=>activated.has(v.id)&&v.effective_from<=meta.at.toISOString()).sort((a,b)=>b.effective_from.localeCompare(a.effective_from)||b.version-a.version)[0];
 sheet('Xülasə',['Göstərici','Dəyər'],[
  ['Backup yaradılıb',localTimestamp(meta.at)],['Saat qurşağı',timezone],['Yoxlamalar (silinmiş daxil)',runs.length],
  ['Tamamlandı',runs.filter(r=>r.status==='completed').length],['Davam edir',runs.filter(r=>r.status==='in_progress').length],
  ['Problem',count(items,'problem')],['N/A',count(items,'na')],['Əlaqələndirilmiş nasazlıqlar',s.checklist_report_links.filter(l=>l.state==='linked').length],
  ['Şablon versiyaları',versions.length],['Cari dərc edilmiş şablon',currentVersions.join('; ')||'Yoxdur'],
  ['Cari növbə cədvəli',schedule?.status==='published'?String(schedule.version):'Yoxdur']]);
 sheet('Yoxlamalar',['ID','Tarix','İş günü','İcraçı','Login','Növbə','Başlama vaxtı (UTC)','Bitmə vaxtı (UTC)','Status','Şablon versiyası','OK','Problem','N/A','Tamamlanan mövqelər','Ümumi mövqelər','Əlavə yoxlama','Silinib','Saat qurşağı','İlk tamamlanma (UTC)','Redaktə sərhədi (UTC)','Şablon hash'],runs.map(r=>{
  const own=sectionsByRun.get(r.id)??[],answers=own.flatMap(s=>itemsBySection.get(s.id)??[]);
  return [r.id,r.local_date,r.work_date,r.employee_name_snapshot,r.username_snapshot,r.shift_label_snapshot,r.started_at,r.completed_at,status(r.status),r.template_version_snapshot,count(answers,'ok'),count(answers,'problem'),count(answers,'na'),own.filter(complete).length,own.length,yes(r.is_extra),yes(r.deleted_at),r.timezone_snapshot,r.first_completed_at,r.edit_until_snapshot,r.template_content_hash];}));
 sheet('Mövqelər',['Checklist ID','Tarix','İcraçı','Növbə','Mövqe','Sıra','Tamamlanıb','Problem sayı','N/A sayı','Mövqe üzrə qeyd','Mövqe ID','Silinib'],sections.map(section=>{const r=runById.get(section.run_id)!,a=itemsBySection.get(section.id)??[];return [r.id,r.work_date,r.employee_name_snapshot,r.shift_label_snapshot,section.name_snapshot,section.sort_order_snapshot,yes(complete(section)),count(a,'problem'),count(a,'na'),section.section_comment,section.id,yes(r.deleted_at)];}));
 sheet('Yoxlama bəndləri',['Checklist ID','Mövqe','Avadanlıq / bənd','Texnoloji kart','Tələb olunur','Nəticə','Qeyd','Nasazlıq ID','Əlaqənin saxlanmış vəziyyəti','Bənd ID','Avadanlıq','Silinib'],items.map(i=>{const section=sectionById.get(i.run_section_id)!,r=runById.get(section.run_id)!,l=links.get(i.id);return [r.id,section.name_snapshot,i.name_snapshot,i.technology_card_snapshot,yes(i.required_snapshot),i.result?status(i.result):'Yoxlanılmayıb',i.comment,l?.report_id,l?status(l.state):'Əlaqə yoxdur',i.id,i.equipment_name_snapshot,yes(r.deleted_at)];}));
 sheet('Problemlər',['Tarix','İcraçı','Növbə','Mövqe','Avadanlıq','Nəticə','Qeyd','Nasazlıq ID','Əlaqənin saxlanmış vəziyyəti','Checklist ID','Silinib'],items.filter(i=>['problem','na'].includes(i.result)).map(i=>{const section=sectionById.get(i.run_section_id)!,r=runById.get(section.run_id)!,l=links.get(i.id);return [r.work_date,r.employee_name_snapshot,r.shift_label_snapshot,section.name_snapshot,i.equipment_name_snapshot||i.name_snapshot,status(i.result),i.comment,l?.report_id,l?status(l.state):'Əlaqə yoxdur',r.id,yes(r.deleted_at)];}));
 
 sheet('Şablon versiyaları',['Şablon','Versiya','Status','Yaradılıb (UTC)','Dərc edilib (UTC)','Arxivləşdirilib (UTC)','Məzmun hash','Əsas versiya ID','Versiya ID'],versions.map(v=>[v.name_snapshot,v.version_label,status(v.status),v.created_at,v.published_at,v.archived_at,v.content_hash,v.based_on_version_id,v.id]));
 const structures:unknown[][]=[];for(const v of versions){const own=s.checklist_sections.filter(sec=>sec.template_version_id===v.id).sort((a,b)=>a.sort_order-b.sort_order);if(!own.length)structures.push([v.version_label,'','','','','','','','','','',v.id,'','','']);for(const sec of own){const children=s.checklist_items.filter(i=>i.section_id===sec.id).sort((a,b)=>a.sort_order-b.sort_order);for(const i of children.length?children:[null])structures.push([v.version_label,sec.name,sec.sort_order,i?.name,i?.sort_order,i?yes(i.required):'',yes(sec.active),i?yes(i.active):'',i?.equipment_name,sec.service_name,sec.object_name,v.id,sec.stable_key,i?.stable_key,i?.technology_card]);}}
 sheet('Şablon strukturu',['Versiya','Mövqe','Mövqenin sırası','Bənd','Bəndin sırası','Tələb olunur','Mövqe aktivdir','Bənd aktivdir','Avadanlıq','Xidmət','Obyekt','Versiya ID','Mövqe açarı','Bənd açarı','Texnoloji kart'],structures);
 const shiftRows:unknown[][]=[];for(const v of s.checklist_shift_schedule_versions){shiftRows.push([v.version,status(v.status),v.timezone,'','','','','','Cədvəl',v.effective_from,v.id]);for(const r of s.checklist_shift_rules.filter(r=>r.schedule_version_id===v.id))shiftRows.push([v.version,status(v.status),v.timezone,r.shift_key,r.label,r.local_start_time,r.local_end_time,'','Qayda (yerli saat)',v.effective_from,v.id,r.applicable_days,yes(r.active)]);for(const p of s.checklist_shift_periods.filter(p=>p.schedule_version_id===v.id))shiftRows.push([v.version,status(v.status),p.timezone_snapshot,p.shift_key,p.label_snapshot,p.starts_at,p.ends_at,p.work_date,'Saxlanmış növbə (UTC)',v.effective_from,v.id,'','',p.edit_until,p.id]);}
 sheet('Növbələr',['Cədvəl versiyası','Status','Saat qurşağı','Növbə açarı','Ad','Başlama','Bitmə','İş günü','Sətir növü','Dövrün başlanğıcı (UTC)','Cədvəl ID','Legacy həftə günləri','Aktiv','Redaktə sərhədi (UTC)','Növbə ID'],shiftRows);
 sheet('Backup məlumatı',['Göstərici','Dəyər'],[['Backup yaradılıb',localTimestamp(meta.at)],['Serverin yerli vaxtı',localTimestamp(meta.at)],['UTC vaxtı',meta.at.toISOString()],['Saat qurşağı',timezone],['SQLite sxem versiyası',Math.max(...s.checklist_schema_migrations.map(m=>m.version),0)],['Tətbiq versiyası',meta.applicationVersion??'Məlum deyil'],['Mənbə DB yolu',meta.source],['DB backup faylı',meta.databaseFile],['Excel faylı',meta.excelFile],['Əlaqələr haqqında','Nasazlıq statusu checklist snapshot-dan götürülüb; jurnal ayrıca zamanda dəyişmiş ola bilər.'],['Bərpa haqqında','Tam bərpa üçün SQLite backup istifadə edin. Excel baxış üçündür.']]);
 return book;
}
