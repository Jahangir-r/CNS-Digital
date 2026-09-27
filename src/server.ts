import express from "express";
import session from "express-session";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { AuditLog } from "./audit.js";
import { auditRequests } from "./audit-http.js";
import { ChecklistBackup } from "./checklists/backup.js";
import { BackupManager } from "./backup.js";
import { createAuthService } from "./auth.js";
import { openChecklistDatabase } from "./checklists/db.js";
import { createReportLinkRouter } from "./checklists/report-link-routes.js";
import { createRunRouter } from "./checklists/run-routes.js";
import { createTemplateRouter } from "./checklists/template-routes.js";
import { createJournalRouter } from "./modules/journal/journal-router.js";
import { createAdministrationRouter } from "./modules/users/administration-router.js";

const audit = new AuditLog(path.join(process.cwd(), "logs"));
const { db } = await import("./db.js").catch(async () => {
  audit.write({ event: "SERVER_ERROR", result: "ERROR", description: "Database initialization failed" });
  await audit.flush();
  throw new Error("Database initialization failed");
});
const checklistStorage = openChecklistDatabase(process.cwd(), entry => audit.write(entry));
const checklistDb = checklistStorage.db;
const checklistBackups = checklistDb ? new ChecklistBackup(checklistDb, path.join(process.cwd(), "CNS-Digital-Backup", "Checklist"), entry => audit.write(entry), {applicationVersion: process.env.npm_package_version}) : null;
const backups = new BackupManager(db, path.join(process.cwd(), "CNS-Digital-Backup"), entry => audit.write(entry));
function backupReports(res: express.Response): void {
  try {
    const actor = res.locals.auditActor;
    backups.requestExcel({ user: actor?.username, name: actor?.full_name, ip: res.req.ip });
  } catch { /* the database operation has already committed */ }
}
const PORT = Number(process.env.PORT) || 3001;
const APP_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const app = express();
app.locals.checklistStorage = checklistStorage;
// Explicit IP addresses/subnets only; never blindly trust X-Forwarded-For.
const trustedProxies = (process.env.TRUST_PROXY || "").split(",").map(value => value.trim()).filter(Boolean);
app.set("trust proxy", trustedProxies.length ? trustedProxies : false);
app.use(auditRequests(audit));
if (checklistBackups) app.use(checklistBackups.middleware());
app.use(express.json({ limit: "2mb" }));
app.use(
  session({
    name: "cns.sid",
    secret: APP_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: 12 * 60 * 60 * 1000,
    },
  })
);

const auth = createAuthService(db, APP_SECRET);
const { isShiftEngineer } = auth;
const journal = createJournalRouter(db, auth, backupReports);
app.use("/api", auth.routes(user => {
  if (isShiftEngineer(user)) journal.reconcileHistoricalOwnershipForUser(user.id);
}));
app.use("/api", journal.router);
app.use("/api", createAdministrationRouter(db, auth, journal.reconcileHistoricalOwnershipForUser));
app.use("/api", createTemplateRouter(checklistStorage, auth, audit));
app.use("/api", createRunRouter(checklistStorage, auth, audit));
app.use("/api", createReportLinkRouter(checklistStorage, db, auth, audit, backupReports));
journal.reconcileAllHistoricalOwnership();

// Keep the SPA fallback out of the API namespace. Admin clients can now rely
// on every /api response being JSON, including a mistyped or stale endpoint.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API endpoint tapılmadı" });
});

// Do not echo exception messages: they can contain SQL values or request secrets.
app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    audit.write({ event: "API_ERROR", result: "ERROR", description: "Response stream failed" });
    res.destroy();
    return;
  }
  const status = (error as { status?: number })?.status;
  res.status(status && status >= 400 && status < 500 ? status : 500).json({ error: "Server request failed" });
});

// Static web UI.
app.use(express.static(path.join(process.cwd(), "public")));
app.get("*", (_req, res) => res.sendFile(path.join(process.cwd(), "public", "index.html")));

const server = app.listen(PORT, "0.0.0.0", () => {
  audit.write({ event: "SERVER_START", result: "SUCCESS", description: `Server listening on port ${PORT}` });
  backups.start();
  checklistBackups?.start();
  console.log(`CNS Digital Server: http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const key of Object.keys(nets)) {
    const list = nets[key] ?? [];
    for (const n of list) if (n.family === "IPv4" && !n.internal) console.log(`LAN: http://${n.address}:${PORT}`);
  }
});

server.on("error", async () => {
  audit.write({ event: "SERVER_ERROR", result: "ERROR", description: "HTTP server failed" });
  await audit.flush();
  process.exitCode = 1;
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  audit.write({ event: "SERVER_STOP", result: "SUCCESS", description: `Graceful shutdown requested: ${signal}` });
  const timeout = setTimeout(() => { process.exit(1); }, 15_000);
  timeout.unref();
  server.close(async () => {
    await Promise.all([backups.stop(), checklistBackups?.stop()]);
    await audit.flush();
    checklistDb?.close();
    db.close();
    clearTimeout(timeout);
    process.exit(0);
  });
}
process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
