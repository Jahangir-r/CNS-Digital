import bcrypt from "bcryptjs";
import express from "express";
import type Database from "better-sqlite3";
import type { User } from "../../core/database/domain-types.js";
import { authorizationMiddleware } from "../authorization/authorization-middleware.js";
import type { AuthService } from "./auth-service.js";

export function createAuthRouter(db: Database.Database, auth: AuthService, afterLogin: (user:User)=>void = () => {}) {
  const router = express.Router(), guard = authorizationMiddleware(auth);
  router.post("/login", (req,res,next) => {
    const username = String(req.body?.username ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    if (!username || !password) return res.status(400).json({error:"Login və parol daxil edin"});
    const user = db.prepare("SELECT * FROM users WHERE username=? AND active=1 AND COALESCE(deleted,0)=0").get(username) as User|undefined;
    if (user) res.locals.auditActor = {id:user.id,username:user.username,full_name:user.full_name};
    if (!user || !bcrypt.compareSync(password,user.password_hash)) return res.status(401).json({error:"Yanlış login və ya parol"});
    req.session.regenerate(error => {
      if (error) return res.status(500).json({error:"Sessiya yaradıla bilmədi"});
      req.session.userId=user.id;
      try { afterLogin(user); } catch (caught) { return next(caught); }
      req.session.save(saveError => saveError ? res.status(500).json({error:"Sessiya yadda saxlanmadı"}) :
        res.json({...auth.userPayload(user),auth_token:auth.signAuthToken(user.id)}));
    });
  });
  router.post("/logout",(req,res,next)=>{const user=auth.currentUser(req);if(user)res.locals.auditActor={id:user.id,username:user.username,full_name:user.full_name};req.session.destroy(error=>error?next(error):res.json({ok:true}));});
  router.get("/me",(req,res)=>{const user=auth.currentUser(req);return user?res.json({...auth.userPayload(user),auth_token:auth.signAuthToken(user.id)}):res.status(401).json({error:"Giriş tələb olunur"});});
  router.post("/change-password",guard.authenticated,(req,res)=>{const user=(res.locals as {user:User}).user;const oldPassword=String(req.body?.oldPassword??""),newPassword=String(req.body?.newPassword??"");if(!oldPassword||newPassword.length<6)return res.status(400).json({error:"Yeni parol ən azı 6 simvol olmalıdır"});if(!bcrypt.compareSync(oldPassword,user.password_hash))return res.status(400).json({error:"Köhnə parol yanlışdır"});db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync(newPassword,10),user.id);res.json({ok:true});});
  return router;
}
