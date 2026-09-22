import type { RequestHandler } from "express";
import type { AuditEvent, AuditLog } from "./audit.js";

const actions: [string, RegExp, string, string][] = [
  ["POST", /^\/api\/login$/, "LOGIN", "User login"],
  ["POST", /^\/api\/logout$/, "LOGOUT", "User logout"],
  ["POST", /^\/api\/change-password$/, "PASSWORD_CHANGE", "Own password change"],
  ["POST", /^\/api\/users\/\d+\/password$/, "PASSWORD_RESET", "Administrator password reset"],
  ["POST", /^\/api\/users$/, "USER_CREATE", "Create user"],
  ["PUT", /^\/api\/users\/\d+$/, "USER_UPDATE", "Update user"],
  ["DELETE", /^\/api\/users\/\d+$/, "USER_DELETE", "Delete user"],
  ["POST", /^\/api\/roles$/, "ROLE_CREATE", "Create role"],
  ["PUT", /^\/api\/roles\/[^/]+(?:\/permissions(?:-batch)?)?$/, "ROLE_UPDATE", "Update role"],
  ["POST", /^\/api\/reports$/, "REPORT_CREATE", "Create journal record"],
  ["PUT", /^\/api\/reports\/\d+$/, "REPORT_UPDATE", "Update journal record"],
  ["POST", /^\/api\/reports\/\d+\/restore$/, "REPORT_RESTORE", "Restore equipment"],
  ["DELETE", /^\/api\/reports\/\d+$/, "REPORT_DELETE", "Delete journal record"],
  ["DELETE", /^\/api\/reports$/, "REPORT_DELETE_ALL", "Delete all journal records"],
  ["POST", /^\/api\/import$/, "EXCEL_IMPORT", "Import Excel journal"],
  ["GET", /^\/api\/export$/, "EXCEL_EXPORT", "Export Excel journal"],
];

export function auditRequests(audit: Pick<AuditLog, "write">): RequestHandler {
  return (req, res, next) => {
    const requestPath = req.path; // Routers may temporarily strip their mount path.
    const action = actions.find(([method, pattern]) => method === req.method && pattern.test(requestPath));
    let objectId: string | number | undefined;
    const json = res.json;
    res.json = function (body) {
      // Only capture an object's public identifier, never the whole response.
      try {
        if (body && typeof body === "object") {
          const id = action?.[2] === "ROLE_CREATE" ? body.name : body.id;
          if (typeof id === "string" || typeof id === "number") objectId = id;
        }
      } catch { /* non-fatal */ }
      return json.call(this, body);
    };
    let recorded = false;
    const record = (aborted = false) => {
      if (recorded) return;
      recorded = true;
      try {
        const failed = aborted || res.statusCode >= 400;
        const actor = res.locals.auditActor;
        const entry: AuditEvent = {
          event: res.locals.auditEvent || action?.[2] || "API_ERROR",
          user: actor?.username || (requestPath === "/api/login" && typeof req.body?.username === "string" ? req.body.username : "anonymous"),
          name: actor?.full_name || "",
          ip: req.ip || req.socket.remoteAddress || "-",
          description: aborted ? "Client disconnected before response completed" : action?.[3] || "API request failed",
          status: res.statusCode,
          result: failed ? "ERROR" : "SUCCESS",
        };
        if (action?.[2] === "LOGIN") entry.event = failed ? "LOGIN_FAILURE" : "LOGIN_SUCCESS";
        if (["LOGIN", "LOGOUT", "PASSWORD_CHANGE"].includes(action?.[2] || "") && actor?.id !== undefined) {
          entry.user_id = actor.id;
        }
        if (res.locals.auditEvent === "REPORT_RESTORE") entry.description = "Restore equipment";
        if (action?.[2] === "USER_UPDATE" && req.body?.active === false) {
          entry.event = "USER_DEACTIVATE";
          entry.description = "Deactivate user";
        }
        const report = /^\/api\/reports\/(\d+)/.exec(requestPath);
        const user = /^\/api\/users\/(\d+)/.exec(requestPath);
        const role = /^\/api\/roles\/([^/]+)/.exec(requestPath);
        if (report) entry.report_id = report[1];
        if (user) entry.user_id = user[1];
        if (role) entry.role_id = role[1];
        if (!failed && objectId !== undefined) {
          if (action?.[2] === "REPORT_CREATE") entry.report_id = objectId;
          if (action?.[2] === "USER_CREATE") entry.user_id = objectId;
          if (action?.[2] === "ROLE_CREATE") entry.role_id = objectId;
        }
        if (action || (failed && requestPath.startsWith("/api/"))) audit.write(entry);
        if (res.statusCode >= 500 && action) audit.write({ ...entry, event: "API_ERROR", description: "API or database operation failed" });
      } catch { /* logging never changes an HTTP response */ }
    };
    res.once("finish", () => record());
    res.once("close", () => { if (!res.writableFinished) record(true); });
    next();
  };
}
