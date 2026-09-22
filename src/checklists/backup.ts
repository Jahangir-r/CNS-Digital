import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import type {RequestHandler} from 'express';
import type {AuditEvent} from '../audit.js';
import {localDate} from '../local-time.js';
import {readChecklistSnapshot,buildChecklistWorkbook} from './backup-excel.js';
interface Options {
 now?:()=>Date;debounceMs?:number;maxDelayMs?:number;checkMs?:number;shutdownMs?:number;applicationVersion?:string;
 // Injectable writers support fault/slow-I/O tests; production uses SQLite Online Backup and ExcelJS.
 writeDatabase?:(temporary:string)=>Promise<unknown>;
 writeExcel?:(book:ReturnType<typeof buildChecklistWorkbook>,temporary:string)=>Promise<unknown>;
}
export class ChecklistBackup {
 private generation=0;private dbDone=-1;private excelDone=-1;private day='';private firstDirtyAt:number|null=null;
 private timer?:ReturnType<typeof setTimeout>;private daily?:ReturnType<typeof setInterval>;private active?:Promise<void>;
 private checking?:Promise<void>;private stopping=false;private cancelled=false;private observed='';
 private now:()=>Date;
 constructor(private db:Database.Database,private root:string,private audit:(entry:AuditEvent)=>void,private options:Options={}){this.now=options.now??(()=>new Date());try{this.observed=this.version();}catch{/* initialization will be retried */}}
 private log(event:string,file:string,date:string,start:number,error?:unknown){
  const code=error?(typeof (error as any)?.code==='string'?(error as any).code:'BACKUP_FAILED'):undefined;
  try{this.audit({module:'CHECKLIST',event,result:error?'ERROR':'SUCCESS',filename:file,date,duration_ms:Math.max(0,Date.now()-start),error_code:code});}catch{/* audit failure is nonfatal */}
 }
 private version(){return `${(this.db.prepare('SELECT total_changes() n').get() as {n:number}).n}:${this.db.pragma('data_version',{simple:true})}`;}
 private observe(){try{const current=this.version();if(current!==this.observed){this.observed=current;this.request();}}catch{/* unavailable DB is handled by backup attempts */}}
 // This observes committed writes even if a request fails after a cross-database partial commit.
 middleware():RequestHandler{return (_req,res,next)=>{let checked=false;const done=()=>{if(!checked){checked=true;this.observe();}};res.once('finish',done);res.once('close',done);next();};}
 request():void{
  if(this.stopping||this.cancelled)return;
  this.generation++;this.firstDirtyAt??=Date.now();if(this.active)return;
  clearTimeout(this.timer);const delay=Math.max(0,Math.min(this.options.debounceMs??1000,(this.options.maxDelayMs??5000)-(Date.now()-this.firstDirtyAt)));
  this.timer=setTimeout(()=>{this.timer=undefined;void this.run();},delay);this.timer.unref();
 }
 private rollDay(){const day=localDate(this.now());if(day!==this.day){if(this.day)this.log('CHECKLIST_BACKUP_ROLLOVER','',day,Date.now());this.day=day;this.dbDone=-1;this.excelDone=-1;}}
 private async pass(kind:'DB'|'EXCEL',day:string,target:number):Promise<boolean>{
  const start=Date.now(),file=kind==='DB'?`checklist-${day}.db`:`Checklist-${day}.xlsx`,folder=path.join(this.root,kind==='DB'?'Database':'Excel'),temporary=path.join(folder,`.${file}.${randomUUID()}.tmp`);
  try{
   await fs.mkdir(folder,{recursive:true});if(this.cancelled)throw Object.assign(Error('cancelled'),{code:'SHUTDOWN_TIMEOUT'});
   if(kind==='DB'){
    if(this.options.writeDatabase)await this.options.writeDatabase(temporary);
    else await this.db.backup(temporary,{progress:()=>{if(this.cancelled)throw Object.assign(Error('cancelled'),{code:'SHUTDOWN_TIMEOUT'});return 200;}});
    const copy=new Database(temporary);
    try {copy.pragma('wal_checkpoint(TRUNCATE)');copy.pragma('journal_mode=DELETE');
     if(copy.pragma('quick_check',{simple:true})!=='ok')throw Object.assign(Error('invalid backup'),{code:'SQLITE_CORRUPT'});
    } finally {copy.close();}
   }else{
    const at=this.now(),snapshot=readChecklistSnapshot(this.db);
    const book=buildChecklistWorkbook(snapshot,{at,source:path.resolve(this.db.name),databaseFile:`checklist-${day}.db`,excelFile:file,applicationVersion:this.options.applicationVersion});
    if(this.options.writeExcel)await this.options.writeExcel(book,temporary);else await book.xlsx.writeFile(temporary);
   }
   if(this.cancelled)throw Object.assign(Error('cancelled'),{code:'SHUTDOWN_TIMEOUT'});
   // Same-directory atomic replacement preserves the previous file if writing or rename fails.
   await fs.rename(temporary,path.join(folder,file));
   if(this.day===day){if(kind==='DB')this.dbDone=target;else this.excelDone=target;}
   this.log(`CHECKLIST_BACKUP_${kind}_SUCCESS`,file,day,start);return true;
  }catch(error){this.log(`CHECKLIST_BACKUP_${kind}_ERROR`,file,day,start,error);return false;}
  finally{for(const suffix of ['', '-wal','-shm','-journal'])await fs.unlink(temporary+suffix).catch(()=>{});}
 }
 private run():Promise<void>{
  if(this.active)return this.active;
  this.active=(async()=>{
   do{
    this.rollDay();const target=this.generation,day=this.day;
    if(this.dbDone<target)await this.pass('DB',day,target);
    if(this.excelDone<target&&!this.cancelled&&localDate(this.now())===day)await this.pass('EXCEL',day,target);
    this.observe();
    // Don't spin on a failed disk. Retry that generation at the next check/change/explicit flush.
    if(this.cancelled||this.generation===target&&localDate(this.now())===day)break;
   }while(true);
  })().catch(error=>this.log('CHECKLIST_BACKUP_DB_ERROR','',localDate(this.now()),Date.now(),error)).finally(()=>{this.active=undefined;this.firstDirtyAt=null;});return this.active;
 }
 async checkDaily():Promise<void>{
  if(this.stopping||this.cancelled)return;if(this.checking)return this.checking;
  this.checking=(async()=>{
   this.rollDay();this.observe();
   for(const kind of ['DB','EXCEL'] as const){const folder=path.join(this.root,kind==='DB'?'Database':'Excel'),file=kind==='DB'?`checklist-${this.day}.db`:`Checklist-${this.day}.xlsx`;
    try{await fs.mkdir(folder,{recursive:true});await fs.access(path.join(folder,file));}catch{if(kind==='DB')this.dbDone=-1;else this.excelDone=-1;}
   }
   if(this.dbDone<this.generation||this.excelDone<this.generation)await this.flush();
  })().catch(error=>this.log('CHECKLIST_BACKUP_DB_ERROR','',localDate(this.now()),Date.now(),error)).finally(()=>{this.checking=undefined;});return this.checking;
 }
 start():void{if(this.daily||this.stopping)return;void this.checkDaily();this.daily=setInterval(()=>{void this.checkDaily();},this.options.checkMs??45000);this.daily.unref();}
 async flush():Promise<void>{clearTimeout(this.timer);this.timer=undefined;if(this.cancelled)return;await this.run();}
 async stop():Promise<void>{
  clearInterval(this.daily);clearTimeout(this.timer);this.observe();this.stopping=true;
  let timeout:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([this.flush(),new Promise<void>(resolve=>{timeout=setTimeout(()=>{this.cancelled=true;
   const day=localDate(this.now()),err={code:'SHUTDOWN_TIMEOUT'};
   if(this.dbDone<this.generation)this.log('CHECKLIST_BACKUP_DB_ERROR',`checklist-${day}.db`,day,Date.now(),err);
   if(this.excelDone<this.generation)this.log('CHECKLIST_BACKUP_EXCEL_ERROR',`Checklist-${day}.xlsx`,day,Date.now(),err);
   resolve();},this.options.shutdownMs??5000);})]);clearTimeout(timeout);
 }
}
