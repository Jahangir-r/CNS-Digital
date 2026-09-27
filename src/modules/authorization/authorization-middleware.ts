import type express from "express";
import type { User } from "../../core/database/domain-types.js";
import type { AuthService } from "../auth/auth-service.js";
import type { PermField } from "./permission-service.js";

export function authorizationMiddleware(auth: AuthService) {
  const authenticated: express.RequestHandler = (req, res, next) => {
    const user = auth.currentUser(req);
    if (!user) return res.status(401).json({error:"Giriş tələb olunur"});
    (res.locals as {user:User}).user = user;
    res.locals.auditActor = {id:user.id, username:user.username, full_name:user.full_name};
    next();
  };
  const permitted = (permission: PermField): express.RequestHandler => (_req, res, next) => {
    const user = (res.locals as {user:User}).user;
    if (!auth.can(user, permission)) return res.status(403).json({error:"İcazə yoxdur"});
    next();
  };
  return {authenticated, permitted};
}
