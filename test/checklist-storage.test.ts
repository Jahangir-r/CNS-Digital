import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { migrateChecklistPermissions } from "../src/permission-migrations.js";
import { CHECKLIST_PERMISSIONS, checklistDefaults } from "../src/checklists/permissions.js";
import { openChecklistDatabase } from "../src/checklists/db.js";
import { migrateChecklistDatabase } from "../src/checklists/migrations.js";
import type { AuditEvent } from "../src/audit.js";

function legacy() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE roles (
    id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, label TEXT NOT NULL,
    manage_users INTEGER DEFAULT 0, manage_roles INTEGER DEFAULT 0, reset_password INTEGER DEFAULT 0,
    view_all_reports INTEGER DEFAULT 0, create_reports INTEGER DEFAULT 0, edit_reports INTEGER DEFAULT 0,
    delete_reports INTEGER DEFAULT 0, export_import INTEGER DEFAULT 0, shift_engineer_access INTEGER DEFAULT 0,
    built_in INTEGER DEFAULT 0
  );
  CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT);
  CREATE TABLE reports (id INTEGER PRIMARY KEY, nasazliq TEXT);
  INSERT INTO users VALUES (1,'existing','employee');
  INSERT INTO reports VALUES (1,'Unchanged journal');`);
  for (const role of ["admin", "employee", "shift_engineer", "observer", "custom_existing"]) {
    db.prepare("INSERT INTO roles(name,label,create_reports,built_in) VALUES (?,?,?,?)")
      .run(role, `Custom label ${role}`, 1, role === "custom_existing" ? 0 : 1);
  }
  return db;
}

test("permission migration: exact defaults, seven columns, existing data preserved and repeat is a no-op", () => {
  const db = legacy();
  try {
    const oldRoles = db.prepare("SELECT * FROM roles ORDER BY id").all() as Record<string, unknown>[];
    const users = db.prepare("SELECT * FROM users").all();
    const reports = db.prepare("SELECT * FROM reports").all();
    migrateChecklistPermissions(db);
    assert.deepEqual(db.prepare("SELECT * FROM users").all(), users);
    assert.deepEqual(db.prepare("SELECT * FROM reports").all(), reports);
    for (const original of oldRoles) {
      const current = db.prepare("SELECT * FROM roles WHERE id=?").get(original.id) as Record<string, unknown>;
      for (const key of Object.keys(original)) assert.equal(current[key], original[key]);
    }
    for (const name of ["admin", "employee", "shift_engineer", "observer", "technician", "engineer", "custom_existing"]) {
      const role = db.prepare("SELECT * FROM roles WHERE name=?").get(name) as Record<string, unknown>;
      for (const key of CHECKLIST_PERMISSIONS) assert.equal(role[key], checklistDefaults(name)[key], `${name}.${key}`);
      if (["technician", "engineer"].includes(name)) assert.equal(role.create_reports, 0);
    }
    db.exec("UPDATE roles SET view_checklists=0,manage_checklist_shifts=1 WHERE name='employee'; UPDATE roles SET create_reports=1,create_reports_from_checklist=0,label='Changed' WHERE name='technician'");
    const snapshot = db.prepare("SELECT * FROM roles ORDER BY id").all();
    const marker = db.prepare("SELECT * FROM journal_schema_migrations").all();
    migrateChecklistPermissions(db);
    assert.deepEqual(db.prepare("SELECT * FROM roles ORDER BY id").all(), snapshot);
    assert.deepEqual(db.prepare("SELECT * FROM journal_schema_migrations").all(), marker);
    assert.throws(() => db.exec("UPDATE roles SET manage_checklist_shifts=2"));
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='report_creation_requests'").get(), undefined);
  } finally { db.close(); }
});

test("reserved role collision aborts atomically without overwriting custom role", () => {
  const db = legacy();
  try {
    db.exec("INSERT INTO roles(name,label) VALUES ('engineer','Existing custom role')");
    const before = db.prepare("SELECT * FROM roles").all();
    assert.throws(() => migrateChecklistPermissions(db), /collision/);
    assert.deepEqual(db.prepare("SELECT * FROM roles").all(), before);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='journal_schema_migrations'").get(), undefined);
  } finally { db.close(); }
});

test("pre-existing checklist permission values are preserved during migration", () => {
  const db = legacy();
  try {
    db.exec("ALTER TABLE roles ADD COLUMN view_checklists INTEGER NOT NULL DEFAULT 0; UPDATE roles SET view_checklists=1 WHERE name='custom_existing'");
    migrateChecklistPermissions(db);
    assert.equal((db.prepare("SELECT view_checklists FROM roles WHERE name='custom_existing'").get() as any).view_checklists, 1);
    assert.equal((db.prepare("SELECT view_checklists FROM roles WHERE name='employee'").get() as any).view_checklists, 0);
  } finally { db.close(); }
});

test("checklist storage: directories, WAL, FK, timeout, migration ledger and restart", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cns-storage-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const events: AuditEvent[] = [];
  let storage = openChecklistDatabase(root, e => events.push(e));
  assert.ok(storage.available);
  if (!storage.available) return;
  assert.equal(storage.db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(storage.db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(storage.db.pragma("busy_timeout", { simple: true }), 5000);
  assert.deepEqual(storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), ["checklist_schema_migrations", "checklist_templates", "checklist_template_versions", "checklist_sections", "checklist_items", "checklist_shift_schedule_versions", "checklist_shift_rules", "checklist_shift_periods", "checklist_runs", "checklist_run_sections", "checklist_run_items", "checklist_report_links", "checklist_shift_current"].map(name => ({ name })));
  const marker = storage.db.prepare("SELECT * FROM checklist_schema_migrations").all();
  storage.db.close();
  storage = openChecklistDatabase(root, e => events.push(e));
  assert.ok(storage.available);
  if (!storage.available) return;
  try {
    assert.deepEqual(storage.db.prepare("SELECT * FROM checklist_schema_migrations").all(), marker);
    storage.db.exec("INSERT INTO checklist_schema_migrations VALUES (999,'future','future')");
    assert.throws(() => migrateChecklistDatabase(storage.db), /Unsupported/);
  } finally { storage.db.close(); }
  assert.equal(events.filter(e => e.event === "CHECKLIST_STORAGE_READY").length, 2);
});

test("unavailable/corrupt checklist DB and even failing audit never throw to the journal", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cns-storage-failed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "data"));
  await fs.writeFile(path.join(root, "data/checklist.db"), "not a database");
  const events: AuditEvent[] = [];
  assert.deepEqual(openChecklistDatabase(root, e => events.push(e)), { available: false, db: null });
  assert.equal(events[0].event, "CHECKLIST_STORAGE_ERROR");
  assert.equal(events[0].module, "CHECKLIST");
  assert.doesNotThrow(() => openChecklistDatabase(root, () => { throw new Error("audit failure"); }));
});

test("failure halfway through permission migration rolls back added columns, roles and marker", () => {
  const db = legacy();
  try {
    db.exec("CREATE TRIGGER reject_engineer BEFORE INSERT ON roles WHEN NEW.name='engineer' BEGIN SELECT RAISE(ABORT,'test migration failure'); END");
    const before = db.prepare("SELECT * FROM roles ORDER BY id").all();
    const schema = db.prepare("PRAGMA table_info(roles)").all();
    assert.throws(() => migrateChecklistPermissions(db), /test migration failure/);
    assert.deepEqual(db.prepare("SELECT * FROM roles ORDER BY id").all(), before);
    assert.deepEqual(db.prepare("PRAGMA table_info(roles)").all(), schema);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='journal_schema_migrations'").get(), undefined);
    db.exec("DROP TRIGGER reject_engineer");
    migrateChecklistPermissions(db);
    assert.ok(db.prepare("SELECT 1 FROM roles WHERE name='engineer'").get());
  } finally { db.close(); }
});
