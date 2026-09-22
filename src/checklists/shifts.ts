import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export class ChecklistError extends Error {
 constructor(public status: number, message: string) { super(message); }
}
export const invalid = (message='Məlumat formatı düzgün deyil'): never => { throw new ChecklistError(422,message); };
export function object(value: unknown): Record<string,unknown> {
 if (!value || typeof value!=='object' || Array.isArray(value)) return invalid();
 return value as Record<string,unknown>;
}
export function text(value: unknown): string {
 if(typeof value!=='string' || !value.trim() || value.length>500) return invalid();
 return value.trim();
}
export function revision(expected: unknown, actual: number) {
 if(!Number.isSafeInteger(expected)) invalid('Revision tələb olunur');
 if(expected!==actual) throw new ChecklistError(409,'Məlumat dəyişdirilib. Yeniləyin');
}
export function localParts(date: Date, timezone: string) {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
 const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));
 return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}:${p.second}`};
}
export function addDays(date: string, days: number) {return new Date(Date.parse(date+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);}
// Enumerate UTC offsets around the date. Reject nonexistent/ambiguous wall times rather than silently choosing a DST boundary.
export function wallTime(date: string, time: string, timezone: string): string {
 const target=Date.parse(`${date}T${time}:00Z`), offsets=new Set<number>();
 for(let h=-36;h<=36;h+=6) {
  const instant=target+h*3600000,p=localParts(new Date(instant),timezone);
  offsets.add(Date.parse(`${p.date}T${p.time}Z`)-instant);
 }
 const candidates=[...offsets].map(offset=>target-offset).filter(instant=>{
  const p=localParts(new Date(instant),timezone);return p.date===date && p.time===time+':00';
 });
 if(candidates.length!==1) throw new ChecklistError(409,'Növbə vaxtı saat qurşağı keçidinə görə birmənalı deyil');
 return new Date(candidates[0]).toISOString();
}
export interface Rule { id:string; schedule_version_id:string; shift_key:string;label:string; applicable_days:number[];local_start_time:string;local_end_time:string;sort_order:number;active:number }
export interface Schedule { id:string;version:number;status:string;timezone:string;effective_from:string;cycle_anchor:string|null;revision:number;rules:Rule[] }
export interface Period { id:string;schedule_version_id:string;shift_key:string;work_date:string;label_snapshot:string;starts_at:string;ends_at:string;timezone_snapshot:string;edit_until:string }
function validate(input: unknown, publishing=false) {
 const b=object(input),timezone=text(b.timezone);
 try {new Intl.DateTimeFormat('en',{timeZone:timezone}).format();} catch {invalid('Saat qurşağı düzgün deyil');}
 if(typeof b.effective_from!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(b.effective_from) || !Number.isFinite(Date.parse(b.effective_from))) invalid('UTC effective_from tələb olunur');
 const anchorValue=b.cycle_anchor??b.effective_from;
 if(typeof anchorValue!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(anchorValue) || !Number.isFinite(Date.parse(anchorValue))) invalid('UTC cycle_anchor tələb olunur');
 const cycle_anchor=new Date(anchorValue as string).toISOString(),effective_from=cycle_anchor;
 if(!Array.isArray(b.rules)||b.rules.length>100) invalid();
 const rules=(b.rules as unknown[]).map(value=>{
  const r=object(value),shift_key=text(r.shift_key),label=text(r.label);
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(shift_key)) invalid();
  if(r.applicable_days!==undefined&&(!Array.isArray(r.applicable_days)||r.applicable_days.length)) invalid('Həftə günləri dövri cədvəldə istifadə edilmir');
  for(const v of [r.local_start_time,r.local_end_time]) if(typeof v!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) invalid();
  if(r.local_start_time===r.local_end_time) invalid('Növbənin başlanğıcı və sonu fərqli olmalıdır');
  if(!Number.isSafeInteger(r.sort_order)||(r.sort_order as number)<0 || ![true,false,0,1].includes(r.active as any)) invalid();
  return {shift_key,label,applicable_days:[],local_start_time:r.local_start_time as string,local_end_time:r.local_end_time as string,sort_order:r.sort_order as number,active:+!!r.active};
 });
 if(new Set(rules.map(r=>r.shift_key)).size!==rules.length||new Set(rules.map(r=>r.sort_order)).size!==rules.length) invalid('Təkrarlanan açar və ya sıra');
 const active=rules.filter(r=>r.active).sort((a,b)=>a.sort_order-b.sort_order);
 if(publishing&&!active.length)invalid('Aktiv növbə tələb olunur');
 if(publishing){
  const anchor=localParts(new Date(cycle_anchor),timezone);
  if(anchor.time.slice(0,5)!==active[0].local_start_time)invalid('Dövrün başlanğıcı ilk növbənin başlama vaxtına uyğun olmalıdır');
  for(let i=0;i<active.length;i++)if(active[i].local_end_time!==active[(i+1)%active.length].local_start_time)invalid('Növbələr arasında boşluq və ya üst-üstə düşmə olmamalıdır');
 }
 return {timezone,effective_from,cycle_anchor,rules};
}
export function createShiftService(db: Database.Database, now:()=>Date=()=>new Date()) {
 function get(id:string): Schedule {
  const s=db.prepare('SELECT * FROM checklist_shift_schedule_versions WHERE id=?').get(id) as Schedule|undefined;
  if(!s) throw new ChecklistError(404,'Növbə cədvəli tapılmadı');
  s.rules=(db.prepare('SELECT * FROM checklist_shift_rules WHERE schedule_version_id=? ORDER BY sort_order').all(id) as any[]).map(r=>({...r,applicable_days:JSON.parse(r.applicable_days)}));return s;
 }
 function write(id:string,rules:ReturnType<typeof validate>['rules']) {
  db.prepare('DELETE FROM checklist_shift_rules WHERE schedule_version_id=?').run(id);
  const insert=db.prepare('INSERT INTO checklist_shift_rules VALUES (?,?,?,?,?,?,?,?,?)');
  for(const r of rules) insert.run(randomUUID(),id,r.shift_key,r.label,JSON.stringify(r.applicable_days),r.local_start_time,r.local_end_time,r.sort_order,r.active);
 }
 function matching(s:Schedule,instant:Date): Omit<Period,'id'>|null {
  const anchor=Date.parse(s.cycle_anchor??s.effective_from),at=instant.getTime();if(at<anchor)return null;
  const minutes=(value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3));
  const rules=s.rules.filter(r=>r.active).sort((a,b)=>a.sort_order-b.sort_order).map(r=>({...r,duration:(minutes(r.local_end_time)-minutes(r.local_start_time)+1440)%1440*60000}));
  if(!rules.length||rules.some(r=>!r.duration))return null;
  const cycle=rules.reduce((n,r)=>n+r.duration,0),cycleStart=anchor+Math.floor((at-anchor)/cycle)*cycle;
  let offset=0;
  for(const r of rules){const start=cycleStart+offset,end=start+r.duration;if(start<=at&&at<end){const starts_at=new Date(start).toISOString(),ends_at=new Date(end).toISOString();return {schedule_version_id:s.id,shift_key:r.shift_key,work_date:localParts(new Date(start),s.timezone).date,label_snapshot:r.label,starts_at,ends_at,timezone_snapshot:s.timezone,edit_until:ends_at};}offset+=r.duration;}
  return null;
 }
 function current(instant=now()): Omit<Period,'id'> {
  // Archived latest effective schedules intentionally do not reactivate older schedules.
  const row=db.prepare("SELECT v.id,v.status FROM checklist_shift_current c JOIN checklist_shift_schedule_versions v ON v.id=c.schedule_version_id LIMIT 1").get() as {id:string;status:string}|undefined;
  if(!row||row.status!=='published') throw new ChecklistError(409,'Növbə cədvəli təyin edilməyib');
  const s=get(row.id),p=matching(s,instant);
  if(!p||p.starts_at<s.effective_from) throw new ChecklistError(409,'Hazırda aktiv növbə yoxdur');return p;
 }
 const period=db.transaction((instant:Date)=>{
  const p=current(instant);
  const existing=db.prepare('SELECT * FROM checklist_shift_periods WHERE schedule_version_id=? AND shift_key=? AND work_date=?').get(p.schedule_version_id,p.shift_key,p.work_date) as Period|undefined;
  if(existing)return existing;
  const id=randomUUID();db.prepare('INSERT INTO checklist_shift_periods VALUES (@id,@schedule_version_id,@shift_key,@work_date,@label_snapshot,@starts_at,@ends_at,@timezone_snapshot,@edit_until)').run({id,...p});return {id,...p};
 });
 const create=db.transaction((input:unknown,actor:number)=>{
  const b=object(input);let data:unknown=b;
  if(b.based_on_version_id!==undefined){const source=get(text(b.based_on_version_id));data={...source,effective_from:b.effective_from,cycle_anchor:b.cycle_anchor??b.effective_from};}
  const v=validate(data),id=randomUUID();
  const n=(db.prepare('SELECT COALESCE(MAX(version),0)+1 AS n FROM checklist_shift_schedule_versions').get() as {n:number}).n;
  db.prepare("INSERT INTO checklist_shift_schedule_versions(id,version,status,timezone,effective_from,created_by,created_at,cycle_anchor) VALUES (?,?,'draft',?,?,?,?,?)").run(id,n,v.timezone,v.effective_from,actor,now().toISOString(),v.cycle_anchor);write(id,v.rules);return get(id);
 });
 const update=db.transaction((id:string,input:unknown)=>{
  const s=get(id);if(s.status!=='draft')throw new ChecklistError(409,'Yalnız qaralama dəyişdirilə bilər');
  const b=object(input);revision(b.revision,s.revision);const v=validate(b);
  write(id,v.rules);db.prepare('UPDATE checklist_shift_schedule_versions SET timezone=?,effective_from=?,cycle_anchor=?,revision=revision+1 WHERE id=?').run(v.timezone,v.effective_from,v.cycle_anchor,id);return get(id);
 });
 const publish=db.transaction((id:string,rev:unknown,actor:number,makeCurrent:boolean)=>{
  const s=get(id);revision(rev,s.revision);if(s.status!=='draft')throw new ChecklistError(409,'Yalnız qaralama dərc edilə bilər');
  validate(s,true);if(!s.rules.some(r=>r.active))invalid('Aktiv növbə tələb olunur');
  const own=matching(s,new Date(s.effective_from));if(own&&own.starts_at<s.effective_from)invalid('Cədvəl növbə sərhədində qüvvəyə minməlidir');
  db.prepare("UPDATE checklist_shift_schedule_versions SET status='published',published_by=?,published_at=?,revision=revision+1 WHERE id=?").run(actor,now().toISOString(),id);
  if(makeCurrent){db.prepare('DELETE FROM checklist_shift_current').run();db.prepare("INSERT INTO checklist_shift_current(schedule_version_id,activated_at) VALUES(?,?)").run(id,now().toISOString());}
  return get(id);
 });
 const activate=db.transaction((id:string,rev:unknown)=>{const s=get(id);revision(rev,s.revision);if(s.status!=='published')throw new ChecklistError(409,'Yalnız dərc edilmiş cədvəl cari edilə bilər');db.prepare('DELETE FROM checklist_shift_current').run();db.prepare("INSERT INTO checklist_shift_current(schedule_version_id,activated_at) VALUES(?,?)").run(id,now().toISOString());return get(id);});
 const archive=db.transaction((id:string,rev:unknown,actor:number)=>{const s=get(id);revision(rev,s.revision);if(s.status==='archived')throw new ChecklistError(409,'Cədvəl arxivləşdirilib');db.prepare("UPDATE checklist_shift_schedule_versions SET status='archived',archived_by=?,archived_at=? WHERE id=?").run(actor,now().toISOString(),id);return get(id);});
 const remove=db.transaction((id:string)=>{get(id);if(db.prepare('SELECT 1 FROM checklist_shift_current WHERE schedule_version_id=?').get(id))throw new ChecklistError(409,'Cari növbə cədvəli silinə bilməz');if(db.prepare('SELECT 1 FROM checklist_shift_periods WHERE schedule_version_id=? LIMIT 1').get(id))throw new ChecklistError(409,'Bu cədvəl tarixi yoxlamalarda istifadə olunur və silinə bilməz.');db.prepare('DELETE FROM checklist_shift_rules WHERE schedule_version_id=?').run(id);db.prepare('DELETE FROM checklist_shift_schedule_versions WHERE id=?').run(id);return{id,deleted:true};});
 return {get,list:()=>db.prepare('SELECT v.*,CASE WHEN c.schedule_version_id=v.id THEN 1 ELSE 0 END is_current FROM checklist_shift_schedule_versions v LEFT JOIN checklist_shift_current c ON c.schedule_version_id=v.id ORDER BY v.version DESC').all(),current,
  resolveCurrentShift:(instant=now())=>period.immediate(instant),create:(b:unknown,u:number)=>create.immediate(b,u),update:(id:string,b:unknown)=>update.immediate(id,b),
  publish:(id:string,r:unknown,u:number,makeCurrent=true)=>publish.immediate(id,r,u,makeCurrent),activate:(id:string,r:unknown)=>activate.immediate(id,r),archive:(id:string,r:unknown,u:number)=>archive.immediate(id,r,u),remove:(id:string)=>remove.immediate(id)};
}
