import bcrypt from "bcryptjs";
import type Database from "better-sqlite3";
import { migrateChecklistPermissions } from "../../permission-migrations.js";
import { migrateReportRequests } from "../../reports/migrations.js";

const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, full_name TEXT NOT NULL, role TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS roles (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
 manage_users INTEGER NOT NULL DEFAULT 0, manage_roles INTEGER NOT NULL DEFAULT 0,
 reset_password INTEGER NOT NULL DEFAULT 0, view_all_reports INTEGER NOT NULL DEFAULT 0,
 create_reports INTEGER NOT NULL DEFAULT 0, edit_reports INTEGER NOT NULL DEFAULT 0,
 delete_reports INTEGER NOT NULL DEFAULT 0, export_import INTEGER NOT NULL DEFAULT 0,
 shift_engineer_access INTEGER NOT NULL DEFAULT 0, built_in INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS reports (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
 xidmet TEXT NOT NULL, obyekt TEXT NOT NULL DEFAULT '', sistem TEXT NOT NULL,
 nasazliq TEXT NOT NULL, nasazliq_vaxti TEXT NOT NULL, sebeb TEXT NOT NULL DEFAULT '',
 tedbir TEXT NOT NULL DEFAULT '', berpa_vaxti TEXT NOT NULL DEFAULT '', muraciet TEXT NOT NULL DEFAULT '',
 cavabdeh TEXT NOT NULL DEFAULT '', prioritet TEXT NOT NULL DEFAULT 'orta',
 created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
 updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);`;

const requiredColumns: Record<string, string[]> = {
  reports: [
    "prioritet TEXT NOT NULL DEFAULT 'orta'", "owner_user_id INTEGER REFERENCES users(id)",
    "restored_by_update INTEGER NOT NULL DEFAULT 0", "restored_at TEXT NOT NULL DEFAULT ''",
    "restored_by_user_id INTEGER REFERENCES users(id)",
  ],
  users: ["deleted INTEGER NOT NULL DEFAULT 0"],
  roles: [
    "manage_roles INTEGER NOT NULL DEFAULT 0", "reset_password INTEGER NOT NULL DEFAULT 0",
    "create_reports INTEGER NOT NULL DEFAULT 0", "edit_reports INTEGER NOT NULL DEFAULT 0",
    "shift_engineer_access INTEGER NOT NULL DEFAULT 0",
  ],
};

const builtInRoles = [
  ["admin", "Admin", 1, 1, 1, 1, 1, 1, 1, 1, 0],
  ["employee", "İstifadəçi", 0, 0, 0, 1, 0, 0, 0, 0, 0],
  ["shift_engineer", "Növbə mühəndisi", 0, 0, 0, 1, 1, 1, 0, 0, 1],
  ["observer", "Müstəqil müşahidəçi", 1, 0, 0, 1, 1, 1, 0, 1, 0],
] as const;

function addMissingColumns(db: Database.Database): void {
  for (const [table, definitions] of Object.entries(requiredColumns)) {
    const known = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(column => column.name));
    for (const definition of definitions) {
      const name = definition.split(/\s+/, 1)[0];
      if (!known.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  }
}

function removeLegacyRoleConstraint(db: Database.Database): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get() as {sql?:string}|undefined;
  if (!table?.sql?.includes("CHECK")) return;
  db.pragma("foreign_keys = OFF");
  try {
    db.exec(`BEGIN;
      CREATE TABLE users_new (
       id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
       password_hash TEXT NOT NULL, full_name TEXT NOT NULL, role TEXT NOT NULL,
       active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO users_new (id,username,password_hash,full_name,role,active,created_at)
       SELECT id,username,password_hash,full_name,CASE role WHEN 'director' THEN 'admin' ELSE role END,active,created_at FROM users;
      DROP TABLE users; ALTER TABLE users_new RENAME TO users; COMMIT;`);
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.pragma("foreign_keys = ON"); }
}

function seedRoles(db: Database.Database): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO roles
   (name,label,manage_users,manage_roles,reset_password,view_all_reports,create_reports,edit_reports,delete_reports,export_import,shift_engineer_access,built_in)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`);
  for (const role of builtInRoles) insert.run(...role);
}

function migrateDirectorAccount(db: Database.Database): void {
  db.prepare("UPDATE users SET role='admin' WHERE role='director'").run();
  const legacy = db.prepare("SELECT id FROM users WHERE username='director'").get() as {id:number}|undefined;
  if (legacy && !db.prepare("SELECT 1 FROM users WHERE username='admin'").get()) {
    db.prepare("UPDATE users SET username='admin',full_name='Admin',role='admin' WHERE id=?").run(legacy.id);
  }
}

function bootstrapAdministrator(db: Database.Database): void {
  const password = process.env.CNS_BOOTSTRAP_ADMIN_PASSWORD?.trim();
  const count = db.prepare("SELECT COUNT(*) n FROM users").get() as {n:number};
  if (!count.n && password) {
    db.prepare("INSERT INTO users (username,password_hash,full_name,role) VALUES (?,?,?,'admin')")
      .run("admin", bcrypt.hashSync(password, 10), "Admin");
    console.log("Initial administrator created from explicit bootstrap configuration");
  }
}

export function migrateJournalDatabase(db: Database.Database): void {
  db.exec(INITIAL_SCHEMA);
  addMissingColumns(db);
  removeLegacyRoleConstraint(db);
  seedRoles(db);
  migrateChecklistPermissions(db);
  migrateReportRequests(db);
  migrateDirectorAccount(db);
  bootstrapAdministrator(db);
}
