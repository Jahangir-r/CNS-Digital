import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import ExcelJS from "exceljs";
import { AuditLog, type AuditEvent } from "../src/audit.js";
import { BackupManager } from "../src/backup.js";
import { localDate, localTimestamp } from "../src/local-time.js";

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cns-backup-test-"));
  const db = new Database(path.join(root, "source.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, full_name TEXT);
    INSERT INTO users VALUES (1, 'Test Engineer');
    CREATE TABLE reports (id INTEGER PRIMARY KEY, user_id INTEGER, sistem TEXT, prioritet TEXT);
    INSERT INTO reports VALUES (1, 1, 'ILS', 'orta');`);
  const events: AuditEvent[] = [];
  let date = new Date(2026, 8, 20, 23, 59, 50, 123);
  const backups = new BackupManager(db, path.join(root, "CNS-Jurnal-Backup"), e => { events.push(e); }, () => date);
  t.after(async () => { await backups.stop(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, db, events, backups, setDate: (d: Date) => { date = d; } };
}

test("local timestamps include milliseconds and use local calendar components", () => {
  const date = new Date(2026, 0, 2, 0, 3, 4, 5);
  assert.equal(localDate(date), "2026-01-02");
  assert.equal(localTimestamp(date), "2026-01-02 00:03:04.005");
});

test("Excel queue keeps the latest state, overwrites daily file and rolls over without deleting backups", async t => {
  const f = await fixture(t);
  await f.backups.checkDaily();
  f.db.prepare("UPDATE reports SET sistem=?").run("Updated ILS");
  f.backups.requestExcel();
  f.db.prepare("INSERT INTO reports VALUES (2,1,'Radar','yuksek')").run();
  f.backups.requestExcel();
  await f.backups.flush();
  const folder = path.join(f.root, "CNS-Jurnal-Backup/Excel");
  assert.deepEqual(await fs.readdir(folder), ["CNS-Jurnal-2026-09-20.xlsx"]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(folder, "CNS-Jurnal-2026-09-20.xlsx"));
  assert.equal(workbook.creator, "CNS Digital");
  assert.equal(workbook.title, "CNS Digital — Jurnal backup");
  assert.equal(workbook.worksheets[0].rowCount, 3);
  assert.equal(workbook.worksheets[0].getCell("D2").value, "Updated ILS");
  assert.equal(workbook.worksheets[1].getCell("B1").value, "2026-09-20 23:59:50.123");
  f.db.exec("DELETE FROM reports");
  f.backups.requestExcel();
  await f.backups.flush();
  await workbook.xlsx.readFile(path.join(folder, "CNS-Jurnal-2026-09-20.xlsx"));
  assert.equal(workbook.worksheets[0].rowCount, 1);
  f.setDate(new Date(2026, 8, 21, 0, 0, 10));
  await f.backups.checkDaily();
  assert.deepEqual((await fs.readdir(folder)).sort(), ["CNS-Jurnal-2026-09-20.xlsx", "CNS-Jurnal-2026-09-21.xlsx"]);
});

test("SQLite daily backup includes WAL, passes integrity check and is not overwritten on restart", async t => {
  const f = await fixture(t);
  await f.backups.checkDaily();
  const folder = path.join(f.root, "CNS-Jurnal-Backup/Database");
  const firstFile = path.join(folder, "jurnal-2026-09-20.db");
  const first = await fs.readFile(firstFile);
  const copy = new Database(firstFile, { readonly: true });
  assert.equal(copy.pragma("integrity_check", { simple: true }), "ok");
  assert.equal((copy.prepare("SELECT sistem FROM reports").get() as any).sistem, "ILS");
  copy.close();
  f.db.exec("UPDATE reports SET sistem='Changed'");
  const restarted = new BackupManager(f.db, path.join(f.root, "CNS-Jurnal-Backup"), () => {}, () => new Date(2026, 8, 20));
  await restarted.checkDaily();
  await restarted.stop();
  assert.deepEqual(await fs.readFile(firstFile), first);
  f.setDate(new Date(2026, 8, 21));
  await f.backups.checkDaily();
  assert.equal((await fs.readdir(folder)).filter(file => file.endsWith(".db")).length, 2);
});

test("backup and audit failures do not reject tasks or revert committed changes; recovery works", async t => {
  const f = await fixture(t);
  const blocked = path.join(f.root, "blocked");
  await fs.writeFile(blocked, "not a directory");
  const brokenAudit = new AuditLog(blocked);
  brokenAudit.write({ event: "REPORT_CREATE", result: "SUCCESS" });
  await brokenAudit.flush();
  const manager = new BackupManager(f.db, blocked, e => { f.events.push(e); throw new Error("audit failed"); });
  f.db.exec("UPDATE reports SET sistem='Committed'");
  manager.requestExcel();
  await manager.checkDaily();
  await manager.flush();
  assert.equal((f.db.prepare("SELECT sistem FROM reports").get() as any).sistem, "Committed");
  assert.ok(f.events.some(e => e.event === "BACKUP" && e.result === "ERROR"));
  await fs.unlink(blocked);
  await manager.checkDaily();
  await manager.stop();
  assert.ok((await fs.readdir(path.join(blocked, "Database"))).some(file => file.endsWith(".db")));
});

test("failed Excel backup preserves previous file and retries within the same day", async t => {
  const f = await fixture(t);
  await f.backups.checkDaily();
  const file = path.join(f.root, "CNS-Jurnal-Backup/Excel/CNS-Jurnal-2026-09-20.xlsx");
  const previous = await fs.readFile(file);
  f.db.exec("ALTER TABLE reports RENAME TO unavailable_reports");
  f.backups.requestExcel();
  await f.backups.flush();
  assert.deepEqual(await fs.readFile(file), previous);
  assert.equal(f.events.at(-1)?.result, "ERROR");
  f.db.exec("ALTER TABLE unavailable_reports RENAME TO reports; UPDATE reports SET sistem='Recovered'");
  await f.backups.checkDaily();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  assert.equal(workbook.worksheets[0].getCell("D2").value, "Recovered");
});

test("audit rotates locally, removes only own logs older than 45 days and excludes unknown secret fields", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cns-audit-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let date = new Date(2026, 8, 20, 10, 15, 42, 123);
  const audit = new AuditLog(root, () => date);
  await fs.writeFile(path.join(root, "CNS-Jurnal-2026-08-05.log"), "old");
  await fs.writeFile(path.join(root, "CNS-Jurnal-2026-08-06.log"), "boundary");
  await fs.writeFile(path.join(root, "other-2020-01-01.log"), "keep");
  audit.write({ event: "LOGIN_FAILURE", result: "ERROR", user: 'fake\n[FORGED]', description: "Login failed", password: "DO_NOT_LOG", cookie: "SECRET_COOKIE" } as any);
  await audit.flush();
  let files = await fs.readdir(root);
  assert.ok(!files.includes("CNS-Jurnal-2026-08-05.log"));
  assert.ok(files.includes("CNS-Jurnal-2026-08-06.log"));
  assert.ok(files.includes("other-2020-01-01.log"));
  const content = await fs.readFile(path.join(root, "CNS-Jurnal-2026-09-20.log"), "utf8");
  assert.equal(content.trim().split("\n").length, 1);
  assert.ok(!content.includes("DO_NOT_LOG") && !content.includes("SECRET_COOKIE"));
  date = new Date(2026, 8, 21);
  audit.write({ event: "SERVER_START", result: "SUCCESS" });
  await audit.flush();
  files = await fs.readdir(root);
  assert.ok(files.includes("CNS-Jurnal-2026-09-21.log"));
  assert.ok(!files.includes("CNS-Jurnal-2026-08-06.log"));
});
