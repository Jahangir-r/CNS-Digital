import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import ExcelJS from "exceljs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { User, Report } from "./db.js";
import { AuditLog } from "./audit.js";
import { auditRequests } from "./audit-http.js";
import { ChecklistBackup } from "./checklists/backup.js";
import { BackupManager } from "./backup.js";
import { CHECKLIST_PERMISSIONS } from "./checklists/permissions.js";
import { createAuthService, type PermField } from "./auth.js";
import { createReportService, ReportServiceError } from "./reports/service.js";
import { REPORT_FIELDS, PRIORITY_LABELS, normalizePriority, normalizePersonText,
  extractPersonIdentity, personMatches, pickReport } from "./reports/normalization.js";
import { openChecklistDatabase } from "./checklists/db.js";
import { createReportLinkRouter } from "./checklists/report-link-routes.js";
import { createRunRouter } from "./checklists/run-routes.js";
import { createTemplateRouter } from "./checklists/template-routes.js";

const audit = new AuditLog(path.join(process.cwd(), "logs"));
const { db, getRole } = await import("./db.js").catch(async () => {
  audit.write({ event: "SERVER_ERROR", result: "ERROR", description: "Database initialization failed" });
  await audit.flush();
  throw new Error("Database initialization failed");
});
const checklistStorage = openChecklistDatabase(process.cwd(), entry => audit.write(entry));
const checklistDb = checklistStorage.db;
const checklistBackups = checklistDb ? new ChecklistBackup(checklistDb, path.join(process.cwd(), "CNS-Jurnal-Backup", "Checklist"), entry => audit.write(entry), {applicationVersion: process.env.npm_package_version}) : null;
const backups = new BackupManager(db, path.join(process.cwd(), "CNS-Jurnal-Backup"), entry => audit.write(entry));
function backupReports(res: express.Response): void {
  try {
    const actor = res.locals.auditActor;
    backups.requestExcel({ user: actor?.username, name: actor?.full_name, ip: res.req.ip });
  } catch { /* the database operation has already committed */ }
}
const asyncRoute = (handler: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => { Promise.resolve().then(() => handler(req, res, next)).catch(next); };

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
const { can, isShiftEngineer, requireAuth, requirePerm } = auth;
const { createManual: createReport, canEdit: reportCanEdit, canDelete: reportCanDelete } = createReportService(db, auth);
app.use("/api", auth.routes(user => {
  if (isShiftEngineer(user)) reconcileHistoricalOwnershipForUser(user.id);
}));
app.use("/api", createTemplateRouter(checklistStorage, auth, audit));
app.use("/api", createRunRouter(checklistStorage, auth, audit));
app.use("/api", createReportLinkRouter(checklistStorage, db, auth, audit, backupReports));

// ---------- Reports ----------
function reconcileHistoricalOwnershipForUser(userId: number): number {
  const user = db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND COALESCE(deleted,0)=0").get(userId) as User | undefined;
  if (!user || !isShiftEngineer(user)) return 0;

  const identity = extractPersonIdentity(user.full_name);
  if (!identity) return 0;

  const rows = db.prepare(`
    SELECT id,cavabdeh FROM reports
    WHERE owner_user_id IS NULL
  `).all() as { id: number; cavabdeh: string }[];

  const shiftUsers = db.prepare(`
    SELECT u.id,u.full_name
    FROM users u
    JOIN roles r ON r.name=u.role
    WHERE u.active=1 AND COALESCE(u.deleted,0)=0 AND COALESCE(r.shift_engineer_access,0)=1
  `).all() as { id: number; full_name: string }[];

  const sameIdentity = shiftUsers.filter(x => {
    const i = extractPersonIdentity(x.full_name);
    return !!i && i.surname === identity.surname && i.initial === identity.initial;
  });
  const uniqueIdentity = sameIdentity.length === 1 && sameIdentity[0].id === user.id;

  const upd = db.prepare("UPDATE reports SET owner_user_id=? WHERE id=? AND owner_user_id IS NULL");
  let linked = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const rowIdentity = extractPersonIdentity(row.cavabdeh);
      if (!rowIdentity) continue;
      const exact = personMatches(user.full_name, row.cavabdeh);
      const safeUnique = uniqueIdentity &&
        rowIdentity.surname === identity.surname &&
        rowIdentity.initial === identity.initial;
      if (exact || safeUnique) linked += upd.run(user.id, row.id).changes;
    }
  });
  tx();
  return linked;
}

