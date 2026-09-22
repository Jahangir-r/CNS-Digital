// All history belongs to checklist.db; user IDs deliberately have no cross-file FK.
export const RUN_SCHEMA = `
CREATE TABLE checklist_shift_schedule_versions (
 id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL UNIQUE CHECK(version>0),
 status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
 timezone TEXT NOT NULL, effective_from TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by INTEGER NOT NULL, created_at TEXT NOT NULL,
 published_by INTEGER, published_at TEXT, archived_by INTEGER, archived_at TEXT
);
CREATE INDEX checklist_schedule_effective ON checklist_shift_schedule_versions(effective_from,version) WHERE published_at IS NOT NULL;
CREATE TABLE checklist_shift_rules (
 id TEXT PRIMARY KEY NOT NULL, schedule_version_id TEXT NOT NULL REFERENCES checklist_shift_schedule_versions(id),
 shift_key TEXT NOT NULL, label TEXT NOT NULL, applicable_days TEXT NOT NULL,
 local_start_time TEXT NOT NULL, local_end_time TEXT NOT NULL,
 sort_order INTEGER NOT NULL CHECK(sort_order>=0), active INTEGER NOT NULL CHECK(active IN (0,1)),
 UNIQUE(schedule_version_id,shift_key), UNIQUE(schedule_version_id,sort_order)
);
CREATE TABLE checklist_shift_periods (
 id TEXT PRIMARY KEY NOT NULL, schedule_version_id TEXT NOT NULL REFERENCES checklist_shift_schedule_versions(id),
 shift_key TEXT NOT NULL, work_date TEXT NOT NULL, label_snapshot TEXT NOT NULL,
 starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, timezone_snapshot TEXT NOT NULL, edit_until TEXT NOT NULL,
 UNIQUE(schedule_version_id,shift_key,work_date), CHECK(starts_at<ends_at), CHECK(edit_until>=ends_at)
);
CREATE TABLE checklist_runs (
 id TEXT PRIMARY KEY NOT NULL, user_id INTEGER NOT NULL, username_snapshot TEXT NOT NULL, employee_name_snapshot TEXT NOT NULL,
 template_id TEXT NOT NULL REFERENCES checklist_templates(id), template_version_id TEXT NOT NULL REFERENCES checklist_template_versions(id),
 template_version_snapshot TEXT NOT NULL, template_content_hash TEXT NOT NULL,
 shift_period_id TEXT NOT NULL REFERENCES checklist_shift_periods(id), shift_label_snapshot TEXT NOT NULL,
 work_date TEXT NOT NULL, local_date TEXT NOT NULL, timezone_snapshot TEXT NOT NULL,
 period_starts_at_snapshot TEXT NOT NULL, period_ends_at_snapshot TEXT NOT NULL, edit_until_snapshot TEXT NOT NULL,
 started_at TEXT NOT NULL, started_local_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed')),
 first_completed_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 is_extra INTEGER NOT NULL DEFAULT 0 CHECK(is_extra IN (0,1)), override_reason TEXT,
 deleted_at TEXT, deleted_by INTEGER, delete_reason TEXT,
 CHECK(is_extra=0 OR length(trim(COALESCE(override_reason,'')))>0),
 CHECK((deleted_at IS NULL AND deleted_by IS NULL AND delete_reason IS NULL) OR
 (deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND length(trim(COALESCE(delete_reason,'')))>0))
);
CREATE UNIQUE INDEX checklist_run_user_period ON checklist_runs(user_id,shift_period_id) WHERE is_extra=0;
CREATE INDEX checklist_run_list ON checklist_runs(work_date,started_at,id);
CREATE INDEX checklist_run_owner ON checklist_runs(user_id,work_date);
CREATE TABLE checklist_run_sections (
 id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES checklist_runs(id),
 template_section_id TEXT NOT NULL REFERENCES checklist_sections(id), stable_key_snapshot TEXT NOT NULL,
 name_snapshot TEXT NOT NULL, sort_order_snapshot INTEGER NOT NULL, active_snapshot INTEGER NOT NULL CHECK(active_snapshot=1),
 service_name_snapshot TEXT NOT NULL, object_name_snapshot TEXT NOT NULL,
 section_comment TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1, updated_by INTEGER, updated_at TEXT NOT NULL,
 UNIQUE(run_id,stable_key_snapshot), UNIQUE(run_id,sort_order_snapshot)
);
CREATE TABLE checklist_run_items (
 id TEXT PRIMARY KEY NOT NULL, run_section_id TEXT NOT NULL REFERENCES checklist_run_sections(id),
 template_item_id TEXT NOT NULL REFERENCES checklist_items(id), stable_key_snapshot TEXT NOT NULL,
 name_snapshot TEXT NOT NULL, equipment_name_snapshot TEXT NOT NULL, sort_order_snapshot INTEGER NOT NULL,
 required_snapshot INTEGER NOT NULL CHECK(required_snapshot IN (0,1)), active_snapshot INTEGER NOT NULL CHECK(active_snapshot=1),
 result TEXT CHECK(result IN ('ok','problem','na')), comment TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 1, updated_by INTEGER, updated_at TEXT NOT NULL,
 UNIQUE(run_section_id,stable_key_snapshot), UNIQUE(run_section_id,sort_order_snapshot)
);
CREATE TRIGGER checklist_schedule_insert BEFORE INSERT ON checklist_shift_schedule_versions BEGIN
 SELECT CASE WHEN NEW.status!='draft' OR EXISTS(SELECT 1 FROM checklist_shift_schedule_versions WHERE id=NEW.id OR version=NEW.version)
 THEN RAISE(ABORT,'schedule must be a new draft') END;
END;
CREATE TRIGGER checklist_schedule_update BEFORE UPDATE ON checklist_shift_schedule_versions BEGIN
 SELECT CASE WHEN NEW.id IS NOT OLD.id OR NEW.version IS NOT OLD.version OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
 THEN RAISE(ABORT,'schedule identity immutable') END;
 SELECT CASE WHEN OLD.status='archived' OR (OLD.status='published' AND NOT (
 NEW.status='archived' AND NEW.timezone IS OLD.timezone AND NEW.effective_from IS OLD.effective_from AND NEW.revision IS OLD.revision
 AND NEW.published_by IS OLD.published_by AND NEW.published_at IS OLD.published_at AND NEW.archived_at IS NOT NULL AND NEW.archived_by IS NOT NULL))
 THEN RAISE(ABORT,'schedule immutable') END;
END;
CREATE TRIGGER checklist_schedule_delete BEFORE DELETE ON checklist_shift_schedule_versions BEGIN SELECT RAISE(ABORT,'archive schedule instead'); END;
CREATE TRIGGER checklist_rule_insert BEFORE INSERT ON checklist_shift_rules BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM checklist_shift_schedule_versions WHERE id=NEW.schedule_version_id AND status='draft')
 OR EXISTS(SELECT 1 FROM checklist_shift_rules WHERE id=NEW.id) THEN RAISE(ABORT,'rule requires draft') END;
END;
CREATE TRIGGER checklist_rule_update BEFORE UPDATE ON checklist_shift_rules
 WHEN NEW.id IS NOT OLD.id OR NEW.schedule_version_id IS NOT OLD.schedule_version_id OR NOT EXISTS(
 SELECT 1 FROM checklist_shift_schedule_versions WHERE id=OLD.schedule_version_id AND status='draft')
 BEGIN SELECT RAISE(ABORT,'rule immutable'); END;
CREATE TRIGGER checklist_rule_delete BEFORE DELETE ON checklist_shift_rules WHEN NOT EXISTS(
 SELECT 1 FROM checklist_shift_schedule_versions WHERE id=OLD.schedule_version_id AND status='draft')
 BEGIN SELECT RAISE(ABORT,'rule immutable'); END;
` + immutable('checklist_shift_periods') + immutable('checklist_runs',[
 'id','user_id','username_snapshot','employee_name_snapshot','template_id','template_version_id','template_version_snapshot','template_content_hash',
 'shift_period_id','shift_label_snapshot','work_date','local_date','timezone_snapshot','period_starts_at_snapshot','period_ends_at_snapshot','edit_until_snapshot',
 'started_at','started_local_at','is_extra','override_reason'
]) + immutable('checklist_run_sections',['id','run_id','template_section_id','stable_key_snapshot','name_snapshot','sort_order_snapshot','active_snapshot','service_name_snapshot','object_name_snapshot'])
 + immutable('checklist_run_items',['id','run_section_id','template_item_id','stable_key_snapshot','name_snapshot','equipment_name_snapshot','sort_order_snapshot','required_snapshot','active_snapshot']);

