import { migrateReportRequests } from "./reports/migrations.js";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import path from "node:path";
import fs from "node:fs";
import { migrateChecklistPermissions } from "./permission-migrations.js";
import type { ChecklistPermissions } from "./checklists/permissions.js";

const dataDir = path.join(process.cwd(), "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, "jurnal.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS roles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL UNIQUE,
  label            TEXT NOT NULL,
  manage_users     INTEGER NOT NULL DEFAULT 0,
  manage_roles     INTEGER NOT NULL DEFAULT 0,
  reset_password   INTEGER NOT NULL DEFAULT 0,
  view_all_reports INTEGER NOT NULL DEFAULT 0,
  create_reports   INTEGER NOT NULL DEFAULT 0,
  edit_reports     INTEGER NOT NULL DEFAULT 0,
  delete_reports   INTEGER NOT NULL DEFAULT 0,
  export_import    INTEGER NOT NULL DEFAULT 0,
  shift_engineer_access INTEGER NOT NULL DEFAULT 0,
  built_in         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS reports (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  xidmet         TEXT NOT NULL,
  obyekt         TEXT NOT NULL DEFAULT '',
  sistem         TEXT NOT NULL,
  nasazliq       TEXT NOT NULL,
  nasazliq_vaxti TEXT NOT NULL,
  sebeb          TEXT NOT NULL DEFAULT '',
  tedbir         TEXT NOT NULL DEFAULT '',
  berpa_vaxti    TEXT NOT NULL DEFAULT '',
  muraciet       TEXT NOT NULL DEFAULT '',
  cavabdeh       TEXT NOT NULL DEFAULT '',
  prioritet      TEXT NOT NULL DEFAULT 'orta',
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

function ensureColumn(table: string, name: string, sql: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
}

ensureColumn("reports", "prioritet", "prioritet TEXT NOT NULL DEFAULT 'orta'");
ensureColumn("reports", "owner_user_id", "owner_user_id INTEGER REFERENCES users(id)");
ensureColumn("reports", "restored_by_update", "restored_by_update INTEGER NOT NULL DEFAULT 0");
ensureColumn("reports", "restored_at", "restored_at TEXT NOT NULL DEFAULT ''");
ensureColumn("reports", "restored_by_user_id", "restored_by_user_id INTEGER REFERENCES users(id)");
ensureColumn("users", "deleted", "deleted INTEGER NOT NULL DEFAULT 0");
ensureColumn("roles", "manage_roles", "manage_roles INTEGER NOT NULL DEFAULT 0");
ensureColumn("roles", "reset_password", "reset_password INTEGER NOT NULL DEFAULT 0");
ensureColumn("roles", "create_reports", "create_reports INTEGER NOT NULL DEFAULT 0");
ensureColumn("roles", "edit_reports", "edit_reports INTEGER NOT NULL DEFAULT 0");
ensureColumn("roles", "shift_engineer_access", "shift_engineer_access INTEGER NOT NULL DEFAULT 0");

// Remove old CHECK constraint on users.role if an old database still has it.
const usersSchema = db
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'")
  .get() as { sql?: string } | undefined;
if (usersSchema?.sql?.includes("CHECK")) {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    BEGIN;
    CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    INSERT INTO users_new (id, username, password_hash, full_name, role, active, created_at)
      SELECT id, username, password_hash, full_name,
             CASE role WHEN 'director' THEN 'admin' ELSE role END,
             active, created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
  `);
  db.pragma("foreign_keys = ON");
}

type BuiltInRole = {
  name: string;
  label: string;
  manage_users: number;
  manage_roles: number;
  reset_password: number;
  view_all_reports: number;
  create_reports: number;
  edit_reports: number;
  delete_reports: number;
  export_import: number;
  shift_engineer_access: number;
};

const builtIns: BuiltInRole[] = [
  {
    name: "admin",
    label: "Admin",
    manage_users: 1,
    manage_roles: 1,
    reset_password: 1,
    view_all_reports: 1,
    create_reports: 1,
    edit_reports: 1,
    delete_reports: 1,
    export_import: 1,
    shift_engineer_access: 0,
  },
  {
    name: "employee",
    label: "İstifadəçi",
    manage_users: 0,
    manage_roles: 0,
    reset_password: 0,
    view_all_reports: 1,
    create_reports: 0,
    edit_reports: 0,
    delete_reports: 0,
    export_import: 0,
    shift_engineer_access: 0,
  },
  {
    name: "shift_engineer",
    label: "Növbə mühəndisi",
    manage_users: 0,
    manage_roles: 0,
    reset_password: 0,
    view_all_reports: 1,
    create_reports: 1,
    edit_reports: 1,
    delete_reports: 0,
    export_import: 0,
    shift_engineer_access: 1,
  },
  {
    name: "observer",
    label: "Müstəqil müşahidəçi",
    manage_users: 1,
    manage_roles: 0,
    reset_password: 0,
    view_all_reports: 1,
    create_reports: 1,
    edit_reports: 1,
    delete_reports: 0,
    export_import: 1,
    shift_engineer_access: 0,
  },
];

const insertRole = db.prepare(`
  INSERT OR IGNORE INTO roles
  (name,label,manage_users,manage_roles,reset_password,view_all_reports,create_reports,edit_reports,delete_reports,export_import,shift_engineer_access,built_in)
  VALUES (@name,@label,@manage_users,@manage_roles,@reset_password,@view_all_reports,@create_reports,@edit_reports,@delete_reports,@export_import,@shift_engineer_access,1)
`);
// Defaults are seed data, not a startup reset of administrator settings.
for (const r of builtIns) insertRole.run(r);
migrateChecklistPermissions(db);
migrateReportRequests(db);

// Old role label/account migration.
db.prepare("UPDATE users SET role='admin' WHERE role='director'").run();
const oldDirector = db.prepare("SELECT id FROM users WHERE username='director'").get() as { id: number } | undefined;
const adminTaken = db.prepare("SELECT id FROM users WHERE username='admin'").get();
if (oldDirector && !adminTaken) {
  db.prepare("UPDATE users SET username='admin', full_name='Admin', role='admin' WHERE id=?").run(oldDirector.id);
}

export interface User {
  id: number;
  username: string;
  password_hash: string;
  full_name: string;
  role: string;
  active: number;
  deleted: number;
  created_at: string;
}

export interface Role extends ChecklistPermissions {
  id: number;
  name: string;
  label: string;
  manage_users: number;
  manage_roles: number;
  reset_password: number;
  view_all_reports: number;
  create_reports: number;
  edit_reports: number;
  delete_reports: number;
  export_import: number;
  shift_engineer_access: number;
  built_in: number;
  created_at: string;
}

export interface Report {
  id: number;
  user_id: number;
  xidmet: string;
  obyekt: string;
  sistem: string;
  nasazliq: string;
  nasazliq_vaxti: string;
  sebeb: string;
  tedbir: string;
  berpa_vaxti: string;
  muraciet: string;
  cavabdeh: string;
  prioritet: string;
  created_at: string;
  updated_at: string;
  owner_user_id: number | null;
  restored_by_update: number;
  restored_at: string;
  restored_by_user_id: number | null;
}

export function getRole(name: string): Role | undefined {
  return db.prepare("SELECT * FROM roles WHERE name=?").get(name) as Role | undefined;
}

// First launch only.
const hasUsers = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
if (hasUsers.n === 0) {
  db.prepare(
    "INSERT INTO users (username,password_hash,full_name,role) VALUES (?,?,?,'admin')"
  ).run("admin", bcrypt.hashSync("admin123", 10), "Admin");
  console.log("Admin yaradıldı: admin / admin123 — parolu dəyişin");
}
