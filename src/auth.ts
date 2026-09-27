import type Database from "better-sqlite3";
import { AuthService as CoreAuthService } from "./modules/auth/auth-service.js";
import { createAuthRouter } from "./modules/auth/auth-router.js";
import { authorizationMiddleware } from "./modules/authorization/authorization-middleware.js";
import type { User } from "./core/database/domain-types.js";

export type { PermField } from "./modules/authorization/permission-service.js";

export function createAuthService(db: Database.Database, secret: string, now: () => number = Date.now) {
  const core = new CoreAuthService(db, secret, now);
  const middleware = authorizationMiddleware(core);
  return {
    currentUser: core.currentUser,
    can: core.can,
    isShiftEngineer: core.isShiftEngineer,
    userPayload: core.userPayload,
    signAuthToken: core.signAuthToken,
    verifyAuthToken: core.verifyAuthToken,
    requireAuth: middleware.authenticated,
    requirePerm: middleware.permitted,
    routes: (afterLogin: (user:User)=>void = () => {}) => createAuthRouter(db, core, afterLogin),
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
