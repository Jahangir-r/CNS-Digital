import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { migrateJournalDatabase } from "./migration-runner.js";

export function openJournalDatabase(root = process.cwd()): Database.Database {
  const directory = path.join(root, "data");
  fs.mkdirSync(directory, { recursive: true });
  const connection = new Database(path.join(directory, "jurnal.db"));
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  migrateJournalDatabase(connection);
  return connection;
}
