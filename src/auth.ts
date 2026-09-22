import express from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { User, Role } from "./db.js";
import { CHECKLIST_PERMISSIONS, checklistDefaults, type ChecklistPermission } from "./checklists/permissions.js";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

export type PermField =
  | ChecklistPermission
  | "manage_users"
  | "manage_roles"
  | "reset_password"
  | "view_all_reports"
  | "create_reports"
  | "edit_reports"
  | "delete_reports"
  | "export_import"
  | "shift_engineer_access";

// Explicit dependencies keep tests and future modules independent of the live database.
export function createAuthService(db: Database.Database, secret: string, now: () => number = Date.now) {
  function signAuthToken(userId: number): string {
    const exp = now() + 12 * 60 * 60 * 1000;
    const payload = `${userId}.${exp}`;
    const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
  }

  function verifyAuthToken(token: string | undefined): number | null {
    if (!token) return null;
    try {
      const raw = Buffer.from(token, "base64url").toString("utf8");
      const [idRaw, expRaw, sig] = raw.split(".");
      const userId = Number(idRaw);
      const exp = Number(expRaw);
      if (!Number.isInteger(userId) || !Number.isFinite(exp) || exp < now() || !sig) return null;
      const payload = `${userId}.${exp}`;
      const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      const a = Buffer.from(sig, "hex");
      const b = Buffer.from(expected, "hex");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      return userId;
    } catch {
      return null;
    }
  }

  function currentUser(req: express.Request): User | null {
    let userId = req.session.userId || null;

    if (!userId) {
      const headerToken =
        (req.get("x-cns-token") || "").trim() ||
        ((req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim());
      userId = verifyAuthToken(headerToken);
    }

    if (!userId) return null;
    return (
      (db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND COALESCE(deleted,0)=0").get(userId) as User | undefined) ??
      null
    );
  }

  function emptyRole(name = "unknown"): Role {
    return {
      id: 0,
      name,
      label: name,
      manage_users: 0,
      manage_roles: 0,
      reset_password: 0,
      view_all_reports: 0,
      create_reports: 0,
      edit_reports: 0,
      delete_reports: 0,
      export_import: 0,
      shift_engineer_access: 0,
      ...checklistDefaults(),
      built_in: 0,
      created_at: "",
    };
  }

  function permsOf(u: User): Role {
    return (db.prepare("SELECT * FROM roles WHERE name=?").get(u.role) as Role | undefined) ?? emptyRole(u.role);
  }
  function can(u: User, perm: PermField): boolean {
    return permsOf(u)[perm] === 1;
  }
  function isShiftEngineer(u: User): boolean {
    return permsOf(u).shift_engineer_access === 1;
  }
  function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const u = currentUser(req);
    if (!u) return res.status(401).json({ error: "Giriş tələb olunur" });
    (res.locals as { user: User }).user = u;
    res.locals.auditActor = { id: u.id, username: u.username, full_name: u.full_name };
    next();
  }
  function requirePerm(perm: PermField) {
    return (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      const u = (res.locals as { user: User }).user;
      if (!can(u, perm)) return res.status(403).json({ error: "İcazə yoxdur" });
      next();
    };
  }
  function userPayload(u: User) {
    const p = permsOf(u);
    return {
      id: u.id,
      username: u.username,
      full_name: u.full_name,
      role: u.role,
      role_label: p.label,
      perms: {
        manage_users: !!p.manage_users,
        manage_roles: !!p.manage_roles,
        reset_password: !!p.reset_password,
        view_all_reports: !!p.view_all_reports,
        create_reports: !!p.create_reports,
        edit_reports: !!p.edit_reports,
        delete_reports: !!p.delete_reports,
        export_import: !!p.export_import,
        shift_engineer_access: !!p.shift_engineer_access,
        ...Object.fromEntries(CHECKLIST_PERMISSIONS.map(key => [key, p[key] === 1])),
      },
    };
  }


  function routes(afterLogin: (user: User) => void = () => {}) {
    const router = express.Router();
    router.post("/login", (req, res, next) => {
      const { username, password } = req.body as { username?: string; password?: string };
      if (!username || !password) return res.status(400).json({ error: "Login və parol daxil edin" });
      const u = db
        .prepare("SELECT * FROM users WHERE username=? AND active=1 AND COALESCE(deleted,0)=0")
        .get(username.trim().toLowerCase()) as User | undefined;
      if (u) res.locals.auditActor = { id: u.id, username: u.username, full_name: u.full_name };
      if (!u || !bcrypt.compareSync(password, u.password_hash)) {
        return res.status(401).json({ error: "Yanlış login və ya parol" });
      }

      // Regenerate + explicitly save the session before responding.
      // This is more reliable on mobile Safari over a raw LAN IP.
      req.session.regenerate((regenErr) => {
        if (regenErr) return res.status(500).json({ error: "Sessiya yaradıla bilmədi" });

        req.session.userId = u.id;

        try { afterLogin(u); }
        catch (error) { return next(error); }

        req.session.save((saveErr) => {
          if (saveErr) return res.status(500).json({ error: "Sessiya yadda saxlanmadı" });
          try { res.json({ ...userPayload(u), auth_token: signAuthToken(u.id) }); }
          catch (error) { next(error); }
        });
      });
    });
    router.post("/logout", (req, res, next) => {
      const actor = currentUser(req);
      if (actor) res.locals.auditActor = { id: actor.id, username: actor.username, full_name: actor.full_name };
      req.session.destroy(error => error ? next(error) : res.json({ ok: true }));
    });
    router.get("/me", (req, res) => {
      const u = currentUser(req);
      if (!u) return res.status(401).json({ error: "Giriş tələb olunur" });
      res.json({ ...userPayload(u), auth_token: signAuthToken(u.id) });
    });

    // Every authenticated user can change their own password after confirming the current password.
    router.post("/change-password", requireAuth, (req, res) => {
      const u = (res.locals as { user: User }).user;
      const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string };
      if (!oldPassword || !newPassword || newPassword.length < 6) {
        return res.status(400).json({ error: "Yeni parol ən azı 6 simvol olmalıdır" });
      }
      if (!bcrypt.compareSync(oldPassword, u.password_hash)) {
        return res.status(400).json({ error: "Köhnə parol yanlışdır" });
      }
      db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync(newPassword, 10), u.id);
      res.json({ ok: true });
    });

    return router;
  }

  return { currentUser, can, isShiftEngineer, requireAuth, requirePerm, userPayload, signAuthToken, verifyAuthToken, routes };
}

export type AuthService = ReturnType<typeof createAuthService>;
