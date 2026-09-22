export const REPORT_LINK_SCHEMA=`CREATE TABLE checklist_report_links (
 id TEXT PRIMARY KEY NOT NULL,run_item_id TEXT NOT NULL UNIQUE REFERENCES checklist_run_items(id),
 operation_id TEXT NOT NULL UNIQUE,report_id INTEGER,state TEXT NOT NULL CHECK(state IN ('pending','linked','error')),
 requested_by INTEGER NOT NULL,requested_at TEXT NOT NULL,linked_at TEXT,last_error_code TEXT,
 CHECK(state!='linked' OR (report_id IS NOT NULL AND linked_at IS NOT NULL)));
 CREATE TRIGGER checklist_link_identity BEFORE UPDATE ON checklist_report_links
 WHEN NEW.id IS NOT OLD.id OR NEW.run_item_id IS NOT OLD.run_item_id OR NEW.operation_id IS NOT OLD.operation_id
 OR NEW.requested_by IS NOT OLD.requested_by OR NEW.requested_at IS NOT OLD.requested_at
 OR (OLD.report_id IS NOT NULL AND NEW.report_id IS NOT OLD.report_id)
 OR (OLD.state='linked' AND (NEW.state IS NOT OLD.state OR NEW.linked_at IS NOT OLD.linked_at))
 BEGIN SELECT RAISE(ABORT,'link identity immutable'); END;
 CREATE TRIGGER checklist_link_no_delete BEFORE DELETE ON checklist_report_links BEGIN SELECT RAISE(ABORT,'link history retained'); END;
 CREATE TRIGGER checklist_link_no_replace BEFORE INSERT ON checklist_report_links WHEN EXISTS(
 SELECT 1 FROM checklist_report_links WHERE id=NEW.id OR run_item_id=NEW.run_item_id OR operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'link already exists'); END;`;
