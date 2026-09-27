import type Database from "better-sqlite3";
import { CHECKLIST_PERMISSIONS, checklistDefaults, type ChecklistPermission } from "../../checklists/permissions.js";
import type { Role, User } from "../../core/database/domain-types.js";

export type PermField = ChecklistPermission | "manage_users" | "manage_roles" | "reset_password" |
  "view_all_reports" | "create_reports" | "edit_reports" | "delete_reports" | "export_import" | "shift_engineer_access";

export class PermissionService {
  constructor(private readonly db: Database.Database) {}

  role(name: string): Role {
    const stored = this.db.prepare("SELECT * FROM roles WHERE name=?").get(name) as Role|undefined;
    return stored ?? { id:0, name, label:name, manage_users:0, manage_roles:0, reset_password:0,
      view_all_reports:0, create_reports:0, edit_reports:0, delete_reports:0, export_import:0,
      shift_engineer_access:0, ...checklistDefaults(), built_in:0, created_at:"" };
  }

  allows(user: User, permission: PermField): boolean { return this.role(user.role)[permission] === 1; }
  shiftEngineer(user: User): boolean { return this.role(user.role).shift_engineer_access === 1; }

  payload(user: User) {
    const role = this.role(user.role);
    return { id:user.id, username:user.username, full_name:user.full_name, role:user.role, role_label:role.label,
      perms:{ manage_users:!!role.manage_users, manage_roles:!!role.manage_roles, reset_password:!!role.reset_password,
        view_all_reports:!!role.view_all_reports, create_reports:!!role.create_reports, edit_reports:!!role.edit_reports,
        delete_reports:!!role.delete_reports, export_import:!!role.export_import,
        shift_engineer_access:!!role.shift_engineer_access,
        ...Object.fromEntries(CHECKLIST_PERMISSIONS.map(key => [key, role[key] === 1])) } };
  }
}
