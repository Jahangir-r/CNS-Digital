import express from "express";
import ExcelJS from "exceljs";
import type Database from "better-sqlite3";
import type { User, Report } from "../../core/database/domain-types.js";
import type { AuthService } from "../../auth.js";
import { createReportService, ReportServiceError } from "../../reports/service.js";
import { REPORT_FIELDS, PRIORITY_LABELS, normalizePriority, normalizePersonText, extractPersonIdentity, personMatches } from "../../reports/normalization.js";

export function createJournalRouter(
  db: Database.Database,
  auth: AuthService,
  backupReports: (res: express.Response) => void,
) {
  const router = express.Router();
  const { can, isShiftEngineer, requireAuth, requirePerm } = auth;
  const reports = createReportService(db, auth);
  const asyncRoute = (handler: express.RequestHandler): express.RequestHandler =>
    (req, res, next) => { Promise.resolve().then(() => handler(req, res, next)).catch(next); };

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

const actor=(res:express.Response)=>(res.locals as {user:User}).user;
const respond=(res:express.Response,work:()=>unknown,after?:()=>void)=>{
  try{const result=work();after?.();res.json(result??{ok:true});}
  catch(error){if(error instanceof ReportServiceError)return res.status(error.status).json({error:error.message});throw error;}
};

router.get("/reports", requireAuth, (_req, res) => {
  const u = (res.locals as { user: User }).user;
  if (isShiftEngineer(u)) reconcileHistoricalOwnershipForUser(u.id);
  res.json(reports.list(u));
});
router.post("/reports", requireAuth, requirePerm("create_reports"), (req, res) => {
  respond(res,()=>reports.createManual(actor(res),req.body as Record<string,unknown>),()=>backupReports(res));
});
router.put("/reports/:id", requireAuth, requirePerm("edit_reports"), (req, res) => {
  respond(res,()=>{const result=reports.update(actor(res),Number(req.params.id),req.body as Record<string,unknown>);if(result.restored)res.locals.auditEvent="REPORT_RESTORE";},()=>backupReports(res));
});
router.post("/reports/:id/restore", requireAuth, requirePerm("edit_reports"), (req, res) => {
  respond(res,()=>reports.restore(actor(res),Number(req.params.id),req.body as Record<string,unknown>),()=>backupReports(res));
});

router.delete("/reports", requireAuth, requirePerm("delete_reports"), (_req, res) => {
  respond(res,()=>({ok:true,deleted:reports.deleteAll(actor(res))}),()=>backupReports(res));
});
router.delete("/reports/:id", requireAuth, requirePerm("delete_reports"), (req, res) => {
  respond(res,()=>{reports.deleteOne(actor(res),Number(req.params.id));},()=>backupReports(res));
});

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

router.get("/export", requireAuth, requirePerm("export_import"), asyncRoute(async (_req, res) => {
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

// Import accepts both the supplied historical Excel layout and exports from this router.
// Existing records are NOT deleted; duplicates are skipped.
router.post(
  "/import",
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


  return { router, reconcileHistoricalOwnershipForUser, reconcileAllHistoricalOwnership };
}
