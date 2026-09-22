"use strict";
let me = null;
let reports = [];
let roles = [];
let roleDrafts = {};
let reportSort = { field: "nasazliq_vaxti", direction: "desc" };
let pendingRestore = null;
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const PRIORITY_LABELS = { asagi: "Aşağı", orta: "Orta", yuksek: "Yüksək" };

function can(p) { return !!(me && me.perms && me.perms[p]); }
function esc(v) { const d = document.createElement("div"); d.textContent = v ?? ""; return d.innerHTML; }
function parseDateValue(v) {
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
function fmtDate(v) {
  const d = parseDateValue(v);
  if (!d || Number.isNaN(d.getTime())) return String(v || "").replace("T", " ");
  const yy = String(d.getFullYear()).slice(-2);
  return `${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")}.${yy} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}
function searchFold(v) {
  return String(v ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/ə/g,"e").replace(/ı/g,"i");
}
function confirmDelete(message,title="Silməni təsdiqləyin") {
  return new Promise(resolve=>{
    const dialog=document.createElement("dialog");dialog.className="cl-native-modal cns-delete-modal";
    dialog.innerHTML=`<div class="cl-modal-body"><h3>${esc(title)}</h3><p>${esc(message)}</p><div class="cl-modal-actions modal-destructive-actions"><button type="button" class="btn modal-cancel-button">İmtina</button><button type="button" class="btn modal-delete-button">Sil</button></div></div>`;
    const done=value=>{dialog.close();dialog.remove();resolve(value);};
    dialog.querySelector(".modal-cancel-button").addEventListener("click",()=>done(false));dialog.querySelector(".modal-delete-button").addEventListener("click",()=>done(true));dialog.addEventListener("cancel",e=>{e.preventDefault();done(false);},{once:true});document.body.append(dialog);dialog.showModal();dialog.querySelector(".modal-cancel-button").focus();
  });
}
window.CNSConfirmDelete=confirmDelete;

function toast(msg, type = "success") {
  const t = $("#toast"); t.textContent = msg; t.className = `toast ${type === "success" ? "success" : "error-toast"}`;
  setTimeout(() => t.classList.add("hidden"), 3500);
}
function showError(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }
async function api(url, options = {}) {
  const token = localStorage.getItem("cns_auth_token") || "";
  const opts = { credentials: "same-origin", cache: "no-store", ...options };
  opts.headers = { ...(opts.headers || {}) };
  if (token) opts.headers["X-CNS-Token"] = token;
  if (opts.body && typeof opts.body === "string") opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== "/api/login" && url !== "/api/me") { me = null; showLogin(); }
    throw new Error(data.error || "Xəta baş verdi");
  }
  return data;
}

function resetPanels() {
  $$(".tab").forEach((x) => x.classList.remove("active"));
  $$(".tab-panel").forEach((x) => x.classList.add("hidden"));
}
function showLogin() {
  document.body.classList.remove("journal-view");
  window.CNSChecklists?.reset();
  window.CNSTemplateAdmin?.reset();
  window.CNSShiftAdmin?.reset();
  closeChecklistRoleModal();
  closeRestoreModal();
  closeReportModal();
  closeUserModal();
  closeRoleModal();
  resetPanels();
  $("#login-screen").classList.remove("hidden");
  $("#app-screen").classList.add("hidden");
}
function switchTab(name) {
  if ($("#app-screen")?.dataset.view === "checklist-templates" && name !== "checklist-templates" && window.CNSTemplateAdmin?.leave() === false) return;
  if ($("#app-screen")?.dataset.view === "checklist-shifts" && name !== "checklist-shifts" && window.CNSShiftAdmin?.leave() === false) return;
  if (document.querySelector("#app-screen")?.dataset.view === "checklists" && name !== "checklists" && !window.CNSChecklists?.leave()) return;
  const btn = $(`.tab[data-tab="${name}"]`);
  const panel = $(`#tab-${name}`);
  if (!btn || !panel || btn.classList.contains("hidden")) name = "journal";
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if($("#mobile-nav-title"))$("#mobile-nav-title").textContent="CNS Digital";
  closeMobileMenu();
  $$(".tab-panel").forEach((p) => p.classList.add("hidden"));
  $(`#tab-${name}`).classList.remove("hidden");
  const appScreen = $("#app-screen");
  if (appScreen) appScreen.dataset.view = name;
  document.body.classList.toggle("journal-view", name === "journal");
  if (name === "checklists") window.CNSChecklists?.open();
  if (name === "checklist-templates") window.CNSTemplateAdmin?.open();
  if (name === "checklist-shifts") window.CNSShiftAdmin?.open();
  if (name === "users") loadUsers();
  if (name === "roles") renderRoles();
  requestAnimationFrame(updateJournalChrome);
}
function openMobileMenu(){if(innerWidth>600)return;document.body.classList.add('mobile-menu-open');$('#mobile-menu-trigger')?.setAttribute('aria-expanded','true');$('#mobile-menu-overlay').hidden=false;}
function closeMobileMenu(){document.body.classList.remove('mobile-menu-open');$('#mobile-menu-trigger')?.setAttribute('aria-expanded','false');if($('#mobile-menu-overlay'))$('#mobile-menu-overlay').hidden=true;}

function journalScrollElement(){
  return $(".journal-table-wrap");
}
function updateJournalChrome(){
  const app=$("#app-screen"),footer=document.querySelector("#app-screen .app-footer"),button=$("#journal-back-to-top");
  if(!app||!footer||!button)return;
  const active=app.dataset.view==="journal"&&!app.classList.contains("hidden"),table=$(".journal-table-wrap");
  footer.classList.remove("journal-footer-hidden");app.classList.remove("journal-footer-collapsed");
  if(!active){button.classList.add("hidden");if(table){table.style.height="";table.style.maxHeight="";}return;}
  // The page shell and footer stay fixed; only the journal table scrolls.
  // Derive its height from the live viewport geometry so resize/zoom cannot
  // leave rows behind the footer.
  const reserve=footer.scrollHeight+8;
  const available=Math.max(140,window.innerHeight-table.getBoundingClientRect().top-reserve);
  table.style.height=`${available}px`;table.style.maxHeight=`${available}px`;
  const top=table.scrollTop;
  button.classList.toggle("hidden",!active||top<400);
}
async function showApp() {
  $("#login-screen").classList.add("hidden");
  $("#app-screen").classList.remove("hidden");
  $("#user-name").textContent = `${me.full_name} · ${me.role_label || me.role}`;
  const initials = String(me.full_name || me.username || "U").trim().split(/\s+/).slice(0,2).map(x=>x[0]||"").join("").toUpperCase();
  const avatar = $("#user-avatar"); if (avatar) avatar.textContent = initials || "U";
  $$(".perm").forEach((el) => el.classList.toggle("hidden", !can(el.dataset.perm)));
  // Always open the journal after every login. This fixes the old admin-tab leak.
  switchTab("journal");
  await loadReports();
  if (can("manage_users")) await loadRoles();
}

async function loadReports() {
  reports = await api("/api/reports");
  renderReports();
  renderStats();
}
function renderStats() {
  $("#stat-total").textContent = reports.length;
  const openCount = reports.filter((r) => !r.berpa_vaxti).length;
  $("#stat-open").textContent = openCount;
  const done = $("#stat-done"); if (done) done.textContent = reports.length - openCount;
  const n = new Date(); const ym = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
  $("#stat-month").textContent = reports.filter((r) => (r.nasazliq_vaxti || "").startsWith(ym)).length;
}
function filteredReports() {
  const q = searchFold($("#filter-search").value.trim());
  const x = $("#filter-xidmet").value;
  const st = $("#filter-status").value;
  const out = reports.filter((r) => {
    if (x && r.xidmet !== x) return false;
    if (st === "open" && r.berpa_vaxti) return false;
    if (st === "done" && !r.berpa_vaxti) return false;
    if (q) {
      const hay = searchFold([
        r.id,r.xidmet,r.obyekt,r.sistem,r.nasazliq,r.sebeb,r.tedbir,r.muraciet,r.cavabdeh,r.author,
        PRIORITY_LABELS[r.prioritet] || r.prioritet,fmtDate(r.nasazliq_vaxti),fmtDate(r.berpa_vaxti)
      ].join(" "));
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const field = reportSort.field;
  const dir = reportSort.direction === "asc" ? 1 : -1;
  return out.sort((a,b) => {
    const da = parseDateValue(a[field]);
    const db = parseDateValue(b[field]);
    const ta = da && !Number.isNaN(da.getTime()) ? da.getTime() : (a[field] ? 0 : -Infinity);
    const tb = db && !Number.isNaN(db.getTime()) ? db.getTime() : (b[field] ? 0 : -Infinity);
    if (ta === tb) return (Number(a.id) - Number(b.id)) * dir;
    return (ta - tb) * dir;
  });
}
function updateSortHeaders() {
  $$('#reports-table th[data-sort]').forEach((th) => {
    const active = th.dataset.sort === reportSort.field;
    th.setAttribute('aria-sort', active ? (reportSort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = active ? (reportSort.direction === 'asc' ? '↑' : '↓') : '↕';
  });
}
function priorityBadge(p) {
  const cls = p === "yuksek" ? "badge-open" : p === "asagi" ? "badge-off" : "badge-mid";
  return `<span class="badge ${cls}">${PRIORITY_LABELS[p] || "Orta"}</span>`;
}
function renderReports() {
  const rows = filteredReports();
  const hasActions=rows.some(r=>r.can_edit||r.can_delete);
  $("#reports-table").classList.toggle("journal-no-actions",!hasActions);
  updateSortHeaders();
  $("#empty-journal").classList.toggle("hidden", !!rows.length);
  $("#reports-table tbody").innerHTML = rows.map((r) => {
    const status = r.berpa_vaxti ? `<span class="badge badge-done">${esc(fmtDate(r.berpa_vaxti))}</span>` : '<span class="badge badge-open">Bərpa olunmayıb</span>';
    const actions = [
      r.can_edit ? `<button class="icon-btn" data-edit="${r.id}" title="Redaktə">✎</button>` : "",
      r.can_delete ? `<button class="icon-btn danger" data-del="${r.id}" title="Sil">✕</button>` : "",
    ].join("");
    const restoredMark = r.restored_by_update ? '<span class="restored-star" title="Sonradan bərpa edilib">★</span>' : '';
    return `<tr class="${r.restored_by_update ? 'was-restored' : ''}"><td>${r.id}${restoredMark}</td><td>${esc(r.xidmet)}</td><td>${esc(r.obyekt)}</td><td><b>${esc(r.sistem)}</b></td><td>${esc(r.nasazliq)}</td><td>${esc(fmtDate(r.nasazliq_vaxti))}</td><td>${priorityBadge(r.prioritet)}</td><td>${esc(r.sebeb)}</td><td>${esc(r.tedbir).replace(/\n/g,'<br>')}</td><td>${status}</td><td>${esc(r.muraciet)}</td><td>${esc(r.cavabdeh)}</td><td>${esc(r.author)}</td><td><div class="row-actions">${actions}</div></td></tr>`;
  }).join("");
  $("#journal-mobile-list").innerHTML = rows.map((r) => {
    const active=!r.berpa_vaxti,actions=[r.can_edit?`<button class="icon-btn" data-edit="${r.id}" title="Redaktə" aria-label="Redaktə">✎</button>`:"",r.can_delete?`<button class="icon-btn danger" data-del="${r.id}" title="Sil" aria-label="Sil">✕</button>`:""].join("");
    return `<article class="journal-mobile-card"><div class="jmc-head"><strong>#${r.id}</strong><span class="badge ${active?'badge-open':'badge-done'}">${active?'Aktiv':'Bərpa edilib'}</span></div><div class="jmc-route">${esc(r.xidmet)} · ${esc(r.obyekt)} · ${esc(r.sistem)}</div><div class="jmc-fault"><span>Nasazlıq</span><strong>${esc(r.nasazliq)}</strong></div><div class="jmc-time">${esc(fmtDate(r.nasazliq_vaxti))} · ${priorityBadge(r.prioritet)}</div><div class="jmc-action-row"><details><summary><span class="jmc-more">Ətraflı</span><span class="jmc-less">Bağla</span></summary><div class="jmc-detail"><div><span>Səbəb</span><p>${esc(r.sebeb)||'—'}</p></div><div><span>Tədbir</span><p>${esc(r.tedbir).replace(/\n/g,'<br>')||'—'}</p></div><dl><dt>Müraciət</dt><dd>${esc(r.muraciet)||'—'}</dd><dt>Cavabdeh</dt><dd>${esc(r.cavabdeh)||'—'}</dd><dt>Bərpa</dt><dd>${esc(fmtDate(r.berpa_vaxti))||'—'}</dd><dt>Daxil etdi</dt><dd>${esc(r.author)||'—'}</dd></dl></div></details>${actions?`<div class="jmc-actions">${actions}</div>`:''}</div></article>`;
  }).join("");
}

function resetReportForm() {
  $("#report-form").reset(); $("#f-id").value = ""; $("#form-title").textContent = "Yeni nasazlıq qeydi";
  $("#btn-cancel-edit").classList.add("hidden"); $("#form-error").classList.add("hidden");
  const mur = $("#f-muraciet"); if (mur) mur.placeholder = "Soyad A. (məsələn: Əliyev A.)";
  const cav = $("#f-cavabdeh");
  if (cav) {
    const locked = !!me?.perms?.shift_engineer_access;
    cav.readOnly = locked;
    cav.setAttribute("aria-readonly", locked ? "true" : "false");
    cav.classList.toggle("field-readonly", locked);
    if (locked) cav.value = me.full_name || "";
  }
}
function openReportModal(mode="new") {
  if (mode === "new") resetReportForm();
  $("#report-modal").classList.remove("hidden");
  $("#report-modal").setAttribute("aria-hidden","false");
  document.body.classList.add("modal-open");
  setTimeout(()=>$("#f-xidmet")?.focus(),0);
}
function closeReportModal() {
  const m=$("#report-modal");
  if (m) { m.classList.add("hidden"); m.setAttribute("aria-hidden","true"); }
  resetReportForm();
  if ($("#restore-modal")?.classList.contains("hidden") && $("#user-modal")?.classList.contains("hidden") && $("#role-modal")?.classList.contains("hidden")) document.body.classList.remove("modal-open");
}
function openRestoreModal(dateValue, body, id) {
  pendingRestore = { id, body };
  $("#restore-date-preview").textContent = fmtDate(dateValue);
  $("#restore-description").value = "";
  $("#restore-error").classList.add("hidden");
  $("#restore-modal").classList.remove("hidden");
  $("#restore-modal").setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  setTimeout(() => $("#restore-description")?.focus(), 0);
}
function closeRestoreModal() {
  const m = $("#restore-modal");
  if (m) { m.classList.add("hidden"); m.setAttribute("aria-hidden", "true"); }
  pendingRestore = null;
  if ($("#report-modal")?.classList.contains("hidden") && $("#user-modal")?.classList.contains("hidden") && $("#role-modal")?.classList.contains("hidden")) document.body.classList.remove("modal-open");
}
async function submitRestore(e) {
  e.preventDefault();
  if (!pendingRestore) return;
  const description = $("#restore-description").value.trim();
  if (!description) { showError($("#restore-error"), "Görülən tədbiri yazın"); return; }
  try {
    await api(`/api/reports/${pendingRestore.id}/restore`, {
      method: "POST",
      body: JSON.stringify({ ...pendingRestore.body, recovery_description: description })
    });
    toast("Nasazlıq bərpa edildi");
    closeRestoreModal();
    closeReportModal();
    await loadReports();
    switchTab("journal");
  } catch (err) { showError($("#restore-error"), err.message); }
}

function startEdit(id) {
  const r = reports.find((x) => x.id === id); if (!r || !r.can_edit) return;
  $("#f-id").value=r.id; $("#f-xidmet").value=r.xidmet; $("#f-obyekt").value=r.obyekt;
  $("#f-sistem").value=r.sistem; $("#f-nasazliq").value=r.nasazliq; $("#f-nasazliq-vaxti").value=r.nasazliq_vaxti;
  $("#f-berpa-vaxti").value=r.berpa_vaxti; $("#f-sebeb").value=r.sebeb; $("#f-tedbir").value=r.tedbir;
  $("#f-muraciet").value=r.muraciet; $("#f-cavabdeh").value=!!me?.perms?.shift_engineer_access ? (me.full_name || r.cavabdeh) : r.cavabdeh; $("#f-prioritet").value=r.prioritet || "orta";
  $("#f-cavabdeh").readOnly = !!me?.perms?.shift_engineer_access;
  $("#f-cavabdeh").setAttribute("aria-readonly", !!me?.perms?.shift_engineer_access ? "true" : "false");
  $("#f-cavabdeh").classList.toggle("field-readonly", !!me?.perms?.shift_engineer_access);
  $("#form-title").textContent=`Qeyd №${r.id} — redaktə`; $("#btn-cancel-edit").classList.remove("hidden"); openReportModal("edit");
}
async function submitReport(e) {
  e.preventDefault();
  const id=$("#f-id").value;
  const body={xidmet:$("#f-xidmet").value,obyekt:$("#f-obyekt").value,sistem:$("#f-sistem").value,nasazliq:$("#f-nasazliq").value,nasazliq_vaxti:$("#f-nasazliq-vaxti").value,berpa_vaxti:$("#f-berpa-vaxti").value,sebeb:$("#f-sebeb").value,tedbir:$("#f-tedbir").value,muraciet:$("#f-muraciet").value,cavabdeh:$("#f-cavabdeh").value,prioritet:$("#f-prioritet").value};
  if (id && !!me?.perms?.shift_engineer_access) {
    const existing = reports.find((r) => String(r.id) === String(id));
    if (existing && !existing.berpa_vaxti && body.berpa_vaxti) {
      openRestoreModal(body.berpa_vaxti, body, id);
      return;
    }
  }
  try { await api(id?`/api/reports/${id}`:"/api/reports",{method:id?"PUT":"POST",body:JSON.stringify(body)}); toast(id?"Qeyd yeniləndi":"Qeyd əlavə olundu"); closeReportModal(); await loadReports(); switchTab("journal"); }
  catch(err){ showError($("#form-error"),err.message); }
}

function allowedRolesForActor() {
  if (can("manage_roles")) return roles;
  return roles.filter((r) => ["employee","shift_engineer"].includes(r.name));
}
function roleOptions(selected="employee") { return allowedRolesForActor().map((r)=>`<option value="${esc(r.name)}" ${r.name===selected?"selected":""}>${esc(r.label)}</option>`).join(""); }
async function loadRoles() {
  roles = await api("/api/roles");
  roleDrafts = {};
  $("#u-role").innerHTML = roleOptions("employee");
  renderRoles();
}
function yesNo(v){return v?'<span class="badge badge-done">Bəli</span>':'<span class="badge badge-off">Xeyr</span>';}
const CHECKLIST_ROLE_PERMS = [
  ["view_checklists", "Yoxlama vərəqlərinə baxış"],
  ["create_checklists", "Yoxlama vərəqi yaratmaq"],
  ["edit_own_checklists", "Öz yoxlama vərəqini redaktə etmək"],
  ["manage_checklists", "Bütün yoxlama vərəqlərini idarə etmək"],
  ["manage_checklist_templates", "Yoxlama şablonlarını idarə etmək"],
  ["manage_checklist_shifts", "Növbə cədvəllərini idarə etmək"],
  ["create_reports_from_checklist", "Yoxlamadan nasazlıq yaratmaq"],
];
const ROLE_TOGGLE_PERMS=["view_all_reports","create_reports","edit_reports","delete_reports","export_import","manage_users","shift_engineer_access",...CHECKLIST_ROLE_PERMS.map(([key])=>key)];
function roleValue(role,perm){ return roleDrafts[role.name]?.[perm] ?? !!role[perm]; }
function roleDirty(name){ return !!roleDrafts[name] && Object.keys(roleDrafts[name]).length>0; }
function permToggle(role,perm,value){
  const locked=role.name==="admin" || !can("manage_roles") || !ROLE_TOGGLE_PERMS.includes(perm);
  const actual=roleValue(role,perm);
  return `<input type="checkbox" class="role-permission-checkbox" data-roleperm="${esc(role.name)}" data-perm="${esc(perm)}" ${actual?"checked":""} ${locked?"disabled":""} aria-label="${esc(role.label)}: ${esc(perm)}" />`;
}
function renderRoles(){
  const tb=$("#roles-table tbody"); if(!tb) return;
  tb.innerHTML=roles.map(r=>{
    const actions = r.name==="admin" ? '<span class="muted">Qorunan</span>' : `<div class="role-actions"><button class="icon-btn" data-editrole="${esc(r.name)}" title="Rolun adını dəyiş">✎</button><button class="icon-btn save-role ${roleDirty(r.name)?"":"is-clean"}" data-saverole="${esc(r.name)}">Yadda saxla</button></div>`;
    return `<tr><td data-label="Rol"><b>${esc(r.label)}</b>${r.name==="admin"?'<div class="role-lock-note">Qorunan rol</div>':''}</td><td data-label="Jurnal">${permToggle(r,"view_all_reports",r.view_all_reports)}</td><td data-label="Əlavə et">${permToggle(r,"create_reports",r.create_reports)}</td><td data-label="Redaktə">${permToggle(r,"edit_reports",r.edit_reports)}</td><td data-label="Sil">${permToggle(r,"delete_reports",r.delete_reports)}</td><td data-label="Excel">${permToggle(r,"export_import",r.export_import)}</td><td data-label="İstifadəçilər">${permToggle(r,"manage_users",r.manage_users)}</td><td data-label="Növbə müh.">${permToggle(r,"shift_engineer_access",r.shift_engineer_access)}</td><td data-label="Parol">${permToggle(r,"reset_password",r.reset_password)}</td><td data-label="Yoxlama hüquqları" class="checklist-role-cell"><span class="checklist-role-summary"><span>${CHECKLIST_ROLE_PERMS.filter(([key])=>roleValue(r,key)).length} / ${CHECKLIST_ROLE_PERMS.length}</span><button type="button" class="icon-btn checklist-role-menu" data-checklist-role="${esc(r.name)}" aria-label="${esc(r.label)} — Yoxlama hüquqları" aria-haspopup="dialog">⋮</button></span></td><td data-label="Əməliyyat">${actions}</td></tr>`;
  }).join("");
}
function setRoleDraft(role, permission, enabled){
  const draft={...(roleDrafts[role.name]||{})};
  if(enabled===!!role[permission]) delete draft[permission]; else draft[permission]=enabled;
  if(Object.keys(draft).length) roleDrafts[role.name]=draft; else delete roleDrafts[role.name];
}
function toggleRolePermission(btn){
  const role=roles.find(r=>r.name===btn.dataset.roleperm), permission=btn.dataset.perm;
  if(!role || role.name==="admin" || !can("manage_roles") || !ROLE_TOGGLE_PERMS.includes(permission)) return;
  setRoleDraft(role,permission,btn.checked);
  renderRoles();
}
let checklistRoleModalState=null;
function openChecklistRoleModal(name){
  const role=roles.find(r=>r.name===name); if(!role) return;
  const locked=role.name==="admin" || !can("manage_roles");
  checklistRoleModalState={name, trigger:document.activeElement, values:Object.fromEntries(CHECKLIST_ROLE_PERMS.map(([key])=>[key,roleValue(role,key)]))};
  $("#checklist-role-name").textContent=role.label;
  $("#checklist-role-options").innerHTML=CHECKLIST_ROLE_PERMS.map(([key,label])=>`<label class="checklist-role-option"><input type="checkbox" class="role-permission-checkbox" data-checklist-role-perm="${key}" ${checklistRoleModalState.values[key]?"checked":""} ${locked?"disabled":""}>${esc(label)}</label>`).join("");
  $("#apply-checklist-role").disabled=locked;
  const modal=$("#checklist-role-modal"); modal.classList.remove("hidden"); modal.setAttribute("aria-hidden","false"); document.body.classList.add("modal-open");
  modal.querySelector("button").focus();
}
function closeChecklistRoleModal(){
  const trigger=checklistRoleModalState?.trigger;
  checklistRoleModalState=null;
  $("#checklist-role-modal").classList.add("hidden"); $("#checklist-role-modal").setAttribute("aria-hidden","true");
  document.body.classList.remove("modal-open"); trigger?.focus();
}
function applyChecklistRoleModal(){
  const state=checklistRoleModalState, role=roles.find(r=>r.name===state?.name);
  if(!role || role.name==="admin" || !can("manage_roles")) return;
  CHECKLIST_ROLE_PERMS.forEach(([key])=>setRoleDraft(role,key,state.values[key]));
  closeChecklistRoleModal(); renderRoles();
  [...document.querySelectorAll("[data-checklist-role]")].find(el=>el.dataset.checklistRole===role.name)?.focus();
}
async function saveRolePermissions(name){
  const changes=roleDrafts[name]||{};
  if(!Object.keys(changes).length) return;
  try{
    await api(`/api/roles/${encodeURIComponent(name)}/permissions-batch`,{method:"PUT",body:JSON.stringify({permissions:changes})});
    toast("Rol hüquqları yadda saxlanıldı");
    await loadRoles();
  }catch(err){toast(err.message,"error");}
}
function openRoleModal(role=null){
  $("#role-form").reset(); $("#role-error").classList.add("hidden");
  $("#role-name").value=role?.name||""; $("#role-label").value=role?.label||"";
  $("#role-modal-title").textContent=role?"Rolu redaktə et":"Yeni rol";
  $$('[data-role-form-perm]').forEach(cb=>{cb.checked=role?!!role[cb.dataset.roleFormPerm]:false;});
  $("#role-modal").classList.remove("hidden"); document.body.classList.add("modal-open");
}
function closeRoleModal(){const m=$("#role-modal");if(m)m.classList.add("hidden");if($("#user-modal")?.classList.contains("hidden"))document.body.classList.remove("modal-open");}
async function submitRole(e){
  e.preventDefault(); const name=$("#role-name").value;
  const permissions={}; $$('[data-role-form-perm]').forEach(cb=>permissions[cb.dataset.roleFormPerm]=cb.checked);
  const body={label:$("#role-label").value.trim(),permissions};
  try{
    if(name) await api(`/api/roles/${encodeURIComponent(name)}`,{method:"PUT",body:JSON.stringify(body)});
    else await api('/api/roles',{method:'POST',body:JSON.stringify(body)});
    closeRoleModal(); toast(name?"Rol yeniləndi":"Yeni rol yaradıldı"); await loadRoles();
  }catch(err){showError($("#role-error"),err.message);}
}
async function loadUsers(){
  if(!roles.length) await loadRoles();
  const users=await api("/api/users");
  const userView=(u,mobile=false)=>{
    const self=u.id===me.id;
    const roleCell=can("manage_roles")&&!self?`<select class="role-select" data-roleuser="${u.id}">${roles.map(r=>`<option value="${esc(r.name)}" ${r.name===u.role?"selected":""}>${esc(r.label)}</option>`).join("")}</select>`:`<span class="badge badge-dir">${esc(u.role_label)}</span>`;
    const actions=[];
    if(self) actions.push('<span class="muted">Sizin hesab</span>');
    else {
      actions.push(`<button class="icon-btn" data-edituser="${u.id}" data-name="${esc(u.full_name)}" data-username="${esc(u.username)}" data-role="${esc(u.role)}" title="İstifadəçini redaktə et">✎</button>`);
      if(can("reset_password")) actions.push(`<button class="icon-btn" data-resetpw="${u.id}" data-name="${esc(u.full_name)}">Parol</button>`);
      actions.push(`<button class="icon-btn ${u.active?"danger":""}" data-toggle="${u.id}" data-active="${u.active}">${u.active?"Deaktiv et":"Aktiv et"}</button>`);
      actions.push(`<button class="icon-btn danger delete-user" data-deluser="${u.id}" data-name="${esc(u.full_name)}" title="Hesabı sil">✕</button>`);
    }
    const status=u.active?'<span class="badge badge-done">Aktiv</span>':'<span class="badge badge-off">Deaktiv</span>';
    return mobile?`<article class="user-mobile-card"><div class="user-mobile-main"><div class="user-mobile-name"><strong>${esc(u.full_name)}</strong>${status}</div><span class="user-mobile-login">${esc(u.username)}</span><div class="user-mobile-role">${roleCell}</div></div>${actions.length?`<div class="row-actions user-mobile-actions">${actions.join("")}</div>`:''}</article>`:`<tr><td>${u.id}</td><td>${esc(u.full_name)}</td><td>${esc(u.username)}</td><td>${roleCell}</td><td>${status}</td><td class="${self?'user-self-action':''}"><div class="row-actions">${actions.join("")}</div></td></tr>`;
  };
  $("#users-table tbody").innerHTML=users.map(u=>userView(u)).join("");
  $("#users-mobile-list").innerHTML=users.map(u=>userView(u,true)).join("");
}
function openUserModal(user=null){
  $("#user-form").reset(); $("#user-error").classList.add("hidden");
  const editing=!!user;
  $("#u-id").value=editing?user.id:"";
  $("#user-modal-title").textContent=editing?"İstifadəçini redaktə et":"Yeni istifadəçi";
  $("#user-modal-kicker").textContent=editing?"EDIT ACCOUNT":"NEW ACCOUNT";
  $("#user-submit-btn").textContent=editing?"Yadda saxla":"Yarat";
  $("#u-password-label").classList.toggle("hidden",editing);
  $("#u-password").required=!editing;
  $("#u-role").innerHTML=roleOptions(editing?user.role:"employee");
  if(editing){ $("#u-name").value=user.full_name; $("#u-username").value=user.username; }
  $("#user-modal").classList.remove("hidden"); document.body.classList.add("modal-open");
}
function closeUserModal(){ const m=$("#user-modal"); if(m) m.classList.add("hidden"); document.body.classList.remove("modal-open"); }
async function createUser(e){
  e.preventDefault();
  const id=$("#u-id").value;
  try{
    if(id){
      await api(`/api/users/${id}`,{method:"PUT",body:JSON.stringify({full_name:$("#u-name").value,username:$("#u-username").value,role:$("#u-role").value})});
      closeUserModal(); toast("İstifadəçi yeniləndi"); await loadUsers();
    }else{
      await api("/api/users",{method:"POST",body:JSON.stringify({full_name:$("#u-name").value,username:$("#u-username").value,password:$("#u-password").value,role:$("#u-role").value})});
      closeUserModal(); toast("Hesab yaradıldı"); await loadUsers();
    }
  }catch(err){ showError($("#user-error"),err.message); }
}

document.addEventListener("DOMContentLoaded", async()=>{
  $("#login-form").addEventListener("submit",async(e)=>{
    e.preventDefault();
    const form=e.currentTarget;
    const submit=form.querySelector('button[type="submit"]');
    if(submit){submit.disabled=true;submit.textContent="Daxil olunur...";}
    try{
      me=await api("/api/login",{method:"POST",body:JSON.stringify({
        username:$("#login-username").value.trim(),
        password:$("#login-password").value
      })});
      if(me?.auth_token) localStorage.setItem("cns_auth_token",me.auth_token);
      $("#login-error").classList.add("hidden");
      $("#login-form").reset();
      await showApp();
    }catch(err){
      showError($("#login-error"),err.message);
    }finally{
      if(submit){submit.disabled=false;submit.textContent="Daxil ol";}
    }
  });
  $("#btn-logout").addEventListener("click",async()=>{if(window.CNSChecklists && !window.CNSChecklists.leave())return;try{await api("/api/logout",{method:"POST"});}catch{} localStorage.removeItem("cns_auth_token"); me=null; reports=[]; roles=[]; showLogin();});
  $("#nav-tabs").addEventListener("click",(e)=>{const t=e.target.closest(".tab");if(t)switchTab(t.dataset.tab);});
  $(".journal-table-wrap").addEventListener("scroll",updateJournalChrome,{passive:true});
  $(".journal-table-wrap").addEventListener("scrollend",updateJournalChrome,{passive:true});
  window.addEventListener("scroll",updateJournalChrome,{passive:true});
  window.addEventListener("scrollend",updateJournalChrome,{passive:true});
  window.addEventListener("resize",updateJournalChrome,{passive:true});
  $("#journal-back-to-top").addEventListener("click",()=>journalScrollElement()?.scrollTo({top:0,behavior:"smooth"}));
  $("#filter-search").addEventListener("input",renderReports); $("#filter-xidmet").addEventListener("change",renderReports); $("#filter-status").addEventListener("change",renderReports);
  $("#report-form").addEventListener("submit",submitReport);
  $("#btn-cancel-edit").addEventListener("click",closeReportModal);
  $("#btn-new-report").addEventListener("click",()=>openReportModal("new"));
  $$('[data-close-report-modal]').forEach(x=>x.addEventListener("click",closeReportModal));
  $("#restore-form").addEventListener("submit",submitRestore);
  $$('[data-close-restore-modal]').forEach(x=>x.addEventListener("click",closeRestoreModal));
  $("#reports-table").addEventListener("click",async(e)=>{
    const sortBtn=e.target.closest("th[data-sort] .sort-btn");
    if(sortBtn){const th=sortBtn.closest("th[data-sort]");const field=th.dataset.sort;if(reportSort.field===field)reportSort.direction=reportSort.direction==="asc"?"desc":"asc";else{reportSort.field=field;reportSort.direction="desc";}renderReports();return;}
    const ed=e.target.closest("[data-edit]");if(ed)return startEdit(Number(ed.dataset.edit));
    const del=e.target.closest("[data-del]");if(del&&await confirmDelete(`Qeyd №${del.dataset.del} silinsin?`)){try{await api(`/api/reports/${del.dataset.del}`,{method:"DELETE"});toast("Qeyd silindi");await loadReports();}catch(err){toast(err.message,"error");}}
  });
  $("#journal-mobile-list").addEventListener("click",async(e)=>{
    const ed=e.target.closest("[data-edit]");if(ed)return startEdit(Number(ed.dataset.edit));
    const del=e.target.closest("[data-del]");if(del&&await confirmDelete(`Qeyd №${del.dataset.del} silinsin?`)){try{await api(`/api/reports/${del.dataset.del}`,{method:"DELETE"});toast("Qeyd silindi");await loadReports();}catch(err){toast(err.message,"error");}}
  });
  $("#btn-export").addEventListener("click",()=>{window.location.href="/api/export";});
  $("#btn-import").addEventListener("click",()=>$("#import-file").click());
  $("#import-file").addEventListener("change",async(e)=>{const file=e.target.files[0];if(!file)return;if(!confirm("Excel-dəki qeydlər jurnala əlavə olunacaq. Mövcud eyni qeydlər təkrar əlavə edilməyəcək. Davam edilsin?")){e.target.value="";return;}try{const res=await fetch("/api/import",{method:"POST",body:file});const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||"Import xətası");toast(`${data.imported} əlavə edildi · ${data.skipped} təkrar keçildi · ${data.invalid} natamam sətir`);await loadReports();}catch(err){toast(err.message,"error");}finally{e.target.value="";}});
  $("#btn-delete-all").addEventListener("click",async()=>{if(!reports.length)return;if(!await confirmDelete("Bütün jurnal qeydləri silinsin?"))return;try{const d=await api("/api/reports",{method:"DELETE"});toast(`${d.deleted} qeyd silindi`);await loadReports();}catch(err){toast(err.message,"error");}});

  $("#btn-new-user").addEventListener("click",()=>openUserModal()); $$('[data-close-user-modal]').forEach(x=>x.addEventListener("click",closeUserModal)); $("#user-form").addEventListener("submit",createUser);
  $("#btn-new-role").addEventListener("click",()=>openRoleModal()); $$('[data-close-role-modal]').forEach(x=>x.addEventListener("click",closeRoleModal)); $("#role-form").addEventListener("submit",submitRole);
  $$('[data-close-checklist-role]').forEach(el=>el.addEventListener("click",closeChecklistRoleModal));
  $("#apply-checklist-role").addEventListener("click",applyChecklistRoleModal);
  $("#checklist-role-options").addEventListener("change",e=>{
    const input=e.target.closest("[data-checklist-role-perm]");
    if(input && checklistRoleModalState && !input.disabled) checklistRoleModalState.values[input.dataset.checklistRolePerm]=input.checked;
  });
  $("#checklist-role-modal").addEventListener("keydown",e=>{
    if(e.key==="Escape"){e.preventDefault();closeChecklistRoleModal();}
    if(e.key==="Tab"){
      const nodes=[...$("#checklist-role-modal").querySelectorAll("button:not(:disabled),input:not(:disabled)")], first=nodes[0], last=nodes.at(-1);
      if(e.shiftKey && document.activeElement===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();}
    }
  });
  $("#roles-table").addEventListener("click",async(e)=>{
    const menu=e.target.closest("[data-checklist-role]");if(menu){openChecklistRoleModal(menu.dataset.checklistRole);return;}
    const b=e.target.closest("[data-roleperm]");if(b){toggleRolePermission(b);return;}
    const save=e.target.closest("[data-saverole]");if(save){await saveRolePermissions(save.dataset.saverole);return;}
    const edit=e.target.closest("[data-editrole]");if(edit){const r=roles.find(x=>x.name===edit.dataset.editrole);if(r)openRoleModal(r);}
  });
  const userChange=async(e)=>{const s=e.target.closest("[data-roleuser]");if(!s)return;try{await api(`/api/users/${s.dataset.roleuser}`,{method:"PUT",body:JSON.stringify({role:s.value})});toast("Rol dəyişdirildi");await loadUsers();}catch(err){toast(err.message,"error");await loadUsers();}};
  const userClick=async(e)=>{
    const edit=e.target.closest("[data-edituser]");
    if(edit){openUserModal({id:Number(edit.dataset.edituser),full_name:edit.dataset.name,username:edit.dataset.username,role:edit.dataset.role});return;}
    const t=e.target.closest("[data-toggle]"); if(t){try{await api(`/api/users/${t.dataset.toggle}`,{method:"PUT",body:JSON.stringify({active:t.dataset.active!=="1"})});toast("Status dəyişdirildi");await loadUsers();}catch(err){toast(err.message,"error");}return;}
    const p=e.target.closest("[data-resetpw]"); if(p){const np=prompt(`${p.dataset.name} üçün yeni parol (ən azı 6 simvol):`);if(!np)return;try{await api(`/api/users/${p.dataset.resetpw}/password`,{method:"POST",body:JSON.stringify({password:np})});toast("Parol dəyişdirildi");}catch(err){toast(err.message,"error");}return;}
    const d=e.target.closest("[data-deluser]"); if(d&&await confirmDelete(`${d.dataset.name} hesabı tam silinsin?`)){try{await api(`/api/users/${d.dataset.deluser}`,{method:"DELETE"});toast("Hesab silindi");await loadUsers();}catch(err){toast(err.message,"error");}}
  };
  [$("#users-table"),$("#users-mobile-list")].forEach(node=>{node.addEventListener('change',userChange);node.addEventListener('click',userClick);});
  $('#mobile-menu-trigger').addEventListener('click',openMobileMenu);$('#mobile-menu-close').addEventListener('click',closeMobileMenu);$('#mobile-menu-overlay').addEventListener('click',closeMobileMenu);
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMobileMenu();});
  $("#btn-password").addEventListener("click",async()=>{const oldp=prompt("Cari parol:");if(!oldp)return;const newp=prompt("Yeni parol (ən azı 6 simvol):");if(!newp)return;try{await api("/api/change-password",{method:"POST",body:JSON.stringify({oldPassword:oldp,newPassword:newp})});toast("Parol dəyişdirildi");}catch(err){toast(err.message,"error");}});

  try{
    me=await api("/api/me");
    if(me?.auth_token) localStorage.setItem("cns_auth_token",me.auth_token);
    await showApp();
  }catch{
    localStorage.removeItem("cns_auth_token");
    showLogin();
  }
});

window.CNSChecklistCanManage = () => can("manage_checklists");

window.CNSOpenLinkedReport = async (id) => {
  if (!can("view_all_reports")) return;
  const rows = await api("/api/reports");
  if (!rows.some(r => r.id === id)) { toast("Əlaqəli nasazlıq silinib və ya əlçatan deyil", "error"); return; }
  switchTab("journal");
  if ($("#app-screen").dataset.view !== "journal") return;
  reports = rows;
  $("#filter-search").value = String(id);
  $("#filter-xidmet").value = "";
  $("#filter-status").value = "";
  renderReports();renderStats();
};
