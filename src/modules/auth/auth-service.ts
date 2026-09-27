import type Database from "better-sqlite3";
import type express from "express";
import type { User } from "../../core/database/domain-types.js";
import { PermissionService, type PermField } from "../authorization/permission-service.js";
import { TokenService } from "./auth-token.js";

declare module "express-session" {
  interface SessionData { userId?: number; }
}

export class AuthService {
  readonly tokens: TokenService;
  readonly permissions: PermissionService;
  constructor(private readonly db: Database.Database, secret: string, now: () => number = Date.now) {
    this.tokens = new TokenService(secret, now);
    this.permissions = new PermissionService(db);
  }

  currentUser = (req: express.Request): User | null => {
    const header = (req.get("x-cns-token") || "").trim() || (req.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const id = req.session.userId || this.tokens.read(header);
    if (!id) return null;
    return this.db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND COALESCE(deleted,0)=0").get(id) as User|undefined ?? null;
  };
  can = (user: User, permission: PermField) => this.permissions.allows(user, permission);
  isShiftEngineer = (user: User) => this.permissions.shiftEngineer(user);
  userPayload = (user: User) => this.permissions.payload(user);
  signAuthToken = (userId: number) => this.tokens.issue(userId);
  verifyAuthToken = (token?: string) => this.tokens.read(token);
}
