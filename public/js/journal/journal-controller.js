import {state} from "../core/app-state.js";
import {$,$$,esc,api,toast,showError,can,fmtDate,parseDateValue,searchFold,PRIORITY_LABELS} from "../core/ui-core.js";
import {switchTab} from "../navigation.js";

export async function loadReports() {
  state.reports = await api("/api/reports");
  renderReports();
  renderStats();
}
export function renderStats() {
  $("#stat-total").textContent = state.reports.length;
  const openCount = state.reports.filter((r) => !r.berpa_vaxti).length;
  $("#stat-open").textContent = openCount;
  const done = $("#stat-done"); if (done) done.textContent = state.reports.length - openCount;
  const n = new Date(); const ym = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
  $("#stat-month").textContent = state.reports.filter((r) => (r.nasazliq_vaxti || "").startsWith(ym)).length;
}
export function filteredReports() {
  const q = searchFold($("#filter-search").value.trim());
  const x = $("#filter-xidmet").value;
  const st = $("#filter-status").value;
  const out = state.reports.filter((r) => {
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
  const field = state.reportSort.field;
  const dir = state.reportSort.direction === "asc" ? 1 : -1;
  return out.sort((a,b) => {
    const da = parseDateValue(a[field]);
    const db = parseDateValue(b[field]);
    const ta = da && !Number.isNaN(da.getTime()) ? da.getTime() : (a[field] ? 0 : -Infinity);
    const tb = db && !Number.isNaN(db.getTime()) ? db.getTime() : (b[field] ? 0 : -Infinity);
    if (ta === tb) return (Number(a.id) - Number(b.id)) * dir;
    return (ta - tb) * dir;
  });
}
export function updateSortHeaders() {
  $$('#reports-table th[data-sort]').forEach((th) => {
    const active = th.dataset.sort === state.reportSort.field;
    th.setAttribute('aria-sort', active ? (state.reportSort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = active ? (state.reportSort.direction === 'asc' ? '↑' : '↓') : '↕';
  });
}
export function priorityBadge(p) {
  const cls = p === "yuksek" ? "badge-open" : p === "asagi" ? "badge-off" : "badge-mid";
  return `<span class="badge ${cls}">${PRIORITY_LABELS[p] || "Orta"}</span>`;
}
export function renderReports() {
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

export function resetReportForm() {
  $("#report-form").reset(); $("#f-id").value = ""; $("#form-title").textContent = "Yeni nasazlıq qeydi";
  $("#btn-cancel-edit").classList.add("hidden"); $("#form-error").classList.add("hidden");
  const mur = $("#f-muraciet"); if (mur) mur.placeholder = "Soyad A. (məsələn: Əliyev A.)";
  const cav = $("#f-cavabdeh");
  if (cav) {
    const locked = !!state.me?.perms?.shift_engineer_access;
    cav.readOnly = locked;
    cav.setAttribute("aria-readonly", locked ? "true" : "false");
    cav.classList.toggle("field-readonly", locked);
    if (locked) cav.value = state.me.full_name || "";
  }
}
export function openReportModal(mode="new") {
  if (mode === "new") resetReportForm();
  $("#report-modal").classList.remove("hidden");
  $("#report-modal").setAttribute("aria-hidden","false");
  document.body.classList.add("modal-open");
  setTimeout(()=>$("#f-xidmet")?.focus(),0);
}
export function closeReportModal() {
  const m=$("#report-modal");
  if (m) { m.classList.add("hidden"); m.setAttribute("aria-hidden","true"); }
  resetReportForm();
  if ($("#restore-modal")?.classList.contains("hidden") && $("#user-modal")?.classList.contains("hidden") && $("#role-modal")?.classList.contains("hidden")) document.body.classList.remove("modal-open");
}
export function openRestoreModal(dateValue, body, id) {
  state.pendingRestore = { id, body };
  $("#restore-date-preview").textContent = fmtDate(dateValue);
  $("#restore-description").value = "";
  $("#restore-error").classList.add("hidden");
  $("#restore-modal").classList.remove("hidden");
  $("#restore-modal").setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  setTimeout(() => $("#restore-description")?.focus(), 0);
}
export function closeRestoreModal() {
  const m = $("#restore-modal");
  if (m) { m.classList.add("hidden"); m.setAttribute("aria-hidden", "true"); }
  state.pendingRestore = null;
  if ($("#report-modal")?.classList.contains("hidden") && $("#user-modal")?.classList.contains("hidden") && $("#role-modal")?.classList.contains("hidden")) document.body.classList.remove("modal-open");
}
export async function submitRestore(e) {
  e.preventDefault();
  if (!state.pendingRestore) return;
  const description = $("#restore-description").value.trim();
  if (!description) { showError($("#restore-error"), "Görülən tədbiri yazın"); return; }
  try {
    await api(`/api/reports/${state.pendingRestore.id}/restore`, {
      method: "POST",
      body: JSON.stringify({ ...state.pendingRestore.body, recovery_description: description })
    });
    toast("Nasazlıq bərpa edildi");
    closeRestoreModal();
    closeReportModal();
    await loadReports();
    switchTab("journal");
  } catch (err) { showError($("#restore-error"), err.message); }
}

export function startEdit(id) {
  const r = state.reports.find((x) => x.id === id); if (!r || !r.can_edit) return;
  $("#f-id").value=r.id; $("#f-xidmet").value=r.xidmet; $("#f-obyekt").value=r.obyekt;
  $("#f-sistem").value=r.sistem; $("#f-nasazliq").value=r.nasazliq; $("#f-nasazliq-vaxti").value=r.nasazliq_vaxti;
  $("#f-berpa-vaxti").value=r.berpa_vaxti; $("#f-sebeb").value=r.sebeb; $("#f-tedbir").value=r.tedbir;
  $("#f-muraciet").value=r.muraciet; $("#f-cavabdeh").value=!!state.me?.perms?.shift_engineer_access ? (state.me.full_name || r.cavabdeh) : r.cavabdeh; $("#f-prioritet").value=r.prioritet || "orta";
  $("#f-cavabdeh").readOnly = !!state.me?.perms?.shift_engineer_access;
  $("#f-cavabdeh").setAttribute("aria-readonly", !!state.me?.perms?.shift_engineer_access ? "true" : "false");
  $("#f-cavabdeh").classList.toggle("field-readonly", !!state.me?.perms?.shift_engineer_access);
  $("#form-title").textContent=`Qeyd №${r.id} — redaktə`; $("#btn-cancel-edit").classList.remove("hidden"); openReportModal("edit");
}
export async function submitReport(e) {
  e.preventDefault();
  const id=$("#f-id").value;
  const body={xidmet:$("#f-xidmet").value,obyekt:$("#f-obyekt").value,sistem:$("#f-sistem").value,nasazliq:$("#f-nasazliq").value,nasazliq_vaxti:$("#f-nasazliq-vaxti").value,berpa_vaxti:$("#f-berpa-vaxti").value,sebeb:$("#f-sebeb").value,tedbir:$("#f-tedbir").value,muraciet:$("#f-muraciet").value,cavabdeh:$("#f-cavabdeh").value,prioritet:$("#f-prioritet").value};
  if (id && !!state.me?.perms?.shift_engineer_access) {
    const existing = state.reports.find((r) => String(r.id) === String(id));
    if (existing && !existing.berpa_vaxti && body.berpa_vaxti) {
      openRestoreModal(body.berpa_vaxti, body, id);
      return;
    }
  }
  try { await api(id?`/api/reports/${id}`:"/api/reports",{method:id?"PUT":"POST",body:JSON.stringify(body)}); toast(id?"Qeyd yeniləndi":"Qeyd əlavə olundu"); closeReportModal(); await loadReports(); switchTab("journal"); }
  catch(err){ showError($("#form-error"),err.message); }
}
