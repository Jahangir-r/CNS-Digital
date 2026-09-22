import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import express from "express";
import session from "express-session";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { User, Report } from "../src/db.js";
import { createAuthService } from "../src/auth.js";
import { createReportService, ReportServiceError } from "../src/reports/service.js";
import { auditRequests } from "../src/audit-http.js";
import type { AuditEvent } from "../src/audit.js";

function fixture() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, full_name TEXT, role TEXT,
    active INTEGER DEFAULT 1, deleted INTEGER DEFAULT 0, created_at TEXT DEFAULT ''
  );
  CREATE TABLE roles (
    id INTEGER PRIMARY KEY, name TEXT UNIQUE, label TEXT, built_in INTEGER DEFAULT 0, created_at TEXT DEFAULT '',
    manage_users INTEGER DEFAULT 0, manage_roles INTEGER DEFAULT 0, reset_password INTEGER DEFAULT 0,
    view_all_reports INTEGER DEFAULT 0, create_reports INTEGER DEFAULT 0, edit_reports INTEGER DEFAULT 0,
    delete_reports INTEGER DEFAULT 0, export_import INTEGER DEFAULT 0, shift_engineer_access INTEGER DEFAULT 0,
    view_checklists INTEGER DEFAULT 0, create_checklists INTEGER DEFAULT 0, edit_own_checklists INTEGER DEFAULT 0,
    manage_checklists INTEGER DEFAULT 0, manage_checklist_templates INTEGER DEFAULT 0,
    manage_checklist_shifts INTEGER DEFAULT 0, create_reports_from_checklist INTEGER DEFAULT 0
  );
  CREATE TABLE reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), owner_user_id INTEGER REFERENCES users(id),
    xidmet TEXT, obyekt TEXT, sistem TEXT, nasazliq TEXT, nasazliq_vaxti TEXT, sebeb TEXT, tedbir TEXT,
    berpa_vaxti TEXT, muraciet TEXT, cavabdeh TEXT, prioritet TEXT
  );
  INSERT INTO roles(name,label,create_reports,edit_reports,delete_reports) VALUES ('writer','Writer',1,1,1);
  INSERT INTO roles(name,label,create_reports,edit_reports,delete_reports,shift_engineer_access) VALUES ('custom_shift','Custom shift',1,1,1,1);
  INSERT INTO roles(name,label,create_reports_from_checklist) VALUES ('technician','Texnik',1);`);
  const insert = db.prepare("INSERT INTO users(id,username,password_hash,full_name,role) VALUES (?,?,?,?,?)");
  const hash = bcrypt.hashSync("test-password", 4);
  insert.run(1,"writer",hash,"Writer Name","writer");
  insert.run(2,"shift",hash,"Əliyev Azad","custom_shift");
  insert.run(3,"tech",hash,"Tech Name","technician");
  const user = (id: number) => db.prepare("SELECT * FROM users WHERE id=?").get(id) as User;
  return { db, user };
}

const input = {
  xidmet: " CES ", sistem: " ILS ", nasazliq: " Fault ", nasazliq_vaxti: "2026-09-20T10:00",
  muraciet: "Qafarov V", cavabdeh: "Kaysin Roman", prioritet: "Yüksək",
};

test("shared auth preserves signed token format, lifetime and tampering rejection", () => {
  const { db } = fixture();
  try {
    let time = 1_000_000;
    const auth = createAuthService(db, "test-secret", () => time);
    const token = auth.signAuthToken(1);
    const payload = `1.${time + 12 * 60 * 60 * 1000}`;
    const signature = crypto.createHmac("sha256", "test-secret").update(payload).digest("hex");
    assert.equal(token, Buffer.from(`${payload}.${signature}`).toString("base64url"));
    assert.equal(auth.verifyAuthToken(token), 1);
    assert.equal(createAuthService(db, "different-secret", () => time).verifyAuthToken(token), null);
    assert.equal(auth.verifyAuthToken(Buffer.from(`2.${time + 12 * 60 * 60 * 1000}.${signature}`).toString("base64url")), null);
    assert.equal(auth.verifyAuthToken("malformed"), null);
    time += 12 * 60 * 60 * 1000 + 1;
    assert.equal(auth.verifyAuthToken(token), null);
  } finally { db.close(); }
});

test("shared auth reads active users and current permissions; unknown roles are denied", () => {
  const { db, user } = fixture();
  try {
    const auth = createAuthService(db, "secret");
    const req = (headers: Record<string,string> = {}, userId?: number) => ({ session: { userId }, get: (key: string) => headers[key] }) as express.Request;
    const token = auth.signAuthToken(1);
    assert.equal(auth.currentUser(req({}, 1))?.id, 1);
    assert.equal(auth.currentUser(req({ "x-cns-token": token }))?.id, 1);
    assert.equal(auth.currentUser(req({ authorization: `Bearer ${token}` }))?.id, 1);
    assert.equal(auth.currentUser(req({ authorization: `Bearer ${token}` }, 2))?.id, 2);
    assert.equal(auth.can(user(1), "create_reports"), true);
    db.exec("UPDATE roles SET create_reports=0 WHERE name='writer'");
    assert.equal(auth.can(user(1), "create_reports"), false);
    assert.equal(auth.can({ ...user(1), role: "missing" }, "view_checklists"), false);
    assert.equal(auth.can({ ...user(1), role: "missing" }, "create_reports"), false);
    assert.ok(!("password_hash" in auth.userPayload(user(1))));
    db.exec("UPDATE users SET active=0 WHERE id=1");
    assert.equal(auth.currentUser(req({ "x-cns-token": token })), null);
    db.exec("UPDATE users SET active=1,deleted=1 WHERE id=1");
    assert.equal(auth.currentUser(req({}, 1)), null);
  } finally { db.close(); }
});

test("report service retains normalization and server-selected author/ownership", () => {
  const { db, user } = fixture();
  try {
    const reports = createReportService(db, createAuthService(db, "secret"));
    const created = reports.createManual(user(1), { ...input, user_id: 3, owner_user_id: 3, ignored: "not stored" });
    const row = db.prepare("SELECT * FROM reports WHERE id=?").get(created.id) as any;
    assert.equal(row.user_id, 1);
    assert.equal(row.owner_user_id, null);
    assert.equal(row.xidmet, "CES"); assert.equal(row.sistem, "ILS"); assert.equal(row.nasazliq, "Fault");
    assert.equal(row.muraciet, "Qafarov V."); assert.equal(row.cavabdeh, "Kaysın R.");
    assert.equal(row.prioritet, "yuksek"); assert.equal(row.obyekt, "");
    const own = reports.createManual(user(2), input);
    const shift = db.prepare("SELECT * FROM reports WHERE id=?").get(own.id) as any;
    assert.equal(shift.owner_user_id, 2); assert.equal(shift.cavabdeh, "Əliyev A.");
    assert.equal(shift.user_id, 2);
  } finally { db.close(); }
});

test("report service rejects checklist-only permission, validates required fields and propagates DB failures", () => {
  const { db, user } = fixture();
  try {
    const reports = createReportService(db, createAuthService(db, "secret"));
    assert.throws(() => reports.createManual(user(3), { ...input, source: "checklist", create_reports: true }),
      error => error instanceof ReportServiceError && error.status === 403);
    assert.throws(() => reports.createManual(user(1), { ...input, sistem: " " }),
      error => error instanceof ReportServiceError && error.status === 400);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM reports").get() as any).n, 0);
    db.exec("CREATE TRIGGER reject_insert BEFORE INSERT ON reports BEGIN SELECT RAISE(ABORT,'database failure'); END");
    assert.throws(() => reports.createManual(user(1), input), /database failure/);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM reports").get() as any).n, 0);
  } finally { db.close(); }
});

test("report edit/delete policies use permissions and retain shift-owner restrictions", () => {
  const { db, user } = fixture();
  try {
    const reports = createReportService(db, createAuthService(db, "secret"));
    const open = { owner_user_id: 2, berpa_vaxti: "" } as Report;
    assert.equal(reports.canEdit(user(2), open), true);
    assert.equal(reports.canEdit(user(2), { ...open, owner_user_id: 1 }), false);
    assert.equal(reports.canEdit(user(2), { ...open, berpa_vaxti: "2026-09-20T11:00" }), false);
    assert.equal(reports.canDelete(user(2), open), false);
    assert.equal(reports.canEdit(user(1), open), true);
    assert.equal(reports.canDelete(user(1), open), true);
    assert.equal(reports.canEdit(user(3), open), false);
    assert.equal(reports.canDelete(user(3), open), false);
  } finally { db.close(); }
});

test("mounted auth routes preserve cookie/Bearer login, logout and failed-login audit identity", async t => {
  const { db } = fixture();
  const auth = createAuthService(db, "test-secret");
  const events: AuditEvent[] = [];
  const app = express();
  app.use(auditRequests({ write: entry => { events.push(entry); } }));
  app.use(express.json());
  app.use(session({ secret: "test-secret", name: "cns.sid", resave: false, saveUninitialized: false }));
  let afterLoginCalls = 0;
  app.use("/api", auth.routes(() => { afterLoginCalls++; }));
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (url: string, headers = {}, body?: unknown) => fetch(base + url, {
    method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal((await call("/api/login", {}, { username: "writer", password: "NEVER_LOG_PASSWORD" })).status, 401);
  const failed = events.find(event => event.event === "LOGIN_FAILURE");
  assert.equal(failed?.user, "writer");
  const unknownLogin = await call("/api/login", {}, { username: "not-existing", password: "NEVER_LOG_PASSWORD" });
  assert.equal(unknownLogin.status, 401);
  assert.equal(events.filter(event => event.event === "LOGIN_FAILURE").at(-1)?.user, "not-existing");
  const login = await call("/api/login", {}, { username: " WRITER ", password: "test-password" });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const account = await login.json();
  assert.equal(afterLoginCalls, 1);
  assert.equal((await call("/api/me", { Cookie: cookie })).status, 200);
  assert.equal((await call("/api/me", { Authorization: `Bearer ${account.auth_token}` })).status, 200);
  assert.equal((await call("/api/change-password", { Cookie: cookie }, { oldPassword: "test-password", newPassword: "new-password" })).status, 200);
  assert.equal((await call("/api/logout", { Cookie: cookie }, {})).status, 200);
  assert.equal((await call("/api/me", { Cookie: cookie })).status, 401);
  // Existing token semantics are unchanged: logout destroys the session, not issued tokens.
  assert.equal((await call("/api/me", { Authorization: `Bearer ${account.auth_token}` })).status, 200);
  assert.equal((await call("/api/login", {}, { username: "writer", password: "new-password" })).status, 200);
  assert.ok(events.some(event => event.event === "PASSWORD_CHANGE" && event.user === "writer"));
  assert.ok(events.some(event => event.event === "LOGOUT" && event.user === "writer"));
  assert.ok(!JSON.stringify(events).includes("NEVER_LOG_PASSWORD"));
  assert.ok(!JSON.stringify(events).includes(account.auth_token));
});
