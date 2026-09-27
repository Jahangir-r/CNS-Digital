import {state} from "./core/app-state.js";
import {$,$$,can} from "./core/ui-core.js";
import {closeRestoreModal,closeReportModal,loadReports} from "./journal/journal-controller.js";
import {closeChecklistRoleModal,closeUserModal,closeRoleModal,loadUsers,loadRoles,renderRoles} from "./admin/administration-controller.js";

export function resetPanels() {
  $$(".tab").forEach((x) => x.classList.remove("active"));
  $$(".tab-panel").forEach((x) => x.classList.add("hidden"));
}
export function showLogin() {
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
export function switchTab(name) {
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
export function openMobileMenu(){if(innerWidth>600)return;document.body.classList.add('mobile-menu-open');$('#mobile-menu-trigger')?.setAttribute('aria-expanded','true');$('#mobile-menu-overlay').hidden=false;}
export function closeMobileMenu(){document.body.classList.remove('mobile-menu-open');$('#mobile-menu-trigger')?.setAttribute('aria-expanded','false');if($('#mobile-menu-overlay'))$('#mobile-menu-overlay').hidden=true;}

export function journalScrollElement(){
  return $(".journal-table-wrap");
}
export function updateJournalChrome(){
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
export async function showApp() {
  $("#login-screen").classList.add("hidden");
  $("#app-screen").classList.remove("hidden");
  $("#user-name").textContent = `${state.me.full_name} · ${state.me.role_label || state.me.role}`;
  const initials = String(state.me.full_name || state.me.username || "U").trim().split(/\s+/).slice(0,2).map(x=>x[0]||"").join("").toUpperCase();
  const avatar = $("#user-avatar"); if (avatar) avatar.textContent = initials || "U";
  $$(".perm").forEach((el) => el.classList.toggle("hidden", !can(el.dataset.perm)));
  // Always open the journal after every login. This fixes the old admin-tab leak.
  switchTab("journal");
  await loadReports();
  if (can("manage_users")) await loadRoles();
}


