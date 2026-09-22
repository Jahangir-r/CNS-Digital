import type Database from "better-sqlite3";
import { CHECKLIST_PERMISSIONS, checklistDefaults } from "./checklists/permissions.js";

// One transaction includes schema changes, defaults and the migration marker.
// Existing role permissions, users and reports are never rewritten here.
export function migrateChecklistPermissions(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS journal_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    if (db.prepare("SELECT 1 FROM journal_schema_migrations WHERE version=1").get()) return;
    for (const name of ["technician", "engineer"]) {
      if (db.prepare("SELECT 1 FROM roles WHERE name=?").get(name)) {
        throw new Error(`Reserved role name collision: ${name}`);
      }
    }
    const columns = new Set((db.prepare("PRAGMA table_info(roles)").all() as { name: string }[]).map(c => c.name));
    const added = CHECKLIST_PERMISSIONS.filter(key => !columns.has(key));
    for (const key of added) db.exec(`ALTER TABLE roles ADD COLUMN ${key} INTEGER NOT NULL DEFAULT 0 CHECK (${key} IN (0,1))`);
    const insert = db.prepare("INSERT INTO roles (name,label,view_all_reports,built_in) VALUES (?,?,1,1)");
    insert.run("technician", "Texnik");
    insert.run("engineer", "Mühəndis");
    for (const role of ["admin", "employee", "shift_engineer", "observer", "technician", "engineer"]) {
      const defaults = checklistDefaults(role);
      // Preserve pre-existing values if upgrading a partially extended schema.
      const keys = ["technician", "engineer"].includes(role) ? [...CHECKLIST_PERMISSIONS] : added;
      if (keys.length) db.prepare(`UPDATE roles SET ${keys.map(key => `${key}=?`).join(",")} WHERE name=?`)
        .run(...keys.map(key => defaults[key]), role);
    }
    db.prepare("INSERT INTO journal_schema_migrations VALUES (1,?,?)")
      .run("checklist_permissions_and_roles", new Date().toISOString());
  }).immediate();
}
