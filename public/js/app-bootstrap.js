import {state} from "./core/app-state.js";
import {$,$$,api,toast,showError,confirmDelete,can,sessionToken,setUnauthorizedHandler} from "./core/ui-core.js";
import {showLogin,showApp,switchTab,openMobileMenu,closeMobileMenu,journalScrollElement,updateJournalChrome} from "./navigation.js";
import {renderReports,renderStats,submitReport,closeReportModal,openReportModal,submitRestore,closeRestoreModal,startEdit,loadReports} from "./journal/journal-controller.js";
import {openUserModal,closeUserModal,createUser,openRoleModal,closeRoleModal,submitRole,openChecklistRoleModal,closeChecklistRoleModal,applyChecklistRoleModal,setChecklistRolePermission,toggleRolePermission,saveRolePermissions,loadUsers} from "./admin/administration-controller.js";

setUnauthorizedHandler(()=>{state.me=null;showLogin();});

document.addEventListener("DOMContentLoaded", async()=>{
  $("#login-form").addEventListener("submit",async(e)=>{
    e.preventDefault();
    const form=e.currentTarget;
    const submit=form.querySelector('button[type="submit"]');
    if(submit){submit.disabled=true;submit.textContent="Daxil olunur...";}
    try{
      state.me=await api("/api/login",{method:"POST",body:JSON.stringify({
        username:$("#login-username").value.trim(),
        password:$("#login-password").value
      })});
      if(state.me?.auth_token) sessionToken.save(state.me.auth_token);
      $("#login-error").classList.add("hidden");
      $("#login-form").reset();
      await showApp();
    }catch(err){
      showError($("#login-error"),err.message);
    }finally{
      if(submit){submit.disabled=false;submit.textContent="Daxil ol";}
    }
  });
  $("#btn-logout").addEventListener("click",async()=>{if(window.CNSChecklists && !window.CNSChecklists.leave())return;try{await api("/api/logout",{method:"POST"});}catch{} sessionToken.clear(); state.me=null; state.reports=[]; state.roles=[]; showLogin();});
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
    if(sortBtn){const th=sortBtn.closest("th[data-sort]");const field=th.dataset.sort;if(state.reportSort.field===field)state.reportSort.direction=state.reportSort.direction==="asc"?"desc":"asc";else{state.reportSort.field=field;state.reportSort.direction="desc";}renderReports();return;}
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
  $("#btn-delete-all").addEventListener("click",async()=>{if(!state.reports.length)return;if(!await confirmDelete("Bütün jurnal qeydləri silinsin?"))return;try{const d=await api("/api/reports",{method:"DELETE"});toast(`${d.deleted} qeyd silindi`);await loadReports();}catch(err){toast(err.message,"error");}});

  $("#btn-new-user").addEventListener("click",()=>openUserModal()); $$('[data-close-user-modal]').forEach(x=>x.addEventListener("click",closeUserModal)); $("#user-form").addEventListener("submit",createUser);
  $("#btn-new-role").addEventListener("click",()=>openRoleModal()); $$('[data-close-role-modal]').forEach(x=>x.addEventListener("click",closeRoleModal)); $("#role-form").addEventListener("submit",submitRole);
  $$('[data-close-checklist-role]').forEach(el=>el.addEventListener("click",closeChecklistRoleModal));
  $("#apply-checklist-role").addEventListener("click",applyChecklistRoleModal);
  $("#checklist-role-options").addEventListener("change",e=>{
    const input=e.target.closest("[data-checklist-role-perm]");
    if(input && !input.disabled) setChecklistRolePermission(input.dataset.checklistRolePerm,input.checked);
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
    const edit=e.target.closest("[data-editrole]");if(edit){const r=state.roles.find(x=>x.name===edit.dataset.editrole);if(r)openRoleModal(r);}
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
    state.me=await api("/api/me");
    if(state.me?.auth_token) sessionToken.save(state.me.auth_token);
    await showApp();
  }catch(error){
    console.error("Application bootstrap failed",error);
    sessionToken.clear();
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
  state.reports = rows;
  $("#filter-search").value = String(id);
  $("#filter-xidmet").value = "";
  $("#filter-status").value = "";
  renderReports();renderStats();
};
