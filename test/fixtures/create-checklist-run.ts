import Database from 'better-sqlite3';
import {createRunService} from '../../src/checklists/runs.js';
const db=new Database(process.argv[2]);db.pragma('foreign_keys=ON');db.pragma('busy_timeout=5000');
const service=createRunService(db,()=>new Date('2026-09-19T05:00:00Z'));
console.log(JSON.stringify(service.create({id:1,username:'tech',full_name:'Tech',view_checklists:true,create_checklists:true,edit_own_checklists:true,manage_checklists:false},{})));
db.close();
