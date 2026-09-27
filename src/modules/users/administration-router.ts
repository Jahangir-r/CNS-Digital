import express from "express";
import bcrypt from "bcryptjs";
import type Database from "better-sqlite3";
import type { User, Role } from "../../core/database/domain-types.js";
import { CHECKLIST_PERMISSIONS } from "../../checklists/permissions.js";
import type { AuthService, PermField } from "../../auth.js";

export function createAdministrationRouter(
  db: Database.Database,
  auth: AuthService,
  linkHistoricalReports: (userId:number)=>number,
) {
  const router=express.Router();
  const {can,isShiftEngineer,requireAuth,requirePerm}=auth;
  const getRole=(name:string)=>db.prepare("SELECT * FROM roles WHERE name=?").get(name) as Role|undefined;

function countActiveAdmins(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users WHERE active=1 AND COALESCE(deleted,0)=0 AND role='admin'").get() as { n: number }).n;
}
router.get("/users", requireAuth, requirePerm("manage_users"), (_req, res) => {
  const rows = db.prepare(`
    SELECT u.id,u.username,u.full_name,u.role,u.active,u.created_at,COALESCE(r.label,u.role) AS role_label
    FROM users u LEFT JOIN roles r ON r.name=u.role WHERE COALESCE(u.deleted,0)=0 ORDER BY u.id
  `).all();
  res.json(rows);
});
router.post("/users", requireAuth, requirePerm("manage_users"), (req, res) => {
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
    const linked_reports = isShiftEngineer(createdUser) ? linkHistoricalReports(newId) : 0;
    res.json({ id: info.lastInsertRowid, linked_reports });
  } catch {
    res.status(400).json({ error: "Bu login artıq mövcuddur" });
  }
});
router.put("/users/:id", requireAuth, requirePerm("manage_users"), (req, res) => {
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
  const linked_reports = refreshed && isShiftEngineer(refreshed) ? linkHistoricalReports(target.id) : 0;
  res.json({ ok: true, linked_reports });
});
router.post("/users/:id/password", requireAuth, requirePerm("reset_password"), (req, res) => {
  const target = db.prepare("SELECT id FROM users WHERE id=? AND COALESCE(deleted,0)=0").get(req.params.id);
  if (!target) return res.status(404).json({ error: "İstifadəçi tapılmadı" });
  const { password } = req.body as { password?: string };
  if (!password || password.length < 6) return res.status(400).json({ error: "Parol ən azı 6 simvol olmalıdır" });
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});
router.delete("/users/:id", requireAuth, requirePerm("manage_users"), (req, res) => {
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

router.get("/roles", requireAuth, requirePerm("manage_users"), (_req, res) => {
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

router.post("/roles", requireAuth, requirePerm("manage_roles"), (req, res) => {
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

router.put("/roles/:name", requireAuth, requirePerm("manage_roles"), (req, res) => {
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

router.put("/roles/:name/permissions-batch", requireAuth, requirePerm("manage_roles"), (req, res) => {
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

// Password reset and role-management permissions stay Admin-only by design.
router.put("/roles/:name/permissions", requireAuth, requirePerm("manage_roles"), (req, res) => {
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


  return router;
}
