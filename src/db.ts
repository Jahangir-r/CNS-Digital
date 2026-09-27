import { openJournalDatabase } from "./core/database/connection.js";
import type { Role } from "./core/database/domain-types.js";

export type { User, Role, Report } from "./core/database/domain-types.js";

export const db = openJournalDatabase();

export function getRole(name: string): Role | undefined {
  return db.prepare("SELECT * FROM roles WHERE name=?").get(name) as Role | undefined;
}
