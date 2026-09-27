import { $, $$, escapeHtml as esc } from "./dom.js";
import { createApiClient } from "./api-client.js";
import { createNotifications } from "./notifications.js";
import { sessionToken } from "./session.js";
import { state } from "./app-state.js";

const {toast,showError}=createNotifications($);
let unauthorizedHandler=()=>{};
export const setUnauthorizedHandler=handler=>{unauthorizedHandler=handler;};
export const api=createApiClient(()=>unauthorizedHandler());
export { $, $$, esc, toast, showError, sessionToken };
export const PRIORITY_LABELS={asagi:"Aşağı",orta:"Orta",yuksek:"Yüksək"};

export function can(p) { return !!(state.me && state.me.perms && state.me.perms[p]); }
export function parseDateValue(v) {
  const raw = String(v || "").trim();
  if (!raw) return null;
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5]);
  m = raw.match(/(\d{1,2})[.\/,-](\d{1,2})[.\/,-](\d{2,4})(?:\D+?(\d{1,2})[:.,](\d{2}))?/);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    return new Date(y, +m[2]-1, +m[1], +(m[4] || 0), +(m[5] || 0));
  }
  return null;
}
export function fmtDate(v) {
  const d = parseDateValue(v);
  if (!d || Number.isNaN(d.getTime())) return String(v || "").replace("T", " ");
  const yy = String(d.getFullYear()).slice(-2);
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${yy} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}
export function searchFold(v) {
  return String(v ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ə/g,"e").replace(/ı/g,"i");
}
export function confirmDelete(message,title="Silməni təsdiqləyin") {
  return new Promise(resolve=>{
    const dialog=document.createElement("dialog");dialog.className="cl-native-modal cns-delete-modal";
    dialog.innerHTML=`<div class="cl-modal-body"><h3>${esc(title)}</h3><p>${esc(message)}</p><div class="cl-modal-actions modal-destructive-actions"><button type="button" class="btn modal-cancel-button">İmtina</button><button type="button" class="btn modal-delete-button">Sil</button></div></div>`;
    const done=value=>{dialog.close();dialog.remove();resolve(value);};
    dialog.querySelector(".modal-cancel-button").addEventListener("click",()=>done(false));dialog.querySelector(".modal-delete-button").addEventListener("click",()=>done(true));dialog.addEventListener("cancel",e=>{e.preventDefault();done(false);},{once:true});document.body.append(dialog);dialog.showModal();dialog.querySelector(".modal-cancel-button").focus();
  });
}
window.CNSConfirmDelete=confirmDelete;

