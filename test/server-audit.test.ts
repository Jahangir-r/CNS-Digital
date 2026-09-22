import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import ExcelJS from "exceljs";
import Database from "better-sqlite3";
import { localDate } from "../src/local-time.js";

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 150; i++) {
    try { const value = await read(); if (accept(value)) return value; } catch { /* retry file replacement / startup */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for isolated test server or its output");
}

async function start(t: any, trustProxy = "", blocked = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cns-api-test-"));
  if (blocked) {
    await fs.writeFile(path.join(root, "logs"), "blocked");
    await fs.writeFile(path.join(root, "CNS-Jurnal-Backup"), "blocked");
  }
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("src/server.ts")], {
    cwd: root, // db.ts can only create/open data/jurnal.db inside this temporary directory.
    env: { ...process.env, PORT: String(port), TRUST_PROXY: trustProxy, SESSION_SECRET: "isolated-test-secret" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const exited = once(child, "exit");
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 18_000);
    await exited;
    clearTimeout(force);
  }
  t.after(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  await eventually(() => fetch(`${base}/api/me`), r => r.status === 401);
  let token = "";
  async function call(url: string, method = "GET", body?: any, extra: Record<string, string> = {}) {
    const response = await fetch(base + url, {
      method, headers: { "Content-Type": "application/json", "X-CNS-Token": token, "X-Forwarded-For": "203.0.113.25", ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    return { status: response.status, json };
  }
  const logFile = path.join(root, "logs", `CNS-Jurnal-${localDate()}.log`);
  const readLog = () => fs.readFile(logFile, "utf8");
  return { root, base, call, readLog, stop, token: (value: string) => { token = value; } };
}

const report = { xidmet: "CES", obyekt: "Bakı", sistem: "ILS", nasazliq: "Test fault", nasazliq_vaxti: "2026-09-20T10:00", prioritet: "orta" };

test("isolated API: audit coverage, backups after mutations, export unchanged, secrets excluded and proxy spoofing ignored", async t => {
  const s = await start(t);
  assert.equal((await s.call("/api/login", "POST", { username: "admin", password: "NEVER_LOG_FAILED_PASSWORD" })).status, 401);
  const login = await s.call("/api/login", "POST", { username: "admin", password: "admin123" });
  assert.equal(login.status, 200);
  const token = login.json.auth_token;
  s.token(token);
  const created = await s.call("/api/reports", "POST", report);
  assert.equal(created.status, 200);
  const id = created.json.id;
  const excelFile = path.join(s.root, "CNS-Jurnal-Backup/Excel", `CNS-Jurnal-${localDate()}.xlsx`);
  const readSheet = async () => {
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(excelFile); return book.worksheets[0];
  };
  await eventually(readSheet, sheet => sheet.rowCount === 2);
  assert.equal((await s.call(`/api/reports/${id}`, "PUT", { ...report, sistem: "Updated ILS" })).status, 200);
  await eventually(readSheet, sheet => sheet.getCell("D2").value === "Updated ILS");
  assert.equal((await s.call(`/api/reports/${id}`, "PUT", { ...report, berpa_vaxti: "2026-09-20T11:00" })).status, 200);
  await eventually(readSheet, sheet => sheet.getCell("I2").value === "2026-09-20T11:00");
  const exported = await fetch(s.base + "/api/export", { headers: { "X-CNS-Token": token } });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition")!, /CNS_nasazliqlar_.*\.xlsx/);
  const excel = Buffer.from(await exported.arrayBuffer());
  const manual = new ExcelJS.Workbook(); await manual.xlsx.load(excel as any);
  assert.equal(manual.worksheets.length, 1);
  assert.equal(manual.worksheets[0].getCell("A1").value, "S/S");
  assert.equal((await s.call(`/api/reports/${id}`, "DELETE")).status, 200);
  await eventually(readSheet, sheet => sheet.rowCount === 1);
  const imported = await fetch(s.base + "/api/import", { method: "POST", headers: { "X-CNS-Token": token, "Content-Type": "application/octet-stream" }, body: excel });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).imported, 1);
  await eventually(readSheet, sheet => sheet.rowCount === 2);
  const user = await s.call("/api/users", "POST", { username: "engineer", full_name: "Test Engineer", password: "NEVER_LOG_USER_PASSWORD", role: "shift_engineer" });
  assert.equal(user.status, 200);
  const uid = user.json.id;
  assert.equal((await s.call(`/api/users/${uid}`, "PUT", { full_name: "Engineer Updated" })).status, 200);
  assert.equal((await s.call(`/api/users/${uid}/password`, "POST", { password: "NEVER_LOG_RESET_PASSWORD" })).status, 200);
  const engineer = await s.call("/api/login", "POST", { username: "engineer", password: "NEVER_LOG_RESET_PASSWORD" });
  s.token(engineer.json.auth_token);
  const own = await s.call("/api/reports", "POST", report);
  assert.equal((await s.call(`/api/reports/${own.json.id}/restore`, "POST", { ...report, berpa_vaxti: "2026-09-20T12:00", recovery_description: "Equipment restored" })).status, 200);
  await eventually(readSheet, sheet => sheet.getRow(sheet.rowCount).getCell(18).value === 1);
  s.token(token);
  assert.equal((await s.call(`/api/users/${uid}`, "PUT", { active: false })).status, 200);
  assert.equal((await s.call(`/api/users/${uid}`, "DELETE")).status, 200);
  const role = await s.call("/api/roles", "POST", { label: "Test role", permissions: { view_all_reports: true } });
  assert.equal(role.status, 201);
  assert.equal((await s.call(`/api/roles/${role.json.name}/permissions`, "PUT", { permission: "create_reports", enabled: true })).status, 200);
  assert.equal((await s.call("/api/change-password", "POST", { oldPassword: "admin123", newPassword: "NEVER_LOG_NEW_PASSWORD" })).status, 200);
  assert.equal((await s.call("/api/reports", "DELETE")).status, 200);
  await eventually(readSheet, sheet => sheet.rowCount === 1);
  // Force a genuine SQLite error only in this isolated fixture.
  const db = new Database(path.join(s.root, "data/jurnal.db"));
  db.exec("CREATE TRIGGER reject_test_insert BEFORE INSERT ON reports BEGIN SELECT RAISE(ABORT, 'NEVER_LOG_SQL_SECRET'); END");
  assert.equal((await s.call("/api/reports", "POST", report)).status, 500);
  db.close();
  assert.equal((await s.call("/api/logout", "POST")).status, 200);
  await s.stop();
  const log = await s.readLog();
  for (const event of ["SERVER_START", "SERVER_STOP", "LOGIN_SUCCESS", "LOGIN_FAILURE", "LOGOUT", "PASSWORD_CHANGE", "PASSWORD_RESET", "USER_CREATE", "USER_UPDATE", "USER_DEACTIVATE", "USER_DELETE", "ROLE_CREATE", "ROLE_UPDATE", "REPORT_CREATE", "REPORT_UPDATE", "REPORT_RESTORE", "REPORT_DELETE", "REPORT_DELETE_ALL", "EXCEL_IMPORT", "EXCEL_EXPORT", "BACKUP", "API_ERROR"]) {
    assert.ok(log.includes(`[${event}]`), `Missing event ${event}`);
  }
  assert.ok(log.includes(`report_id="${id}"`) && log.includes(`user_id="${uid}"`) && log.includes(`role_id="${role.json.name}"`));
  assert.ok(!log.includes("203.0.113.25"));
  assert.ok(!log.includes("NEVER_LOG") && !log.includes(token) && !log.includes("admin123") && !log.includes("isolated-test-secret"));
});

test("explicit trusted proxy enables forwarded IP", async t => {
  const s = await start(t, "loopback");
  await s.call("/api/login", "POST", { username: "admin", password: "wrong" });
  const log = await eventually(s.readLog, value => value.includes("LOGIN_FAILURE"));
  assert.ok(log.includes('ip="203.0.113.25"'));
});

test("API mutations succeed with both backup directory and logs unavailable", async t => {
  const s = await start(t, "", true);
  const login = await s.call("/api/login", "POST", { username: "admin", password: "admin123" });
  s.token(login.json.auth_token);
  const created = await s.call("/api/reports", "POST", report);
  assert.equal(created.status, 200);
  assert.equal((await s.call(`/api/reports/${created.json.id}`, "PUT", { ...report, sistem: "Still saved" })).status, 200);
  const rows = await s.call("/api/reports");
  assert.equal(rows.json[0].sistem, "Still saved");
  assert.equal((await s.call(`/api/reports/${created.json.id}`, "DELETE")).status, 200);
  assert.equal((await s.call("/api/reports")).json.length, 0);
});