function immutable(table: string, columns?: string[]) {
 const collision:Record<string,string> = {
  checklist_shift_periods:'(schedule_version_id=NEW.schedule_version_id AND shift_key=NEW.shift_key AND work_date=NEW.work_date)',
  checklist_runs:'(is_extra=0 AND NEW.is_extra=0 AND user_id=NEW.user_id AND shift_period_id=NEW.shift_period_id)',
  checklist_run_sections:'(run_id=NEW.run_id AND (stable_key_snapshot=NEW.stable_key_snapshot OR sort_order_snapshot=NEW.sort_order_snapshot))',
  checklist_run_items:'(run_section_id=NEW.run_section_id AND (stable_key_snapshot=NEW.stable_key_snapshot OR sort_order_snapshot=NEW.sort_order_snapshot))'
 };
 return `CREATE TRIGGER ${table}_frozen BEFORE UPDATE ON ${table} ${columns ? `WHEN ${columns.map(c=>`NEW.${c} IS NOT OLD.${c}`).join(' OR ')}` : ''}
 BEGIN SELECT RAISE(ABORT,'historical snapshot immutable'); END;
 CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'historical deletion forbidden'); END;
 CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE id=NEW.id OR ${collision[table]})
 BEGIN SELECT RAISE(ABORT,'historical replacement forbidden'); END;`;
}
