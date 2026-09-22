import Database from 'better-sqlite3';
import {createAuthService} from '../../src/auth.js';
import {createReportService} from '../../src/reports/service.js';
import {createReportLinkService} from '../../src/checklists/report-links.js';
const [journalFile,checklistFile,runId,itemId]=process.argv.slice(2),journal=new Database(journalFile),db=new Database(checklistFile);
for(const d of [journal,db]){d.pragma('busy_timeout=5000');d.pragma('foreign_keys=ON');}
const auth=createAuthService(journal,'test-only'),links=createReportLinkService(db,createReportService(journal,auth),auth,()=>new Date('2026-09-19T05:00:00Z'));
console.log(JSON.stringify(links.create(runId,itemId,journal.prepare('SELECT * FROM users WHERE id=1').get() as any,{})));db.close();journal.close();
