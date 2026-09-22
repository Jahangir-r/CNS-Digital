import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { migrateChecklistDatabase } from "./migrations.js";
import type { AuditEvent } from "../audit.js";

export type ChecklistStorage =
  | { available: true; db: Database.Database }
  | { available: false; db: null };

export function openChecklistDatabase(root: string, audit: (entry: AuditEvent) => void): ChecklistStorage {
  let db: Database.Database | undefined;
  const log = (entry: AuditEvent) => { try { audit(entry); } catch { /* non-fatal */ } };
  try {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    db = new Database(path.join(root, "data", "checklist.db"));
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrateChecklistDatabase(db);
    log({ module: "CHECKLIST", event: "CHECKLIST_STORAGE_READY", result: "SUCCESS", description: "Checklist storage initialized" });
    return { available: true, db };
  } catch {
    try { db?.close(); } catch { /* keep primary journal available */ }
    log({ module: "CHECKLIST", event: "CHECKLIST_STORAGE_ERROR", result: "ERROR", description: "Checklist storage unavailable; primary journal remains available" });
    return { available: false, db: null };
  }
}