function reconcileAllHistoricalOwnership(): number {
  db.prepare(`
    UPDATE reports SET owner_user_id=user_id
    WHERE owner_user_id IS NULL
      AND user_id IN (
        SELECT u.id FROM users u
        JOIN roles r ON r.name=u.role
        WHERE COALESCE(u.deleted,0)=0 AND COALESCE(r.shift_engineer_access,0)=1
      )
  `).run();

  const users = db.prepare(`
    SELECT u.id FROM users u
    JOIN roles r ON r.name=u.role
    WHERE u.active=1 AND COALESCE(u.deleted,0)=0 AND COALESCE(r.shift_engineer_access,0)=1
  `).all() as { id: number }[];
  return users.reduce((n, u) => n + reconcileHistoricalOwnershipForUser(u.id), 0);
}

// Link any already-created shift-engineer accounts to historical Excel rows.
// user_id remains the original importer/author (often Admin); owner_user_id is the operational owner.
reconcileAllHistoricalOwnership();

app.get("/api/reports", requireAuth, (req, res) => {
  const u = (res.locals as { user: User }).user;
  if (isShiftEngineer(u)) reconcileHistoricalOwnershipForUser(u.id);
  if (!can(u, "view_all_reports")) return res.json([]);
  const rows = db
    .prepare(
      `SELECT r.*, author.full_name AS author, owner.full_name AS owner_name
       FROM reports r
       JOIN users author ON author.id=r.user_id
       LEFT JOIN users owner ON owner.id=r.owner_user_id
       ORDER BY datetime(r.updated_at) DESC, r.id DESC`
    )
    .all() as (Report & { author: string; owner_name?: string })[];
  res.json(rows.map((r) => ({
    ...r,
    can_edit: reportCanEdit(u, r),
    can_delete: reportCanDelete(u, r),
  })));
});
app.post("/api/reports", requireAuth, requirePerm("create_reports"), (req, res) => {
  const u = (res.locals as { user: User }).user;
  try {
    const result = createReport(u, req.body as Record<string, unknown>);
    backupReports(res);
    res.json(result);
  } catch (error) {
    if (error instanceof ReportServiceError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});
app.put("/api/reports/:id", requireAuth, requirePerm("edit_reports"), (req, res) => {
  const existing = db.prepare("SELECT * FROM reports WHERE id=?").get(req.params.id) as Report | undefined;
  if (!existing) return res.status(404).json({ error: "Qeyd tapılmadı" });
  const u = (res.locals as { user: User }).user;
  if (!reportCanEdit(u, existing)) {
    return res.status(403).json({ error: "Yalnız öz açıq qeydlərinizi redaktə edə bilərsiniz" });
  }
  const r = pickReport(req.body as Record<string, unknown>);
  if (isShiftEngineer(u)) {
    r.cavabdeh = normalizePersonText(u.full_name, true);
    if (!existing.berpa_vaxti && r.berpa_vaxti) {
      return res.status(409).json({ error: "Bərpa üçün görülən tədbir təsdiqi tələb olunur" });
    }
  }
  if (!r.xidmet || !r.sistem || !r.nasazliq || !r.nasazliq_vaxti) {
    return res.status(400).json({ error: "Xidmət, sistem, nasazlıq və nasazlıq vaxtı mütləqdir" });
  }
  db.prepare(
    `UPDATE reports SET ${REPORT_FIELDS.map((f) => `${f}=?`).join(",")}, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(...REPORT_FIELDS.map((f) => r[f]), existing.id);
  if (!existing.berpa_vaxti && r.berpa_vaxti) res.locals.auditEvent = "REPORT_RESTORE";
  backupReports(res);
  res.json({ ok: true });
});
function formatActionDate(value: string): string {
  const raw = String(value || "").trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return `${m[3]}.${m[2]}.${m[1].slice(-2)} ${m[4]}:${m[5]}`;
  return raw.replace("T", " ");
}

app.post("/api/reports/:id/restore", requireAuth, requirePerm("edit_reports"), (req, res) => {
  const existing = db.prepare("SELECT * FROM reports WHERE id=?").get(req.params.id) as Report | undefined;
  if (!existing) return res.status(404).json({ error: "Qeyd tapılmadı" });
  const u = (res.locals as { user: User }).user;
  if (!isShiftEngineer(u)) {
    return res.status(403).json({ error: "Bu bərpa prosesi Növbə mühəndisi üçün nəzərdə tutulub" });
  }
  if (!reportCanEdit(u, existing)) {
    return res.status(403).json({ error: "Yalnız öz açıq qeydlərinizi bərpa edə bilərsiniz" });
  }
  const body = req.body as Record<string, unknown>;
  const r = pickReport(body);
  r.cavabdeh = normalizePersonText(u.full_name, true);
  const description = String(body.recovery_description ?? "").trim();
  if (!r.xidmet || !r.sistem || !r.nasazliq || !r.nasazliq_vaxti) {
    return res.status(400).json({ error: "Xidmət, sistem, nasazlıq və nasazlıq vaxtı mütləqdir" });
  }
  if (!r.berpa_vaxti) return res.status(400).json({ error: "Bərpa tarixi və saatını seçin" });
  if (!description) return res.status(400).json({ error: "Bərpa üçün görülən tədbiri yazın" });

  const stamp = formatActionDate(r.berpa_vaxti);
  const added = `[${stamp}] ${description}`;
  const newTedbir = [r.tedbir, added].filter(Boolean).join("\n");

  db.prepare(
    `UPDATE reports SET xidmet=?, obyekt=?, sistem=?, nasazliq=?, nasazliq_vaxti=?, sebeb=?, tedbir=?,
      berpa_vaxti=?, muraciet=?, cavabdeh=?, prioritet=?, restored_by_update=1,
      restored_at=datetime('now','localtime'), restored_by_user_id=?, updated_at=datetime('now','localtime')
     WHERE id=?`
  ).run(
    r.xidmet, r.obyekt, r.sistem, r.nasazliq, r.nasazliq_vaxti, r.sebeb, newTedbir,
    r.berpa_vaxti, r.muraciet, r.cavabdeh, r.prioritet, u.id, existing.id
  );
  backupReports(res);
  res.json({ ok: true });
});

app.delete("/api/reports", requireAuth, requirePerm("delete_reports"), (_req, res) => {
  const u = (res.locals as { user: User }).user;
  if (isShiftEngineer(u)) return res.status(403).json({ error: "Növbə mühəndisi qeydləri silə bilməz" });
  const info = db.prepare("DELETE FROM reports").run();
  backupReports(res);
  res.json({ ok: true, deleted: info.changes });
});
app.delete("/api/reports/:id", requireAuth, requirePerm("delete_reports"), (req, res) => {
  const u = (res.locals as { user: User }).user;
  if (isShiftEngineer(u)) return res.status(403).json({ error: "Növbə mühəndisi qeydləri silə bilməz" });
  const existing = db.prepare("SELECT * FROM reports WHERE id=?").get(req.params.id) as Report | undefined;
  if (!existing) return res.status(404).json({ error: "Qeyd tapılmadı" });
  if (!reportCanDelete(u, existing)) return res.status(403).json({ error: "İcazə yoxdur" });
  db.prepare("DELETE FROM reports WHERE id=?").run(req.params.id);
  backupReports(res);
  res.json({ ok: true });
});

// ---------- Excel helpers ----------
const OBJECTS = ["Bakı", "Zabrat", "Yevlax", "Lənkəran", "Qəbələ", "Zaqatala", "Gəncə", "Füzuli", "Zəngilan", "Laçın", "Naxçıvan"];
const SERVICES = ["HHAİS", "CES", "SUV(RLS)", "Rabitə", "Enerji", "Digər"];
function fold(v: string): string {
  // Normalize Unicode first. In JavaScript, capital Azerbaijani İ lowercases
  // to "i" + COMBINING DOT ABOVE, which previously turned "İmtina"
  // into "i mtina" and prevented the historical Excel headers from matching.
  return (v || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ə/g, "e")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function normalizeObject(v: string): string {
  const s = fold(v);
  const tests: [RegExp, string][] = [
    [/\bbaki\b|\bbak\b/, "Bakı"],
    [/\bzabrat\b/, "Zabrat"],
    [/\byevlax\b/, "Yevlax"],
    [/\blenkeran\b|\blankaran\b/, "Lənkəran"],
    [/\bqebele\b|\bqabala\b/, "Qəbələ"],
    [/\bzaqatala\b/, "Zaqatala"],
    [/\bgence\b|\bganja\b/, "Gəncə"],
    [/\bfuzuli\b/, "Füzuli"],
    [/\bzengilan\b/, "Zəngilan"],
    [/\blacin\b/, "Laçın"],
    [/\bnaxcivan\b/, "Naxçıvan"],
  ];
  for (const [re, out] of tests) if (re.test(s)) return out;
  return v.trim();
}
function normalizeService(v: string): string {
  const s = fold(v);
  if (/hh\s*ais|hhais/.test(s)) return "HHAİS";
  if (/^nav$|^ces$|^ils$/.test(s)) return "CES";
  if (/^sur$|^suv$|radar|rls|mlat/.test(s)) return "SUV(RLS)";
  if (/^com$|rabite|communication/.test(s)) return "Rabitə";
  if (/^eas$|elektrik|enerji/.test(s)) return "Enerji";
  if (SERVICES.map(fold).includes(s)) return SERVICES[SERVICES.map(fold).indexOf(s)];
  return "Digər";
}
function pad(n: number) { return String(n).padStart(2, "0"); }
function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function parseDateText(value: string): string {
  let s = (value || "").replace(/\r/g, " ").replace(/\n/g, " ").replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";

  // ISO / database format.
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2})[:.,](\d{2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}T${pad(+m[4])}:${m[5]}`;

  // Time first, then date: 12:34 03.11.2025
  m = s.match(/(\d{1,2})[:.,](\d{2})(?::\d{2})?.*?(\d{1,2})[.\/,-](\d{1,2})[.\/,-](\d{2,4})/);
  if (m) {
    let y = +m[5]; if (y < 100) y += 2000;
    return `${y}-${pad(+m[4])}-${pad(+m[3])}T${pad(+m[1])}:${m[2]}`;
  }

  // Date first, then optional time. Supports dots, commas, slash, dash and times like 20.01.
  m = s.match(/(\d{1,2})[.\/,-](\d{1,2})[.\/,-](\d{2,4})(?:\D+?(\d{1,2})[:.,](\d{2}))?/);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    return `${y}-${pad(+m[2])}-${pad(+m[1])}T${pad(+(m[4] || 0))}:${pad(+(m[5] || 0))}`;
  }
  return s;
}

// Keep historical/imported records in the same database format as records entered from the UI.
// This is idempotent and runs safely on every server start.
function normalizeStoredReportDates(): void {
  const rows = db.prepare("SELECT id,nasazliq_vaxti,berpa_vaxti FROM reports").all() as {id:number;nasazliq_vaxti:string;berpa_vaxti:string}[];
  const update = db.prepare("UPDATE reports SET nasazliq_vaxti=?, berpa_vaxti=? WHERE id=?");
  const tx = db.transaction(() => {
    for (const row of rows) {
      const n = parseDateText(row.nasazliq_vaxti);
      const b = parseDateText(row.berpa_vaxti);
      if (n !== row.nasazliq_vaxti || b !== row.berpa_vaxti) update.run(n, b, row.id);
    }
  });
  tx();
}
normalizeStoredReportDates();

// Bring already-imported historical names to the same display format.
// Safe to run on every startup; repeated runs do not keep changing values.
function normalizeStoredReportPeople(): void {
  const rows = db.prepare("SELECT id,muraciet,cavabdeh FROM reports").all() as {id:number;muraciet:string;cavabdeh:string}[];
  const update = db.prepare("UPDATE reports SET muraciet=?, cavabdeh=? WHERE id=?");
  const tx = db.transaction(() => {
    for (const row of rows) {
      const m = normalizePersonText(row.muraciet, false);
      const c = normalizePersonText(row.cavabdeh, true);
      if (m !== row.muraciet || c !== row.cavabdeh) update.run(m, c, row.id);
    }
  });
  tx();
}
normalizeStoredReportPeople();

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return "";
  if (v instanceof Date) return formatDate(v);
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((x) => x.text).join("").trim();
    if (o.text) return o.text.trim();
    if (o.result != null) return String(o.result).trim();
    return "";
  }
  return String(v).trim();
}
function headerKey(v: string): string { return fold(v).replace(/\s+/g, " "); }

// ---------- Excel export ----------
app.get("/api/export", requireAuth, requirePerm("export_import"), asyncRoute(async (_req, res) => {
  const rows = db
    .prepare(`SELECT r.*,u.full_name AS author FROM reports r JOIN users u ON u.id=r.user_id ORDER BY r.id`)
    .all() as (Report & { author: string })[];
  const wb = new ExcelJS.Workbook();
  wb.creator = "CNS Digital";
  wb.title = "CNS Digital — Jurnal";
  const ws = wb.addWorksheet("CNS Nasazlıq");
  ws.columns = [
    { header: "S/S", key: "n", width: 7 },
    { header: "Xidmət (Aeroport)", key: "obyekt", width: 16 },
    { header: "Qovşaq", key: "xidmet", width: 14 },
    { header: "Sistem, avadanlıq", key: "sistem", width: 24 },
    { header: "Nasazlıq, İmtina, sıradan çıxma və s.", key: "nasazliq", width: 42 },
    { header: "Nasazlığın tarixi və saat", key: "nasazliq_vaxti", width: 20 },
    { header: "Səbəbi", key: "sebeb", width: 38 },
    { header: "Tədbir", key: "tedbir", width: 38 },
    { header: "Tədbirin tarixi və saat", key: "berpa_vaxti", width: 20 },
    { header: "Müraciət edilən şəxs", key: "muraciet", width: 22 },
    { header: "Cavabdeh", key: "cavabdeh", width: 18 },
    { header: "Vaciblik", key: "prioritet", width: 12 },
    { header: "Daxil etdi", key: "author", width: 20 },
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach((r, i) => ws.addRow({ ...r, n: i + 1, prioritet: PRIORITY_LABELS[r.prioritet] ?? r.prioritet }));
  ws.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
    row.eachCell((cell) => {
      cell.border = { top: { style: "thin" }, bottom: { style: "thin" }, left: { style: "thin" }, right: { style: "thin" } };
    });
  });
  const fileName = `CNS_nasazliqlar_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  await wb.xlsx.write(res);
  res.end();
}));

// Import accepts both the supplied historical Excel layout and exports from this app.
// Existing records are NOT deleted; duplicates are skipped.
app.post(
  "/api/import",
  requireAuth,
  requirePerm("export_import"),
  express.raw({ type: () => true, limit: "50mb" }),
  asyncRoute(async (req, res) => {
    const u = (res.locals as { user: User }).user;
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: "Fayl boşdur" });
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buf as unknown as ExcelJS.Buffer); }
    catch { return res.status(400).json({ error: "Excel faylını oxumaq mümkün olmadı" }); }
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ error: "Excel-də vərəq tapılmadı" });

    const headers = new Map<string, number>();
    ws.getRow(1).eachCell((cell, col) => headers.set(headerKey(cellText(cell)), col));
    const findCol = (...tokens: string[]): number => {
      // Token priority matters: e.g. Qovşaq must win over generic Xidmət.
      for (const t of tokens) {
        const key = headerKey(t);
        for (const [h, c] of headers) if (h.includes(key)) return c;
      }
      return 0;
    };
    const cObyekt = findCol("xidmet aeroport", "obyekt yer", "obyekt");
    const cXidmet = findCol("qovsaq", "xidmet");
    const cSistem = findCol("sistem avadanliq");
    const cNasazliq = findCol("nasazliq imtina", "nasazliq barede");
    const cNasVaxt = findCol("nasazligin tarixi", "nasazliq tarixi");
    const cSebeb = findCol("sebebi", "sebeb");
    const cTedbir = findCol("tedbir");
    const cBerpa = findCol("tedbirin tarixi", "berpa tarixi");
    const cMuraciet = findCol("muraciet edilen");
    const cCavabdeh = findCol("cavabdeh");
    const cPrioritet = findCol("vaciblik");
    const cAuthor = findCol("daxil etdi");
    if (!cXidmet || !cSistem || !cNasazliq || !cNasVaxt) {
      return res.status(400).json({ error: "Excel sütunları tanınmadı. Başlıqların 1-ci sətirdə olduğuna əmin olun." });
    }

    const users = db.prepare("SELECT id,full_name FROM users WHERE COALESCE(deleted,0)=0").all() as { id: number; full_name: string }[];
    const nameToId = new Map(users.map((x) => [fold(x.full_name), x.id]));
    const exists = db.prepare(`SELECT id FROM reports WHERE xidmet=? AND obyekt=? AND sistem=? AND nasazliq=? AND nasazliq_vaxti=? LIMIT 1`);
    const insert = db.prepare(
      `INSERT INTO reports (user_id,${REPORT_FIELDS.join(",")}) VALUES (?,${REPORT_FIELDS.map(() => "?").join(",")})`
    );

    let imported = 0, skipped = 0, invalid = 0;
    const tx = db.transaction(() => {
      ws.eachRow((row, rowNo) => {
        if (rowNo === 1) return;
        const get = (c: number) => c ? cellText(row.getCell(c)) : "";
        const xidmet = normalizeService(get(cXidmet));
        const obyekt = normalizeObject(get(cObyekt));
        const sistem = get(cSistem).trim();
        const nasazliq = get(cNasazliq).trim();
        const nasazliq_vaxti = parseDateText(get(cNasVaxt));
        if (!sistem && !nasazliq && !nasazliq_vaxti) return;
        if (!xidmet || !sistem || !nasazliq || !nasazliq_vaxti) { invalid++; return; }
        const fields: Record<string, string> = {
          xidmet,
          obyekt,
          sistem,
          nasazliq,
          nasazliq_vaxti,
          sebeb: get(cSebeb),
          tedbir: get(cTedbir),
          berpa_vaxti: parseDateText(get(cBerpa)),
          muraciet: normalizePersonText(get(cMuraciet), false),
          cavabdeh: normalizePersonText(get(cCavabdeh), true),
          prioritet: normalizePriority(get(cPrioritet)),
        };
        if (exists.get(xidmet, obyekt, sistem, nasazliq, nasazliq_vaxti)) { skipped++; return; }
        const authorId = nameToId.get(fold(get(cAuthor))) ?? u.id;
        insert.run(authorId, ...REPORT_FIELDS.map((f) => fields[f] ?? ""));
        imported++;
      });
    });
    tx();
    backupReports(res);
    const linked_reports = reconcileAllHistoricalOwnership();
    res.json({ imported, skipped, invalid, linked_reports, objects: OBJECTS, services: SERVICES });
  })
);

// ---------- Users ----------
function countActiveAdmins(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users WHERE active=1 AND COALESCE(deleted,0)=0 AND role='admin'").get() as { n: number }).n;
}
app.get("/api/users", requireAuth, requirePerm("manage_users"), (_req, res) => {
  const rows = db.prepare(`
    SELECT u.id,u.username,u.full_name,u.role,u.active,u.created_at,COALESCE(r.label,u.role) AS role_label
    FROM users u LEFT JOIN roles r ON r.name=u.role WHERE COALESCE(u.deleted,0)=0 ORDER BY u.id
  `).all();
  res.json(rows);
});
app.post("/api/users", requireAuth, requirePerm("manage_users"), (req, res) => {
  const actor = (res.locals as { user: User }).user;
  const { username, password, full_name, role } = req.body as Record<string, string>;
  if (!username || !password || !full_name || password.length < 6) {
    return res.status(400).json({ error: "Login, ad-soyad və ən azı 6 simvolluq parol daxil edin" });
  }
  if (!role || !getRole(role)) return res.status(400).json({ error: "Belə rol mövcud deyil" });
  if (!can(actor, "manage_roles") && ["admin", "observer"].includes(role)) {
    return res.status(403).json({ error: "Bu rolu təyin etmək icazəniz yoxdur" });
  }
  try {
    const info = db.prepare("INSERT INTO users (username,password_hash,full_name,role) VALUES (?,?,?,?)")
      .run(username.trim().toLowerCase(), bcrypt.hashSync(password, 10), full_name.trim(), role);
    const newId = Number(info.lastInsertRowid);
    const createdUser = db.prepare("SELECT * FROM users WHERE id=?").get(newId) as User;
    const linked_reports = isShiftEngineer(createdUser) ? reconcileHistoricalOwnershipForUser(newId) : 0;
    res.json({ id: info.lastInsertRowid, linked_reports });
  } catch {
    res.status(400).json({ error: "Bu login artıq mövcuddur" });
  }
});
app.put("/api/users/:id", requireAuth, requirePerm("manage_users"), (req, res) => {
  const actor = (res.locals as { user: User }).user;
  const target = db.prepare("SELECT * FROM users WHERE id=? AND COALESCE(deleted,0)=0").get(req.params.id) as User | undefined;
  if (!target) return res.status(404).json({ error: "İstifadəçi tapılmadı" });
  const { active, full_name, username, role } = req.body as { active?: boolean; full_name?: string; username?: string; role?: string };
  if (role !== undefined) {
    if (!can(actor, "manage_roles")) return res.status(403).json({ error: "Rol dəyişmək yalnız Admin üçündür" });
    if (!getRole(role)) return res.status(400).json({ error: "Belə rol mövcud deyil" });
    if (target.id === actor.id) return res.status(400).json({ error: "Öz rolunuzu dəyişə bilməzsiniz" });
    if (target.role === "admin" && role !== "admin" && countActiveAdmins() <= 1) {
      return res.status(400).json({ error: "Son Admin rolunu dəyişmək olmaz" });
    }
    db.prepare("UPDATE users SET role=? WHERE id=?").run(role, target.id);
  }
  if (typeof active === "boolean") {
    if (target.id === actor.id && !active) return res.status(400).json({ error: "Öz hesabınızı deaktiv edə bilməzsiniz" });
    if (target.role === "admin" && !active && countActiveAdmins() <= 1) {
      return res.status(400).json({ error: "Son Admin hesabını deaktiv etmək olmaz" });
    }
    if (target.role === "admin" && !can(actor, "manage_roles")) {
      return res.status(403).json({ error: "Admin hesabını dəyişmək icazəniz yoxdur" });
    }
    db.prepare("UPDATE users SET active=? WHERE id=?").run(active ? 1 : 0, target.id);
  }
  if (full_name !== undefined) {
    const cleanName = full_name.trim();
    if (!cleanName) return res.status(400).json({ error: "Ad, soyad boş ola bilməz" });
    db.prepare("UPDATE users SET full_name=? WHERE id=?").run(cleanName, target.id);
  }
  if (username !== undefined) {
    const cleanUsername = username.trim().toLowerCase();
    if (!cleanUsername) return res.status(400).json({ error: "Login boş ola bilməz" });
    try {
      db.prepare("UPDATE users SET username=? WHERE id=?").run(cleanUsername, target.id);
    } catch {
      return res.status(400).json({ error: "Bu login artıq mövcuddur" });
    }
  }
  const refreshed = db.prepare("SELECT * FROM users WHERE id=?").get(target.id) as User | undefined;
  const linked_reports = refreshed && isShiftEngineer(refreshed) ? reconcileHistoricalOwnershipForUser(target.id) : 0;
  res.json({ ok: true, linked_reports });
});
app.post("/api/users/:id/password", requireAuth, requirePerm("reset_password"), (req, res) => {
  const target = db.prepare("SELECT id FROM users WHERE id=? AND COALESCE(deleted,0)=0").get(req.params.id);
  if (!target) return res.status(404).json({ error: "İstifadəçi tapılmadı" });
  const { password } = req.body as { password?: string };
  if (!password || password.length < 6) return res.status(400).json({ error: "Parol ən azı 6 simvol olmalıdır" });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});
app.delete("/api/users/:id", requireAuth, requirePerm("manage_users"), (req, res) => {
  const actor = (res.locals as { user: User }).user;
  const target = db.prepare("SELECT * FROM users WHERE id=? AND COALESCE(deleted,0)=0").get(req.params.id) as User | undefined;
  if (!target) return res.status(404).json({ error: "İstifadəçi tapılmadı" });
  if (target.id === actor.id) return res.status(400).json({ error: "Öz hesabınızı silə bilməzsiniz" });
  if (target.role === "admin") {
    if (!can(actor, "manage_roles")) return res.status(403).json({ error: "Admin hesabını silmək icazəniz yoxdur" });
    if (countActiveAdmins() <= 1) return res.status(400).json({ error: "Son Admin hesabını silmək olmaz" });
  }

  // Soft-delete the account instead of deleting the database row. Historical journal
  // records keep their author/owner links, while the account disappears from the UI
  // and can no longer sign in. The old login is released for future reuse.
  const archivedUsername = `__deleted_${target.id}_${Date.now()}_${target.username}`;
  db.prepare("UPDATE users SET active=0, deleted=1, username=? WHERE id=?")
    .run(archivedUsername, target.id);
  res.json({ ok: true });
});

// ---------- Roles ----------
app.get("/api/roles", requireAuth, requirePerm("manage_users"), (_req, res) => {
  const rows = db.prepare(`SELECT r.*,(SELECT COUNT(*) FROM users u WHERE u.role=r.name AND COALESCE(u.deleted,0)=0) AS user_count FROM roles r ORDER BY r.id`).all();
  res.json(rows);
});

const EDITABLE_ROLE_PERMS: PermField[] = [
  ...CHECKLIST_PERMISSIONS,
  "view_all_reports",
  "create_reports",
  "edit_reports",
  "delete_reports",
  "export_import",
  "manage_users",
  "shift_engineer_access",
];

function normalizeRolePermissions(input: unknown) {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of EDITABLE_ROLE_PERMS) out[key] = source[key] === true ? 1 : 0;
  return out;
}

app.post("/api/roles", requireAuth, requirePerm("manage_roles"), (req, res) => {
  const body = req.body as { label?: string; permissions?: Record<string, boolean> };
  const label = String(body.label || "").trim();
  if (label.length < 2) return res.status(400).json({ error: "Rolun adını daxil edin" });
  if (label.length > 60) return res.status(400).json({ error: "Rolun adı çox uzundur" });
  const exists = db.prepare("SELECT id FROM roles WHERE lower(label)=lower(?)").get(label);
  if (exists) return res.status(409).json({ error: "Bu adda rol artıq mövcuddur" });
  const perms = normalizeRolePermissions(body.permissions);
  const name = `custom_${Date.now().toString(36)}`;
  db.prepare(`INSERT INTO roles (name,label,${EDITABLE_ROLE_PERMS.join(",")})
    VALUES (?, ?, ${EDITABLE_ROLE_PERMS.map(() => "?").join(",")})`)
    .run(name, label, ...EDITABLE_ROLE_PERMS.map(key => perms[key]));
  res.status(201).json(getRole(name));
});

app.put("/api/roles/:name", requireAuth, requirePerm("manage_roles"), (req, res) => {
  const name = String(req.params.name || "");
  const role = getRole(name);
  if (!role) return res.status(404).json({ error: "Rol tapılmadı" });
  if (name === "admin") return res.status(400).json({ error: "Admin rolu qorunur" });
  const body = req.body as { label?: string; permissions?: Record<string, boolean> };
  const label = String(body.label || role.label).trim();
  if (label.length < 2 || label.length > 60) return res.status(400).json({ error: "Rolun adı düzgün deyil" });
  const duplicate = db.prepare("SELECT id FROM roles WHERE lower(label)=lower(?) AND name<>?").get(label,name);
  if (duplicate) return res.status(409).json({ error: "Bu adda rol artıq mövcuddur" });
  const perms = normalizeRolePermissions(body.permissions);
  // Older clients do not send checklist fields: do not clear newly configured rights.
  for (const key of CHECKLIST_PERMISSIONS) {
    if (body.permissions?.[key] === undefined) perms[key] = role[key];
  }
  db.prepare(`UPDATE roles SET label=?,${EDITABLE_ROLE_PERMS.map(key => `${key}=?`).join(",")} WHERE name=?`)
    .run(label, ...EDITABLE_ROLE_PERMS.map(key => perms[key]), name);
  res.json(getRole(name));
});

app.put("/api/roles/:name/permissions-batch", requireAuth, requirePerm("manage_roles"), (req, res) => {
  const name = String(req.params.name || "");
  const role = getRole(name);
  if (!role) return res.status(404).json({ error: "Rol tapılmadı" });
  if (name === "admin") return res.status(400).json({ error: "Admin icazələri qorunur" });
  const incoming = ((req.body as { permissions?: Record<string, boolean> })?.permissions || {});
  const updates: string[] = []; const values: number[] = [];
  for (const key of EDITABLE_ROLE_PERMS) {
    if (typeof incoming[key] === "boolean") { updates.push(`${key}=?`); values.push(incoming[key] ? 1 : 0); }
  }
  if (!updates.length) return res.status(400).json({ error: "Dəyişiklik yoxdur" });
  db.prepare(`UPDATE roles SET ${updates.join(",")} WHERE name=?`).run(...values,name);
  res.json(getRole(name));
});

// Admin can tune operational permissions for every non-admin role from the Roles screen.
// Password reset and role-management permissions stay Admin-only by design.
app.put("/api/roles/:name/permissions", requireAuth, requirePerm("manage_roles"), (req, res) => {
  const name = String(req.params.name || "");
  const role = getRole(name);
  if (!role) return res.status(404).json({ error: "Rol tapılmadı" });
  if (name === "admin") return res.status(400).json({ error: "Admin icazələri qorunur və dəyişdirilə bilməz" });

  const { permission, enabled } = req.body as { permission?: PermField; enabled?: boolean };
  if (!permission || !EDITABLE_ROLE_PERMS.includes(permission)) {
    return res.status(400).json({ error: "Bu icazəni dəyişmək olmaz" });
  }
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "Yanlış icazə dəyəri" });

  db.prepare(`UPDATE roles SET ${permission}=? WHERE name=?`).run(enabled ? 1 : 0, name);
  const updated = getRole(name);
  res.json(updated);
});

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
