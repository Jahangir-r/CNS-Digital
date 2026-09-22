export const CHECKLIST_PERMISSIONS = [
  "view_checklists", "create_checklists", "edit_own_checklists", "manage_checklists",
  "manage_checklist_templates", "manage_checklist_shifts", "create_reports_from_checklist",
] as const;

export type ChecklistPermission = typeof CHECKLIST_PERMISSIONS[number];
export type ChecklistPermissions = Record<ChecklistPermission, number>;

export function checklistDefaults(role = ""): ChecklistPermissions {
  return Object.fromEntries(CHECKLIST_PERMISSIONS.map(permission => [permission,
    role === "admin" ||
    (permission === "view_checklists" && ["employee", "shift_engineer", "observer", "technician", "engineer"].includes(role)) ||
    (["technician", "engineer"].includes(role) && ["create_checklists", "edit_own_checklists", "create_reports_from_checklist"].includes(permission)) ? 1 : 0,
  ])) as ChecklistPermissions;
}
