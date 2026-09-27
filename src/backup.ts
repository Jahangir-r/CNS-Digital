import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import ExcelJS from "exceljs";
import type { AuditEvent } from "./audit.js";
import { localDate, localTimestamp } from "./local-time.js";

type Actor = Pick<AuditEvent, "user" | "name" | "ip">;

export class BackupManager {
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private excelDay = "";

  constructor(
    private db: Database.Database,
    private directory: string,
    private audit: (event: AuditEvent) => void,
    private now: () => Date = () => new Date(),
  ) {}

  private log(event: AuditEvent): void {
    try { this.audit(event); } catch { /* auditing must never break backup */ }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch(() => {
      this.log({ event: "BACKUP", result: "ERROR", description: "Backup task failed" });
    });
    return this.queue;
  }

  // Called only after a database mutation has committed; callers never await disk I/O.
  requestExcel(actor: Actor = {}): void {
    void this.enqueue(() => this.excel(actor));
  }

  private async excel(actor: Actor): Promise<void> {
    const date = this.now();
    const day = localDate(date);
    const file = `CNS-Digital-Journal-${day}.xlsx`;
    const folder = path.join(this.directory, "Excel");
    const temporary = path.join(folder, `.${file}.${randomUUID()}.tmp`);
    try {
      // One synchronous SELECT gives this workbook a consistent journal snapshot.
      const rows = this.db.prepare(`SELECT r.*, u.full_name AS author
        FROM reports r LEFT JOIN users u ON u.id=r.user_id ORDER BY r.id`).all() as Record<string, unknown>[];
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "CNS Digital";
      workbook.title = "CNS Digital — Jurnal backup";
      const sheet = workbook.addWorksheet("CNS Nasazlıq");
      const columns = [
        ["id", "ID"], ["obyekt", "Xidmət (Aeroport)"], ["xidmet", "Qovşaq"],
        ["sistem", "Sistem, avadanlıq"], ["nasazliq", "Nasazlıq, İmtina, sıradan çıxma və s."],
        ["nasazliq_vaxti", "Nasazlığın tarixi və saat"], ["sebeb", "Səbəbi"],
        ["tedbir", "Tədbir"], ["berpa_vaxti", "Tədbirin tarixi və saat"],
        ["muraciet", "Müraciət edilən şəxs"], ["cavabdeh", "Cavabdeh"],
        ["prioritet", "Vaciblik"], ["author", "Daxil etdi"],
        ["user_id", "Author ID"], ["owner_user_id", "Owner ID"],
        ["created_at", "Created at"], ["updated_at", "Updated at"],
        ["restored_by_update", "Restored by update"], ["restored_at", "Restored at"],
        ["restored_by_user_id", "Restored by user ID"],
      ];
      sheet.columns = columns.map(([key, header]) => ({ key, header, width: 24 }));
      const priorities: Record<string, string> = { asagi: "Aşağı", orta: "Orta", yuksek: "Yüksək" };
      for (const row of rows) sheet.addRow({ ...row, prioritet: priorities[String(row.prioritet)] ?? row.prioritet });
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      sheet.eachRow(row => { row.alignment = { vertical: "top", wrapText: true }; });
      const metadata = workbook.addWorksheet("Backup info");
      metadata.columns = [{ width: 32 }, { width: 48 }];
      metadata.addRow(["Last backup snapshot (local time)", localTimestamp(date)]);
      metadata.addRow(["UTC offset (minutes)", -date.getTimezoneOffset()]);
      metadata.addRow(["Records", rows.length]);
      await fs.mkdir(folder, { recursive: true });
      await workbook.xlsx.writeFile(temporary);
      await fs.rename(temporary, path.join(folder, file));
      this.excelDay = day;
      this.log({ ...actor, event: "BACKUP", file, result: "SUCCESS", description: "Excel journal snapshot saved" });
    } catch {
      this.excelDay = "";
      this.log({ ...actor, event: "BACKUP", file, result: "ERROR", description: "Excel backup failed; database operation remains committed" });
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  private async database(): Promise<void> {
    const file = `jurnal-${localDate(this.now())}.db`;
    const folder = path.join(this.directory, "Database");
    const target = path.join(folder, file);
    const temporary = path.join(folder, `.${file}.${randomUUID()}.tmp`);
    try {
      await fs.mkdir(folder, { recursive: true });
      try { await fs.access(target); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // SQLite's online backup API includes committed WAL data. Never copy jurnal.db directly.
      await this.db.backup(temporary);
      await fs.rename(temporary, target);
      this.log({ event: "BACKUP", file, result: "SUCCESS", description: "SQLite online backup saved" });
    } catch {
      this.log({ event: "BACKUP", file, result: "ERROR", description: "SQLite backup failed; retry on next daily check" });
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }

  checkDaily(): Promise<void> {
    return this.enqueue(async () => {
      if (this.excelDay !== localDate(this.now())) await this.excel({});
      await this.database();
    });
  }

  start(): void {
    if (this.timer) return;
    void this.checkDaily();
    // Re-read local date, so DST, clock changes and waking from sleep are handled.
    this.timer = setInterval(() => { void this.checkDaily(); }, 30_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.queue;
  }

  async flush(): Promise<void> { await this.queue; }
}
