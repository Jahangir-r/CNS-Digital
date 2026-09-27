import { REPORT_LINK_SCHEMA } from "./report-link-schema.js";
import type Database from "better-sqlite3";
import { RUN_SCHEMA } from "./run-schema.js";
import { TEMPLATE_SCHEMA } from "./template-schema.js";

// Each upgrade and its ledger entry commit together; no production templates are seeded.
export function migrateChecklistDatabase(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS checklist_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    const versions = db.prepare("SELECT version FROM checklist_schema_migrations").all() as { version: number }[];
    if (versions.some(row => ![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(row.version))) throw new Error("Unsupported checklist schema version");
    if (!versions.length) db.prepare("INSERT INTO checklist_schema_migrations VALUES (1,?,?)")
      .run("initialize_checklist_storage", new Date().toISOString());
    if (!versions.some(row => row.version === 2)) {
      db.exec(TEMPLATE_SCHEMA);
      db.prepare("INSERT INTO checklist_schema_migrations VALUES (2,?,?)")
        .run("checklist_templates_immutable_versions", new Date().toISOString());
    }
    if (!versions.some(row => row.version === 3)) {
      db.exec(RUN_SCHEMA);
      db.prepare("INSERT INTO checklist_schema_migrations VALUES (3,?,?)")
        .run("checklist_shifts_and_run_snapshots", new Date().toISOString());
    }
    if (!versions.some(row => row.version === 4)) {
      db.exec(REPORT_LINK_SCHEMA);
      db.prepare("INSERT INTO checklist_schema_migrations VALUES (4,?,?)").run("checklist_report_links",new Date().toISOString());
    }
    if (!versions.some(row => row.version === 5)) {
      db.exec(`CREATE TABLE IF NOT EXISTS checklist_shift_current (
        schedule_version_id TEXT PRIMARY KEY REFERENCES checklist_shift_schedule_versions(id) ON DELETE RESTRICT,
        activated_at TEXT NOT NULL
      )`);
      db.prepare("INSERT INTO checklist_schema_migrations VALUES (5,?,?)").run("explicit_current_shift_schedule",new Date().toISOString());
    }
    if (!versions.some(row => row.version === 6)) {
      db.exec(`
        ALTER TABLE checklist_items ADD COLUMN technology_card TEXT NOT NULL DEFAULT '';
        ALTER TABLE checklist_run_items ADD COLUMN technology_card_snapshot TEXT NOT NULL DEFAULT '';
        ALTER TABLE checklist_shift_schedule_versions ADD COLUMN cycle_anchor TEXT;
        ALTER TABLE checklist_runs ADD COLUMN checklist_day TEXT;
        DROP INDEX checklist_run_user_period;
        DROP TRIGGER checklist_runs_no_replace;
        CREATE TRIGGER checklist_runs_no_replace BEFORE INSERT ON checklist_runs
          WHEN EXISTS(SELECT 1 FROM checklist_runs WHERE id=NEW.id)
          BEGIN SELECT RAISE(ABORT,'historical replacement forbidden'); END;
        CREATE UNIQUE INDEX checklist_run_active_normal_day
          ON checklist_runs(checklist_day)
          WHERE is_extra=0 AND deleted_at IS NULL AND checklist_day IS NOT NULL;
        CREATE TRIGGER checklist_run_day_frozen BEFORE UPDATE OF checklist_day ON checklist_runs
          WHEN NEW.checklist_day IS NOT OLD.checklist_day BEGIN SELECT RAISE(ABORT,'historical snapshot immutable'); END;
        CREATE TRIGGER checklist_run_item_tk_frozen BEFORE UPDATE OF technology_card_snapshot ON checklist_run_items
          WHEN NEW.technology_card_snapshot IS NOT OLD.technology_card_snapshot BEGIN SELECT RAISE(ABORT,'historical snapshot immutable'); END;
        DROP TRIGGER IF EXISTS checklist_version_delete;
        DROP TRIGGER IF EXISTS checklist_section_delete;
        DROP TRIGGER IF EXISTS checklist_item_delete;
        DROP TRIGGER IF EXISTS checklist_schedule_delete;
        DROP TRIGGER IF EXISTS checklist_rule_delete;
      `);
      db.prepare("INSERT INTO checklist_schema_migrations VALUES (6,?,?)")
        .run("technology_card_daily_slot_and_cycle_anchor", new Date().toISOString());
    }
    if (!versions.some(row => row.version === 7)) {
      db.exec(`
        DROP TRIGGER IF EXISTS checklist_version_delete;
        DROP TRIGGER IF EXISTS checklist_section_delete;
        DROP TRIGGER IF EXISTS checklist_item_delete;
        DROP TRIGGER IF EXISTS checklist_schedule_delete;
        DROP TRIGGER IF EXISTS checklist_rule_delete;
      `);
      db.prepare("INSERT INTO checklist_schema_migrations VALUES (7,?,?)")
        .run("safe_physical_delete_for_unused_admin_versions", new Date().toISOString());
    }
    if (!versions.some(row => row.version === 8)) {
      db.exec(`
        ALTER TABLE checklist_runs ADD COLUMN retention_archived_at TEXT;
        CREATE INDEX checklist_run_retention_visible
          ON checklist_runs(retention_archived_at,work_date,started_at,id);
      `);
      db.prepare("INSERT INTO checklist_schema_migrations VALUES (8,?,?)")
        .run("archive_checklist_history_after_31_calendar_days", new Date().toISOString());
    }
    if (!versions.some(row => row.version === 9)) {
      db.exec(`
        DROP INDEX IF EXISTS checklist_run_active_normal_day;
        CREATE UNIQUE INDEX checklist_run_active_normal_shift_period
          ON checklist_runs(shift_period_id)
          WHERE is_extra=0 AND deleted_at IS NULL;
      `);
      db.prepare("INSERT INTO checklist_schema_migrations VALUES (9,?,?)")
        .run("ordinary_checklist_slot_per_shift_period", new Date().toISOString());
    }
  }).immediate();
}
