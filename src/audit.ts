import fs from "node:fs/promises";
import path from "node:path";
import { localDate, localTimestamp } from "./local-time.js";

export interface AuditEvent {
  event: string;
  module?: "CHECKLIST";
  result: "SUCCESS" | "ERROR";
  user?: string;
  name?: string;
  ip?: string;
  description?: string;
  report_id?: string | number;
  user_id?: string | number;
  role_id?: string | number;
  filename?: string;
  date?: string;
  duration_ms?: number;
  error_code?: string;
  operation_id?: string;
  section_id?: string;
  item_id?: string;
  checklist_id?: string;
  schedule_version_id?: string;
  shift?: string;
  work_date?: string;
  template_id?: string;
  template_version_id?: string;
  template_version?: string;
  revision?: number;
  changed_fields?: string;
  file?: string;
  status?: number;
}

// Explicit allowlist: never serialize request bodies, user objects, or Error objects.
const fields = ["module", "user", "name", "ip", "description", "report_id", "user_id", "role_id",
  "filename", "date", "duration_ms", "error_code", "operation_id", "section_id", "item_id", "checklist_id", "schedule_version_id", "shift", "work_date", "template_id", "template_version_id", "template_version", "revision", "changed_fields", "file", "status"] as const;
const quote = (value: string | number) => JSON.stringify(String(value).slice(0, 500));

export class AuditLog {
  private queue: Promise<void> = Promise.resolve();
  private cleanedDay = "";

  constructor(private directory: string, private now: () => Date = () => new Date()) {}

  write(entry: AuditEvent): void {
    try {
      const date = this.now();
      const day = localDate(date);
      const event = entry.event.replace(/[^A-Z0-9_]/g, "_").slice(0, 80);
      const data = { ...entry, user: entry.user ?? "system", name: entry.name ?? "", ip: entry.ip ?? "-" };
      const line = `[${localTimestamp(date)}] [${event}] ${fields
        .filter(key => data[key] !== undefined)
        .map(key => `${key}=${quote(data[key]!)}`).join(" ")} result=${entry.result === "SUCCESS" ? "SUCCESS" : "ERROR"}\n`;
      this.queue = this.queue.then(async () => {
        await fs.mkdir(this.directory, { recursive: true });
        await fs.appendFile(path.join(this.directory, `CNS-Jurnal-${day}.log`), line, { mode: 0o600 });
        if (this.cleanedDay !== day) {
          await this.cleanup(date);
          this.cleanedDay = day;
        }
      }).catch(() => this.fallback());
    } catch {
      this.fallback();
    }
  }

  // Only our daily log files are eligible; backups and unrelated files are untouched.
  private async cleanup(date: Date): Promise<void> {
    const cutoff = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 45);
    const oldest = localDate(cutoff);
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      const match = /^CNS-Jurnal-(\d{4}-\d{2}-\d{2})\.log$/.exec(entry.name);
      if (entry.isFile() && match && match[1] < oldest) {
        await fs.unlink(path.join(this.directory, entry.name));
      }
    }
  }

  private fallback(): void {
    try { console.error("[AUDIT_ERROR] Unable to write or maintain audit log"); } catch { /* non-fatal */ }
  }

  async flush(): Promise<void> { await this.queue; }
}
