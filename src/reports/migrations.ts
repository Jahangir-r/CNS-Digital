import type Database from 'better-sqlite3';
export function migrateReportRequests(db:Database.Database){db.transaction(()=>{
 db.exec('CREATE TABLE IF NOT EXISTS journal_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
 if(db.prepare('SELECT 1 FROM journal_schema_migrations WHERE version=2').get())return;
 db.exec(`CREATE TABLE report_creation_requests (
 request_id TEXT PRIMARY KEY NOT NULL,report_id INTEGER NOT NULL,actor_user_id INTEGER NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER report_request_no_update BEFORE UPDATE ON report_creation_requests BEGIN SELECT RAISE(ABORT,'request history immutable'); END;
 CREATE TRIGGER report_request_no_delete BEFORE DELETE ON report_creation_requests BEGIN SELECT RAISE(ABORT,'request history retained'); END;
 CREATE TRIGGER report_request_no_replace BEFORE INSERT ON report_creation_requests WHEN EXISTS(SELECT 1 FROM report_creation_requests WHERE request_id=NEW.request_id)
 BEGIN SELECT RAISE(ABORT,'request already exists'); END;`);
 db.prepare('INSERT INTO journal_schema_migrations VALUES(2,?,?)').run('idempotent_report_requests',new Date().toISOString());
 }).immediate();}
