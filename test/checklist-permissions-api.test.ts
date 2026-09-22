import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { CHECKLIST_PERMISSIONS } from "../src/checklists/permissions.js";
import { localDate } from "../src/local-time.js";

async function boot(root: string, attempt = 1): Promise<any> {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("src/server.ts")], {
    cwd: root, env: { ...process.env, PORT: String(port), TRUST_PROXY: "", SESSION_SECRET: "stage1-test-only" }, stdio: "ignore",
  });
  const exited = once(child, "exit");
  const base = `http://127.0.0.1:${port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 18_000);
    await exited; clearTimeout(force);
  };
  try {
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(base + "/api/me")).status === 401) { ready = true; break; } } catch {}
      if (child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready && attempt < 3) { await stop(); return boot(root, attempt + 1); }
    assert.ok(ready, "Isolated server must start");
  } catch (error) { await stop(); throw error; }
  const call = async (url: string, method = "GET", body?: unknown, token = "") => {
    const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", "X-CNS-Token": token }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { call, stop };
}

test("API permissions, role editing, no manual report privilege, and persistence across server restarts", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cns-stage1-api-"));
  let server: Awaited<ReturnType<typeof boot>> | undefined;
  t.after(async () => { await server?.stop(); await fs.rm(root, { recursive: true, force: true }); });
  server = await boot(root);
  const login = await server.call("/api/login", "POST", { username: "admin", password: "admin123" });
  assert.equal(login.status, 200);
  let admin = login.body.auth_token;
  const me = await server.call("/api/me", "GET", undefined, admin);
  for (const key of CHECKLIST_PERMISSIONS) assert.equal(me.body.perms[key], true);
  const roleList = await server.call("/api/roles", "GET", undefined, admin);
  const expected: Record<string, number[]> = {
    admin: [1,1,1,1,1,1,1], employee: [1,0,0,0,0,0,0], shift_engineer: [1,0,0,0,0,0,0],
    observer: [1,0,0,0,0,0,0], technician: [1,1,1,0,0,0,1], engineer: [1,1,1,0,0,0,1],
  };
  for (const [name, values] of Object.entries(expected)) {
    const role = roleList.body.find((r: any) => r.name === name);
    assert.deepEqual(CHECKLIST_PERMISSIONS.map(key => role[key]), values, name);
  }
  for (const role of ["technician", "engineer", "employee", "observer", "shift_engineer"]) {
    assert.equal((await server.call("/api/users", "POST", { username: role, full_name: `Test ${role}`, password: "test-password", role }, admin)).status, 200);
    const user: { status: number; body: any } = await server.call("/api/login", "POST", { username: role, password: "test-password" });
    const token: string = user.body.auth_token;
    const self = await server.call("/api/me", "GET", undefined, token);
    assert.deepEqual(CHECKLIST_PERMISSIONS.map(key => +self.body.perms[key]), expected[role]);
    if (["technician", "engineer"].includes(role)) {
      assert.equal(self.body.perms.create_reports, false);
      assert.equal((await server.call("/api/reports", "POST", { xidmet: "CES", sistem: "ILS", nasazliq: "test", nasazliq_vaxti: "2026-09-20T10:00" }, token)).status, 403);
    }
    assert.equal((await server.call("/api/roles/employee/permissions", "PUT", { permission: "manage_checklist_shifts", enabled: true }, token)).status, 403);
  }
  const all = Object.fromEntries(CHECKLIST_PERMISSIONS.map(key => [key, true]));
  const custom = await server.call("/api/roles", "POST", { label: "Checklist custom", permissions: all }, admin);
  assert.equal(custom.status, 201);
  for (const key of CHECKLIST_PERMISSIONS) assert.equal(custom.body[key], 1);
  assert.equal(custom.body.create_reports, 0);
  const empty = await server.call("/api/roles", "POST", { label: "Empty custom", permissions: {} }, admin);
  for (const key of CHECKLIST_PERMISSIONS) assert.equal(empty.body[key], 0);
  assert.equal((await server.call(`/api/roles/${custom.body.name}`, "PUT", { label: "Renamed only", permissions: { view_all_reports: true } }, admin)).status, 200);
  assert.equal((await server.call("/api/roles/technician/permissions-batch", "PUT", { permissions: { manage_checklist_shifts: true, create_reports_from_checklist: false, create_reports: true } }, admin)).status, 200);
  assert.equal((await server.call("/api/roles/employee/permissions", "PUT", { permission: "view_checklists", enabled: false }, admin)).status, 200);
  assert.equal((await server.call("/api/roles/admin/permissions", "PUT", { permission: "manage_checklist_shifts", enabled: false }, admin)).status, 400);
  const updated = await server.call(`/api/roles/${empty.body.name}`, "PUT", { label: "Updated custom", permissions: { manage_checklist_shifts: true, manage_checklist_templates: false } }, admin);
  assert.equal(updated.body.manage_checklist_shifts, 1);
  assert.equal(updated.body.manage_checklist_templates, 0);
  const before = (await server.call("/api/roles", "GET", undefined, admin)).body;
  await server.stop(); server = undefined;
  const db = new Database(path.join(root, "data/jurnal.db"), { readonly: true });
  const users = db.prepare("SELECT * FROM users ORDER BY id").all();
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name='report_creation_requests'").get(), {name:"report_creation_requests"});
  assert.equal((db.prepare("SELECT COUNT(*) n FROM report_creation_requests").get() as any).n,0);
  db.close();
  server = await boot(root);
  admin = (await server.call("/api/login", "POST", { username: "admin", password: "admin123" })).body.auth_token;
  assert.deepEqual((await server.call("/api/roles", "GET", undefined, admin)).body, before);
  const after = new Database(path.join(root, "data/jurnal.db"), { readonly: true });
  assert.deepEqual(after.prepare("SELECT * FROM users ORDER BY id").all(), users);
  after.close();
  const checklist = new Database(path.join(root, "data/checklist.db"), { readonly: true });
  assert.deepEqual(checklist.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), ["checklist_schema_migrations", "checklist_templates", "checklist_template_versions", "checklist_sections", "checklist_items", "checklist_shift_schedule_versions", "checklist_shift_rules", "checklist_shift_periods", "checklist_runs", "checklist_run_sections", "checklist_run_items", "checklist_report_links", "checklist_shift_current"].map(name => ({ name })));
  assert.equal((checklist.prepare("SELECT COUNT(*) AS n FROM checklist_schema_migrations").get() as any).n, 8);
  checklist.close();
});

test("unavailable checklist storage does not prevent login, journal writes or journal backup", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cns-stage1-unavailable-"));
  await fs.mkdir(path.join(root, "data/checklist.db"), { recursive: true }); // path is a directory, not a DB
  const server = await boot(root);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const login = await server.call("/api/login", "POST", { username: "admin", password: "admin123" });
  assert.equal(login.status, 200);
  const created = await server.call("/api/reports", "POST", { xidmet: "CES", sistem: "ILS", nasazliq: "Storage failure test", nasazliq_vaxti: "2026-09-20T10:00" }, login.body.auth_token);
  assert.equal(created.status, 200);
  assert.equal((await server.call("/api/reports", "GET", undefined, login.body.auth_token)).body.length, 1);
  await server.stop();
  const log = await fs.readFile(path.join(root, "logs", `CNS-Jurnal-${localDate()}.log`), "utf8");
  assert.ok(log.includes('[CHECKLIST_STORAGE_ERROR] module="CHECKLIST"'));
  assert.ok(log.includes("[REPORT_CREATE]"));
  assert.ok((await fs.readdir(path.join(root, "CNS-Jurnal-Backup/Excel"))).some(name => name.endsWith(".xlsx")));
});
