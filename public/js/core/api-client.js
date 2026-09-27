import { sessionToken } from "./session.js";

export function createApiClient(onUnauthorized) {
  return async function request(url, options = {}) {
    const opts = {credentials:"same-origin",cache:"no-store",...options};
    opts.headers = {...(opts.headers || {})};
    const token = sessionToken.read();
    if (token) opts.headers["X-CNS-Token"] = token;
    if (typeof opts.body === "string") opts.headers = {"Content-Type":"application/json",...opts.headers};
    const response = await fetch(url, opts);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && url !== "/api/login" && url !== "/api/me") onUnauthorized?.();
      throw new Error(payload.error || "Xəta baş verdi");
    }
    return payload;
  };
}
