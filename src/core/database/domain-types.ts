import type { ChecklistPermissions } from "../../checklists/permissions.js";

export interface User {
  id: number; username: string; password_hash: string; full_name: string;
  role: string; active: number; deleted: number; created_at: string;
}

export interface Role extends ChecklistPermissions {
  id: number; name: string; label: string; manage_users: number; manage_roles: number;
  reset_password: number; view_all_reports: number; create_reports: number; edit_reports: number;
  delete_reports: number; export_import: number; shift_engineer_access: number;
  built_in: number; created_at: string;
}

export interface Report {
  id: number; user_id: number; xidmet: string; obyekt: string; sistem: string;
  nasazliq: string; nasazliq_vaxti: string; sebeb: string; tedbir: string;
  berpa_vaxti: string; muraciet: string; cavabdeh: string; prioritet: string;
  created_at: string; updated_at: string; owner_user_id: number | null;
  restored_by_update: number; restored_at: string; restored_by_user_id: number | null;
}
